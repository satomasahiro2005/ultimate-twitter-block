#!/usr/bin/env node
'use strict';

// Assemble the live-mode dev extension in tests/xweb-harness/live/extension:
//   page/   our page-world scripts (tap, collect, reader, boot, resolver, graph, adapter)
//   xweb/   x-web's cached bundle (fetch-assets.js) + our entry (xweb/entry.js, logged in)
//   xweb-info.js
// Then load it unpacked in chrome://extensions (next to Ultimate Twitter Block).
//
//   node tests/xweb-harness/live/build.js

const fs = require('fs');
const path = require('path');
const { buildEntry, BUNDLE_VERSION, STYLES_FILE } = require('../xweb/entry.js');

const HERE = path.join(__dirname, '..');
const EXT = path.join(__dirname, 'extension');
const BUNDLE = path.join(HERE, '.cache', 'bundle');

const PAGE = {
  'tap.js': 'live/page/tap.js',
  'collect.js': 'live/page/collect.js',
  'reader.js': 'live/page/reader.js',
  'boot.js': 'live/page/boot.js',
  'resolver.js': 'runtime/resolver.js',
  'xweb-graph.js': 'data/xweb-graph.js',
  'classic-adapter.js': 'data/classic-adapter.js',
};

function build() {
  if (!fs.existsSync(path.join(BUNDLE, STYLES_FILE))) throw new Error('x-web bundle missing: run node tests/xweb-harness/fetch-assets.js');
  fs.mkdirSync(path.join(EXT, 'page'), { recursive: true });
  for (const [dest, src] of Object.entries(PAGE)) fs.copyFileSync(path.join(HERE, src), path.join(EXT, 'page', dest));

  const assets = path.join(EXT, 'xweb', 'assets');
  fs.mkdirSync(assets, { recursive: true });
  let n = 0;
  for (const name of fs.readdirSync(BUNDLE)) {
    const dest = path.join(assets, name);
    const src = path.join(BUNDLE, name);
    if (!fs.existsSync(dest) || fs.statSync(dest).size !== fs.statSync(src).size) { fs.copyFileSync(src, dest); n++; }
  }
  fs.writeFileSync(path.join(EXT, 'xweb', 'xwh-entry.js'), buildEntry(BUNDLE, { loggedIn: true }));
  fs.writeFileSync(path.join(EXT, 'xweb-info.js'), 'self.XWEB = ' + JSON.stringify({ styles: STYLES_FILE, version: BUNDLE_VERSION }) + ';\n');
  console.log('live extension: ' + EXT + ' (' + n + ' bundle files updated)');
  return EXT;
}

if (require.main === module) build();
module.exports = { build, EXT };
