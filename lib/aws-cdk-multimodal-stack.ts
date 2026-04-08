import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
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

    // ── Lambda（S3 アップロード検知） ──────────────────────────
    // Terraform では aws_lambda_function + aws_s3_bucket_notification +
    // aws_lambda_permission を個別に書く必要があるが、
    // CDK では addEventNotification() 1行で Lambda トリガー + IAM 権限が完結する
    const processDocFn = new lambda.Function(this, 'ProcessDocFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'lambda_function.lambda_handler',
      code: lambda.Code.fromAsset('lambda_src/process_doc'),
      environment: {
        BUCKET_NAME: docsBucket.bucketName,
      },
      timeout: cdk.Duration.seconds(30),
    });

    // S3 バケットへの読み取り権限を Lambda に付与（IAM ポリシーを自動生成）
    docsBucket.grantRead(processDocFn);

    // S3 ObjectCreated イベントで Lambda を起動（トリガー設定）
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
  }
}
