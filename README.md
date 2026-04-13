# aws-cdk-multimodal

AWS CDK（TypeScript）で S3 + Lambda + DynamoDB によるイベント駆動アーキテクチャを定義・デプロイする実装例です。
Terraform との比較を意識しながら、CDK の基本的な使い方（synth / bootstrap / deploy / destroy）と高レベル抽象化（L2 Construct / grantRead / grantWriteData）を習得するためのプロジェクトです。

---

## アーキテクチャ

![アーキテクチャ図](docs/cdk-multimodal-architecture.drawio.png)

```
CDK TypeScript コード
  ↓ cdk synth
CloudFormation テンプレート（自動生成）
  ↓ cdk deploy
S3 バケット → Lambda（S3 イベントトリガー）→ DynamoDB（アップロード履歴記録）
```

---

## 技術スタック

| カテゴリ | 使用技術 |
|---|---|
| IaC | AWS CDK（TypeScript） |
| ストレージ | Amazon S3（暗号化・バージョニング） |
| コンピュート | AWS Lambda（Python 3.12） |
| データベース | Amazon DynamoDB（PAY_PER_REQUEST・TTL） |
| 監視 | Amazon CloudWatch Logs |
| 言語 | TypeScript / Python |
| リージョン | ap-northeast-1（東京） |

---

## 実装内容

### Phase 1: S3 バケット（`lib/aws-cdk-multimodal-stack.ts`）

```typescript
const docsBucket = new s3.Bucket(this, 'DocsBucket', {
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,  // パブリックアクセス全ブロック
  encryption: s3.BucketEncryption.S3_MANAGED,          // AES-256 暗号化
  versioned: true,                                      // バージョニング有効
  removalPolicy: cdk.RemovalPolicy.DESTROY,            // スタック削除時にバケットも削除
  autoDeleteObjects: true,                              // 削除前にオブジェクトを自動空に
});
```

**Terraform との比較：**

| 設定 | Terraform | CDK |
|---|---|---|
| バケット作成 | `aws_s3_bucket` | `new s3.Bucket()` |
| パブリックアクセスブロック | `aws_s3_bucket_public_access_block` | `blockPublicAccess` オプション 1行 |
| 暗号化 | `aws_s3_bucket_server_side_encryption_configuration` | `encryption` オプション 1行 |
| バージョニング | `aws_s3_bucket_versioning` | `versioned: true` 1行 |
| 削除時オブジェクト削除 | 自分で Lambda + カスタムリソースを書く | `autoDeleteObjects: true` 1行（CDK が自動生成） |

### Phase 2: Lambda + S3 イベントトリガー（`lib/aws-cdk-multimodal-stack.ts`）

```typescript
// Lambda 関数定義
const processDocFn = new lambda.Function(this, 'ProcessDocFunction', {
  runtime: lambda.Runtime.PYTHON_3_12,
  handler: 'lambda_function.lambda_handler',
  code: lambda.Code.fromAsset('lambda_src/process_doc'),
  environment: { BUCKET_NAME: docsBucket.bucketName },
  timeout: cdk.Duration.seconds(30),
});

// S3 読み取り権限を自動付与（IAM ポリシーを自動生成）
docsBucket.grantRead(processDocFn);

// S3 ObjectCreated イベントで Lambda を自動起動（1行で完結）
docsBucket.addEventNotification(
  s3.EventType.OBJECT_CREATED,
  new s3n.LambdaDestination(processDocFn),
);
```

**Terraform では個別に必要なリソース → CDK では自動生成：**
- `aws_lambda_permission`（S3 が Lambda を呼び出す権限）→ 自動
- `aws_s3_bucket_notification`（S3 イベント通知設定）→ 自動
- `aws_iam_policy`（Lambda の S3 読み取り権限）→ `grantRead()` 1行

### Phase 3: DynamoDB 追加（`lib/aws-cdk-multimodal-stack.ts`）

```typescript
// DynamoDB テーブル定義
const uploadHistoryTable = new dynamodb.Table(this, 'UploadHistoryTable', {
  partitionKey: { name: 'fileKey', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // オンデマンド
  encryption: dynamodb.TableEncryption.AWS_MANAGED,
  removalPolicy: cdk.RemovalPolicy.DESTROY,
});

// DynamoDB 書き込み権限を自動付与（IAM ポリシーを自動生成）
uploadHistoryTable.grantWriteData(processDocFn);
```

**Terraform では個別に必要 → CDK では自動生成：**
- `aws_dynamodb_table` → `new dynamodb.Table()` 1ブロックで完結
- `aws_iam_policy`（DynamoDB 書き込み権限）→ `grantWriteData()` 1行

---

## デプロイ手順

```bash
# 依存パッケージインストール
npm install

# CloudFormation テンプレート生成確認
aws-vault exec personal-dev-source -- cdk synth

# CDK 用リソースを AWS アカウントに準備（初回のみ）
aws-vault exec personal-dev-source -- cdk bootstrap

# デプロイ
aws-vault exec personal-dev-source -- cdk deploy
```

### 出力例

```
Outputs:
AwsCdkMultimodalStack.BucketName = awscdkmultimodalstack-docsbucketecea003f-kcmlririf9kl
```

---

## 削除手順

```bash
aws-vault exec personal-dev-source -- cdk destroy
```

---

## スクリーンショット

### Phase 1: S3 バケット定義・デプロイ

#### CloudFormation スタック一覧
![cfn stack list](docs/screenshots/01_cfn_stack_list.png)

#### スタックリソース一覧（6リソース）
![cfn resources](docs/screenshots/02_cfn_resources.png)

#### S3 バケット一覧
![s3 bucket](docs/screenshots/03_s3_bucket.png)

### Phase 2: Lambda + S3 イベントトリガー

#### Lambda 関数一覧
`ProcessDocFunction`（Python 3.12）が作成済み。CDK が自動生成した AutoDeleteObjects / BucketNotificationsHandler も確認できる。
![lambda function list](docs/screenshots/04_lambda_function_list.png)

#### CloudWatch Logs（S3 アップロード検知ログ）
`test-upload.txt` をアップロード後、Lambda が自動起動し `ファイルアップロード検知: key=test-upload.txt, size=49 bytes` をログ出力。
![cloudwatch logs](docs/screenshots/05_cloudwatch_logs.png)

### Phase 3: DynamoDB 追加・Lambda から書き込み

#### DynamoDB テーブル一覧
`UploadHistoryTable`（パーティションキー: fileKey・オンデマンド課金）が作成済み。
![dynamodb table list](docs/screenshots/06_dynamodb_table_list.png)

#### DynamoDB 項目（アップロード履歴）
`test-phase3.txt` をアップロード後、Lambda が自動起動し fileKey / bucket / size / uploadedAt を記録。
![dynamodb items](docs/screenshots/07_dynamodb_items.png)

### Phase 4: cdk destroy（リソース全削除）

#### CloudFormation スタック一覧（destroy 後）
`AwsCdkMultimodalStack` が削除され `CDKToolkit` のみ残存。S3・Lambda・DynamoDB がすべて削除された状態。
![cfn stack destroyed](docs/screenshots/08_cfn_stack_destroyed.png)

---

## 技術的なポイント・工夫

- **CDK = CloudFormation の上位抽象レイヤー**：`cdk synth` で CloudFormation テンプレートに変換される。コード変更の差分は `cdk diff` で確認できる
- **型補完の恩恵**：TypeScript の型定義により、`s3.BucketEncryption.S3_MANAGED` のように補完が効くため設定ミスを防ぎやすい
- **autoDeleteObjects の裏側**：`autoDeleteObjects: true` を指定すると CDK が自動で Lambda + Custom Resource を追加生成してくれる。Terraform では自前実装が必要な部分
- **cdk bootstrap**：CDK が CloudFormation テンプレートや Lambda コードを S3 にアップロードするための専用バケット・IAM ロール等を事前作成するコマンド。アカウント×リージョンごとに1回実行すれば以後不要
- **Construct の概念**：CDK のリソース定義単位。L1（CloudFormation 直接対応）/ L2（高レベル抽象）/ L3（パターン）の3層構造があり、`s3.Bucket` は L2 Construct
