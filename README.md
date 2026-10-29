# NHQM Logs — Single-server Discord logging bot

JavaScript / discord.js v14. Includes **19 original PNG icons** supplied by the project owner. Uses `setThumbnail()` with local attachments and `setImage()` for voice-room snapshot PNGs.

## Installation (Windows / Node.js 20+)
1. Extract ZIP and open a terminal in the `NHQM-Logs` folder.
2. Run `npm install`.
3. Open `config.json`, set `token`, `guildId`, and the destination channel IDs in `logs`. You can reuse one channel ID across categories. Keep `config.json` private; it's gitignored.
4. In Discord Developer Portal enable **Server Members Intent** and **Message Content Intent**. Enable permissions to **View Channels**, **Send Messages**, **Embed Links**, **Attach Files**, **Read Message History**, **View Audit Log**, and **Manage Guild** (for invite lookup, as applicable). Make sure bot can access all destination channels.
5. Run `npm start`.

## Logged events
- Members: joins, leaves/kicks, nickname changes, role changes.
- Moderation: bans/unbans, timeout changes.
- Messages: deletions (cached message content when available), bulk deletions, reactions added.
- Channels: create, delete, edits including permission overwrites.
- Roles: create, delete, edit including added/removed permissions.
- Invites: created, deleted, invite code used for member joins when available.
- Voice: join, leave, channel changes, probable moderator moves/disconnects, server mute/unmute.

## Important limitations
- Discord embeds **cannot** set a custom solid background color; Discord determines the background. The left border color and images are customizable.
- `Audit Logs` are delayed and sometimes ambiguous. `By` is displayed as unknown if a reliable match cannot be found. Voice moves/disconnects are best-effort and can be misclassified if multiple events occur together. Never use these logs alone for disciplinary decisions.
- Voice snapshots are **generated representations**, not Discord screenshots. They list visible members and states from the gateway at event time. They are only attached to probable moderator disconnects and server mute/unmute.
- Message content deleted before bot startup or not cached may be unavailable. Deletion attribution is best effort.
- For exact icons for mute/unmute, provide separate mic icon files; current package uses supplied speaker/disconnect icons as fallback.
- Custom server-specific events such as BlackList, custom AdminRole panels, or application-specific 'Edit Member' actions cannot be inferred from ordinary Discord events; integration with those custom systems is required.
- The token is in `config.json` as requested; never upload the configured file to a public repository. Prefer env-based secrets in production.
