// x-web harness, live mode: boots x-web's real client in this tab (MAIN world,
// injected as the page starts loading; the dev extension holds back the classic
// app's scripts for this tab). Same entry as fixture mode (xweb/entry.js), but
// the data is the user's, read through the classic app's operations
// (live/page/reader.js), and further reads happen on demand as x-web asks.
// eslint-disable-next-line no-unused-vars
function xwhBoot(data, urls) {
  'use strict';
  if (window.__xwhBooted) return;
  window.__xwhBooted = true;
  const X = window.XWH;
  const RT = window.XWH_RT;
  const model = X.reader.ensureShape(data.model);
  const viewer = window.XWH_GRAPH.viewerOf(model);

  // What x.com's server puts in a logged-in x-web page (see xweb/entry.js)
  window.__INITIAL_DATA__ = {
    appMetadata: { appEnvironment: 'prod', observabilityEnvironment: 'production', appVersion: urls.version, country: 'US', isTwoffice: false },
    featureSwitchPayload: { features: {}, impressionPointers: {}, impressions: {}, settingsVersion: 'xwh-live' },
    viewerId: viewer ? viewer.userId : undefined,
    viewerScreenName: viewer ? viewer.screenName : undefined,
  };
  self.$R = self.$R || {};
  self.$R.tsr = [];
  self.$_TSR = { h() { this.hydrated = true; }, e() { this.streamEnded = true; }, c() {}, p(e) { if (this.initialized) e(); else this.buffer.push(e); }, buffer: [], router: { manifest: undefined, matches: [] } };

  model.fetch = X.reader.makeReader(data.discovered, model);
  RT.root = window.XWH_GRAPH.build(model).root;
  RT.viewer = viewer;
  RT.model = model;
  RT.installFetch();

  function start() {
    const html = document.documentElement;
    const theme = /(?:^|; )night_mode=(1|2)/.test(document.cookie) ? 'dark' : 'light';
    html.setAttribute('lang', html.getAttribute('lang') || 'en');
    html.setAttribute('dir', 'ltr');
    html.setAttribute('data-theme', theme);
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = urls.css;
    (document.head || html).appendChild(css);
    const s = document.createElement('script');
    s.type = 'module';
    s.src = urls.entry;
    (document.head || html).appendChild(s);
  }
  if (document.documentElement) start();
  else document.addEventListener('readystatechange', start, { once: true });
}
