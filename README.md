# Ultimate Twitter Block

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/ljfgdpcinehhgcfcjalfidjbhnnjcgdn?logo=googlechrome&logoColor=white&label=Chrome%20Web%20Store&color=4285F4)](https://chromewebstore.google.com/detail/ljfgdpcinehhgcfcjalfidjbhnnjcgdn)
[![Users](https://img.shields.io/chrome-web-store/users/ljfgdpcinehhgcfcjalfidjbhnnjcgdn?label=users&color=4285F4)](https://chromewebstore.google.com/detail/ljfgdpcinehhgcfcjalfidjbhnnjcgdn)
[![GitHub release](https://img.shields.io/github/v/release/satomasahiro2005/ultimate-twitter-block?logo=github&label=release)](https://github.com/satomasahiro2005/ultimate-twitter-block/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

![Ultimate Twitter Block のスクリーンショット](images/screenshot.png)

Twitterの究極のブロックツール。ツイート・RT・引用RT・プロフィールすべてにワンクリックのブロック＆ミュートボタンを追加するブラウザ拡張機能です。TwitterのUIに完全に溶け込むデザインで、違和感なく使えます。

[![Install from Chrome Web Store](https://img.shields.io/badge/Install%20from%20Chrome%20Web%20Store-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/ljfgdpcinehhgcfcjalfidjbhnnjcgdn)

## 特徴

- TwitterのネイティブUIに完全に馴染むデザイン
- 軽量で高速：パフォーマンスに影響しません
- ブロック・ミュートボタンの表示/非表示を個別に設定可能
- フォロー中のユーザーをブロックする前に確認する機能
  - **デフォルトでオンにしました！！(v2.2.3)**
- ミュートで畳んだ後、そのままブロックに切り替えられる (v2.3.0)
- プロフィールでのブロックがページを再読み込みしなくなった (v2.3.0)
- 統計機能：ブロック・ミュート回数を記録
- 日本語 / English / 简体中文 対応

## 機能

### ブロック
見たくないユーザーをワンクリックで排除します。ブロックされたユーザーのツイートはタイムラインに表示されなくなり、あなたのプロフィールも閲覧できなくなります。

### ミュート
フォローしているけどタイムラインには表示したくないユーザーをワンクリックで非表示にします。フォロー関係はそのまま維持されますが、そのユーザーのツイートはTLに流れなくなります。

### リツイート対応
リツイート(リポスト)にも対応。「○○さんがリポスト」の横にRT者用のブロック・ミュートボタンが表示され、ツイート本体には元の投稿者用のボタンが表示されます。RTで流れてくる不快なツイートの元凶を即ブロックできます。

### ミュートからブロックへ切り替え
ミュートするとツイートが畳まれてボタンも隠れてしまうので、畳んだ後に出るバーに「ブロックに切替」を用意しました。押し間違えたときや、やっぱりブロックしたくなったときにそのまま切り替えられます。

### プロフィールでのブロック
以前はブロック直後にページを再読み込みしていましたが、やめました。代わりに「ブロックしました」というバーが出て、そこから解除や再読み込みができます。X側の表示（Followボタンなど）は再読み込みするまで古いままなので、気になるときだけ押してください。設定で以前どおりの自動再読み込みに戻せます。

### 別の端末で解除したとき
別の端末や公式アプリでミュート/ブロックを解除すると、この拡張のローカル記録だけが残ることがあります。畳まれた投稿の「解除」ボタンを押せばその場で整合します（X が「もう解除済み」と答えたら、そのまま記録を落とします）。

## ボタンの表示場所

- タイムラインのツイート
- リツイート(RT者 + 元の投稿者を個別に対応)
- プロフィールページ
- おすすめユーザー(You might like)
- フォロー/フォロワー一覧
- 引用ツイート
- ホバーカード

## インストール

### Chrome (推奨)

[**Chrome ウェブストアからインストール**](https://chromewebstore.google.com/detail/ljfgdpcinehhgcfcjalfidjbhnnjcgdn)

### Firefox

1. [Releases](https://github.com/satomasahiro2005/ultimate-twitter-block/releases)から最新のZIPをダウンロード
2. `about:debugging#/runtime/this-firefox` を開く
3. 「一時的なアドオンを読み込む」でZIPファイルを選択

### ユーザースクリプト (Tampermonkey / Violentmonkey)

[**twitter-block.user.js をインストール**](https://raw.githubusercontent.com/satomasahiro2005/ultimate-twitter-block/main/userscripts/twitter-block.user.js)

バージョンが更新されるとTampermonkey/Violentmonkeyが自動で更新通知を出します。

> **Note:** ユーザースクリプト版に設定画面はありません。ボタンは両方表示、フォロー中ユーザーをブロックする前に確認、プロフィールでのブロック後は再読み込みしない、が固定です。
> 変えたい場合はChrome拡張版を使うか、DevTools で `localStorage.twblock_settings` を書き換えてください。

## ビルド

```bash
node build.js            # ZIP + ユーザースクリプト両方
node build.js zip        # ZIPのみ
node build.js userscript # ユーザースクリプトのみ
node build.js check      # ビルドせず検証だけ
```

`build.js` はビルド前後に次を検証し、1つでも落ちたら中断します。

- `_locales` 3言語のキーとプレースホルダが一致していること
- 全JSの構文
- `content.js` の `chrome.*` が `/* @twblock:*-start */` マーカー区間の中だけに閉じていること
- `content.js` と生成したユーザースクリプトを最小DOMスタブ上で起動し、`init()` が完走すること（拡張版は `chrome.*` スタブ、ユーザースクリプト版は localStorage で別々に）

最後の1つは v2.2.4 のユーザースクリプトが `init()` の途中で例外死してボタンを1つも出せていなかったのを受けて追加したものです。

## テスト

```bash
node tests/dom.test.js   # 実Chrome上でX風DOMに対する回帰テスト
```

puppeteer-core と Chrome が要ります。見つからない場合はスキップします。

## 対応言語

- 日本語
- English
- 简体中文

## ライセンス

MIT

## クレジット

フォールバック用の一部アイコンに [Material Design Icons](https://github.com/google/material-design-icons)（Apache License 2.0）を使用しています。

