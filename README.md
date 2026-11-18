# app-itonami-explorer — Explorer

kotoba の Datom ログ（content-addressed な追記型の commit 鎖）を手元で読み込み、すべての CID を計算し直して鎖を検証し、EAVT で entity を見て、属性で問い合わせます。

Tauri **3.0.0-alpha.6** の独立 app（`tauri-runtime-wry`、OS の WebView）と、同じファイルの static Web ビルドです。記録はすべてこの端末の中（localStorage、key `itonami.explorer.v1`）に保存し、外部へは通信しません。外部操作の宣言もありません（`dist/descriptor.json` の `operations: []`）。保存に失敗したときは画面に表示します。

## できること

| 操作 | 内容 |
| --- | --- |
| ログを読み込む (importLog) | 1 行 1 transaction の EDN（kotoba.datom の tx->edn-line 形式）を貼り付けます。最大 200 万文字。 |
| 鎖を検証 (verifyLog) | 各 transaction の CID を datoms と直前の CID から計算し直します。1 つでも改ざんがあれば、そこから先が合わなくなります。 |
| entity の一覧 (listEntities) | — |
| entity を見る (browseEntity) | — |
| 属性で探す (queryDatoms) | attribute は :actor/status のように書きます。value を入れると、その値の entity だけを返します。 |
| 読み込んだログ (listLogs) | — |

記録（collection）: `cloud.itonami.apps.explorer.datomLog`

## 補足

- **旧 SPA との違い:** 旧 SPA は apex の Worker から snapshot と block を取得していました。この app は通信しないので、Datom ログは人が貼り付けて読み込みます。organism / nodes の表示は移していません（aliveness の計算は app-itonami-organism-viz にあります）。
- CID の計算（`src/domain/datom.ts`）は kotoba-lang/kotodama の `kotoba.datom` の移植です。テストの CID は、Python 3.15 の `json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=False)` と `hashlib.sha256` で 2026-11-17 に一度だけ計算した参照値（oracle）です。
- EDN の浮動小数点は元の表記のまま CID の計算に使うので、Python / JVM が書いた `1.0` は `1.0` のまま扱います。
- 旧 cljs SPA（`src/itonami/`、`test/itonami/`、`public/`、`shadow-cljs.edn`、`actor-registry/`、`visual-test/`）は残しています。`package.json` は Tauri app 用に置き換えたので、旧 SPA の `amu` ビルドの script はなくなりました。

## 構成

| パス | 役割 |
| --- | --- |
| `src/domain/` | domain logic（TypeScript）。ビルド時に Node の type stripping で JS にします（bundler・依存なし） |
| `src/local-store.js` | この端末内の record store。domain が使う `read` / `write` を localStorage で実装 |
| `src/app-def.js` | 画面の操作と domain 関数・collection の対応 |
| `src/ui/` | 依存なしの UI。DOM はテキストノードだけで組み、HTML 文字列を使いません（CSP `style-src 'self'`） |
| `vendor/` | kotoba-lang/kotoba の `kotoba-client-runtime.js` / consent CSS と `PINS.json`。`scripts/build.mjs` が digest のずれで失敗します |
| `src-tauri/` | Tauri v3 host。read-only command は `awai_host_info` の 1 つだけ。filesystem・network・shell・installer 権限なし |
| `actor-registry/` | 旧 actor registry（cljk）。この app のビルド・テストでは使いません |

## コマンド

```sh
npm ci
npm test              # build してから domain と local-only のテスト（explorer.test.ts, local-only.test.mjs）
npm run build         # dist/ と SHA-256 の release.json
npm run build:desktop # native desktop 実行ファイル（bundle・署名なし）
```

## 状態と制限（AWAI-3079, 2026-11-17）

- 旧構成（Cloudflare Worker の XRPC dispatcher / adapter、`wrangler.jsonc`、`@etzhayyim/sdk`）は削除しました。履歴は git にあります。
- 検証済み: `npm test`、`npm run build`、`cargo check`（Tauri 3.0.0-alpha.6）。
- 未検証: native window の起動、`tauri build`、Android、署名、配布。アイコンは app-soshiki の仮アイコンです。

## Android（Itonami Store）

AWAI-3502 で Android 版を加えました。Store の ID は `network.itonami.explorer` です。

- `npm run build:android`（`scripts/android-apk.sh`）が、`tauri android build --debug --apk --target aarch64` で APK を作り、SHA-256 を表示します。Android SDK・NDK 27・JDK 21・Rust の `aarch64-linux-android` が要ります。
- 出力は `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`（約 20 MB、手元の Android debug 鍵で署名）です。
- manifest に `INTERNET` 権限はありません。OS が app の通信をすべて止めます。
- ネイティブライブラリは 16 KB 境界にそろえ（Android 15 以降の 16 KB ページ）、debug 情報を除いています。画面はシステムバーと切り欠きを避け、明暗の配色に合わせます。
- Store への掲載は network-awai/awai-os の `android/local-apps.json` と `build.py --local-apps-dir` で行います。
- 確認済み: APK の作成、パッケージ名・権限・署名・16 KB 境界の確認。エミュレータでの起動は awai-os 側の記録を見てください。実機・署名済みの配布は未確認です。
