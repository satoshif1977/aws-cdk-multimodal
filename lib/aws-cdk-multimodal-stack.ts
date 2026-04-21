import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

const MODEL_ID = 'anthropic.claude-3-haiku-20240307-v1:0';

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
    });

    // ── DynamoDB テーブル（アップロード履歴 + 分析結果） ────────
    // パーティションキー: fileKey（S3 オブジェクトキー）
    // 追加属性: analysisResult（Bedrock 分析テキスト）, fileType, modelId
    const uploadHistoryTable = new dynamodb.Table(this, 'UploadHistoryTable', {
      partitionKey: { name: 'fileKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
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

    // Bedrock InvokeModel 権限（Claude 3 Haiku のみ）
    processDocFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/${MODEL_ID}`,
      ],
    }));

    // S3 ObjectCreated イベントで Lambda を起動
    docsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(processDocFn),
    );

    // ── Outputs ───────────────────────────────────────────────
    new cdk.CfnOutput(this, 'BucketName', {
      value: docsBucket.bucketName,
      description: 'ファイルアップロード先 S3 バケット名',
    });

    new cdk.CfnOutput(this, 'LambdaFunctionName', {
      value: processDocFn.functionName,
      description: 'S3 アップロード検知 Lambda 関数名',
    });

    new cdk.CfnOutput(this, 'TableName', {
      value: uploadHistoryTable.tableName,
      description: 'アップロード履歴 + 分析結果 DynamoDB テーブル名',
    });
  }
}
