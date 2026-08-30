'use strict';

// dom.test.js と perf.test.js が共有する、Chrome と puppeteer-core の探し方。
// 2ファイルに同じ探索を書いていたので、片方だけ直して食い違うのを防ぐ。

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (err) { /* noop */ }
  }
  return null;
}

function loadPuppeteer() {
  const candidates = [
    'puppeteer-core',
    path.join(process.env.USERPROFILE || process.env.HOME || '', 'node_modules', 'puppeteer-core'),
  ];
  for (const id of candidates) {
    try { return require(id); } catch (err) { /* noop */ }
  }
  return null;
}

// fixture.html を1枚だけ返すサーバ。ポートは OS に選ばせる（固定だと衝突する）
function startServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'fixture.html')));
  });
  server.on('error', (err) => {
    console.error('fixture server error: ' + err.message);
    process.exit(1);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

module.exports = { ROOT, findChrome, loadPuppeteer, startServer };
