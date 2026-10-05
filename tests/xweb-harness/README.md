# x-web harness

X's new web frontend, x-web, is served today only to logged-out visitors. Its client bundle already contains the logged-in screens: home, Following/Followers lists, notifications, the blocked/muted lists and hover cards. X just doesn't serve them to normal accounts. This harness runs that real client offline so the extension can be tested on every screen, logged in or out, at any width.

## How it works

- **x-web's own code.** `fetch-assets.js` caches the public x-web bundle once: the logged-out entry, about 1,070 chunks, the stylesheet and the Chirp fonts. These are the same static files any logged-out visitor downloads.
- **Our entry.** `xweb/entry.js` patches a copy of the logged-out entry in four ways:
  - `isAuthenticated: true`
  - mount x-web's own `ViewerProvider`, as the logged-in entry would
  - hand the Relay environment to our runtime
  - render on the client, with no SSR, so the router loads the route itself

  Every patch must match exactly, so a new x-web build fails loudly. Nothing sets `isTwoffice` or any feature switch. The staff-only `/_wip-logged-in` layout stays gated, which is why the page frame is the logged-out frame (sign-in box in the sidebar) even on logged-in screens. The main column and sidebar modules are the logged-in ones.
- **Data.** `runtime/resolver.js` answers x-web's GraphQL in the page. Every query x-web sends reaches the Relay environment together with its full operation AST. The resolver walks that AST over a plain object graph (`data/xweb-graph.js`, built from `data/fixtures.js`), so a new screen needs data, not response templates. Fields the graph lacks come back `null` and are counted in `XWH_RT.misses`.
- **Network.** puppeteer request interception serves the bundle, fonts and placeholder images. It answers the extension's own `/i/api/` calls with `{}` and records them. It swallows x-web telemetry (Sentry, scribe). Any other request is aborted and fails the run. Chrome's DNS is also pointed at nothing (`--host-resolver-rules`), so nothing can reach X.
- **Extension.** Each run uses a fresh Chrome profile with the unpacked extension installed, on `https://x.com/...` URLs, so `content.js` runs exactly as it does on x.com.

## Run

```
node tests/xweb-harness/fetch-assets.js                       # once
node tests/xweb-harness/run.js --list                         # shots and their x.com paths
node tests/xweb-harness/run.js                                # every shot at 1280px and 420px (~2 min)
node tests/xweb-harness/run.js --shot following --width 420
node tests/xweb-harness/run.js --no-extension                 # x-web alone
node tests/xweb-harness/run.js --extension-path DIR           # another build, e.g. before/after
node tests/xweb-harness/run.js --dump-ops DIR                 # save the GraphQL ASTs x-web sent
node tests/xweb-harness/tools/ast-fields.js DIR User Tweet    # which fields x-web reads, per type
```

Each shot writes three files to `out/` (or `--out DIR`):
- `<shot>@<width>.png`: a full-page screenshot.
- `.html`: a DOM snapshot.
- `.json`: where every `.twblock-btn-container` landed relative to x-web's own control (⋯ of a post, or Follow in a user row, profile header or hover card). It records the vertical-centre offset, gap, overlap and clipping. The same file also lists the GraphQL operations served, the misses, and any unserved requests.

Shots, all logged in unless marked:

| shot | path |
|---|---|
| home | /home |
| profile (+ logged-out) | /fake_alice |
| profile-self / -blocked / -protected | /fake_me, /fake_frank, /fake_erin |
| following, followers, verified-followers | /fake_me/... |
| following-other | /fake_alice/following |
| tweet-detail (+ logged-out) | /fake_alice/status/... |
| search-top, search-people | /search?q=fake... |
| notifications | /notifications |
| blocked, muted | /settings/blocked/all, /settings/muted/all (x-web opens them as modals over /home) |
| connect | /i/connect_people |
| hovercard (+ logged-out) | /fake_alice, then a real hover on a post author's avatar |

From a test (`tests/dom.test.js` does this, and skips if the bundle isn't cached):

```js
const H = require('./xweb-harness/run.js');
const browser = await H.launch();                      // fresh profile + unpacked extension
const { page } = await H.openShot(browser, 'following', { width: 420 });
const report = await H.measure(page);
```

## Live mode: your own account in x-web

This mode shows a logged-in x.com tab in the real x-web client with your own data, so you can try the extension by hand on screens X doesn't serve you yet.

```
node tests/xweb-harness/fetch-assets.js     # once
node tests/xweb-harness/live/build.js       # assembles live/extension (bundle + page scripts)
```

1. Go to `chrome://extensions` and choose "Load unpacked" for `tests/xweb-harness/live/extension`. Ultimate Twitter Block stays installed next to it.
2. Use x.com as usual for a moment. The dev extension passively records the classic app's own GraphQL requests: the operation ids and features, plus the responses it already got.
3. Click the dev extension's toolbar button on an x.com tab. It does four things:
   - reads your profile through the classic app's operations
   - holds back the classic app's scripts for that tab
   - reloads the tab
   - boots x-web from the bundle inside the dev extension

   The badge shows `XW`. Navigate inside x-web as you like. When x-web asks for something not yet loaded (a Following list, a profile, notifications, a post), the page reads it through the classic operation and then answers.
4. Click again to go back to the classic app.

How live mode handles the network:
- **Reads only.** Reads go to `x.com/i/api/graphql/...` with your tab's session, exactly as the classic app's do. Live mode never sends a GraphQL mutation. x-web's own mutations (like, follow from x-web's buttons) are answered with an error in the page and never sent.
- **x-web's own traffic is blocked for that tab.** That covers `api.x.com`, Sentry, and the Google/Apple sign-in SDKs of its logged-out frame. x-web's GraphQL is answered in the page.
- **The extension's buttons are real.** Ultimate Twitter Block's block/mute buttons call the real API when you click them.
- **Service worker.** Switching on unregisters x.com's service worker so the reload comes from the network. x.com registers it again on its next normal load.

If a screen says an operation is unknown ("open Notifications once in the classic UI"), the classic app hasn't made that request in this tab yet. Switch back, open that screen once, then switch again.

`node tests/xweb-harness/live/selftest.js` tests all of this offline. It uses a fake classic x.com (`live/classic-fake.js` answers with classic-shaped responses built from the fixtures) and installs both extensions. It switches to x-web, navigates to Following, a profile and Notifications (each triggering its on-demand read), and switches back. It also checks that only reads were sent and that nothing went unserved.

## Limits

- The bundle is pinned to build `d8a521fb` (2026-10-06). When X ships a new build, re-fetch it and update the file names and patches in `xweb/entry.js`. The patches fail loudly if they no longer match.
- The page frame is x-web's logged-out frame, because the logged-in layout is staff-gated (see above). Left nav, account switcher and the logged-in phone top bar are therefore not shown.
- The fake graph covers what these screens read (live mode fills the same graph from the classic app). Video, cards, polls, Spaces, communities and lists are mostly `null`, and x-web renders them as missing.
- The logged-in DOM comes from x-web's own code running with fake data, not from a page X served to a logged-in account, because X does not serve one.
