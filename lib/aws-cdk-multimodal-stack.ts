import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

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

    // ── DynamoDB テーブル（アップロード履歴） ──────────────────
    // Terraform の aws_dynamodb_table 相当
    // パーティションキー: fileKey（S3 オブジェクトキー）
    const uploadHistoryTable = new dynamodb.Table(this, 'UploadHistoryTable', {
      partitionKey: { name: 'fileKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // オンデマンド（学習用・コスト最適）
      encryption: dynamodb.TableEncryption.AWS_MANAGED,  // AWS マネージド暗号化
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Lambda（S3 アップロード検知 → DynamoDB 記録） ─────────
    const processDocFn = new lambda.Function(this, 'ProcessDocFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'lambda_function.lambda_handler',
      code: lambda.Code.fromAsset('lambda_src/process_doc'),
      environment: {
        BUCKET_NAME: docsBucket.bucketName,
        TABLE_NAME: uploadHistoryTable.tableName, // 環境変数でテーブル名を渡す
      },
      timeout: cdk.Duration.seconds(30),
    });

    // S3 読み取り権限を付与
    docsBucket.grantRead(processDocFn);

    // DynamoDB 書き込み権限を付与（IAM ポリシーを自動生成）
    // Terraform では aws_iam_policy + aws_iam_role_policy_attachment が必要
    uploadHistoryTable.grantWriteData(processDocFn);

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
      description: 'アップロード履歴 DynamoDB テーブル名',
    });
  }
}
