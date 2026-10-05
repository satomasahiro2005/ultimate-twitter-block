'use strict';

// Our own entry for x-web's client, made from x-web's logged-out entry module.
//
// x-web ships one entry per audience; only the logged-out one is served to us.
// It boots the real app: TanStack router with x-web's full route tree, Relay,
// i18n, React. We keep all of that and change only what makes it the
// logged-out entry:
//   1. isAuthenticated: false -> true when the page has a (fake or real) session
//   2. mount x-web's own ViewerProvider with the viewer, as the logged-in
//      entry does (the logged-out entry never mounts it, so every component
//      sees "not logged in")
//   3. hand the Relay environment to the harness runtime (runtime/resolver.js),
//      which answers x-web's GraphQL from local data
//   4. render on the client: there is no server, so the router starts with no
//      dehydrated matches and loads the current route itself
// Nothing touches appMetadata.isTwoffice or any feature switch; the staff-only
// layout route (/_wip-logged-in) stays gated exactly as shipped.

const fs = require('fs');
const path = require('path');

const BUNDLE_VERSION = 'd8a521fb74c4c5d537d94765402e69876cfd2af0';
const ENTRY_FILE = 'entry-client-logged-out-CTyqM7Ot.js';
const STYLES_FILE = 'styles-D1dANTrS.css';
const VIEWER_CHUNK = './assets/viewer-BM-Jx7Qb.js';

// [find, replace] applied to the minified entry. Each must match exactly once
// (or the stated count), so a new x-web build fails loudly instead of silently.
function patches(opts) {
  const list = [
    // (3) Relay environment -> harness runtime
    ['Pn=k({serverRequests:Mn,onSsrQueryCacheEvent:Y})', 'Pn=XWH_RT.hookEnvironment(k({serverRequests:Mn,onSsrQueryCacheEvent:Y}))', 1],
    // expose the router for the harness (navigation between screens, waiting for idle)
    ['Re(()=>X.options.context.featureSwitches)', 'XWH_RT.router=X;Re(()=>X.options.context.featureSwitches)', 1],
  ];
  if (opts.loggedIn) {
    // (1) both the router context and the app-shell preload say "logged out"
    list.push(['isAuthenticated:!1', 'isAuthenticated:!0', 2]);
    // (2) ViewerProvider around the router, viewer from XWH_RT.viewer
    list.push([
      '(0,K.jsx)(W.StrictMode,{children:(0,K.jsx)(m,{router:X})})',
      '(0,K.jsx)(W.StrictMode,{children:(0,K.jsx)(XwhViewerProvider,{viewerId:XWH_RT.viewer.userId,viewer:XWH_RT.viewer,children:(0,K.jsx)(m,{router:X})})})',
      1,
    ]);
  }
  return list;
}

function readBundleFile(bundleDir, name) {
  return fs.readFileSync(path.join(bundleDir, name), 'utf8');
}

// Returns the patched entry module source. It is served at
// https://abs.twimg.com/x-web/x-web/<name> so its relative imports
// ("./assets/...") resolve to x-web's own chunk URLs.
function buildEntry(bundleDir, opts) {
  let src = readBundleFile(bundleDir, ENTRY_FILE);
  for (const [find, repl, count] of patches(opts)) {
    const n = src.split(find).length - 1;
    if (n !== count) throw new Error(`x-web entry patch expected ${count} match(es) of ${JSON.stringify(find.slice(0, 60))}, found ${n}. The bundle changed; update xweb/entry.js.`);
    src = src.split(find).join(repl);
  }
  if (opts.loggedIn) {
    // ES imports must be at top level: add ours after the entry's own first import
    const at = src.indexOf('import{');
    if (at < 0) throw new Error('x-web entry: no import statement found');
    src = src.slice(0, at) + `import{t as XwhViewerProvider}from"${VIEWER_CHUNK}";` + src.slice(at);
  }
  return src;
}

// The page x.com would serve, minus SSR: x-web's <html> attributes, the
// stylesheet, __INITIAL_DATA__ (from the logged-out capture; for a session we
// add viewerId/viewerScreenName as the server does), an empty TanStack
// stream bootstrap, the harness runtime + data, then the entry.
function buildHtml(o) {
  const initial = {
    appMetadata: { appEnvironment: 'prod', observabilityEnvironment: 'production', appVersion: BUNDLE_VERSION, country: 'US', isTwoffice: false },
    featureSwitchPayload: o.featureSwitchPayload || { features: {}, impressionPointers: {}, impressions: {}, settingsVersion: 'xwh' },
  };
  if (o.viewer) {
    initial.viewerId = o.viewer.userId;
    initial.viewerScreenName = o.viewer.screenName;
  }
  const theme = o.theme || 'light';
  return `<!DOCTYPE html><html lang="${o.lang || 'en'}" dir="ltr" data-theme="${theme}" data-app-env="prod" data-app-version="${BUNDLE_VERSION}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=0,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<link rel="stylesheet" href="https://abs.twimg.com/x-web/x-web/assets/${STYLES_FILE}">
<title>X</title>
<script>window.__INITIAL_DATA__=${JSON.stringify(initial)};</script>
<script>self.$R=self.$R||{};self.$R.tsr=[];self.$_TSR={h(){this.hydrated=!0},e(){this.streamEnded=!0},c(){},p(e){this.initialized?e():this.buffer.push(e)},buffer:[],router:{manifest:void 0,matches:[]}};</script>
${(o.scripts || []).map((s) => `<script>${s.replace(/<\/script/gi, '<\\/script')}</script>`).join('\n')}
<script type="module" src="https://abs.twimg.com/x-web/x-web/${o.entryName || 'xwh-entry.js'}"></script>
</head><body></body></html>`;
}

module.exports = { buildEntry, buildHtml, BUNDLE_VERSION, ENTRY_FILE, STYLES_FILE };
