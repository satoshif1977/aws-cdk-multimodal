# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
