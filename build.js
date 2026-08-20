#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const LOCALES = ['en', 'ja', 'zh_CN'];

// ---- Helpers ----
function readFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function getVersion() {
  const manifest = JSON.parse(readFile('manifest.json'));
  return manifest.version;
}

function fail(message) {
  console.error('BUILD FAILED: ' + message);
  process.exit(1);
}

// content.js のマーカー区間を丸ごと差し替える。
// 正規表現と違い「見つからない」「複数ある」は必ずビルド失敗になる。
function replaceRegion(src, name, replacement) {
  const open = '/* @twblock:' + name + '-start */';
  const close = '/* @twblock:' + name + '-end */';
  const a = src.indexOf(open);
  if (a === -1) fail(`marker "${name}-start" not found in content.js`);
  const b = src.indexOf(close, a + open.length);
  if (b === -1) fail(`marker "${name}-end" not found in content.js`);
  if (src.indexOf(open, a + open.length) !== -1) fail(`duplicate marker "${name}-start"`);
  if (src.indexOf(close, b + close.length) !== -1) fail(`duplicate marker "${name}-end"`);
  return src.slice(0, a) + replacement + src.slice(b + close.length);
}

// ============================================================
// Locale checks (both builds depend on these files being in sync)
// ============================================================
function loadLocales() {
  const maps = {};
  for (const locale of LOCALES) {
    try {
      maps[locale] = JSON.parse(readFile(`_locales/${locale}/messages.json`));
    } catch (err) {
      fail(`_locales/${locale}/messages.json: ${err.message}`);
    }
  }

  const allKeys = new Set();
  for (const locale of LOCALES) Object.keys(maps[locale]).forEach((k) => allKeys.add(k));

  const problems = [];
  for (const key of allKeys) {
    for (const locale of LOCALES) {
      if (!maps[locale][key]) problems.push(`${locale} is missing "${key}"`);
    }
    const shapes = LOCALES
      .filter((l) => maps[l][key])
      .map((l) => JSON.stringify(Object.keys(maps[l][key].placeholders || {}).sort()));
    if (new Set(shapes).size > 1) problems.push(`placeholders differ for "${key}"`);
  }
  if (problems.length) fail('locales out of sync:\n  ' + problems.join('\n  '));

  console.log(`locales: OK (${allKeys.size} keys x ${LOCALES.length})`);
  return maps;
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

  // manifest が参照しているファイルが1つでも欠けていたら ZIP を書かない
  const missing = manifestReferences().filter((rel) => files.indexOf(rel) === -1);
  if (missing.length) {
    fail('these files are referenced by manifest.json but missing from the zip:\n  ' + missing.join('\n  '));
  }

  const zipBuffer = Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
  fs.writeFileSync(outPath, zipBuffer);
  console.log(`ZIP: ${outName} (${files.length} files, ${zipBuffer.length} bytes)`);
}

function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// リポジトリ内のファイルを相対パスで列挙する（node_modules と .git は除く）
function walkFiles(dir, rel, visit) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = path.join(dir, name);
    const r = rel ? rel + '/' + name : name;
    if (fs.statSync(full).isDirectory()) walkFiles(full, r, visit);
    else visit(r);
  }
}

// manifest.json が名指ししているファイルを列挙する
function manifestReferences() {
  const manifest = JSON.parse(readFile('manifest.json'));
  const out = new Set();
  const add = (v) => { if (typeof v === 'string' && v && !/^__MSG_/.test(v)) out.add(v); };

  for (const cs of manifest.content_scripts || []) {
    (cs.js || []).forEach(add);
    (cs.css || []).forEach(add);
  }
  for (const war of manifest.web_accessible_resources || []) {
    // resources は "_locales/*/messages.json" のようなパターンを取れるので展開する
    (war.resources || []).forEach((pattern) => {
      if (typeof pattern !== 'string') return;
      if (pattern.indexOf('*') === -1) { add(pattern); return; }
      const re = new RegExp('^' + pattern.split('*').map(escapeForRegExp).join('[^/]*') + '$');
      let matched = 0;
      walkFiles(ROOT, '', (rel) => { if (re.test(rel)) { add(rel); matched++; } });
      if (!matched) fail(`manifest pattern matches no file: ${pattern}`);
    });
  }
  if (manifest.background && manifest.background.service_worker) add(manifest.background.service_worker);
  if (manifest.action) {
    add(manifest.action.default_popup);
    Object.values(manifest.action.default_icon || {}).forEach(add);
  }
  Object.values(manifest.icons || {}).forEach(add);
  if (manifest.options_ui) add(manifest.options_ui.page);
  if (manifest.default_locale) add(`_locales/${manifest.default_locale}/messages.json`);
  return Array.from(out);
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
const API_NAMES = 'storage|runtime|i18n|tabs|action|scripting|permissions';
// chrome.storage と chrome['storage'] の両方を拾う
// 文字列の中身は strip で空白化されるので、角括弧アクセスは
// 「chrome[ で始まっていること」だけを見る（このコードベースに正当な用途は無い）
const EXTENSION_API_RE = new RegExp(
  '\\b(?:chrome|browser)\\s*(?:\\.\\s*(?:' + API_NAMES + ')\\b' +
  '|\\[)',
  'g'
);

// コメントと文字列リテラルを空白に潰す（行番号は保つ）。
// 「コメントに chrome.storage と書いた」を誤検知しないため。
// 直前の非空白文字から「この / は除算ではなく正規表現の始まり」かを判定する
function isRegexStart(before) {
  const m = before.match(/([^\s])\s*$/);
  if (!m) return true;
  const ch = m[1];
  if ('=(,:[!&|?{};+-*%~^<>'.indexOf(ch) !== -1) return true;
  return /\b(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)\s*$/.test(before);
}

function stripLiteralsAndComments(src) {
  let out = '';
  let i = 0;
  const blank = (text) => text.replace(/[^\n]/g, ' ');
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out += blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    const ch = src[i];
    if (ch === '/' && isRegexStart(out)) {
      // 正規表現リテラル。中のクォートで文字列モードに入ると、
      // そこから先の chrome.* を丸ごと見逃す
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const c = src[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '\n') break;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) { j++; break; }
        j++;
      }
      out += blank(src.slice(i, j));
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === ch) { j++; break; }
        j++;
      }
      out += ch + blank(src.slice(i + 1, Math.max(j - 1, i + 1))) + (src[j - 1] === ch ? ch : '');
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function checkContentScriptMarkers(contentJs) {
  // content.js 側の不変条件: 拡張API はマーカー区間の中だけで使う。
  // これが守られている限り、userscript 版に chrome.* が漏れることはない。
  let rest = contentJs;
  for (const name of ['store', 'i18n', 'css', 'pagescript']) {
    const open = '/* @twblock:' + name + '-start */';
    const close = '/* @twblock:' + name + '-end */';
    const a = rest.indexOf(open);
    const b = a === -1 ? -1 : rest.indexOf(close, a + open.length);
    if (a === -1 || b === -1) fail(`marker "${name}" is missing from content.js`);
    rest = rest.slice(0, a) + rest.slice(b + close.length);
  }
  const leaks = [...stripLiteralsAndComments(rest).matchAll(EXTENSION_API_RE)].map((m) => m[0]);
  if (leaks.length) {
    fail('content.js uses extension APIs outside the @twblock markers: ' + [...new Set(leaks)].join(', '));
  }
}

function buildLocaleTable(maps) {
  const table = {};
  for (const locale of LOCALES) {
    const out = {};
    for (const [key, val] of Object.entries(maps[locale])) {
      let message = val.message;
      if (val.placeholders) {
        for (const [name, ph] of Object.entries(val.placeholders)) {
          message = message.replace(new RegExp('\\$' + name + '\\$', 'gi'), ph.content);
        }
      }
      out[key] = message;
    }
    table[locale] = out;
  }
  return table;
}

function storeImpl() {
  return `
  // ---- ストレージ抽象（ユーザースクリプト版: localStorage） ----
  const STORE_PREFIX = 'twblock_';
  const storeListeners = [];

  function notifyStoreListeners(changes) {
    storeListeners.forEach((cb) => { try { cb(changes); } catch (err) { /* noop */ } });
  }

  const store = {
    // chrome.storage.local.get と同じく、文字列・配列・オブジェクト(既定値)・null を受ける
    get(keys) {
      const out = {};
      let list;
      let defaults = null;
      if (keys === null || keys === undefined) {
        list = [];
        for (let i = 0; i < localStorage.length; i++) {
          const raw = localStorage.key(i);
          if (raw && raw.indexOf(STORE_PREFIX) === 0) list.push(raw.slice(STORE_PREFIX.length));
        }
      } else if (Array.isArray(keys)) {
        list = keys;
      } else if (typeof keys === 'object') {
        defaults = keys;
        list = Object.keys(keys);
      } else {
        list = [keys];
      }
      for (const key of list) {
        if (defaults && Object.prototype.hasOwnProperty.call(defaults, key)) out[key] = defaults[key];
        try {
          const raw = localStorage.getItem(STORE_PREFIX + key);
          if (raw !== null) out[key] = JSON.parse(raw);
        } catch (err) { /* 壊れた値は無視する */ }
      }
      return Promise.resolve(out);
    },
    set(obj) {
      const changes = {};
      for (const [key, value] of Object.entries(obj)) {
        try {
          // undefined を JSON.stringify すると "undefined" が書き込まれて読み戻せなくなる
          if (value === undefined) localStorage.removeItem(STORE_PREFIX + key);
          else localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value));
        } catch (err) {
          // 書けなかったものは「変わった」と言わない
          continue;
        }
        changes[key] = { newValue: value };
      }
      if (Object.keys(changes).length) notifyStoreListeners(changes);
      return Promise.resolve();
    },
    remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes = {};
      for (const key of list) {
        try {
          localStorage.removeItem(STORE_PREFIX + key);
          changes[key] = { newValue: undefined };
        } catch (err) { /* noop */ }
      }
      if (Object.keys(changes).length) notifyStoreListeners(changes);
      return Promise.resolve();
    },
    onChanged(callback) {
      storeListeners.push(callback);
    },
    getPageScriptUrl() { return ''; },
  };

  // 他タブでの変更も拾う（拡張版の storage.onChanged にあたる部分）
  window.addEventListener('storage', (event) => {
    if (!event.key || event.key.indexOf(STORE_PREFIX) !== 0) return;
    let newValue;
    try { newValue = event.newValue === null ? undefined : JSON.parse(event.newValue); } catch (err) { return; }
    const changes = {};
    changes[event.key.slice(STORE_PREFIX.length)] = { newValue };
    notifyStoreListeners(changes);
  });
`;
}

function i18nImpl(table) {
  return `
  const _M = ${JSON.stringify(table)};
  // 既定はブラウザの表示言語
  const _lang = (navigator.language || '').toLowerCase();
  const _L = _lang.indexOf('ja') === 0 ? 'ja' : (_lang.indexOf('zh') === 0 ? 'zh_CN' : 'en');

  function _fallbackMsg(key, subs) {
    const table = _M[_L] || _M.en;
    let out = table[key];
    if (out == null) out = _M.en[key];
    if (out == null) return '';
    if (subs && subs.length) {
      out = out.replace(/\\$(\\d)/g, (whole, digit) => {
        const value = subs[Number(digit) - 1];
        return value === undefined ? whole : value;
      });
    }
    return out;
  }

  // 拡張版は messages.json を読みに行くが、こちらは埋め込み済みなので選ぶだけ
  function fetchLocaleTable(locale) {
    return Promise.resolve(_M[locale] || null);
  }
`;
}

function cssImpl(stylesCss) {
  return `
  function injectCSS() {
    if (document.getElementById('twblock-style')) return;
    const style = document.createElement('style');
    style.id = 'twblock-style';
    style.textContent = ${JSON.stringify(stylesCss)};
    (document.head || document.documentElement).appendChild(style);
  }
`;
}

function pageScriptImpl(pageScriptJs) {
  return `
  // ---- ページスクリプト（@grant none: そのままページコンテキストで実行される） ----
  function injectPageScript() {
${pageScriptJs.trimEnd()}
  }
`;
}

async function verifyUserscript(src) {
  const errors = [];
  const lineOf = (index) => src.slice(0, index).split('\n').length;

  // (1) 拡張APIが残っていないか
  for (const m of stripLiteralsAndComments(src).matchAll(EXTENSION_API_RE)) {
    errors.push(`L${lineOf(m.index)}: extension API survived -> ${m[0]}`);
  }

  // (2) 構文
  try {
    new vm.Script(src, { filename: 'twitter-block.user.js' });
  } catch (err) {
    errors.push('syntax: ' + err.message);
  }

  // (3) 差し替えの結果が実際に入っているか（静かに空振りしたビルドを落とす）
  const required = [
    [/^\/\/ ==UserScript==[\s\S]*?^\/\/ ==\/UserScript==/m, 'metadata block'],
    [/function\s+injectCSS\s*\(/, 'injectCSS() definition'],
    [/twblock-btn-container/, 'styles.css payload'],
    [/const\s+_M\s*=\s*\{/, 'locale table'],
    [/function\s+_msg\s*\(/, '_msg() definition'],
    [/const\s+STORE_PREFIX\s*=/, 'localStorage store'],
    [/loadStoredIconSignatures\(/, 'icon signature restore'],
    [/blocks\/create\.json/, 'inlined pageScript'],
    [/observer\.observe\(document\.body/, 'main observer'],
  ];
  for (const [re, name] of required) {
    if (!re.test(src)) errors.push('missing: ' + name);
  }

  // (4) DOMスタブの上で実際に走らせて init() が最後まで到達するか。
  //     v2.2.4 は init() の途中で例外死してボタンが1個も出なかったので、
  //     「構文が通る」だけでは足りない。
  errors.push(...(await smokeTest(src, { label: 'smoke', expectInlineCss: true, expectInlinePageScript: true })));

  if (errors.length) {
    fail('userscript verification:\n  ' + errors.join('\n  '));
  }
  console.log(`verify: OK (${src.split('\n').length} lines)`);
}

// ユーザースクリプトを最小DOMスタブ上で起動し、初期化が完走することを確認する
async function smokeTest(src, options) {
  const opts = options || {};
  const label = opts.label || 'smoke';
  const errors = [];
  const state = { observedBody: false, styleInjected: false, pageScriptRan: false, scriptTagSrc: '' };
  const storage = new Map();

  const makeEl = (tag) => {
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      style: {},
      dataset: {},
      children: [],
      id: '',
      src: '',
      onload: null,
      classList: {
        add() {}, remove() {}, toggle() {}, contains() { return false; },
      },
      setAttribute() {}, getAttribute() { return null; },
      removeAttribute() {}, hasAttribute() { return false; },
      appendChild(child) { this.children.push(child); return child; },
      insertBefore(child) { this.children.push(child); return child; },
      remove() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      querySelector() { return null; }, querySelectorAll() { return []; },
      closest() { return null; }, contains() { return false; },
      getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0 }; },
      innerHTML: '', textContent: '', title: '',
    };
    return el;
  };

  const body = makeEl('body');
  const head = makeEl('head');
  head.appendChild = function (child) {
    if (child && child.tagName === 'SCRIPT' && child.src) state.scriptTagSrc = child.src;
    this.children.push(child);
    return child;
  };
  const documentElement = makeEl('html');
  documentElement.lang = 'en';

  const documentStub = {
    readyState: 'complete',
    cookie: 'ct0=deadbeef; twid=u%3D1234567890',
    body, head, documentElement,
    createElement: (tag) => {
      const el = makeEl(tag);
      if (String(tag).toLowerCase() === 'style') {
        Object.defineProperty(el, 'textContent', {
          set(value) { if (String(value).includes('twblock-btn-container')) state.styleInjected = true; },
          get() { return ''; },
        });
      }
      return el;
    },
    createElementNS: (ns, tag) => makeEl(tag),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    visibilityState: 'visible',
    hasFocus: () => true,
  };

  function XMLHttpRequestStub() {}
  XMLHttpRequestStub.prototype.open = function () {};
  XMLHttpRequestStub.prototype.setRequestHeader = function () {};
  XMLHttpRequestStub.prototype.send = function () {};

  const warnings = [];
  const timers = [];
  const sandbox = {
    console: {
      log() {}, info() {}, table() {}, groupCollapsed() {}, groupEnd() {},
      // processAll は各フェーズの例外を握って console.warn に落とすので、ここで拾う
      warn(...args) {
        const text = args.map((a) => (a && a.message) ? a.message : String(a)).join(' ');
        if (text.indexOf('[twblock]') !== -1) warnings.push(text);
      },
      error(...args) {
        const text = args.map((a) => (a && a.message) ? a.message : String(a)).join(' ');
        if (text.indexOf('[twblock]') !== -1) warnings.push(text);
      },
    },
    setTimeout: (fn) => { if (typeof fn === 'function') timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    setInterval: (fn) => { if (typeof fn === 'function') timers.push(fn); return 0; },
    clearInterval: () => {},
    requestAnimationFrame: (fn) => { if (typeof fn === 'function') timers.push(fn); return 0; },
    fetch: () => Promise.resolve({ ok: false, status: 0, json: () => Promise.resolve(null) }),
    Headers: function Headers() {},
    XMLHttpRequest: XMLHttpRequestStub,
    KeyboardEvent: function KeyboardEvent() {},
    getComputedStyle: () => ({ display: 'block', flexDirection: 'row', backgroundColor: 'rgb(0, 0, 0)' }),
    MutationObserver: function MutationObserver() {
      return {
        observe(target) { if (target === body) state.observedBody = true; },
        disconnect() {},
      };
    },
    navigator: { language: 'ja-JP' },
    location: { href: 'https://x.com/home', pathname: '/home', hostname: 'x.com', reload() {} },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => { storage.set(k, String(v)); },
      removeItem: (k) => { storage.delete(k); },
    },
    document: documentStub,
    confirm: () => true,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.postMessage = () => { state.pageScriptRan = true; };

  if (opts.chrome) {
    const area = {
      get(keys, cb) { if (cb) cb({}); },
      set(obj, cb) { if (cb) cb(); },
      remove(keys, cb) { if (cb) cb(); },
    };
    sandbox.chrome = {
      storage: { local: area, onChanged: { addListener() {} } },
      i18n: { getMessage: (key) => key },
      runtime: { getURL: (rel) => 'chrome-extension://test/' + rel },
    };
  }

  // init() は async。中で例外が出ると unhandledRejection として外に出る。
  const rejections = [];
  const onRejection = (reason) => {
    rejections.push(reason && reason.stack ? String(reason.stack).split('\n').slice(0, 2).join(' | ') : String(reason));
  };
  process.on('unhandledRejection', onRejection);

  try {
    vm.createContext(sandbox);
    new vm.Script(src, { filename: 'twitter-block.user.js' }).runInContext(sandbox, { timeout: 5000 });

    // マクロタスクを数回挟んで microtask を流し切る
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // init が仕込んだタイマー（processAll 等）を1巡だけ実行する。
    // ここを流さないと「ボタン挿入が丸ごと例外で死ぬ」壊れ方が検出できない
    const queued = timers.splice(0, timers.length);
    for (const fn of queued) {
      try { fn(); } catch (err) { warnings.push('[twblock] timer threw: ' + err.message); }
    }
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  } catch (err) {
    process.off('unhandledRejection', onRejection);
    return ['smoke: threw during load -> ' + err.message];
  }
  process.off('unhandledRejection', onRejection);

  for (const reason of rejections) errors.push(label + ': unhandled rejection -> ' + reason);
  for (const warning of warnings) errors.push(label + ': ' + warning);

  if (!state.observedBody) errors.push(label + ': init() never reached observer.observe(document.body)');
  if (opts.expectInlineCss && !state.styleInjected) errors.push(label + ': injectCSS() never injected styles.css');
  if (opts.expectInlinePageScript && !state.pageScriptRan) errors.push(label + ': inlined pageScript never ran');
  if (opts.expectScriptTag && !/pageScript\.js$/.test(state.scriptTagSrc)) {
    errors.push(label + ': injectPageScript() never appended pageScript.js');
  }
  return errors;
}

async function buildUserscript(localeMaps, options) {
  const dryRun = Boolean(options && options.dryRun);
  const version = getVersion();
  const contentJs = readFile('content.js');
  const pageScriptJs = readFile('pageScript.js');
  const stylesCss = readFile('styles.css');

  checkContentScriptMarkers(contentJs);

  let transformed = contentJs;
  transformed = replaceRegion(transformed, 'store', storeImpl());
  transformed = replaceRegion(transformed, 'i18n', i18nImpl(buildLocaleTable(localeMaps)));
  transformed = replaceRegion(transformed, 'css', cssImpl(stylesCss));
  transformed = replaceRegion(transformed, 'pagescript', pageScriptImpl(pageScriptJs));

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

  const output = header + '\n' + transformed;
  await verifyUserscript(output);

  if (dryRun) {
    console.log('check: OK (nothing written)');
    return;
  }

  const outDir = path.join(ROOT, 'userscripts');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  const outPath = path.join(outDir, 'twitter-block.user.js');
  fs.writeFileSync(outPath, output, 'utf8');
  console.log(`Userscript: userscripts/twitter-block.user.js (${output.length} bytes)`);
}

// ============================================================
// Extension-side sanity checks
// ============================================================
async function checkExtensionSources() {
  for (const file of ['content.js', 'pageScript.js', 'background.js', 'options.js', 'popup.js']) {
    try {
      new vm.Script(readFile(file), { filename: file });
    } catch (err) {
      fail(`${file}: ${err.message}`);
    }
  }

  const manifest = JSON.parse(readFile('manifest.json'));
  for (const rel of [...manifest.content_scripts[0].js, ...manifest.content_scripts[0].css]) {
    if (!fs.existsSync(path.join(ROOT, rel))) fail(`manifest references missing file: ${rel}`);
  }

  // 拡張版の content.js も DOMスタブ + chrome スタブ上で起動して init() の完走を見る。
  // userscript 版のスモークテストは localStorage 実装しか通らないので、こちらが要る。
  const extErrors = await smokeTest(readFile('content.js'), {
    label: 'smoke(extension)',
    chrome: true,
    expectScriptTag: true,
  });
  if (extErrors.length) fail('content.js verification:\n  ' + extErrors.join('\n  '));

  console.log('sources: OK');
}

// ============================================================
// Main
// ============================================================
const arg = process.argv[2];

if (arg && arg !== 'zip' && arg !== 'userscript' && arg !== 'check') {
  console.error(`Usage: node build.js [zip|userscript|check]`);
  process.exit(1);
}

(async () => {
  const localeMaps = loadLocales();
  await checkExtensionSources();

  if (arg === 'check') {
    // 生成物を書かずに、マーカー・chrome.* 漏れ・スモークテストまで通す
    await buildUserscript(localeMaps, { dryRun: true });
    return;
  }
  if (!arg || arg === 'zip') {
    buildZip();
  }
  if (!arg || arg === 'userscript') {
    await buildUserscript(localeMaps);
  }
})();
