#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;

// ---- Helpers ----
function readFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function getVersion() {
  const manifest = JSON.parse(readFile('manifest.json'));
  return manifest.version;
}

// ============================================================
// ZIP
// ============================================================
function buildZip() {
  const version = getVersion();
  const outName = `twitter-block-v${version}.zip`;
  const outPath = path.join(ROOT, outName);

  // Files and directories to include
  const entries = [
    'manifest.json',
    'content.js',
    'pageScript.js',
    'styles.css',
    'background.js',
    'popup.html', 'popup.js', 'popup.css',
    'options.html', 'options.js', 'options.css',
    'LICENSE',
    'README.md',
    'PRIVACY_POLICY.md',
  ];

  // Collect all files (including directories)
  const files = [];
  for (const entry of entries) {
    const full = path.join(ROOT, entry);
    if (!fs.existsSync(full)) continue;
    files.push(entry);
  }

  // Add icons/ and _locales/ recursively
  for (const dir of ['icons', '_locales']) {
    const dirPath = path.join(ROOT, dir);
    if (!fs.existsSync(dirPath)) continue;
    (function walk(d, rel) {
      for (const name of fs.readdirSync(d)) {
        const full = path.join(d, name);
        const r = rel + '/' + name;
        if (fs.statSync(full).isDirectory()) {
          walk(full, r);
        } else {
          files.push(r);
        }
      }
    })(dirPath, dir);
  }

  // Build ZIP using Node.js built-in zlib (manual ZIP construction)
  const zlib = require('zlib');
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const file of files) {
    const filePath = path.join(ROOT, file);
    const data = fs.readFileSync(filePath);
    const compressed = zlib.deflateRawSync(data);
    const nameBuffer = Buffer.from(file.replace(/\\/g, '/'), 'utf8');

    const stat = fs.statSync(filePath);
    const date = stat.mtime;
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

    // CRC-32
    const crc = crc32(data);

    // Local file header
    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0);   // signature
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(8, 8);             // compression: deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);            // extra field length
    nameBuffer.copy(local, 30);

    localHeaders.push(Buffer.concat([local, compressed]));

    // Central directory header
    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0);  // signature
    central.writeUInt16LE(20, 4);           // version made by
    central.writeUInt16LE(20, 6);           // version needed
    central.writeUInt16LE(0, 8);            // flags
    central.writeUInt16LE(8, 10);           // compression
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);           // extra field length
    central.writeUInt16LE(0, 32);           // file comment length
    central.writeUInt16LE(0, 34);           // disk number start
    central.writeUInt16LE(0, 36);           // internal attributes
    central.writeUInt32LE(0, 38);           // external attributes
    central.writeUInt32LE(offset, 42);      // local header offset
    nameBuffer.copy(central, 46);

    centralHeaders.push(central);
    offset += local.length + compressed.length;
  }

  const centralDirOffset = offset;
  const centralDirSize = centralHeaders.reduce((s, b) => s + b.length, 0);

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                // disk number
  eocd.writeUInt16LE(0, 6);                // disk with central dir
  eocd.writeUInt16LE(files.length, 8);     // entries on this disk
  eocd.writeUInt16LE(files.length, 10);    // total entries
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20);               // comment length

  const zipBuffer = Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
  fs.writeFileSync(outPath, zipBuffer);
  console.log(`ZIP: ${outName} (${files.length} files, ${zipBuffer.length} bytes)`);
}

// CRC-32 table
const crcTable = (function () {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ============================================================
// Userscript
// ============================================================
function buildUserscript() {
  const version = getVersion();

  // Load locale messages
  const enMessages = JSON.parse(readFile('_locales/en/messages.json'));
  const jaMessages = JSON.parse(readFile('_locales/ja/messages.json'));
  const zhCnMessages = JSON.parse(readFile('_locales/zh_CN/messages.json'));

  // Build _M object entries (resolve $PLACEHOLDER$ → $1 etc.)
  function buildLocaleObj(messages) {
    const map = {};
    for (const [key, val] of Object.entries(messages)) {
      let msg = val.message;
      if (val.placeholders) {
        for (const [name, ph] of Object.entries(val.placeholders)) {
          msg = msg.replace(new RegExp('\\$' + name + '\\$', 'gi'), ph.content);
        }
      }
      map[key] = msg;
    }
    return map;
  }
  const enMap = buildLocaleObj(enMessages);
  const jaMap = buildLocaleObj(jaMessages);
  const zhCnMap = buildLocaleObj(zhCnMessages);

  // Load source files
  const contentJs = readFile('content.js');
  const pageScriptJs = readFile('pageScript.js');
  const stylesCss = readFile('styles.css');

  // ---- Transform content.js ----
  let transformed = contentJs;

  // Remove the outer IIFE wrapper
  transformed = transformed.replace(/^\(function \(\) \{\s*'use strict';\s*\n/, '');
  transformed = transformed.replace(/\n\}\)\(\);\s*$/, '');

  // Remove chrome.storage.onChanged listener block
  transformed = transformed.replace(
    /\s*\/\/ ---- chrome\.storage\.onChanged[\s\S]*?chrome\.storage\.onChanged\.addListener\([\s\S]*?\}\);\s*/,
    '\n'
  );

  // Remove chrome.runtime.sendMessage calls
  transformed = transformed.replace(/\s*chrome\.runtime\.sendMessage\([^)]*\)\.catch\(\(\) => \{\}\);/g, '');

  // Replace injectPageScript function - inline the pageScript
  const pageScriptContent = pageScriptJs
    .replace(/^\(function \(\) \{\s*'use strict';\s*\n/, '')
    .replace(/\n\}\)\(\);\s*$/, '');

  transformed = transformed.replace(
    /\s*\/\/ ---- ページスクリプト注入 ----\s*\n\s*function injectPageScript\(\) \{[\s\S]*?\}\s*\n/,
    `
  // ---- ページスクリプト注入（@grant none: ページコンテキストで直接実行） ----
  function injectPageScript() {
    ${pageScriptJs.trim()}
  }
`
  );

  // Replace i18n system: chrome.i18n.getMessage -> _M lookup
  // Remove old i18n helper and replace with new one
  transformed = transformed.replace(
    /\s*\/\/ ---- i18n ヘルパー[\s\S]*?function msg\(key, sub\) \{[\s\S]*?\}\s*\n/,
    `
  // ---- i18n ----
  const _lang = (navigator.language || '').toLowerCase();
  const _L = _lang.startsWith('ja') ? 'ja' : (_lang.startsWith('zh') ? 'zh_CN' : 'en');
  const _M = ${JSON.stringify({ en: enMap, ja: jaMap, zh_CN: zhCnMap })};
  function _i18n(key) { return (_M[_L] || _M.en)[key] || key; }
  const i18n = {};
  function cacheI18n() {
    const keys = [
      'blockLabel', 'muteLabel', 'blockedStatus', 'mutedStatus',
      'unblockLabel', 'unmuteLabel', 'errorTimeout', 'errorOccurred',
    ];
    for (const k of keys) i18n[k] = _i18n(k);
  }
  function msg(key, sub) {
    if (sub != null) {
      const s = _i18n(key);
      return s.replace(/\\$1/g, sub);
    }
    return i18n[key] || _i18n(key) || key;
  }
`
  );

  // Remove _msg line
  transformed = transformed.replace(/\s*const _msg = chrome\.i18n\.getMessage\.bind\(chrome\.i18n\);\s*\n/, '\n');

  // Replace chrome.storage.local.get('icons', ...) with localStorage
  transformed = transformed.replace(
    /function loadStoredIcons\(\) \{[\s\S]*?return new Promise[\s\S]*?\}\);\s*\}\)/,
    `function loadStoredIcons() {
    return new Promise((resolve) => {
      try {
        const stored = JSON.parse(localStorage.getItem('twblock_icons'));
        if (stored && stored.version === ICON_CACHE_VERSION) {
          if (stored.block) BLOCK_ICON = stored.block;
          if (stored.mute) MUTE_ICON = stored.mute;
          iconsExtracted = Boolean(BLOCK_ICON && MUTE_ICON);
        }
      } catch {}
      resolve();
    })`
  );

  // Replace chrome.storage.local.get('settings', ...) with localStorage
  transformed = transformed.replace(
    /function loadSettings\(\) \{[\s\S]*?return new Promise[\s\S]*?\}\);\s*\}\)/,
    `function loadSettings() {
    return new Promise((resolve) => {
      try {
        const stored = JSON.parse(localStorage.getItem('twblock_settings'));
        if (stored) {
          showBlock = stored.showBlock !== false;
          showMute = stored.showMute !== false;
          confirmBlockFollowing = stored.confirmBlockFollowing === true;
        }
      } catch {}
      resolve();
    })`
  );

  // Replace chrome.storage.local.set for icons
  transformed = transformed.replace(
    /chrome\.storage\.local\.set\(\{ icons: \{ version: ICON_CACHE_VERSION, block: BLOCK_ICON, mute: MUTE_ICON \} \}\);/g,
    "localStorage.setItem('twblock_icons', JSON.stringify({ version: ICON_CACHE_VERSION, block: BLOCK_ICON, mute: MUTE_ICON }));"
  );

  // Replace chrome.storage.local.get('accentColor', ...) with localStorage
  transformed = transformed.replace(
    /function loadStoredAccentColor\(\) \{[\s\S]*?return new Promise[\s\S]*?\}\);\s*\}\)/,
    `function loadStoredAccentColor() {
    return new Promise((resolve) => {
      try {
        const stored = localStorage.getItem('twblock_accentColor');
        if (stored && ACCENT_COLORS.has(stored)) {
          cachedAccentColor = stored;
        }
      } catch {}
      resolve();
    })`
  );

  // Replace chrome.storage.local.set for accentColor
  transformed = transformed.replace(
    /chrome\.storage\.local\.set\(\{ accentColor: bg \}\);/g,
    "localStorage.setItem('twblock_accentColor', bg);"
  );

  // Inject CSS function
  const cssInjector = `
  // ---- CSS注入 ----
  function injectCSS() {
    const style = document.createElement('style');
    style.textContent = ${JSON.stringify(stylesCss)};
    document.head.appendChild(style);
  }
`;

  // Add CSS injection call in init and the function itself
  transformed = transformed.replace(
    /(\s*\/\/ ---- 初期化 ----\s*\n\s*async function init\(\) \{)/,
    cssInjector + '\n$1'
  );
  transformed = transformed.replace(
    /(async function init\(\) \{\s*\n)/,
    '$1    injectCSS();\n'
  );

  // Build userscript header
  const REPO_RAW = 'https://raw.githubusercontent.com/satomasahiro2005/ultimate-twitter-block/main';
  const header = `// ==UserScript==
// @name         Ultimate Twitter Block
// @namespace    twitter-block-userscript
// @version      ${version}
// @description  Add one-click block/mute buttons to tweets, profiles, and search suggestions on Twitter/X
// @author       nemut.ai
// @match        https://x.com/*
// @match        https://twitter.com/*
// @updateURL    ${REPO_RAW}/userscripts/twitter-block.user.js
// @downloadURL  ${REPO_RAW}/userscripts/twitter-block.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==
`;

  const output = header + '\n(function () {\n  \'use strict\';\n' + transformed + '\n})();\n';

  // Write output
  const outDir = path.join(ROOT, 'userscripts');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  const outPath = path.join(outDir, 'twitter-block.user.js');
  fs.writeFileSync(outPath, output, 'utf8');
  console.log(`Userscript: userscripts/twitter-block.user.js (${output.length} bytes)`);
}

// ============================================================
// Main
// ============================================================
const arg = process.argv[2];

if (!arg || arg === 'zip') {
  buildZip();
}
if (!arg || arg === 'userscript') {
  buildUserscript();
}

if (arg && arg !== 'zip' && arg !== 'userscript') {
  console.error(`Usage: node build.js [zip|userscript]`);
  process.exit(1);
}

