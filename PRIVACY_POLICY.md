# Privacy Policy - Ultimate Twitter Block

Last updated: August 18, 2026

## Data Collection

This extension does **not** collect, transmit, or share any personal data with external servers.
It talks to no server other than x.com itself, using your existing signed-in session.

## Data Stored Locally

The following data is stored locally on your device using `chrome.storage.local`
(the userscript build stores the same things in `localStorage`):

- **Block/mute history**: the usernames (handles) you have blocked or muted through this
  extension, and which of the two states apply. This is what lets the extension keep a post
  collapsed after you act on it, and offer an undo button.
- **Statistics**: count of blocks and mutes performed (numbers only)
- **Settings**: your button display preferences and confirmation/reload options
- **Icons**: cached SVG icon data extracted from Twitter's own menus
- **Accent color**: the theme color read from the page, used for the toast notification

This data never leaves your device.

## Website Content Access

This extension accesses Twitter (x.com) page content solely to:

- Add block and mute buttons to the Twitter interface
- Extract icon SVGs from Twitter's native menus
- Read authentication tokens from your existing Twitter session to perform block/mute actions
  on your behalf

No website content is collected, stored, or transmitted to any third party.

## Actions Performed on Your Behalf

All requests go to `https://x.com/i/api/1.1/` using your existing session:

- `blocks/create.json`, `blocks/destroy.json`, `mutes/users/create.json`,
  `mutes/users/destroy.json` — when you press a block/mute button
- `friendships/show.json` — to check whether you follow someone, for the
  "confirm before blocking followed users" setting

## Third-Party Services

This extension does not use any analytics, tracking, or third-party services.

## Contact

If you have questions about this privacy policy, contact us at:

- Twitter: [@ainemut](https://x.com/ainemut)
