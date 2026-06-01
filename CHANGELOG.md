# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [1.5.0] - 2026-06-01

### Changed
- Bedrock モデルを `Claude 3.5 Haiku`（廃止）→ `Claude Haiku 4.5`（`jp.anthropic.claude-haiku-4-5-20251001-v1:0`）に更新
- S3 イベント通知を直接 Lambda 通知から **EventBridge ファンアウト**（`eventBridgeEnabled: true` + `AWS::Events::Rule`）に変更（同バケット同イベント複数 Lambda の S3 制約を回避）
- Lambda ハンドラーを S3 直接通知形式 → EventBridge イベント形式（`event.detail.object.key`）に更新（validator / process_doc）
- CDK テスト: `Custom::S3BucketNotifications` → `AWS::Events::Rule` に更新（29 件 PASS 維持）
- デフォルトブランチを `master` → `main` に統一

## [1.4.0] - 2026-06-01

### Added
- TypeScript Lambda（validator）を追加（`lambda_src/validator/index.ts`）
  - S3 ObjectCreated イベントでファイルサイズ（10MB上限）・拡張子（.jpg/.jpeg/.png/.gif/.webp）をバリデーション
  - Jest ユニットテスト 7件追加（URLデコード・各拡張子・サイズ上限ケース）
- Go Lambda（notifier）を追加（`lambda_src/notifier/main.go`）
  - DynamoDB Stream（INSERT）→ CloudWatch カスタムメトリクス `DocumentAnalyzed` を送信
  - Go テスト 4件追加（`go test` でパス確認済み）
  - Windows ローカルビルド対応（PowerShell 経由 クロスコンパイル）
- DynamoDB Stream（NEW_IMAGE）を有効化
- CDK テストを 14 → 22件に拡充（TypeScript validator / Go notifier / DynamoDB Stream / IAM 権限検証）
- Jest roots に `lambda_src/` を追加（validator ユニットテストを npm test で実行可能に）

### Changed
- CDK スタックに `NodejsFunction`・`DynamoEventSource` を追加
- DynamoDB テーブルに `stream: StreamViewType.NEW_IMAGE` を追加
- `esbuild`・`@types/aws-lambda` を devDependencies に追加

## [1.3.0] - 2026-06-01

### Changed
- aws-cdk-lib を 2.253.1 に更新
- aws-cdk (CLI) を 2.1121.0 に更新
- @types/node を 25.6.2 に更新
- jest を 30.4.2 に更新
- GitHub Actions: `actions/checkout` v6・`actions/setup-node` v6・`actions/github-script` v9 に更新

### Notes
- typescript v6 は CDK ビルドと非互換のため v5 系を維持（PR#5 クローズ）

## [1.2.1] - 2026-05-26

### Fixed
- README のモデル名を `Claude 3 Haiku` → `Claude 3.5 Haiku` に統一（v1.1.0 でコード移行済みだったが README が未更新だった・5か所）

## [1.2.0] - 2026-05-19

### Added
- CONTRIBUTING.md 追加（PR プロセス・スタイルガイド）

## [1.1.0] - 2026-05-12

### Added
- SECURITY.md 追加
- Dependabot 設定追加
- README にトラブルシューティング・ローカル開発テスト方法セクション追加
- マルチモーダル入力サポートフォーマット詳細表を README に追加（2026-05-18）

### Changed
- Claude 3 Haiku → Claude 3.5 Haiku（`anthropic.claude-3-5-haiku-20241022-v1:0`）に移行（EOL: 2026-09-10）

## [1.0.0] - 2026-04-21

### Added
- Phase 5: Bedrock マルチモーダル画像分析を実装（Claude 3 Haiku Vision）
  - S3 に画像をアップロード → Lambda で base64 エンコード → Bedrock Vision API で分析
  - 分析結果を DynamoDB に保存
  - AWS4 スタイルのアーキテクチャ構成図・デモ GIF 追加

## [0.1.0] - 2026-04-08

### Added
- 初回実装：AWS CDK TypeScript による S3 + Lambda + DynamoDB パイプライン
  - Phase 1: S3 バケット定義・CDK デプロイ
  - Phase 2: Lambda + S3 イベントトリガー追加
  - Phase 3: DynamoDB 追加・Lambda 書き込み
  - Phase 4: `cdk destroy` 完了・フェーズ完結
- アーキテクチャ構成図（draw.io + PNG）
