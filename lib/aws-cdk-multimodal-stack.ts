import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import * as path from 'path';
import { NagSuppressions } from 'cdk-nag';

const MODEL_ID = 'jp.anthropic.claude-haiku-4-5-20251001-v1:0';

export class AwsCdkMultimodalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── S3 バケット（業務文書アップロード先） ──────────────────
    const docsBucket = new s3.Bucket(this, 'DocsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      eventBridgeEnabled: true, // EventBridge ファンアウト（複数 Lambda への並列通知）
    });

    // ── DynamoDB テーブル（アップロード履歴 + 分析結果） ────────
    // パーティションキー: fileKey（S3 オブジェクトキー）
    // 追加属性: analysisResult（Bedrock 分析テキスト）, fileType, modelId
    // stream: NEW_IMAGE を有効化 → notifier Lambda（Go）が CloudWatch メトリクスを送信
    const uploadHistoryTable = new dynamodb.Table(this, 'UploadHistoryTable', {
      partitionKey: { name: 'fileKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      stream: dynamodb.StreamViewType.NEW_IMAGE,
    });

    // ── Lambda（S3 アップロード検知 → Bedrock 分析 → DynamoDB 記録） ──
    // 画像ファイル（jpg/jpeg/png/gif/webp）は Bedrock Claude で分析
    // 非画像ファイルはメタデータのみ記録（従来動作）
    const processDocFn = new lambda.Function(this, 'ProcessDocFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'lambda_function.lambda_handler',
      code: lambda.Code.fromAsset('lambda_src/process_doc'),
      environment: {
        BUCKET_NAME: docsBucket.bucketName,
        TABLE_NAME: uploadHistoryTable.tableName,
        MODEL_ID: MODEL_ID,
      },
      timeout: cdk.Duration.seconds(60), // Bedrock 呼び出しを考慮して 60 秒
    });

    // S3 読み取り権限（画像取得のため）
    docsBucket.grantRead(processDocFn);

    // DynamoDB 書き込み権限
    uploadHistoryTable.grantWriteData(processDocFn);

    // Bedrock InvokeModel 権限
    // JP 推論プロファイルは ap-northeast-1（東京）と ap-northeast-3（大阪）の両方にルーティングするため
    // foundation-model ARN のリージョン部分をワイルドカード（*）にして両リージョンをカバー
    processDocFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`, // TODO: JP推論プロファイルが複数リージョンにルーティングするため * を使用
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${MODEL_ID}`,
      ],
    }));

    // S3 ObjectCreated イベント → EventBridge ルールで ValidatorFn・ProcessDocFn に並列ファンアウト
    // （同バケット同イベントへの直接 Lambda 通知は S3 の制約で 1 件のみ → EventBridge で回避）
    const s3ObjectCreatedRule = new events.Rule(this, 'S3ObjectCreatedRule', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [docsBucket.bucketName] },
        },
      },
    });

    s3ObjectCreatedRule.addTarget(new eventsTargets.LambdaFunction(processDocFn));


    // ── TypeScript Lambda（validator） ────────────────────────
    // S3 ObjectCreated → ファイルサイズ（10MB上限）・拡張子（画像のみ）バリデーション
    const validatorFn = new lambdaNodejs.NodejsFunction(this, 'ValidatorFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../lambda_src/validator/index.ts'),
      handler: 'handler',
      bundling: {
        minify: true,
        sourceMap: false,
      },
      timeout: cdk.Duration.seconds(10),
    });

    s3ObjectCreatedRule.addTarget(new eventsTargets.LambdaFunction(validatorFn));

    // ── Go Lambda（notifier） ─────────────────────────────────
    // DynamoDB Stream（INSERT）→ CloudWatch カスタムメトリクス送信
    const notifierFn = new lambda.Function(this, 'NotifierFunction', {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      handler: 'bootstrap',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda_src/notifier'), {
        bundling: {
          image: lambda.Runtime.PROVIDED_AL2023.bundlingImage,
          command: [
            'bash', '-c',
            'export GOPATH=/tmp/go && export GOCACHE=/tmp/go-cache && go build -o /asset-output/bootstrap .',
          ],
          local: {
            tryBundle(outputDir: string): boolean {
              const { execSync } = require('child_process');
              const srcDir = path.join(__dirname, '../lambda_src/notifier');
              try {
                if (process.platform === 'win32') {
                  execSync(
                    `powershell -Command "` +
                    `$env:GOARCH='amd64'; $env:GOOS='linux'; ` +
                    `Push-Location '${srcDir}'; ` +
                    `go build -o '${outputDir}/bootstrap' .; ` +
                    `Pop-Location"`,
                    { stdio: 'inherit' },
                  );
                } else {
                  execSync(
                    `cd "${srcDir}" && GOARCH=amd64 GOOS=linux go build -o "${outputDir}/bootstrap" .`,
                    { stdio: 'inherit' },
                  );
                }
                return true;
              } catch {
                return false;
              }
            },
          },
        },
      }),
      environment: {
        CW_NAMESPACE: 'MultimodalApp',
      },
      timeout: cdk.Duration.seconds(30),
    });

    // DynamoDB Stream を notifier Lambda のイベントソースに設定
    notifierFn.addEventSource(
      new lambdaEventSources.DynamoEventSource(uploadHistoryTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        retryAttempts: 2,
      }),
    );

    // CloudWatch PutMetricData 権限
    notifierFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'], // TODO: PutMetricData は特定リソースARN指定不可のため * を使用
    }));

    // ── Outputs ───────────────────────────────────────────────
    new cdk.CfnOutput(this, 'BucketName', {
      value: docsBucket.bucketName,
      description: 'ファイルアップロード先 S3 バケット名',
    });

    new cdk.CfnOutput(this, 'LambdaFunctionName', {
      value: processDocFn.functionName,
      description: 'S3 アップロード検知 Lambda 関数名（Python）',
    });

    new cdk.CfnOutput(this, 'ValidatorFunctionName', {
      value: validatorFn.functionName,
      description: 'S3 バリデーション Lambda 関数名（TypeScript）',
    });

    new cdk.CfnOutput(this, 'NotifierFunctionName', {
      value: notifierFn.functionName,
      description: 'DynamoDB Stream → CloudWatch メトリクス Lambda 関数名（Go）',
    });

    new cdk.CfnOutput(this, 'TableName', {
      value: uploadHistoryTable.tableName,
      description: 'アップロード履歴 + 分析結果 DynamoDB テーブル名',
    });

    // ── cdk-nag suppressions（dev 環境の意図的な省略） ────────────
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-L1',
        reason: 'PYTHON_3_12 / NODEJS_22_X / PROVIDED_AL2023 は現時点で最新ランタイム。cdk-nag のルール定義が追いついていないため抑制。',
      },
      {
        id: 'AwsSolutions-S1',
        reason: 'dev 環境のため S3 サーバーアクセスログは省略。本番では別バケットへのアクセスログを有効化すること。',
      },
      {
        id: 'AwsSolutions-S10',
        reason: 'dev 環境のため S3 HTTPS 強制ポリシーは未設定。本番では aws:SecureTransport 条件のバケットポリシーを追加すること。',
      },
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole は CDK Lambda が自動付与する標準マネージドポリシー。Lambda 基本実行権限として許容。',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'CDK grantRead が自動生成する S3 ワイルドカード・cloudwatch:PutMetricData は Resource:* 必須（AWS 仕様）・Bedrock JP 推論プロファイルは複数リージョンへのルーティングに * が必要（コード内 TODO コメント参照）。',
      },
      {
        id: 'AwsSolutions-DDB3',
        reason: 'dev 環境のため PITR は無効。本番では pointInTimeRecovery: true を設定すること。',
      },
    ]);
  }
}
