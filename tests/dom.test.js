#!/usr/bin/env node
'use strict';

// 実ブラウザ(Chrome)上で、ビルド済みユーザースクリプトを X 風のDOMに当てて回帰を見る。
//
//   node tests/dom.test.js
//
// puppeteer-core と Chrome が要る。見つからない場合はスキップ扱いで exit 0。
// ユーザースクリプト版と拡張版は content.js を共有しているので、
// ここで通ることは拡張側のロジックが通ることでもある（ストレージ層だけが別）。

const fs = require('fs');
const path = require('path');

const { ROOT, findChrome, loadPuppeteer, startServer } = require('./helpers');
const USERSCRIPT = path.join(ROOT, 'userscripts', 'twitter-block.user.js');


const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && !ok ? '  -> ' + detail : ''}`);
}

// ---------------------------------------------------------------
// ログイン中の x-web（まだ一般には配られていない画面）を本物で回す。
// tests/xweb-harness が x-web 本体をオフラインで起動し、拡張（content.js そのもの）を
// 入れた Chrome で開く。x-web のバンドルは .cache に要る（fetch-assets.js）。
// 無ければスキップ（REQUIRE_XWEB=1 なら失敗）
// ---------------------------------------------------------------
async function xwebHarnessTests() {
  let H;
  try {
    H = require('./xweb-harness/run.js');
  } catch (err) {
    console.log('SKIP x-web harness: ' + err.message);
    return;
  }
  let browser;
  try {
    // XWEB_EXTENSION_PATH: 別のビルド（修正前など）で同じ確認を回す
    browser = await H.launch({ extension: true, extensionPath: process.env.XWEB_EXTENSION_PATH || undefined });
  } catch (err) {
    if (process.env.REQUIRE_XWEB) { check('x-web harness: 起動できる', false, err.message); return; }
    console.log('SKIP x-web harness: ' + err.message);
    return;
  }
  try {
    // 行ごとに: こちらのコンテナが Follow 系ボタンの直前の兄弟か、中心の高さが揃うか
    const rowReport = (page, kind) => page.evaluate((cls) => {
      const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, cy: (r.top + r.bottom) / 2, left: r.left, right: r.right }; };
      return [...document.querySelectorAll('.twblock-btn-container.' + cls)]
        .filter((c) => c.getClientRects().length)
        .map((c) => {
          const next = c.nextElementSibling;
          const a = box(c);
          const b = next ? box(next) : null;
          return {
            name: c.getAttribute('data-screen-name'),
            nextIsButton: Boolean(next && next.tagName === 'BUTTON'),
            dy: b ? Math.round(a.cy - b.cy) : null,
            gap: b ? Math.round(b.left - a.right) : null,
            below: c.classList.contains('twblock-xweb-below'),
            nextTop: b ? Math.round(b.top) : null,
            top: Math.round(a.top),
          };
        });
    }, kind);

    // 1. フォロー一覧: 全行（自分以外）に Follow 系ボタンの左隣で、高さが揃う
    for (const width of [1280, 420]) {
      const { page } = await H.openShot(browser, 'following', { width });
      const cells = await page.evaluate(() => [...document.querySelectorAll('main [data-timeline-entry][data-href]')]
        .filter((e) => !e.querySelector('article')).map((e) => e.getAttribute('data-href').slice(1)));
      const rows = await rowReport(page, 'twblock-xweb-user');
      const inMain = await page.evaluate(() => [...document.querySelectorAll('main .twblock-btn-container')].map((c) => c.getAttribute('data-screen-name')));
      check(`x-web フォロー一覧(${width}): 全ユーザー行にボタン`, cells.length === 8 && JSON.stringify(inMain) === JSON.stringify(cells),
        JSON.stringify({ cells, inMain }));
      const bad = rows.filter((r) => !r.nextIsButton || Math.abs(r.dy) > 1 || r.gap !== 8);
      check(`x-web フォロー一覧(${width}): Follow の左隣 8px で中心が揃う`, rows.length >= 8 && bad.length === 0, JSON.stringify(bad));
      await page.close();
    }

    // 2. ホーム: 自分の投稿には出さない（x-web は自分の名前を __INITIAL_DATA__ でだけ持つ）。
    //    リポストは元の投稿を article で包み直すが、その「もっと見る」の左に出る
    {
      const { page } = await H.openShot(browser, 'home', { width: 420 });
      const r = await page.evaluate(() => {
        const entryOf = (needle) => [...document.querySelectorAll('[data-timeline-entry]')].find((e) => (e.getAttribute('data-href') || '').startsWith(needle));
        const own = entryOf('/fake_me/status/');
        const repost = entryOf('/fake_heidi/status/');
        const more = repost && [...repost.querySelectorAll('svg[data-icon="icon-more"]')].map((s) => s.closest('button'))[0];
        return {
          own: own ? own.querySelectorAll('.twblock-btn-container').length : -1,
          repost: Boolean(more && more.previousElementSibling && more.previousElementSibling.classList.contains('twblock-btn-container')),
        };
      });
      check('x-web ホーム: 自分の投稿にはボタンを出さない', r.own === 0, JSON.stringify(r));
      check('x-web ホーム: リポストの「もっと見る」の左に出る', r.repost, JSON.stringify(r));
      await page.close();
    }

    // 3. プロフィール: 操作行の Follow の左。スマホ幅で入りきらないときは行の下へ回し、
    //    X の [もっと見る][メッセージ][通知][Follow] は1行に残す
    for (const width of [1280, 420]) {
      const { page } = await H.openShot(browser, 'profile', { width });
      const rows = await rowReport(page, 'twblock-xweb-profile');
      const r = rows[0] || {};
      const xwebOneLine = await page.evaluate(() => {
        const c = document.querySelector('.twblock-xweb-profile');
        if (!c) return false;
        const tops = [...c.parentElement.children].filter((el) => el !== c).map((el) => Math.round(el.getBoundingClientRect().top));
        return tops.every((t) => t === tops[0]);
      });
      if (width === 1280) {
        check('x-web プロフィール(1280): Follow の左隣 8px で中心が揃う', rows.length === 1 && r.name === 'fake_alice' && r.nextIsButton && Math.abs(r.dy) <= 1 && r.gap === 8 && !r.below, JSON.stringify(rows));
      } else {
        check('x-web プロフィール(420): 入りきらないので行の下に回す', rows.length === 1 && r.below && r.top > r.nextTop, JSON.stringify(rows));
      }
      check(`x-web プロフィール(${width}): X のボタンは1行のまま`, xwebOneLine);
      await page.close();
    }

    // 4. 自分のプロフィールには出さない
    {
      const { page } = await H.openShot(browser, 'profile-self', { width: 1280 });
      const n = await page.evaluate(() => document.querySelectorAll('.twblock-btn-container').length);
      check('x-web 自分のプロフィール: ボタンを出さない', n === 0, `got ${n}`);
      await page.close();
    }

    // 5. ホバーカード: [こちら][メッセージ][Follow] の順で中心が揃う
    {
      const { page } = await H.openShot(browser, 'hovercard', { width: 1280 });
      const r = await page.evaluate(() => {
        const c = document.querySelector('[data-side] .twblock-btn-container.twblock-xweb-hover');
        if (!c) return null;
        const cy = (el) => { const b = el.getBoundingClientRect(); return (b.top + b.bottom) / 2; };
        const sibs = [...c.parentElement.children];
        return {
          name: c.getAttribute('data-screen-name'),
          first: sibs[0] === c,
          rest: sibs.slice(1).map((el) => el.tagName),
          dy: sibs.slice(1).map((el) => Math.round(cy(c) - cy(el))),
        };
      });
      check('x-web ホバーカード: 操作の塊の先頭に出て中心が揃う',
        r && r.name === 'fake_heidi' && r.first && r.rest.join() === 'BUTTON,BUTTON' && r.dy.every((d) => Math.abs(d) <= 2), JSON.stringify(r));
      await page.close();
    }

    // 6. ブロック一覧（モーダル）: Blocked ボタンの左
    {
      const { page } = await H.openShot(browser, 'blocked', { width: 420 });
      const rows = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] .twblock-btn-container, [data-open] .twblock-btn-container')]
        .map((c) => ({ name: c.getAttribute('data-screen-name'), next: c.nextElementSibling && c.nextElementSibling.getAttribute('aria-label') })));
      check('x-web ブロック一覧: Unblock ボタンの左に出る',
        rows.length === 2 && rows.every((r) => r.next === 'Unblock @' + r.name), JSON.stringify(rows));
      await page.close();
    }

    // 7. 通知: 「〇〇さんがフォロー/いいね」には出さず、返信・メンションの投稿には出す
    {
      const { page } = await H.openShot(browser, 'notifications', { width: 1280 });
      const r = await page.evaluate(() => {
        const entries = [...document.querySelectorAll('main [data-timeline-entry]')].filter((e) => !e.parentElement.closest('[data-timeline-entry]'));
        return entries.map((e) => (e.querySelector('article') ? 'post' : 'notice') + ':' + e.querySelectorAll(':scope .twblock-btn-container').length);
      });
      check('x-web 通知: お知らせ行には出さず投稿には出す',
        r.filter((x) => x.startsWith('notice')).every((x) => x === 'notice:0') && r.filter((x) => x.startsWith('post')).every((x) => x !== 'post:0') && r.length >= 6,
        JSON.stringify(r));
      await page.close();
    }

    // 8. ログアウト中はボタンを出さない（ct0 が無いと操作できない）
    {
      const { page } = await H.openShot(browser, 'profile--logged-out', { width: 1280 });
      const n = await page.evaluate(() => document.querySelectorAll('.twblock-btn-container').length);
      check('x-web ログアウト中: ボタンを出さない', n === 0, `got ${n}`);
      await page.close();
    }

    // 9. この拡張でブロック済みと記録した人: 投稿は畳み、ユーザー行のボタンは済みの表示
    {
      // 拡張のストレージには拡張のページ（設定画面）から書く。service worker は眠っていることがある
      const ext = await browser.newPage();
      await ext.goto('chrome-extension://' + browser.__xwhExtensionId + '/options.html');
      await ext.evaluate(() => chrome.storage.local.set({ blockedUsersV2: { fake_bob: { b: 1, m: 0 } } }));
      const { page } = await H.openShot(browser, 'home', { width: 1280 });
      const post = await page.evaluate(() => {
        const e = [...document.querySelectorAll('[data-timeline-entry]')].find((x) => (x.getAttribute('data-href') || '').startsWith('/fake_bob/status/'));
        return Boolean(e && e.querySelector(':scope > article > .twblock-hidden-bar'));
      });
      check('x-web ホーム: 記録済みの人の投稿を畳む', post);
      await page.close();
      const { page: p2 } = await H.openShot(browser, 'following', { width: 1280 });
      const btn = await p2.evaluate(() => {
        const c = document.querySelector('.twblock-btn-container[data-screen-name="fake_bob"]');
        const b = c && c.querySelector('.twblock-block');
        return b ? b.getAttribute('aria-pressed') : null;
      });
      check('x-web フォロー一覧: 記録済みの人はブロック済みの表示', btn === 'true', `got ${btn}`);
      await p2.close();
      await ext.evaluate(() => chrome.storage.local.remove('blockedUsersV2'));
      await ext.close();
    }
  } catch (err) {
    check('x-web harness: 例外なく回る', false, err && err.stack || err);
  } finally {
    await browser.close();
  }
}

(async () => {
  const puppeteer = loadPuppeteer();
  const chromePath = findChrome();
  if (!puppeteer || !chromePath) {
    // CI ではスキップを緑にしない（環境構築が壊れても気づけなくなる）
    if (process.env.REQUIRE_BROWSER) {
      console.error('REQUIRE_BROWSER is set but puppeteer-core or Chrome is not available');
      process.exit(1);
    }
    console.log('SKIP: puppeteer-core or Chrome not available');
    process.exit(0);
  }
  if (!fs.existsSync(USERSCRIPT)) {
    console.error('build first: node build.js userscript');
    process.exit(1);
  }

  const script = fs.readFileSync(USERSCRIPT, 'utf8');
  const server = await startServer();
  const port = server.address().port;
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: ['--no-sandbox'] });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 900 });

    // confirm() が出たら記録して承諾する（放置するとページが固まる）
    const dialogs = [];
    page.on('dialog', async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.accept();
    });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });

    // x.com のふりをする: URL・cookie・fetch を差し替えてから注入する
    await page.evaluate(() => {
      history.replaceState({}, '', '/me_myself/followers');
      document.cookie = 'twid=u%3D2001261086327328768';
      document.cookie = 'ct0=testcsrftoken';
      window.__apiCalls = [];
      window.__apiReply = { success: true };
      // friendships/show は別枠。既定は「フォローしていない」= 確認ダイアログ無し
      window.__followReply = { relationship: { source: { following: false } } };
      window.fetch = function (url, options) {
        const href = String(url);
        window.__apiCalls.push({ url: href, method: (options && options.method) || 'GET' });
        if (href.includes('friendships/show.json')) {
          const f = window.__followReply;
          if (f === null) {
            return Promise.resolve({
              ok: false, status: 429, clone() { return this; },
              json: () => Promise.resolve({ errors: [{ code: 88 }] }), text: () => Promise.resolve(''),
            });
          }
          return Promise.resolve({
            ok: true, status: 200, clone() { return this; },
            json: () => Promise.resolve(f), text: () => Promise.resolve(''),
          });
        }
        const reply = window.__apiReply;
        return Promise.resolve({
          ok: reply.status ? reply.status < 400 : true,
          status: reply.status || 200,
          clone() { return this; },
          json: () => Promise.resolve(reply.body === undefined ? { ok: 1 } : reply.body),
          text: () => Promise.resolve(''),
        });
      };
    });

    await page.evaluate(script);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));

    // ---------------------------------------------------------------
    // 1. Issue #14: フォロワー一覧の二重挿入
    //    X が再レンダリングで Follow ボタンのネスト段数を変えるのを再現する
    // ---------------------------------------------------------------
    await page.evaluate(() => {
      window.reset();
      const root = document.getElementById('root');
      // 1周目: Follow ボタンが rowOuter の直下（浅い形）
      root.appendChild(window.buildUserCell('alice', { nested: false, testid: '1-follow' }));
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));

    const afterFirst = await page.evaluate(() =>
      document.querySelectorAll('[data-testid="UserCell"] .twblock-btn-container').length);
    check('UserCell: 1周目でコンテナが1つ挿入される', afterFirst === 1, `got ${afterFirst}`);

    // 2周目: React が作り直して、今度は1段深い形で描画する
    await page.evaluate(() => {
      const cell = document.querySelector('[data-testid="UserCell"]');
      const rowOuter = cell.firstElementChild;
      // 既存の followChild を消して、深い形の行を足す（Reactの作り直しを模す）
      [...rowOuter.children].forEach((child) => {
        if (child.querySelector('[data-testid$="-follow"]')) child.remove();
      });
      const rowInner = document.createElement('div');
      rowInner.className = 'row';
      const followChild = document.createElement('div');
      followChild.className = 'col ml12';
      const btn = document.createElement('button');
      btn.setAttribute('data-testid', '1-follow');
      btn.textContent = 'Follow';
      followChild.appendChild(btn);
      rowInner.appendChild(followChild);
      rowOuter.appendChild(rowInner);
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));

    const afterSecond = await page.evaluate(() => {
      const cell = document.querySelector('[data-testid="UserCell"]');
      const containers = cell.querySelectorAll('.twblock-btn-container');
      const follow = cell.querySelector('[data-testid$="-follow"]');
      const container = containers[0];
      return {
        count: containers.length,
        // reparent していないこと: Follow ボタンはコンテナの中に入っていない
        followInsideContainer: Boolean(container && container.contains(follow)),
        // 正しい位置（Followボタンの直前）にいること
        adjacent: Boolean(container && container.nextElementSibling &&
          container.nextElementSibling.contains(follow)),
      };
    });
    check('Issue #14: ネスト段数が変わってもコンテナは1つのまま', afterSecond.count === 1, `got ${afterSecond.count}`);
    check('Issue #14: Follow ボタンを包み直していない', afterSecond.followInsideContainer === false);
    check('Issue #14: コンテナが Follow ボタンの直前にある', afterSecond.adjacent === true);

    // Follow → Following の差し替え（Reactが新しいボタン要素を作る）でも増えない
    await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="1-follow"]');
      const parent = btn.parentElement;
      btn.remove();
      const next = document.createElement('button');
      next.setAttribute('data-testid', '1-unfollow');
      next.textContent = 'Following';
      parent.appendChild(next);
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
    const afterToggle = await page.evaluate(() =>
      document.querySelectorAll('[data-testid="UserCell"] .twblock-btn-container').length);
    check('Issue #14: Follow→Following の差し替えでも増えない', afterToggle === 1, `got ${afterToggle}`);

    // ブロック済みプロフィールの -unblock ボタンにもボタンが付く
    await page.evaluate(() => {
      window.reset();
      document.getElementById('root').appendChild(
        window.buildUserCell('carol', { testid: '3-unblock', label: 'Blocked' }));
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
    const unblockAnchored = await page.evaluate(() =>
      document.querySelectorAll('[data-testid="UserCell"] .twblock-btn-container').length);
    check('ブロック済み行(-unblock)にもボタンが出る', unblockAnchored === 1, `got ${unblockAnchored}`);

    // Verified Followers / Following の行は justify-content: space-between。
    // Followボタンと別のflexアイテムになるので、余白を山分けされて真ん中に飛びやすい
    await page.evaluate(() => {
      window.reset();
      document.getElementById('root').appendChild(
        window.buildUserCell('dora', { spaceBetween: true, testid: '4-follow' }));
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
    const spaced = await page.evaluate(() => {
      const cell = document.querySelector('[data-testid="UserCell"]');
      const cont = cell.querySelector('.twblock-btn-container');
      const follow = cell.querySelector('[data-testid$="-follow"]');
      const c = cont.getBoundingClientRect();
      const f = follow.parentElement.getBoundingClientRect();
      return { count: cell.querySelectorAll('.twblock-btn-container').length, gap: Math.round(f.left - c.right) };
    });
    check('space-between の行でもボタンが1つ', spaced.count === 1, `got ${spaced.count}`);
    check('space-between の行でもFollowボタンの隣に並ぶ',
      spaced.gap >= 0 && spaced.gap <= 8, `gap=${spaced.gap}px`);

    // ---------------------------------------------------------------
    // 2. ツイート: 二重挿入しない / RT行と本文行が別々に付く
    // ---------------------------------------------------------------
    await page.evaluate(() => {
      window.reset();
      const root = document.getElementById('root');
      root.appendChild(window.buildTweet('bob'));
      root.appendChild(window.buildTweet('dave', { retweeter: 'erin' }));
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
    const tweetState = await page.evaluate(() => {
      const arts = [...document.querySelectorAll('article[data-testid="tweet"]')];
      return arts.map((a) => [...a.querySelectorAll('.twblock-btn-container')]
        .map((c) => c.getAttribute('data-screen-name')));
    });
    check('ツイート: 著者ボタンが1つ', JSON.stringify(tweetState[0]) === '["bob"]', JSON.stringify(tweetState[0]));
    check('RT: RT者と著者の2つ', JSON.stringify(tweetState[1]) === '["erin","dave"]', JSON.stringify(tweetState[1]));

    // 同じDOMをもう一度 processAll に通しても増えない
    await page.evaluate(() => {
      document.querySelectorAll('[data-twblock]').forEach((el) => el.removeAttribute('data-twblock'));
      // observer は data-testid を持つ要素の追加しか拾わない。コメントノードでは走らない
      const poke = document.createElement('div');
      poke.setAttribute('data-testid', 'poke');
      document.getElementById('root').appendChild(poke);
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
    const tweetAfterRescan = await page.evaluate(() => {
      const arts = [...document.querySelectorAll('article[data-testid="tweet"]')];
      return arts.map((a) => a.querySelectorAll('.twblock-btn-container').length);
    });
    check('ツイート: 再スキャンしても二重にならない',
      JSON.stringify(tweetAfterRescan) === '[1,2]', JSON.stringify(tweetAfterRescan));

    // ---------------------------------------------------------------
    // 3. ミュート → 非表示バー → ブロックへ切り替え
    // ---------------------------------------------------------------
    await page.evaluate(() => { window.__apiReply = { success: true, body: { ok: 1 } }; });
    await page.evaluate(() => {
      const btn = document.querySelector('article[data-twblock-author="bob"] .twblock-mute');
      btn.click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 900)));

    const muted = await page.evaluate(() => {
      const art = document.querySelector('article[data-twblock-author="bob"]');
      const bar = art.querySelector(':scope > .twblock-hidden-bar');
      const inner = art.children[1];
      return {
        hasBar: Boolean(bar),
        barWidth: bar ? Math.round(bar.getBoundingClientRect().width) : 0,
        contentWidth: inner ? Math.round(art.clientWidth - 16) : 0,
        barBorderBottom: bar ? getComputedStyle(bar).borderBottomWidth : null,
        labelOffset: bar ? Math.round(
          bar.querySelector('.twblock-hidden-label').getBoundingClientRect().left
          - bar.getBoundingClientRect().left) : null,
        undoIsRightmost: (() => {
          if (!bar) return null;
          const bs = [...bar.querySelectorAll('button')];
          if (bs.length < 2) return null;
          const last = bs[bs.length - 1];
          return !/(ブロックに切替|Switch to block|切换为屏蔽)/.test(last.textContent);
        })(),
        buttonsRight: bar ? Math.round(
          Math.max(...[...bar.querySelectorAll('button')].map((b) => b.getBoundingClientRect().right))) : null,
        barRight: bar ? Math.round(bar.getBoundingClientRect().right) : null,
        buttons: bar ? [...bar.querySelectorAll('button')].map((b) => b.textContent) : [],
        contentHidden: art.children[1] ? art.children[1].style.display === 'none' : false,
        stored: JSON.parse(localStorage.getItem('twblock_blockedUsersV2') || '{}'),
        muteCall: window.__apiCalls.some((c) => c.url.includes('mutes/users/create.json')),
      };
    });
    check('ミュート: 非表示バーが出る', muted.hasBar);
    check('ミュート: バーが行いっぱいに広がる（文字幅に縮まない）',
      muted.barWidth > 0 && muted.barWidth >= muted.contentWidth - 1,
      `bar=${muted.barWidth} content=${muted.contentWidth}`);
    check('ミュート: 自前の下線を引かない（Xの区切り線と二重になる）',
      muted.barBorderBottom === '0px', muted.barBorderBottom);
    check('ミュート: バーの中身は左寄せ（幅いっぱいにすると中央に飛ぶ）',
      muted.labelOffset !== null && muted.labelOffset <= 20,
      `label は左端から ${muted.labelOffset}px`);
    check('ミュート: 本文が隠れる', muted.contentHidden);
    check('ミュート: mutes/users/create.json を叩いた', muted.muteCall);
    check('要望: バーに「ブロックに切替」が出る', muted.buttons.length >= 2, JSON.stringify(muted.buttons));
    check('並び: 戻すボタンが一番右（押した直後のカーソルに近い）',
      muted.undoIsRightmost === true, JSON.stringify(muted.buttons));
    check('並び: ボタン群が行の右端に寄る',
      muted.buttonsRight !== null && muted.buttonsRight >= muted.barRight - 24,
      `buttons=${muted.buttonsRight} bar=${muted.barRight}`);
    check('保存: mute 状態が記録される',
      Boolean(muted.stored.bob && muted.stored.bob.m === 1), JSON.stringify(muted.stored));

    // 「ブロックに切替」を押す
    await page.evaluate(() => {
      const bar = document.querySelector('article[data-twblock-author="bob"] > .twblock-hidden-bar');
      // 役割で選ぶ（並び順を変えても壊れないように）
      bar.querySelector('.twblock-bar-danger').click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 900)));
    const escalated = await page.evaluate(() => {
      const art = document.querySelector('article[data-twblock-author="bob"]');
      const bar = art.querySelector(':scope > .twblock-hidden-bar');
      const stored = JSON.parse(localStorage.getItem('twblock_blockedUsersV2') || '{}');
      return {
        label: bar ? bar.querySelector('.twblock-hidden-label').textContent : null,
        blockCall: window.__apiCalls.some((c) => c.url.includes('blocks/create.json')),
        state: stored.bob,
        blockBtnActive: Boolean(art.querySelector('.twblock-block.twblock-success')),
      };
    });
    check('要望: 切替で blocks/create.json を叩く', escalated.blockCall);
    check('要望: block と mute が両方立つ',
      escalated.state && escalated.state.b === 1 && escalated.state.m === 1, JSON.stringify(escalated.state));
    check('要望: バーの表示がブロック済みに変わる',
      Boolean(escalated.label && !/Muted|ミュート済み/.test(escalated.label)), escalated.label);
    check('要望: ツイート側のブロックボタンも済み表示になる', escalated.blockBtnActive);

    // ---------------------------------------------------------------
    // 4. Issue #15: 解除APIが「もうその状態じゃない」(code 272)を返しても解除できる
    // ---------------------------------------------------------------
    await page.evaluate(() => {
      window.__apiReply = { status: 403, body: { errors: [{ code: 272, message: 'You are not muting the specified user.' }] } };
    });
    await page.evaluate(() => {
      const bar = document.querySelector('article[data-twblock-author="bob"] > .twblock-hidden-bar');
      bar.querySelector('button:not(.twblock-bar-danger)').click();  // ブロック解除
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 900)));
    const afterStuckUndo = await page.evaluate(() => {
      const art = document.querySelector('article[data-twblock-author="bob"]');
      const stored = JSON.parse(localStorage.getItem('twblock_blockedUsersV2') || '{}');
      return {
        state: stored.bob,
        barLabel: (() => {
          const bar = art.querySelector(':scope > .twblock-hidden-bar');
          return bar ? bar.querySelector('.twblock-hidden-label').textContent : null;
        })(),
      };
    });
    check('Issue #15: 403/code272 でもブロック状態が解除される',
      afterStuckUndo.state && afterStuckUndo.state.b === 0, JSON.stringify(afterStuckUndo.state));
    check('Issue #15: ミュートだけ残るのでバーはミュート表示に戻る',
      Boolean(afterStuckUndo.barLabel), afterStuckUndo.barLabel);

    // ミュート側も解除して、本文が戻ることを確認
    await page.evaluate(() => {
      const bar = document.querySelector('article[data-twblock-author="bob"] > .twblock-hidden-bar');
      bar.querySelector('button:not(.twblock-bar-danger)').click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 900)));
    const fullyCleared = await page.evaluate(() => {
      const art = document.querySelector('article[data-twblock-author="bob"]');
      const stored = JSON.parse(localStorage.getItem('twblock_blockedUsersV2') || '{}');
      return {
        hasBar: Boolean(art.querySelector(':scope > .twblock-hidden-bar')),
        contentShown: art.children[0] ? art.children[0].style.display !== 'none' : false,
        entry: stored.bob,
      };
    });
    check('Issue #15: 全部解除でバーが消える', fullyCleared.hasBar === false);
    check('Issue #15: 本文が戻る', fullyCleared.contentShown);
    check('Issue #15: ローカル記録が消える', !fullyCleared.entry);

    // ---------------------------------------------------------------
    // 5. プロフィールでブロック: リロードせず通知バーを出す
    // ---------------------------------------------------------------
    await page.evaluate(() => {
      window.__apiReply = { success: true, body: { ok: 1 } };
      window.__reloaded = false;
      window.reset();
      document.getElementById('root').appendChild(window.buildProfile('frank'));
      history.replaceState({}, '', '/frank');
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
    const profileHasButtons = await page.evaluate(() =>
      document.querySelectorAll('.twblock-btn-container.twblock-profile').length);
    check('プロフィール: ボタンが1つ出る', profileHasButtons === 1, `got ${profileHasButtons}`);

    // X が後からボタンを足しても「X のボタン群 → こちら → Follow」の並びが崩れないこと。
    // Followの直前に挿しているだけだと、後から生えたものがこちらとFollowの間に割り込む
    const beforeLate = await page.evaluate(() => {
      const cont = document.querySelector('.twblock-btn-container.twblock-profile');
      const row = cont.parentElement;
      return [...row.children].map((c) => ({ el: c, x: c.getBoundingClientRect().left }))
        .sort((a, b) => a.x - b.x)
        .map((o) => o.el.getAttribute('data-testid')
          || (String(o.el.className).includes('twblock') ? 'OURS' : '?')).join(' ');
    });
    await page.evaluate(() => window.addLateProfileButton());
    await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
    const afterLate = await page.evaluate(() => {
      const cont = document.querySelector('.twblock-btn-container.twblock-profile');
      const row = cont.parentElement;
      const visual = [...row.children].map((c) => ({ el: c, x: c.getBoundingClientRect().left }))
        .sort((a, b) => a.x - b.x)
        .map((o) => o.el.getAttribute('data-testid')
          || (String(o.el.className).includes('twblock') ? 'OURS' : '?')).join(' ');
      const dom = [...row.children].map((c) => c.getAttribute('data-testid')
        || (String(c.className).includes('twblock') ? 'OURS' : '?')).join(' ');
      return { visual, dom };
    });
    check('プロフィール: 後から足されたボタンが割り込んでも並びが変わらない',
      afterLate.visual === 'userActions lateGiftButton OURS placementTracking',
      `DOM=[${afterLate.dom}] 見た目=[${afterLate.visual}] 元=[${beforeLate}]`);

    let reloaded = false;
    page.on('framenavigated', () => { reloaded = true; });
    await page.evaluate(() => {
      document.querySelector('.twblock-btn-container.twblock-profile .twblock-block').click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1200)));
    const profileAfter = await page.evaluate(() => {
      const notice = document.querySelector('.twblock-notice-bar');
      return {
        hasNotice: Boolean(notice),
        buttons: notice ? [...notice.querySelectorAll('button')].map((b) => b.textContent) : [],
        label: notice ? notice.querySelector('.twblock-hidden-label').textContent : null,
        stillOnProfile: location.pathname === '/frank',
      };
    });
    check('プロフィール: 通知バーに相手のIDは出さない（本人のページなので）',
      Boolean(profileAfter.label) && !profileAfter.label.includes('@'), profileAfter.label);
    check('要望: プロフィールのブロックでリロードしない', reloaded === false && profileAfter.stillOnProfile);
    check('要望: 代わりに通知バーが出る', profileAfter.hasNotice);
    check('要望: 通知バーはリロードだけ（解除はプロフィールのボタン側にある）',
      profileAfter.buttons.length === 1, JSON.stringify(profileAfter.buttons));

    // ミュートでは通知バーを出さない（X側の表示が変わらないので出す意味がない）
    await page.evaluate(() => {
      document.querySelector('.twblock-notice-bar').remove();
      window.reset();
      document.getElementById('root').appendChild(window.buildProfile('grace'));
      history.replaceState({}, '', '/grace');
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 700)));
    await page.evaluate(() => {
      document.querySelector('.twblock-btn-container.twblock-profile .twblock-mute').click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 900)));
    const muteOnProfile = await page.evaluate(() => ({
      notice: Boolean(document.querySelector('.twblock-notice-bar')),
      muted: Boolean(document.querySelector('.twblock-btn-container.twblock-profile .twblock-mute.twblock-success')),
    }));
    check('プロフィールのミュートでは通知バーを出さない', muteOnProfile.notice === false);
    check('プロフィールのミュートはボタンだけ済み表示になる', muteOnProfile.muted);

    // ---------------------------------------------------------------
    // 6. 解除が別の理由で失敗したときの逃げ道
    // ---------------------------------------------------------------
    await page.evaluate(() => {
      window.__apiReply = { success: true, body: { ok: 1 } };
      window.reset();
      history.replaceState({}, '', '/home');
      document.getElementById('root').appendChild(window.buildTweet('heidi'));
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
    await page.evaluate(() => {
      document.querySelector('article[data-twblock-author="heidi"] .twblock-mute').click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 900)));
    // 解除だけ 429（レート制限）で失敗させる
    await page.evaluate(() => { window.__apiReply = { status: 429, body: { errors: [{ code: 88 }] } }; });
    await page.evaluate(() => {
      document.querySelector('article[data-twblock-author="heidi"] > .twblock-hidden-bar button:not(.twblock-bar-danger)').click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 900)));
    const stuck = await page.evaluate(() => {
      const art = document.querySelector('article[data-twblock-author="heidi"]');
      const bar = art.querySelector(':scope > .twblock-hidden-bar');
      return {
        stillHidden: Boolean(bar),
        hasForce: Boolean(bar && bar.querySelector('.twblock-bar-force')),
        stored: JSON.parse(localStorage.getItem('twblock_blockedUsersV2') || '{}').heidi,
      };
    });
    check('失敗時: バーは残り、状態も消えない', stuck.stillHidden && Boolean(stuck.stored));
    check('失敗時: 「強制的に表示」が出る', stuck.hasForce);

    await page.evaluate(() => {
      document.querySelector('article[data-twblock-author="heidi"] .twblock-bar-force').click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
    const forced = await page.evaluate(() => {
      const art = document.querySelector('article[data-twblock-author="heidi"]');
      return {
        hasBar: Boolean(art.querySelector(':scope > .twblock-hidden-bar')),
        contentShown: art.children[0] ? art.children[0].style.display !== 'none' : false,
        stored: JSON.parse(localStorage.getItem('twblock_blockedUsersV2') || '{}').heidi,
      };
    });
    check('失敗時: 強制表示でローカル記録だけ消えて本文が戻る',
      !forced.hasBar && forced.contentShown && !forced.stored,
      JSON.stringify(forced));

    // ---------------------------------------------------------------
    // 7. 一覧の行をプロフィールと取り違えない
    //    （UserCell がまだ付いていない瞬間でも、行のユーザーに対して動くこと）
    // ---------------------------------------------------------------
    await page.evaluate(() => {
      window.reset();
      history.replaceState({}, '', '/frank/followers');
      const li = document.createElement('div');
      li.setAttribute('role', 'listitem');
      const cell = window.buildUserCell('ivan', { testid: '7-follow' });
      // UserCell の印だけまだ付いていない状態を作る
      cell.removeAttribute('data-testid');
      // Follow ボタンを placementTracking で包む（プロフィールと同じ形）
      const followChild = cell.querySelector('[data-testid="7-follow"]').parentElement;
      followChild.setAttribute('data-testid', 'placementTracking');
      li.appendChild(cell);
      document.getElementById('root').appendChild(li);
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 700)));
    const listMisread = await page.evaluate(() => {
      const c = document.querySelector('.twblock-btn-container');
      return {
        name: c ? c.getAttribute('data-screen-name') : null,
        isProfileClass: Boolean(c && c.classList.contains('twblock-profile')),
      };
    });
    check('一覧の行をプロフィール主と取り違えない', listMisread.name === 'ivan', JSON.stringify(listMisread));
    check('一覧の行に twblock-profile が付かない', listMisread.isProfileClass === false);

    // ---------------------------------------------------------------
    // 8. 同じユーザーの投稿が2箇所にあるとき、両方のバーが追随する
    // ---------------------------------------------------------------
    await page.evaluate(() => {
      window.__apiReply = { success: true, body: { ok: 1 } };
      window.reset();
      history.replaceState({}, '', '/home');
      const root = document.getElementById('root');
      root.appendChild(window.buildTweet('judy'));
      root.appendChild(window.buildTweet('judy'));
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 700)));
    await page.evaluate(() => {
      document.querySelectorAll('article[data-twblock-author="judy"] .twblock-mute')[0].click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 900)));
    const bothMuted = await page.evaluate(() =>
      [...document.querySelectorAll('article[data-twblock-author="judy"] > .twblock-hidden-bar')].length);
    check('同一ユーザー: 2枚とも畳まれる', bothMuted === 2, `got ${bothMuted}`);

    await page.evaluate(() => {
      const bar = document.querySelectorAll('article[data-twblock-author="judy"] > .twblock-hidden-bar')[0];
      bar.querySelector('.twblock-bar-danger').click();  // ブロックに切替
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1000)));
    const barsAfterEscalate = await page.evaluate(() => {
      const bars = [...document.querySelectorAll('article[data-twblock-author="judy"] > .twblock-hidden-bar')];
      return {
        labels: bars.map((b) => b.querySelector('.twblock-hidden-label').textContent),
        buttonCounts: bars.map((b) => b.querySelectorAll('button').length),
        blockCalls: window.__apiCalls.filter((c) => c.url.includes('blocks/create.json')).length,
      };
    });
    const sameLabel = new Set(barsAfterEscalate.labels).size === 1;
    check('同一ユーザー: もう片方のバーも「ブロック済み」に追随する',
      sameLabel, JSON.stringify(barsAfterEscalate.labels));
    check('同一ユーザー: 追随後のバーから「切替」が消える',
      barsAfterEscalate.buttonCounts.every((n) => n === 1), JSON.stringify(barsAfterEscalate.buttonCounts));

    // 古いバーの切替を押してもブロックAPIを二度投げない（統計の二重加算防止）
    const statsBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('twblock_stats') || '{}'));
    await page.evaluate(() => {
      const bars = [...document.querySelectorAll('article[data-twblock-author="judy"] > .twblock-hidden-bar')];
      const esc = bars[1].querySelector('.twblock-bar-danger');
      if (esc) esc.click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 700)));
    const statsAfter = await page.evaluate(() => ({
      stats: JSON.parse(localStorage.getItem('twblock_stats') || '{}'),
      blockCalls: window.__apiCalls.filter((c) => c.url.includes('blocks/create.json')).length,
    }));
    check('同一ユーザー: ブロックが二重にカウントされない',
      (statsAfter.stats.blocked || 0) === (statsBefore.blocked || 0),
      JSON.stringify(statsAfter));
    check('同一ユーザー: ブロックAPIも二度投げない',
      statsAfter.blockCalls === barsAfterEscalate.blockCalls,
      `${barsAfterEscalate.blockCalls} -> ${statsAfter.blockCalls}`);

    // ---------------------------------------------------------------
    // 9. block と mute の両方が立っている状態での「強制的に表示」
    // ---------------------------------------------------------------
    await page.evaluate(() => { window.__apiReply = { status: 500, body: {} }; });
    await page.evaluate(() => {
      const bar = document.querySelector('article[data-twblock-author="judy"] > .twblock-hidden-bar');
      bar.querySelector('button:not(.twblock-bar-danger)').click();  // ブロック解除 → 500 で失敗
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 900)));
    await page.evaluate(() => {
      document.querySelector('article[data-twblock-author="judy"] .twblock-bar-force').click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 700)));
    const forcedBoth = await page.evaluate(() => {
      const arts = [...document.querySelectorAll('article[data-twblock-author="judy"]')];
      return {
        bars: arts.filter((a) => a.querySelector(':scope > .twblock-hidden-bar')).length,
        shown: arts.every((a) => a.children[0] && a.children[0].style.display !== 'none'),
        stored: JSON.parse(localStorage.getItem('twblock_blockedUsersV2') || '{}').judy,
      };
    });
    check('強制表示: block と mute の両方が落ちて本文が戻る',
      forcedBoth.bars === 0 && forcedBoth.shown && !forcedBoth.stored,
      JSON.stringify(forcedBoth));

    // ---------------------------------------------------------------
    // 10. プロフィール通知バーが、同じページで解除したときに消える
    // ---------------------------------------------------------------
    await page.evaluate(() => {
      window.__apiReply = { success: true, body: { ok: 1 } };
      window.reset();
      document.getElementById('root').appendChild(window.buildProfile('karl'));
      history.replaceState({}, '', '/karl');
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 700)));
    await page.evaluate(() => {
      document.querySelector('.twblock-btn-container.twblock-profile .twblock-block').click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1000)));
    const noticeShown = await page.evaluate(() => Boolean(document.querySelector('.twblock-notice-bar')));
    check('プロフィール: 通知バーが出る（再確認）', noticeShown);

    await page.evaluate(() => {
      document.querySelector('.twblock-btn-container.twblock-profile .twblock-block').click();  // 解除
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1000)));
    const noticeGone = await page.evaluate(() => ({
      notice: Boolean(document.querySelector('.twblock-notice-bar')),
      stored: JSON.parse(localStorage.getItem('twblock_blockedUsersV2') || '{}').karl,
    }));
    check('プロフィール: 解除したら通知バーも消える',
      noticeGone.notice === false && !noticeGone.stored, JSON.stringify(noticeGone));

    // ---------------------------------------------------------------
    // 11. 「フォロー中の相手をブロックする前に確認」
    // ---------------------------------------------------------------
    check('確認: フォローしていない相手では確認を出さない', dialogs.length === 0, JSON.stringify(dialogs));

    async function blockFresh(name, followReply) {
      await page.evaluate((n, f) => {
        window.__apiReply = { success: true, body: { ok: 1 } };
        window.__followReply = f;
        window.reset();
        history.replaceState({}, '', '/home');
        document.getElementById('root').appendChild(window.buildTweet(n));
      }, name, followReply);
      await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
      await page.evaluate((n) => {
        document.querySelector('article[data-twblock-author="' + n + '"] .twblock-block').click();
      }, name);
      await page.evaluate(() => new Promise((r) => setTimeout(r, 1200)));
    }

    dialogs.length = 0;
    await blockFresh('leo', { relationship: { source: { following: true } } });
    check('確認: フォロー中の相手では確認が出る', dialogs.length === 1, JSON.stringify(dialogs));

    dialogs.length = 0;
    await blockFresh('mona', null);  // friendships/show が 429
    check('確認: フォロー判定に失敗したときも確認が出る（黙って素通ししない）',
      dialogs.length === 1, JSON.stringify(dialogs));

    await page.evaluate(() => { window.__followReply = { relationship: { source: { following: false } } }; });

    // ---------------------------------------------------------------
    // 11b. 表示言語の設定
    // ---------------------------------------------------------------
    async function labelWith(settings, htmlLang) {
      await page.evaluate((s, lang) => {
        document.documentElement.lang = lang;
        localStorage.setItem('twblock_settings', JSON.stringify(s));
        window.dispatchEvent(new StorageEvent('storage', {
          key: 'twblock_settings', newValue: JSON.stringify(s),
        }));
      }, settings, htmlLang);
      await page.evaluate(() => new Promise((r) => setTimeout(r, 700)));
      await page.evaluate(() => {
        window.reset();
        history.replaceState({}, '', '/home');
        document.getElementById('root').appendChild(window.buildTweet('lang_probe'));
      });
      await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
      return page.evaluate(() => {
        const btn = document.querySelector('article[data-twblock-author="lang_probe"] .twblock-block');
        return btn ? btn.getAttribute('aria-label') : null;
      });
    }

    const base = { showBlock: true, showMute: true, confirmBlockFollowing: false };
    const jaFixed = await labelWith(Object.assign({}, base, { language: 'ja' }), 'en');
    check('言語: 日本語を指定するとXが英語でも日本語になる',
      Boolean(jaFixed && jaFixed.indexOf('ブロック') === 0), jaFixed);

    const enFixed = await labelWith(Object.assign({}, base, { language: 'en' }), 'ja');
    check('言語: Englishを指定するとXが日本語でも英語になる',
      Boolean(enFixed && enFixed.indexOf('Block') === 0), enFixed);

    const followSiteEn = await labelWith(Object.assign({}, base, { language: 'x' }), 'en');
    check('言語: Xに合わせる → Xが英語なら英語',
      Boolean(followSiteEn && followSiteEn.indexOf('Block') === 0), followSiteEn);

    const followSiteJa = await labelWith(Object.assign({}, base, { language: 'x' }), 'ja');
    check('言語: Xに合わせる → Xが日本語なら日本語',
      Boolean(followSiteJa && followSiteJa.indexOf('ブロック') === 0), followSiteJa);

    // ブラウザに合わせる = X の言語が変わっても文言が動かないこと
    const browserOnJa = await labelWith(Object.assign({}, base, { language: 'browser' }), 'ja');
    const browserOnEn = await labelWith(Object.assign({}, base, { language: 'browser' }), 'en');
    check('言語: ブラウザに合わせる → Xの言語が変わっても文言が動かない',
      Boolean(browserOnJa) && browserOnJa === browserOnEn,
      `X=ja:[${browserOnJa}] X=en:[${browserOnEn}]`);

    await page.evaluate(() => {
      document.documentElement.lang = 'en';
      const s = { showBlock: true, showMute: true, confirmBlockFollowing: true, language: 'en' };
      localStorage.setItem('twblock_settings', JSON.stringify(s));
      window.dispatchEvent(new StorageEvent('storage', { key: 'twblock_settings', newValue: JSON.stringify(s) }));
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 700)));

    // ---------------------------------------------------------------
    // 11c. ブロックボタンを隠していても、バーの「ブロックに切替」は出す
    // ---------------------------------------------------------------
    await page.evaluate(() => {
      window.__apiReply = { success: true, body: { ok: 1 } };
      const s = { showBlock: false, showMute: true, confirmBlockFollowing: false, language: 'ja' };
      localStorage.setItem('twblock_settings', JSON.stringify(s));
      window.dispatchEvent(new StorageEvent('storage', { key: 'twblock_settings', newValue: JSON.stringify(s) }));
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 700)));
    await page.evaluate(() => {
      window.reset();
      history.replaceState({}, '', '/home');
      document.getElementById('root').appendChild(window.buildTweet('rita'));
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
    const hiddenBlockBtn = await page.evaluate(() => ({
      blockButtons: document.querySelectorAll('article[data-twblock-author="rita"] .twblock-block').length,
      muteButtons: document.querySelectorAll('article[data-twblock-author="rita"] .twblock-mute').length,
    }));
    check('設定: ブロックボタンを隠すとTLには出ない',
      hiddenBlockBtn.blockButtons === 0 && hiddenBlockBtn.muteButtons === 1, JSON.stringify(hiddenBlockBtn));

    await page.evaluate(() => {
      document.querySelector('article[data-twblock-author="rita"] .twblock-mute').click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 900)));
    const barWithHiddenBlock = await page.evaluate(() => {
      const bar = document.querySelector('article[data-twblock-author="rita"] > .twblock-hidden-bar');
      return bar ? [...bar.querySelectorAll('button')].map((b) => b.textContent) : null;
    });
    check('設定: それでもバーには「ブロックに切替」が出る',
      Array.isArray(barWithHiddenBlock) && barWithHiddenBlock.length === 2,
      JSON.stringify(barWithHiddenBlock));

    await page.evaluate(() => {
      const s = { showBlock: true, showMute: true, confirmBlockFollowing: true, language: 'en' };
      localStorage.setItem('twblock_settings', JSON.stringify(s));
      window.dispatchEvent(new StorageEvent('storage', { key: 'twblock_settings', newValue: JSON.stringify(s) }));
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 700)));

    // ---------------------------------------------------------------
    // 12. リポスト行のボタンで押したときも投稿が畳まれる
    // ---------------------------------------------------------------
    await page.evaluate(() => {
      window.__apiReply = { success: true, body: { ok: 1 } };
      window.reset();
      history.replaceState({}, '', '/home');
      const root = document.getElementById('root');
      root.appendChild(window.buildTweet('nina', { retweeter: 'oscar' }));
      root.appendChild(window.buildTweet('paul', { retweeter: 'oscar' }));
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 700)));
    await page.evaluate(() => {
      document.querySelector('.twblock-repost[data-screen-name="oscar"] .twblock-mute').click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1000)));
    const repostHidden = await page.evaluate(() => {
      const arts = [...document.querySelectorAll('article[data-testid="tweet"]')];
      return {
        bars: arts.filter((a) => a.querySelector(':scope > .twblock-hidden-bar')).length,
        hidden: arts.filter((a) => a.children[1] && a.children[1].style.display === 'none').length,
        stored: JSON.parse(localStorage.getItem('twblock_blockedUsersV2') || '{}').oscar,
      };
    });
    check('リポスト: RT者をミュートしたらその投稿が畳まれる',
      repostHidden.bars === 2 && Boolean(repostHidden.stored), JSON.stringify(repostHidden));

    // 別人の投稿は畳まれない（属性の取り違えが無いこと）
    await page.evaluate(() => {
      const root = document.getElementById('root');
      root.appendChild(window.buildTweet('quinn'));
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
    const otherUntouched = await page.evaluate(() => {
      const art = document.querySelector('article[data-twblock-author="quinn"]');
      return Boolean(art && !art.querySelector(':scope > .twblock-hidden-bar'));
    });
    check('リポスト: 無関係な投稿は畳まれない', otherUntouched);

    // ---------------------------------------------------------------
    // 13. 引用ツイート: 畳んだバーが引用カードからはみ出さない
    // ---------------------------------------------------------------
    await page.evaluate(() => {
      window.__apiReply = { success: true, body: { ok: 1 } };
      window.reset();
      history.replaceState({}, '', '/home');
      document.getElementById('root').appendChild(window.buildQuotedTweet('sam', 'tina'));
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 700)));
    const quotedButtons = await page.evaluate(() => ({
      onQuote: document.querySelectorAll('[data-twblock-quoted="tina"] .twblock-btn-container').length,
      onOuter: document.querySelectorAll('article[data-twblock-author="sam"] > div > .twblock-btn-container').length,
    }));
    check('引用: 引用元にもボタンが出る',
      quotedButtons.onQuote === 1, JSON.stringify(quotedButtons));

    await page.evaluate(() => {
      document.querySelector('[data-twblock-quoted="tina"] .twblock-mute').click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 900)));
    const quotedBar = await page.evaluate(() => {
      const block = document.querySelector('[data-twblock-quoted="tina"]');
      const bar = block && block.querySelector(':scope > .twblock-hidden-bar');
      if (!bar) return { hasBar: false };
      const br = block.getBoundingClientRect();
      const r = bar.getBoundingClientRect();
      const btns = [...bar.querySelectorAll('button')];
      return {
        hasBar: true,
        boxSizing: getComputedStyle(bar).boxSizing,
        overflowRight: Math.round(r.right - br.right),
        buttonOverflow: Math.round(Math.max(...btns.map((b) => b.getBoundingClientRect().right)) - br.right),
        above: Math.round(r.top - br.top),
        below: Math.round(br.bottom - r.bottom),
        cardHeight: Math.round(br.height),
        barHeight: Math.round(r.height),
        outerIntact: !document.querySelector('article[data-twblock-author="sam"] > .twblock-hidden-bar'),
      };
    });
    check('引用: 引用元をミュートすると引用カードだけ畳まれる',
      quotedBar.hasBar === true && quotedBar.outerIntact === true, JSON.stringify(quotedBar));
    // width:100% と padding が足し算になると、右に寄せたボタンがカードの外へ出る。
    // 実ページでは 31px はみ出して、引用の枠を越えて本体の右端まで届いていた
    check('引用: バーがカードからはみ出さない（box-sizing）',
      quotedBar.overflowRight !== undefined && quotedBar.overflowRight <= 0,
      `bar が ${quotedBar.overflowRight}px はみ出し / box-sizing=${quotedBar.boxSizing}`);
    check('引用: ボタンがカードの内側に収まる',
      quotedBar.buttonOverflow !== undefined && quotedBar.buttonOverflow <= 0,
      `button が ${quotedBar.buttonOverflow}px はみ出し`);
    // カードの min-height がバーより高いと、余りが全部下に落ちて下だけ長く見える
    check('引用: バーがカードの上下中央に来る',
      quotedBar.above !== undefined && Math.abs(quotedBar.above - quotedBar.below) <= 1,
      `上 ${quotedBar.above}px / 下 ${quotedBar.below}px`);

    // ---------------------------------------------------------------
    // 狭い画面: ヘッダーに Follow ボタンが足されると、X は caret/grok を
    // 1段内側の行に包み直す。先に入れたボタンだけ外側の行に取り残されると、
    // 行の高さが変わって 6px 浮く（実測: 他は中心 y=81、うちだけ 75）
    // ---------------------------------------------------------------
    await page.evaluate(() => {
      window.reset();
      document.getElementById('root').appendChild(window.buildTweet('nate'));
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
    const beforeNarrow = await page.evaluate(() =>
      document.querySelectorAll('article[data-testid="tweet"] .twblock-btn-container').length);
    check('狭い画面: まず通常どおりボタンが1つ入る', beforeNarrow === 1, `got ${beforeNarrow}`);

    await page.evaluate(() => {
      const bar = document.querySelector('article .actionbar');
      const inner = document.createElement('div');
      inner.className = 'row';
      [...bar.children].forEach((child) => {
        if (child.querySelector('[aria-label^="Grok"], [data-testid="caret"]')) inner.appendChild(child);
      });
      const followWrap = document.createElement('div');
      followWrap.className = 'row';
      const follow = document.createElement('button');
      follow.setAttribute('data-testid', '77-follow');
      follow.textContent = 'Follow';
      followWrap.appendChild(follow);
      inner.insertBefore(followWrap, inner.firstChild);
      bar.appendChild(inner);
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));

    const narrow = await page.evaluate(() => {
      const art = document.querySelector('article[data-testid="tweet"]');
      const inner = [...art.querySelectorAll('.row')].find((r) => r.querySelector('[aria-label^="Grok"]'));
      const cont = art.querySelector('.twblock-btn-container');
      const mid = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
      return {
        count: art.querySelectorAll('.twblock-btn-container').length,
        inGrokRow: Boolean(inner && inner.querySelector(':scope > .twblock-btn-container')),
        beforeFollow: Boolean(cont.nextElementSibling && cont.nextElementSibling.querySelector('[data-testid$="-follow"]')),
        gap: Math.abs(mid(cont) - mid(art.querySelector('[data-testid="caret"]'))),
      };
    });
    check('狭い画面: Follow が足されたらボタンをgrok行へ入れ直す', narrow.inGrokRow, JSON.stringify(narrow));
    check('狭い画面: Follow の左に置く', narrow.beforeFollow, JSON.stringify(narrow));
    check('狭い画面: 入れ直しても二重にならない', narrow.count === 1, `got ${narrow.count}`);
    check('狭い画面: caret と同じ高さに揃う', narrow.gap <= 1, `ずれ ${narrow.gap}px`);

    // X はこの行を後から作り直して並べ替える。Follow の後・grok の前に戻ること
    await page.evaluate(() => {
      const inner = [...document.querySelectorAll('article .row')].find((r) => r.querySelector('[aria-label^="Grok"]'));
      inner.appendChild(inner.querySelector('.twblock-btn-container'));
      // 作り直しを模して Follow ボタンを差し替える（X は data-testid ごと作り直す）
      const wrap = document.querySelector('article [data-testid="77-follow"]').parentElement;
      wrap.innerHTML = '<button data-testid="77-follow">Follow</button>';
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
    const order = await page.evaluate(() => {
      const art = document.querySelector('article[data-testid="tweet"]');
      const cont = art.querySelector('.twblock-btn-container');
      const next = cont.nextElementSibling;
      return {
        count: art.querySelectorAll('.twblock-btn-container').length,
        beforeFollow: Boolean(next && next.querySelector('[data-testid$="-follow"]')),
      };
    });
    check('狭い画面: 並べ替えられても Follow の直前に戻る', order.beforeFollow, JSON.stringify(order));
    check('狭い画面: 戻した後も二重にならない', order.count === 1, `got ${order.count}`);

    // ---------------------------------------------------------------
    // TL から遷移したとき: X はこちらが入れた後で行をもう1段深く包み直す。
    // Follow ボタン自体は作り直されない（data-testid が変わらない＝isNew が立たない）ので、
    // 「作り直された回だけ入れ直す」実装だと外側の行に取り残されたままになる。
    // リロードでは最初から最終形なので気づけない
    // ---------------------------------------------------------------
    await page.evaluate(() => {
      const art = document.querySelector('article[data-testid="tweet"]');
      const outer = art.querySelector('.twblock-btn-container').parentElement;
      const deeper = document.createElement('div');
      deeper.className = 'row';
      // Follow / grok / caret だけを1段内側へ移す。こちらのボタンは外側に残る
      [...outer.children].forEach((child) => {
        if (child.querySelector('[data-testid$="-follow"], [aria-label^="Grok"], [data-testid="caret"]')) {
          deeper.appendChild(child);
        }
      });
      outer.style.alignItems = 'flex-start';
      outer.style.minHeight = '40px';
      outer.appendChild(deeper);
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 800)));
    const moved = await page.evaluate(() => {
      const art = document.querySelector('article[data-testid="tweet"]');
      const cont = art.querySelector('.twblock-btn-container');
      const follow = art.querySelector('[data-testid$="-follow"]');
      const mid = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
      return {
        count: art.querySelectorAll('.twblock-btn-container').length,
        sameRow: cont.parentElement === follow.parentElement.parentElement,
        beforeFollow: Boolean(cont.nextElementSibling && cont.nextElementSibling.contains(follow)),
        gap: Math.abs(mid(cont) - mid(follow)),
      };
    });
    check('TL遷移: 後から包み直されても Follow と同じ行に入り直す', moved.sameRow, JSON.stringify(moved));
    check('TL遷移: Follow の直前に戻る', moved.beforeFollow, JSON.stringify(moved));
    check('TL遷移: 入れ直しても二重にならない', moved.count === 1, JSON.stringify(moved));
    check('TL遷移: Follow と中心が揃う', moved.gap <= 1, `ずれ ${moved.gap}px`);

    // ---------------------------------------------------------------
    // 丸で囲うのは Follow が 32px の pill のときだけ。
    // スマホの X は同じボタンを 24px で出すので、そこに 32px の丸を付けると
    // grok や ⋯ より大きい輪になり、上揃えの行では 4px 下にはみ出す（iPhone実測）
    // ---------------------------------------------------------------
    await page.addStyleTag({ path: path.join(ROOT, 'styles.css') });
    const headerLook = async (followStyle) => {
      await page.evaluate((style) => {
        const inner = [...document.querySelectorAll('article .row')].find((r) => r.querySelector('[aria-label^="Grok"]'));
        inner.style.alignItems = 'flex-start';
        const wrap = document.querySelector('article [data-testid$="-follow"], article [data-testid$="-unfollow"]').parentElement;
        // X の作り直しを模す（data-testid ごと作り直すと isNew が立つ）
        wrap.innerHTML = '<button data-testid="77-follow" style="' + style + '">Follow</button>';
      }, followStyle);
      await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
      return page.evaluate(() => {
        const art = document.querySelector('article[data-testid="tweet"]');
        const cont = art.querySelector('.twblock-btn-container');
        const btn = cont.querySelector('.twblock-btn');
        const follow = art.querySelector('[data-testid$="-follow"]');
        const mid = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
        return {
          pill: cont.classList.contains('twblock-pill'),
          size: btn.getBoundingClientRect().height,
          border: getComputedStyle(btn).borderTopStyle,
          gap: Math.abs(mid(cont) - mid(follow)),
        };
      });
    };

    const phone = await headerLook('min-height:24px;height:24px;padding:0 16px');
    check('スマホ(24px): 丸で囲わない', phone.pill === false && phone.border === 'none', JSON.stringify(phone));
    check('スマホ(24px): 従来どおり20pxのアイコン', phone.size === 20, JSON.stringify(phone));
    check('スマホ(24px): 上揃えの行でも Follow と中心が揃う', phone.gap <= 1, `ずれ ${phone.gap}px`);

    const pc = await headerLook('min-height:32px;height:32px;padding:0 16px');
    check('PC狭い窓(32px): 丸で囲う', pc.pill === true && pc.border === 'solid', JSON.stringify(pc));
    check('PC狭い窓(32px): Follow と同じ 32px', pc.size === 32, JSON.stringify(pc));
    check('PC狭い窓(32px): 中心が揃う', pc.gap <= 1, `ずれ ${pc.gap}px`);

    // 窓を広げて Follow が消えたら、印が残っていても丸は消える（:has() が外れる）
    const widened = await page.evaluate(() => {
      const art = document.querySelector('article[data-testid="tweet"]');
      art.querySelector('[data-testid$="-follow"]').remove();
      const cont = art.querySelector('.twblock-btn-container');
      const btn = cont.querySelector('.twblock-btn');
      return {
        stillStamped: cont.classList.contains('twblock-pill'),
        border: getComputedStyle(btn).borderTopStyle,
        size: btn.getBoundingClientRect().height,
      };
    });
    check('窓を広げたら丸は自分で消える', widened.border === 'none' && widened.size === 20, JSON.stringify(widened));

    // ---------------------------------------------------------------
    // ホバーカード: メンションをホバーすると出るカード。
    // 行は align-items:stretch で高さを 64px のアバターが決め、Followボタン(36px)は
    // その上端に置かれる。共通の center 揃えのままだと自分のボタンだけ 14px 下に落ちる
    // ---------------------------------------------------------------
    await page.evaluate(() => {
      window.reset();
      const layers = document.getElementById('layers');
      layers.textContent = '';
      layers.appendChild(window.buildHoverCard('carol', { testid: '9001-follow' }));
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));

    const hover = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="HoverCard"]');
      const cont = card.querySelector('.twblock-btn-container');
      if (!cont) return { missing: true };
      const follow = card.querySelector('[data-testid$="-follow"]');
      const mid = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
      return {
        count: card.querySelectorAll('.twblock-btn-container').length,
        tagged: cont.classList.contains('twblock-hovercard'),
        gap: Math.abs(mid(cont.querySelector('.twblock-btn')) - mid(follow)),
        beforeFollow: cont.nextElementSibling === follow.parentElement,
      };
    });
    check('ホバーカード: コンテナが1つ入る', hover.count === 1 && hover.tagged, JSON.stringify(hover));
    check('ホバーカード: Follow の直前に置かれる', hover.beforeFollow === true, JSON.stringify(hover));
    check('ホバーカード: Follow と中心が揃う', hover.gap <= 1, `ずれ ${hover.gap}px`);

    // ---------------------------------------------------------------
    // 15. x-web（ログアウト中に配られる新しいフロント）
    //     data-testid が無く、投稿は [data-timeline-entry] > article。
    //     サンプルは実際の会話ページ（本体 + 引用 + 返信3件）を匿名化したもの
    // ---------------------------------------------------------------
    const xwebSample = fs.readFileSync(path.join(__dirname, 'xweb-status.html'), 'utf8');
    const mountXweb = (html, url) => page.evaluate((html, url) => {
      window.reset();
      history.replaceState({}, '', url || '/xw_author/status/1002');
      // SPA の遷移と同じく、出来上がった木をまとめて差し込む
      const holder = document.createElement('div');
      holder.innerHTML = html;
      document.getElementById('root').appendChild(holder);
    }, html, url);

    await page.evaluate(() => { document.cookie = 'ct0=testcsrftoken; path=/'; window.__apiReply = { success: true }; });
    await mountXweb(xwebSample);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));

    const xweb = await page.evaluate(() => {
      const tops = [...document.querySelectorAll('[data-timeline-entry] > article')]
        .filter((a) => !a.parentElement.closest('article'));
      const quote = document.querySelector('article [data-timeline-entry] > article');
      return {
        authors: tops.map((a) => a.getAttribute('data-twblock-author')),
        // ボタンは「もっと見る」の直前に1つ。X のボタンは包み直さない
        beforeMore: tops.map((a) => {
          const conts = [...a.querySelectorAll('.twblock-btn-container')].filter((c) => !c.closest('[data-twblock-quoted]'));
          const more = a.querySelector('button[aria-label="もっと見る"]');
          return conts.length === 1 && conts[0].nextElementSibling === more &&
            conts[0].getAttribute('data-screen-name') === a.getAttribute('data-twblock-author');
        }),
        quoted: quote && quote.getAttribute('data-twblock-quoted'),
        quoteButtons: quote ? [...quote.querySelectorAll('.twblock-btn-container')].map((c) => c.getAttribute('data-screen-name')) : null,
        quoteRowHasAvatar: Boolean(quote && quote.querySelector('.twblock-btn-container')
          && quote.querySelector('.twblock-btn-container').parentElement.querySelector('.x-avatar')),
      };
    });
    check('x-web: 本体と返信の著者を取れる（本体は data-href が無く日時のリンクから）',
      JSON.stringify(xweb.authors) === '["xw_author","xw_reply1","xw_reply2","xw_reply3"]', JSON.stringify(xweb.authors));
    check('x-web: 各投稿の「もっと見る」の直前にボタンが1つ', xweb.beforeMore.every(Boolean), JSON.stringify(xweb.beforeMore));
    check('x-web: 引用カードを引用として扱う', xweb.quoted === 'xw_quoted', xweb.quoted);
    check('x-web: 引用カードのボタンはアバターと名前の行に1つ',
      JSON.stringify(xweb.quoteButtons) === '["xw_quoted"]' && xweb.quoteRowHasAvatar, JSON.stringify(xweb));

    // ログイン中なら x-web でも従来どおり API を叩いて畳む
    await page.evaluate(() => {
      document.querySelector('article[data-twblock-author="xw_reply1"] .twblock-mute').click();
      document.querySelector('[data-twblock-quoted="xw_quoted"] .twblock-block').click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 900)));
    const xwebActed = await page.evaluate(() => {
      const reply = document.querySelector('article[data-twblock-author="xw_reply1"]');
      const quote = document.querySelector('[data-twblock-quoted="xw_quoted"]');
      return {
        replyBar: reply.firstElementChild.classList.contains('twblock-hidden-bar'),
        quoteBar: quote.firstElementChild.classList.contains('twblock-hidden-bar'),
        outerOpen: !document.querySelector('article[data-twblock-author="xw_author"]').hasAttribute('data-twblock-collapsed'),
        calls: window.__apiCalls.filter((c) => /mutes\/users\/create|blocks\/create/.test(c.url)).length,
      };
    });
    check('x-web: ミュートした返信が畳まれる', xwebActed.replyBar, JSON.stringify(xwebActed));
    check('x-web: ブロックした引用はカードだけ畳まれる', xwebActed.quoteBar && xwebActed.outerOpen, JSON.stringify(xwebActed));

    // ログアウト: ct0 が消える。ボタンは出さず、記録済みの相手は畳んだまま
    await page.evaluate(() => {
      document.cookie = 'ct0=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
      document.cookie = 'ct0=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
      window.__callsAtLogout = window.__apiCalls.length;
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
    const loggedOut = await page.evaluate(() => {
      const reply = document.querySelector('article[data-twblock-author="xw_reply1"]');
      const bar = reply.querySelector(':scope > .twblock-hidden-bar');
      const qbar = document.querySelector('[data-twblock-quoted="xw_quoted"] > .twblock-hidden-bar');
      return {
        noCookie: !/(?:^|;\s*)ct0=[^;]/.test(document.cookie),
        containers: document.querySelectorAll('#root .twblock-btn-container').length,
        // 文言は表示言語の設定（11b）に左右されるので、どれでもよい
        replyButtons: bar ? [...bar.querySelectorAll('button')].map((b) => /^(Show|表示|显示)$/.test(b.textContent) ? 'show' : b.textContent) : null,
        quoteButtons: qbar ? [...qbar.querySelectorAll('button')].map((b) => /^(Show|表示|显示)$/.test(b.textContent) ? 'show' : b.textContent) : null,
      };
    });
    check('ログアウト: ct0 が消えている（前提）', loggedOut.noCookie);
    check('ログアウト: 必ず失敗するブロック/ミュートボタンは出さない', loggedOut.containers === 0, `got ${loggedOut.containers}`);
    check('ログアウト: 記録済みの返信は畳んだまま、バーは「表示」だけ',
      JSON.stringify(loggedOut.replyButtons) === '["show"]', JSON.stringify(loggedOut.replyButtons));
    check('ログアウト: 記録済みの引用も「表示」だけ',
      JSON.stringify(loggedOut.quoteButtons) === '["show"]', JSON.stringify(loggedOut.quoteButtons));

    // 「表示」はこの投稿を開くだけ。記録は消さず、API も叩かない
    await page.evaluate(() => {
      document.querySelector('article[data-twblock-author="xw_reply1"] > .twblock-hidden-bar button').click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
    const revealed = await page.evaluate(() => {
      const reply = document.querySelector('article[data-twblock-author="xw_reply1"]');
      return {
        open: !reply.querySelector('.twblock-hidden-bar') && !reply.hasAttribute('data-twblock-collapsed') &&
          [...reply.children].every((c) => getComputedStyle(c).display !== 'none'),
        stored: JSON.parse(localStorage.getItem('twblock_blockedUsersV2') || '{}').xw_reply1,
        newCalls: window.__apiCalls.length - window.__callsAtLogout,
      };
    });
    check('ログアウト: 「表示」で中身が戻る', revealed.open, JSON.stringify(revealed));
    check('ログアウト: 「表示」は記録を消さない', Boolean(revealed.stored && revealed.stored.m === 1), JSON.stringify(revealed.stored));
    check('ログアウト: API を1度も叩いていない', revealed.newCalls === 0, `got ${revealed.newCalls}`);

    // SPA で別の会話へ移ると木ごと差し替わる。data-testid が無くても拾い直す
    await mountXweb(xwebSample);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
    const remounted = await page.evaluate(() => ({
      reply: Boolean(document.querySelector('article[data-twblock-author="xw_reply1"] > .twblock-hidden-bar')),
      others: document.querySelectorAll('#root .twblock-hidden-bar').length,
    }));
    check('x-web: 差し替わった木でも記録済みの相手を畳む', remounted.reply && remounted.others === 2, JSON.stringify(remounted));

    // スマホ幅: 投稿へのリンクと data-href が https://m.x.com/... の絶対URLになる
    const xwebMobile = fs.readFileSync(path.join(__dirname, 'xweb-status-mobile.html'), 'utf8');
    await mountXweb(xwebMobile);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
    const mobile = await page.evaluate(() => ({
      authors: [...document.querySelectorAll('[data-twblock-author]')].map((a) => a.getAttribute('data-twblock-author')),
      quoted: [...document.querySelectorAll('[data-twblock-quoted]')].map((a) => a.getAttribute('data-twblock-quoted')),
      bars: [...document.querySelectorAll('#root .twblock-hidden-bar')].map((b) => b.getAttribute('data-screen-name')),
    }));
    check('x-web(スマホ幅): 絶対URLからも著者を取れる',
      JSON.stringify(mobile.authors) === '["xw_author","xw_reply1","xw_reply2","xw_reply3"]' &&
      JSON.stringify(mobile.quoted) === '["xw_quoted"]', JSON.stringify(mobile));
    check('x-web(スマホ幅): 記録済みの相手を畳む',
      JSON.stringify(mobile.bars.sort()) === '["xw_quoted","xw_reply1"]', JSON.stringify(mobile.bars));

    // 相手のプロフィールでは、その人の投稿は畳まない（従来と同じ）
    await mountXweb(xwebSample, '/xw_reply1');
    await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
    const onProfile = await page.evaluate(() => ({
      reply: Boolean(document.querySelector('article[data-twblock-author="xw_reply1"] > .twblock-hidden-bar')),
      quote: Boolean(document.querySelector('[data-twblock-quoted="xw_quoted"] > .twblock-hidden-bar')),
    }));
    check('x-web: 本人のプロフィールではその人の投稿を畳まない', !onProfile.reply && onProfile.quote, JSON.stringify(onProfile));

    // 再ログインで ct0 が戻ると、ボタンと「解除」のバーに戻る
    await page.evaluate(() => { document.cookie = 'ct0=testcsrftoken; path=/'; });
    await mountXweb(xwebSample);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
    const relogged = await page.evaluate(() => {
      const bar = document.querySelector('article[data-twblock-author="xw_reply1"] > .twblock-hidden-bar');
      return {
        containers: document.querySelectorAll('#root .twblock-btn-container').length,
        buttons: bar ? [...bar.querySelectorAll('button')].map((b) => b.classList.contains('twblock-bar-danger') ? 'switch' : 'undo') : null,
      };
    });
    check('再ログイン: ボタンが戻る', relogged.containers === 5, `got ${relogged.containers}`);
    check('再ログイン: バーが「ブロックに切替」「ミュート解除」に戻る',
      JSON.stringify(relogged.buttons) === '["switch","undo"]', JSON.stringify(relogged.buttons));


  } finally {
    await browser.close();
    server.close();
  }

  await xwebHarnessTests();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
