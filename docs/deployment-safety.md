# 本番公開の再発防止手順

## 目的

`zemione`の本番Workerへ、静的ファイルだけの簡易構成や未確認の`dist`を直接公開しないための手順です。本番への公開経路は、Git連携によるプレビュー版アップロードと、確認後の手動昇格に分離します。

## Cloudflare Workers Buildsの必須設定

Cloudflare Dashboardの「Workers & Pages → zemione → Settings → Builds」で、次を設定します。

- Build command: `npm run build`
- Deploy command: `npm run deploy:workers-build`
- Non-production branch deploy command: `npm run deploy:workers-build`
- Build variable: `ZEMIONE_WORKERS_DEPLOY_COMMAND=npm run deploy:workers-build`

この設定が終わるまでは、Workers Builds上の`npm run build`が意図的に失敗します。現在の本番バージョンは変更されません。

`deploy:workers-build`は`wrangler versions upload`だけを実行し、新しいバージョンを本番トラフィックへ自動昇格しません。

## ソース同期の必須条件

Gitの`main`は、少なくとも次の本番契約をすべて保持する必要があります。

- `wrangler.jsonc`のWorkerエントリーポイントが`./src/worker.ts`
- 静的資産の`ASSETS` binding
- `/api/article-event`のWorker先行実行
- `ARTICLE_EVENTS` Analytics Engine binding
- 本番用の共通スタイル、サイト設定、検索ページ、ビルドSHAエンドポイント
- トップページに`site-header`、`article-card`、CSS参照が存在

契約を変える場合は、ゲートを削除して回避せず、設計変更として同じPull Requestで明示的に更新します。

## 公開フロー

1. 記事・画像・共通UIの変更をPull Requestに限定する。
2. `deployment-safety-tests`と`production-source-contract`を成功させる。
3. Cloudflareのバージョンプレビューで、トップ、対象記事、検索、カテゴリを確認する。
4. 次のコマンドでプレビューとビルドSHAを検証する。

   ```powershell
   npm run verify:release -- --url "https://<version-preview-url>" --expect-sha "<40-character-commit-sha>" --path "/対象記事/"
   ```

5. 現在の正常バージョンIDを`npx wrangler deployments status --name zemione`で記録する。
6. ユーザーの公開承認後に限り、確認済みバージョンを100%へ昇格する。

   ```powershell
   npx wrangler versions deploy "<verified-version-id>@100%" --name zemione --message "確認済みバージョンを本番へ昇格" -y
   ```

7. 本番URLに対して同じ`verify:release`を実行し、トップ、対象記事、CSSを再確認する。

## ロールバック

本番確認に失敗した場合は、新しいビルドや通常の`wrangler deploy`を重ねません。手順5で記録した直前の正常バージョンを100%へ戻します。

```powershell
npx wrangler versions deploy "<previous-good-version-id>@100%" --name zemione --message "本番確認失敗のためロールバック" -y
```

ロールバック後、トップ、対象記事、検索、カテゴリのHTTP応答とCSSを確認します。

## 禁止事項

- `npx wrangler deploy`による即時100%公開
- 汚れた作業ツリーから生成した`dist`の全量公開
- 本番と異なる`wrangler.jsonc`からの公開
- ビルド成功だけを根拠にした公開完了判定
- 記録した正常バージョンがない状態での本番切替
