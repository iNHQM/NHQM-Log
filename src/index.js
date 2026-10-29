'use strict';
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { Client, GatewayIntentBits, Partials, EmbedBuilder, AttachmentBuilder, AuditLogEvent, Events } = require('discord.js');
const cfg = require('../config.json');
if (!cfg.token || cfg.token === 'YOUR_BOT_TOKEN' || !/^\d{15,22}$/.test(String(cfg.guildId))) { console.error('Set token and guildId in config.json'); process.exit(1); }
const client = new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent,GatewayIntentBits.GuildMessageReactions,GatewayIntentBits.GuildVoiceStates,GatewayIntentBits.GuildInvites,GatewayIntentBits.GuildModeration],partials:[Partials.Message,Partials.Channel,Partials.Reaction,Partials.User]});
const icons = path.join(__dirname,'../assets/icons');
const channels = new Map();
const inviteCache = new Map();
const messageCache = new Map();
const seenAudit = new Map();
const messageAuditCounts = new Map();
const pendingDeletions = new Map();
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const remember = (m) => { if (!m?.id || String(m.guildId) !== String(cfg.guildId)) return; messageCache.set(m.id,{content:m.content||'',authorId:m.authorId,channelId:m.channelId}); if(messageCache.size>2500)messageCache.delete(messageCache.keys().next().value); };
const limit = (s,n=1000)=>String(s??'Unknown').slice(0,n);
const mention = (id)=>id?`<@${id}>`:'Unknown';
const chMention=(id)=>id?`<#${id}>`:'Unknown';
const perms=(p)=>p?.toArray?.().join(', ')||'None';
const memberName=(m)=>m?.displayName||m?.user?.username||m?.username||'Unknown';
const guildOnly=(g)=>g?.id===String(cfg.guildId);
const categories={members:'members',messages:'messages',voice:'voice',moderation:'moderation',roles:'roles',channels:'channels',invites:'invites',reactions:'reactions'};
async function log(category,title,lines,{icon,subject,image,extraFiles=[]}={}){
  if(!categories[category])return;
  const id=cfg.logs?.[category]; if(!id||id==='CHANNEL_ID')return;
  let target=channels.get(id);if(!target){target=await client.channels.fetch(id).catch(()=>null);if(target)channels.set(id,target);}
  if(!target?.isTextBased?.()||!target.send)return;
  const guild = target.guild || client.guilds.cache.get(String(cfg.guildId));

const embed = new EmbedBuilder()
  .setTitle(limit(title, 256))
  .setDescription(limit(lines.join('\n') || '—', 4000))
  .setColor(cfg.colors?.[category] || '#746a9d')
  .setTimestamp()
  .setFooter({
    text: guild?.name || 'Unknown Server',
    iconURL: guild?.iconURL({ extension: 'png' }) || undefined
  });
  if(subject?.displayAvatarURL)embed.setAuthor({name:limit(memberName(subject),256),iconURL:subject.displayAvatarURL({extension:'png'})});
  else if(subject?.user?.displayAvatarURL)embed.setAuthor({name:limit(memberName(subject),256),iconURL:subject.user.displayAvatarURL({extension:'png'})});
  const files=[...extraFiles];
  if(cfg.features?.thumbnails!==false&&icon&&fs.existsSync(path.join(icons,icon+'.png'))){const filename=`nhqm_${icon}.png`;files.push(new AttachmentBuilder(path.join(icons,icon+'.png'),{name:filename}));embed.setThumbnail('attachment://'+filename);}
  if(image){files.push(image);embed.setImage('attachment://'+image.name);}
  await target.send({embeds:[embed],files,allowedMentions:{parse:[]}}).catch(e=>console.error('[send]',category,e.message));
}
// Audit logs are asynchronous and may arrive after the gateway event.
// Never claim an executor without a matching audit entry.
async function audit(guild,type,targetId,age=12000,channelId=null){
 if(cfg.features?.auditLogs===false)return null;
 for(const wait of [600,1200]){
  await sleep(wait);
  try {
   const result=await guild.fetchAuditLogs({type,limit:20});
   const now=Date.now();
   for(const a of result.entries.values()){
    if(targetId && String(a.target?.id)!==String(targetId))continue;
    if(channelId && String(a.extra?.channel?.id || a.extra?.channelId || '')!==String(channelId))continue;
    if(now-a.createdTimestamp>age || a.createdTimestamp-now>1500)continue;
    const key=`${type}:${a.id}`;
    if(seenAudit.has(key))continue;
    seenAudit.set(key,now);
    if(seenAudit.size>1200)for(const [k,t] of seenAudit)if(now-t>60000)seenAudit.delete(k);
    return a;
   }
  }catch(e){console.warn('[Audit]',type,e.message);return null;}
 }
 return null;
}
// MessageDelete audit entries are aggregate counters (not one entry per message).
// Match target user + channel + recent timestamp and only consume an increased count.
// Serialise same author/channel to prevent two events claiming the same audit increment.
async function messageDeletionAudit(guild,authorId,channelId){
 if(cfg.features?.auditLogs===false || !authorId || !channelId)return null;
 const lock=`${guild.id}:${channelId}:${authorId}`;
 const previous=pendingDeletions.get(lock)||Promise.resolve();
 const task=previous.catch(()=>{}).then(async()=>{
  for(const delay of [900,1200,1800]){
   await sleep(delay);
   let entries;
   try{entries=(await guild.fetchAuditLogs({type:AuditLogEvent.MessageDelete,limit:30})).entries;}
   catch(e){console.warn('[MessageDelete audit]',e.message);return null;}
   const now=Date.now();
   for(const a of entries.values()){
    if(String(a.target?.id)!==String(authorId))continue;
    if(String(a.extra?.channel?.id || a.extra?.channelId || '')!==String(channelId))continue;
    if(Math.abs(now-a.createdTimestamp)>15000)continue;
    const key=a.id;
    const count=Number(a.extra?.count);
    if(!Number.isInteger(count)||count<1)continue;
    const used=messageAuditCounts.get(key)||0;
    if(count<=used)continue;
    messageAuditCounts.set(key,used+1);
    if(messageAuditCounts.size>1000)messageAuditCounts.delete(messageAuditCounts.keys().next().value);
    return a;
   }
  }
  return null;
 });
 pendingDeletions.set(lock,task);
 try{return await task;}finally{if(pendingDeletions.get(lock)===task)pendingDeletions.delete(lock);}
}
const by=(a)=>a?.executorId?mention(a.executorId):'Unknown (audit log unavailable)';
const esc=(s)=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function snapshot(channel, action, target) {
  if (!cfg.features?.voiceSnapshots || !channel) return null;

  // The member collection is a live view. Copy it before rendering.
  const members = [...channel.members.values()].slice(0, 29);
  if (target && !members.some(m => m.id === target.id)) members.unshift(target);
  const shown = members.slice(0, 30);
  const width = 960;
  const rowHeight = 76;
  const height = 174 + Math.max(1, shown.length) * rowHeight + 26;
  const xml = value => esc(String(value ?? ''));
  const avatarOverlays = [];
  const title = limit(channel.name || 'Voice Channel', 46);
  const isMutedAction = /muted/i.test(action) && !/unmuted/i.test(action);

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#101025"/><stop offset=".65" stop-color="#14102c"/><stop offset="1" stop-color="#211443"/></linearGradient>
      <linearGradient id="row" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#292044"/><stop offset="1" stop-color="#1d1935"/></linearGradient>
      <linearGradient id="focus" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#44306e"/><stop offset="1" stop-color="#30204d"/></linearGradient>
    </defs>
    <rect width="960" height="${height}" rx="24" fill="url(#bg)"/>
    <rect x="0" y="0" width="10" height="${height}" rx="5" fill="#9e7ae6"/>
    <rect x="24" y="24" width="100" height="${height - 48}" rx="18" fill="#241c45" opacity=".75"/>
    <text x="75" y="96" text-anchor="middle" font-size="57" font-family="DejaVu Sans,Arial" fill="#d9c7ff">♛</text>
    <text x="151" y="65" font-family="Arial,DejaVu Sans" font-size="29" font-weight="bold" fill="#f6f1ff">${xml(title)}</text>
    <text x="151" y="97" font-family="Arial,DejaVu Sans" font-size="17" fill="#b9add5">${xml(action)} · ${shown.length} member(s) · snapshot at event time</text>
    <rect x="756" y="34" width="168" height="34" rx="10" fill="#272040"/>
    <text x="840" y="56" text-anchor="middle" font-family="Arial,DejaVu Sans" font-size="15" letter-spacing="1" fill="#bfa7f5">VOICE CHANNEL</text>`;

  if (!shown.length) {
    svg += `<text x="151" y="177" font-family="Arial" font-size="21" fill="#a9a0c7">No members in channel</text>`;
  }

  for (let i = 0; i < shown.length; i++) {
    const member = shown[i];
    const y = 131 + i * rowHeight;
    const affected = member.id === target?.id;
    // Server mute is separate from a member's own selfMute flag.
    const muted = affected && /unmuted/i.test(action) ? false
      : affected && isMutedAction ? true
      : Boolean(member.voice?.serverMute);
    const status = muted ? 'SERVER MUTED' : member.voice?.selfMute ? 'SELF MUTED' : 'VOICE';
    const statusColor = muted ? '#f2a8c2' : '#c2b1ed';
    svg += `<rect x="144" y="${y}" width="780" height="65" rx="13" fill="${affected ? 'url(#focus)' : 'url(#row)'}" stroke="${affected ? '#9a70df' : '#363050'}" stroke-width="1"/>
      <rect x="144" y="${y + 6}" width="4" height="53" rx="2" fill="${affected ? '#bb92ff' : '#6c578d'}"/>
      <circle cx="189" cy="${y + 32}" r="24" fill="#655487"/>
      <text x="231" y="${y + 40}" font-family="Arial,DejaVu Sans" font-size="21" fill="#f6f2ff">${xml(limit(member.displayName || member.user?.username || 'Unknown', 36))}</text>
      <rect x="750" y="${y + 17}" width="155" height="32" rx="9" fill="#18152d" opacity=".88"/>
      <text x="828" y="${y + 38}" text-anchor="middle" font-family="Arial,DejaVu Sans" font-size="15" font-weight="bold" fill="${statusColor}">${status}</text>`;

    try {
      const url = member.displayAvatarURL?.({ extension: 'png', size: 128 }) || member.user?.displayAvatarURL?.({ extension: 'png', size: 128 });
      if (!url) continue;
      const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 2_000_000) continue;
      const circle = Buffer.from(`<svg width="48" height="48"><circle cx="24" cy="24" r="24" fill="white"/></svg>`);
      const avatar = await sharp(bytes).resize(48, 48, { fit: 'cover' }).composite([{ input: circle, blend: 'dest-in' }]).png().toBuffer();
      avatarOverlays.push({ input: avatar, left: 165, top: y + 8 });
    } catch (err) {
      console.warn('[snapshot avatar]', member.id, err.message);
    }
  }

  svg += '</svg>';
  try {
    const background = await sharp(Buffer.from(svg)).png().toBuffer();
    const output = await sharp(background).composite(avatarOverlays).png().toBuffer();
    return new AttachmentBuilder(output, { name: 'voice_snapshot.png' });
  } catch (err) {
    console.warn('[snapshot render]', err.message);
    return null;
  }
}


client.once(Events.ClientReady,async()=>{
 console.log(`NHQM Logs online: ${client.user.tag} / guild ${cfg.guildId}`);
 const guild=client.guilds.cache.get(String(cfg.guildId));if(!guild)console.warn('Bot is not in configured guild.');
 else {try{for(const i of (await guild.invites.fetch()).values())inviteCache.set(i.code,i.uses||0);}catch(e){console.warn('Invite cache:',e.message)}}
});
client.on(Events.MessageCreate,m=>{remember(m);});
client.on(Events.MessageUpdate,(_old,m)=>{remember(m);});
client.on(Events.MessageDelete,async m=>{
 if(String(m.guildId)!==String(cfg.guildId))return;
 const saved=messageCache.get(m.id);
 messageCache.delete(m.id);
 const authorId=m.authorId||m.author?.id||saved?.authorId;
 if(m.author?.bot)return;
 const a=await messageDeletionAudit(m.guild,authorId,m.channelId);
 const content=m.content||saved?.content||(m.attachments?.size?'[Attachment]':'[Content unavailable: message was not cached]');
 await log('messages','Delete Message',[
  `**To:** ${mention(authorId)}`,
  `**By:** ${a?by(a):'Unknown / possibly self-deleted'}`,
  `**In:** ${chMention(m.channelId)}`,
  `**Message:** ${limit(content,1500)}`
 ],{icon:'message_delete',subject:m.author||m.member});
});
client.on(Events.MessageBulkDelete,async messages=>{const m=messages.first();if(!m||m.guildId!==String(cfg.guildId))return;await log('messages','Bulk Delete Messages',[`**In:** ${chMention(m.channelId)}`,`**Count:** ${messages.size}`],{icon:'message_delete'});});
client.on(Events.MessageReactionAdd,async(reaction,user)=>{try{if(reaction.partial)await reaction.fetch();if(reaction.message.guildId!==String(cfg.guildId)||user.bot)return;const m=reaction.message;await log('reactions','Reaction Add',[`**Message:** [Click Here](${m.url})`,`**In:** ${chMention(m.channelId)}`,`**By:** ${mention(user.id)}`,`**Reaction:** ${reaction.emoji.toString()}`],{icon:'reaction',subject:user});}catch(e){console.warn('Reaction:',e.message)}});
client.on(Events.GuildMemberAdd,async m=>{if(!guildOnly(m.guild))return;let code='Unknown';try{const inv=await m.guild.invites.fetch();for(const i of inv.values()){if((i.uses||0)>(inviteCache.get(i.code)||0))code=i.code;inviteCache.set(i.code,i.uses||0)}}catch{}await log('members','User Join',[`**User:** ${mention(m.id)}`,`**Created:** <t:${Math.floor(m.user.createdTimestamp/1000)}:R>`,`**Invite:** ${code}`],{icon:'verified',subject:m});});
client.on(Events.GuildMemberRemove,async m=>{if(!guildOnly(m.guild))return;const a=await audit(m.guild,AuditLogEvent.MemberKick,m.id,5000);await log('members',a?'Kick Member':'User Leave',[`**User:** ${mention(m.id)}`,`**By:** ${a?by(a):'Left / unknown'}`],{icon:a?'ban':'voice_leave',subject:m});});
client.on(Events.GuildMemberUpdate,async(o,n)=>{
 if(!guildOnly(n.guild))return;
 if(o.nickname!==n.nickname){const a=await audit(n.guild,AuditLogEvent.MemberUpdate,n.id);await log('members','Change Nickname',[`**To:** ${mention(n.id)}`,`**By:** ${by(a)}`,`**Old:** ${limit(o.nickname||o.user.username)}`,`**New:** ${limit(n.nickname||n.user.username)}`],{icon:'nickname',subject:n});}
 const added=n.roles.cache.filter(r=>!o.roles.cache.has(r.id));const removed=o.roles.cache.filter(r=>!n.roles.cache.has(r.id));
 if(added.size||removed.size){const a=await audit(n.guild,AuditLogEvent.MemberRoleUpdate,n.id);const lines=[`**To:** ${mention(n.id)}`,`**By:** ${by(a)}`,...added.map(r=>`✅ Added: ${r.name} (${r.id})`),...removed.map(r=>`❌ Removed: ${r.name} (${r.id})`)];await log('roles','Edit Member',lines,{icon:'member_edit',subject:n});}
 if(o.communicationDisabledUntilTimestamp!==n.communicationDisabledUntilTimestamp){const active=n.communicationDisabledUntilTimestamp>Date.now();const a=await audit(n.guild,AuditLogEvent.MemberUpdate,n.id);await log('moderation',active?'Timeout Member':'Timeout Removed',[`**To:** ${mention(n.id)}`,`**By:** ${by(a)}`,`**Until:** ${active?`<t:${Math.floor(n.communicationDisabledUntilTimestamp/1000)}:F>`:'Removed'}`,`**Reason:** ${limit(a?.reason||'No reason provided')}`],{icon:'timeout',subject:n});}
});
client.on(Events.GuildBanAdd,async b=>{if(!guildOnly(b.guild))return;const a=await audit(b.guild,AuditLogEvent.MemberBanAdd,b.user.id);await log('moderation','Ban Member',[`**To:** ${mention(b.user.id)}`,`**By:** ${by(a)}`,`**Reason:** ${limit(a?.reason||'No reason provided')}`],{icon:'ban',subject:b.user});});
client.on(Events.GuildBanRemove,async b=>{if(!guildOnly(b.guild))return;const a=await audit(b.guild,AuditLogEvent.MemberBanRemove,b.user.id);await log('moderation','Unban Member',[`**To:** ${mention(b.user.id)}`,`**By:** ${by(a)}`],{icon:'verified',subject:b.user});});
client.on(Events.ChannelCreate,async c=>{if(!guildOnly(c.guild))return;const a=await audit(c.guild,AuditLogEvent.ChannelCreate,c.id);await log('channels','Create Channel',[`**Channel:** ${chMention(c.id)}`,`**By:** ${by(a)}`,`**Type:** ${c.type}`,`**Reason:** ${limit(a?.reason||'No Reason')}`],{icon:'create'});});
client.on(Events.ChannelDelete,async c=>{if(!guildOnly(c.guild))return;const a=await audit(c.guild,AuditLogEvent.ChannelDelete,c.id);await log('channels','Delete Channel',[`**Channel:** ${limit(c.name)}`,`**By:** ${by(a)}`,`**Type:** ${c.type}`],{icon:'delete'});});
client.on(Events.ChannelUpdate,async(o,n)=>{if(!guildOnly(n.guild))return;const changes=[];for(const k of ['name','topic','nsfw','rateLimitPerUser','parentId'])if(o[k]!==n[k])changes.push(`**${k}:** ${limit(o[k],200)} → ${limit(n[k],200)}`);if(o.permissionOverwrites?.cache&&n.permissionOverwrites?.cache){for(const [id,now] of n.permissionOverwrites.cache){const before=o.permissionOverwrites.cache.get(id);if(!before||before.allow.bitfield!==now.allow.bitfield||before.deny.bitfield!==now.deny.bitfield)changes.push(`**Overwrite ${id}:** Allow: ${perms(now.allow)} | Deny: ${perms(now.deny)}`)}for(const id of o.permissionOverwrites.cache.keys())if(!n.permissionOverwrites.cache.has(id))changes.push(`**Removed overwrite:** ${id}`)}if(!changes.length)return;const a=await audit(n.guild,AuditLogEvent.ChannelUpdate,n.id);await log('channels','Edit Channel',[`**Channel:** ${chMention(n.id)}`,`**By:** ${by(a)}`,...changes.slice(0,12)],{icon:'edit'});});
client.on(Events.GuildRoleCreate,async r=>{if(!guildOnly(r.guild))return;const a=await audit(r.guild,AuditLogEvent.RoleCreate,r.id);await log('roles','Create Role',[`**Role:** ${r.name}`,`**By:** ${by(a)}`],{icon:'create'});});
client.on(Events.GuildRoleDelete,async r=>{if(!guildOnly(r.guild))return;const a=await audit(r.guild,AuditLogEvent.RoleDelete,r.id);await log('roles','Delete Role',[`**Role:** ${r.name}`,`**By:** ${by(a)}`],{icon:'delete'});});
client.on(Events.GuildRoleUpdate,async(o,n)=>{if(!guildOnly(n.guild))return;const changes=[];for(const k of ['name','color','hoist','mentionable','position'])if(o[k]!==n[k])changes.push(`**${k}:** ${o[k]} → ${n[k]}`);const added=n.permissions.remove(o.permissions).toArray();const removed=o.permissions.remove(n.permissions).toArray();if(added.length)changes.push('🟩 Added permissions: '+added.join(', '));if(removed.length)changes.push('🟥 Removed permissions: '+removed.join(', '));if(!changes.length)return;const a=await audit(n.guild,AuditLogEvent.RoleUpdate,n.id);await log('roles','Edit Role',[`**Role:** ${n.name}`,`**By:** ${by(a)}`,...changes],{icon:'edit'});});
client.on(Events.InviteCreate,async i=>{if(!guildOnly(i.guild))return;inviteCache.set(i.code,i.uses||0);await log('invites','Create Invite',[`**By:** ${mention(i.inviterId)}`,`**Code:** ${i.code}`,`**Max Uses:** ${i.maxUses||'No Limit'}`,`**Ends:** ${i.expiresTimestamp?`<t:${Math.floor(i.expiresTimestamp/1000)}:R>`:'Never'}`,`**Temporary:** ${i.temporary}`,`**In:** ${chMention(i.channelId)}`],{icon:'invite'});});
client.on(Events.InviteDelete,async i=>{if(!guildOnly(i.guild))return;inviteCache.delete(i.code);await log('invites','Delete Invite',[`**Code:** ${i.code}`,`**In:** ${chMention(i.channelId)}`],{icon:'delete'});});
client.on(Events.VoiceStateUpdate,async(o,n)=>{
 if(!guildOnly(n.guild))return;
 const m=n.member||o.member;if(!m)return;
 if(o.channelId!==n.channelId){
  if(o.channelId&&n.channelId){const a=await audit(n.guild,AuditLogEvent.MemberMove,null,4500);const admin=false; /* Voice audit records cannot reliably identify the affected member. */await log('voice',admin?'Move Member':'Change Channel',[`**${admin?'To':'User'}:** ${mention(m.id)}`,...(admin?[`**By:** ${by(a)}`]:[]),`**From:** ${chMention(o.channelId)}`,`**To:** ${chMention(n.channelId)}`],{icon:admin?'voice_move':'voice_change',subject:m});}
  else if(n.channelId){await log('voice','Join Channel',[`**User:** ${mention(m.id)}`,`**To:** ${chMention(n.channelId)}`,`**Members:** ${[...(n.channel?.members?.values?.()||[])].map(x=>limit(memberName(x),70)).join(', ')||'None'}`],{icon:'voice_join',subject:m});}
  else {const a=await audit(n.guild,AuditLogEvent.MemberDisconnect,null,4500);const admin=false; /* Voice audit records cannot reliably identify the affected member. */const image=admin?await snapshot(o.channel,'Disconnected',m):null;await log('voice',admin?'Disconnect Member':'Leave Channel',[`**User:** ${mention(m.id)}`,...(admin?[`**By:** ${by(a)}`]:[]),`**From:** ${chMention(o.channelId)}`,`**Members:** ${[...(o.channel?.members?.values?.()||[])].map(x=>limit(memberName(x),70)).join(', ')||'No Members In Channel'}`],{icon:admin?'disconnect':'voice_leave',subject:m,image});}
 }
 if(o.serverMute!==n.serverMute){const a=await audit(n.guild,AuditLogEvent.MemberUpdate,m.id,5000);const image=await snapshot(n.channel||o.channel,n.serverMute?'Muted':'Unmuted',m);await log('voice',n.serverMute?'Mute Member':'UnMute Member',[`**To:** ${mention(m.id)}`,`**By:** ${by(a)}`,`**In:** ${chMention(n.channelId||o.channelId)}`],{icon:n.serverMute?'disconnect':'voice',subject:m,image});}
});
client.on(Events.Error,e=>console.error('Discord:',e));
process.on('unhandledRejection',e=>console.error('Unhandled:',e));
client.login(cfg.token).catch(e=>{console.error('Login failed:',e.message);process.exitCode=1});
