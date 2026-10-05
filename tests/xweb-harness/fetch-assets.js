#!/usr/bin/env node
'use strict';

// One-time download of the x-web client bundle the harness runs, into
// tests/xweb-harness/.cache/ (git-ignored). These are X's public static files
// (the same ones any logged-out visitor's browser downloads from
// abs.twimg.com): the logged-out entry module, every chunk reachable from it,
// the stylesheet, and the Chirp fonts. No cookies, no account, no API calls.
// Harness runs never touch the network; they serve these cached copies.
//
//   node tests/xweb-harness/fetch-assets.js              crawl the pinned build from abs.twimg.com
//   node tests/xweb-harness/fetch-assets.js --from DIR   copy from a local folder of the same files
//
// The build is pinned (xweb/entry.js names its entry file and patches it);
// a new x-web build needs a new pin and a check of those patches.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { ENTRY_FILE, STYLES_FILE } = require('./xweb/entry.js');

const BASE = 'https://abs.twimg.com/x-web/x-web/';
const CACHE = path.join(__dirname, '.cache');
const BUNDLE = path.join(CACHE, 'bundle');
const FONTS = path.join(CACHE, 'fonts');

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'Mozilla/5.0 (xweb-harness asset fetch)' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(url + ' -> HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// chunk names referenced from a module: "./assets/x-HASH.js", "./x-HASH.js"
function refs(src) {
  const out = new Set();
  const re = /["'`(]\.{0,2}\/?((?:assets\/)?[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(?:js|png|svg|webp|jpg))/g;
  let m;
  while ((m = re.exec(src))) out.add(path.basename(m[1]));
  return out;
}

async function crawl() {
  const queue = [ENTRY_FILE];
  const seen = new Set();
  let fetched = 0;
  while (queue.length) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const dest = path.join(BUNDLE, name);
    if (!fs.existsSync(dest)) {
      const url = name === ENTRY_FILE ? BASE + name : BASE + 'assets/' + name;
      try {
        fs.writeFileSync(dest, await get(url));
        fetched++;
      } catch (err) {
        console.warn('skip ' + name + ': ' + err.message);
        continue;
      }
    }
    if (name.endsWith('.js')) for (const r of refs(fs.readFileSync(dest, 'utf8'))) if (!seen.has(r)) queue.push(r);
  }
  const cssDest = path.join(BUNDLE, STYLES_FILE);
  if (!fs.existsSync(cssDest)) fs.writeFileSync(cssDest, await get(BASE + 'assets/' + STYLES_FILE));
  console.log(`bundle: ${seen.size} modules (${fetched} downloaded) + ${STYLES_FILE}`);
}

function copyFrom(dir) {
  let n = 0;
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      if (/\.(js|css)$/.test(name)) { fs.copyFileSync(full, path.join(BUNDLE, name)); n++; }
      else if (/\.woff2$/.test(name)) fs.copyFileSync(full, path.join(FONTS, name));
    }
  };
  walk(dir);
  console.log(`bundle: copied ${n} files from ${dir}`);
}

async function fonts() {
  const css = fs.readFileSync(path.join(BUNDLE, STYLES_FILE), 'utf8');
  const urls = [...new Set(css.match(/https:\/\/abs\.twimg\.com\/fonts\/[^)"']+\.woff2/g) || [])]
    .filter((u) => /\.(latin|latin-ext|symbols)\.woff2$/.test(u));
  let n = 0;
  for (const u of urls) {
    const dest = path.join(FONTS, path.basename(u));
    if (fs.existsSync(dest)) continue;
    try { fs.writeFileSync(dest, await get(u)); n++; } catch (err) { console.warn('font ' + path.basename(u) + ': ' + err.message); }
  }
  console.log(`fonts: ${urls.length} (${n} downloaded)`);
}

async function main() {
  fs.mkdirSync(BUNDLE, { recursive: true });
  fs.mkdirSync(FONTS, { recursive: true });
  fs.writeFileSync(path.join(CACHE, '.gitignore'), '*\n');
  const i = process.argv.indexOf('--from');
  if (i > 0) copyFrom(path.resolve(process.argv[i + 1]));
  else await crawl();
  if (!fs.existsSync(path.join(BUNDLE, ENTRY_FILE))) throw new Error('entry ' + ENTRY_FILE + ' missing after fetch');
  if (!fs.existsSync(path.join(BUNDLE, STYLES_FILE))) throw new Error(STYLES_FILE + ' missing after fetch');
  if (process.argv.indexOf('--no-fonts') < 0) await fonts();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
