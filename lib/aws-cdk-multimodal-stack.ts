import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export class AwsCdkMultimodalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── S3 バケット（業務文書アップロード先） ──────────────────
    // Terraform の aws_s3_bucket + パブリックアクセスブロック + 暗号化 が
    // CDK では new s3.Bucket() 1つにまとまる
    const docsBucket = new s3.Bucket(this, 'DocsBucket', {
      // バケット名は CDK が自動生成（スタック名 + ランダムサフィックス）
      // 明示的に指定したい場合: bucketName: 'my-bucket-name'

      // パブリックアクセスを全ブロック（セキュリティ必須）
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,

      // AES-256 サーバーサイド暗号化
      encryption: s3.BucketEncryption.S3_MANAGED,

      // バージョニング有効（誤削除対策）
      versioned: true,

      // スタック削除時にバケットも削除する（学習用設定）
      // 本番では RETAIN にして誤削除を防ぐ
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ── Outputs（terraform output 相当） ───────────────────────
    new cdk.CfnOutput(this, 'BucketName', {
      value: docsBucket.bucketName,
      description: 'ファイルアップロード先 S3 バケット名',
    });
  }
}
