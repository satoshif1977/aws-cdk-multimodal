import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AwsCdkMultimodalStack } from '../lib/aws-cdk-multimodal-stack';

const app = new cdk.App();
const stack = new AwsCdkMultimodalStack(app, 'TestStack', {
  env: { account: '123456789012', region: 'ap-northeast-1' },
});
const template = Template.fromStack(stack);

// ── S3 テスト ────────────────────────────────────────────
describe('S3', () => {
  test('パブリックアクセスが全ブロックされている', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('S3 マネージド暗号化が有効である', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
          }),
        ]),
      },
    });
  });

  test('バージョニングが有効である', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });
});

// ── DynamoDB テスト ───────────────────────────────────────
describe('DynamoDB', () => {
  test('パーティションキーが fileKey（STRING）である', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: Match.arrayWith([
        Match.objectLike({ AttributeName: 'fileKey', KeyType: 'HASH' }),
      ]),
    });
  });

  test('PAY_PER_REQUEST（オンデマンド）課金モードである', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('AWS マネージド暗号化が有効である', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      SSESpecification: { SSEEnabled: true },
    });
  });
});

// ── Lambda テスト ─────────────────────────────────────────
describe('Lambda', () => {
  test('Python 3.12 ランタイムで作成される', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.12',
    });
  });

  test('タイムアウトが 30 秒である', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 30,
    });
  });

  test('S3 ObjectCreated イベント通知が設定される', () => {
    template.resourceCountIs('Custom::S3BucketNotifications', 1);
  });
});

// ── Outputs テスト ────────────────────────────────────────
describe('Outputs', () => {
  test('BucketName が出力される', () => {
    template.hasOutput('BucketName', {});
  });

  test('LambdaFunctionName が出力される', () => {
    template.hasOutput('LambdaFunctionName', {});
  });

  test('TableName が出力される', () => {
    template.hasOutput('TableName', {});
  });
});
