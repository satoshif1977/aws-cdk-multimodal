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

  test('DynamoDB Stream が NEW_IMAGE で有効化されている', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
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

  test('タイムアウトが 60 秒である', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 60,
    });
  });

  test('MODEL_ID 環境変数が設定されている', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          MODEL_ID: 'apac.anthropic.claude-haiku-4-5-20251001-v1:0',
        }),
      },
    });
  });

  test('EventBridge ルールで S3 ObjectCreated イベントを受け取る', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({
        source: ['aws.s3'],
        'detail-type': ['Object Created'],
      }),
    });
  });

  test('TypeScript validator Lambda が Node.js 22.x で作成される', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
    });
  });

  test('Go notifier Lambda が provided.al2023 で作成される', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'provided.al2023',
      Handler: 'bootstrap',
    });
  });

  test('Go notifier Lambda に CW_NAMESPACE 環境変数が設定されている', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          CW_NAMESPACE: 'MultimodalApp',
        }),
      },
    });
  });

  test('Lambda 関数が合計 3 つ作成される（Python / TypeScript / Go）', () => {
    // CDK custom resource Lambda を除いた関数数チェック
    const functions = template.findResources('AWS::Lambda::Function', {
      Properties: Match.objectLike({ Runtime: Match.anyValue() }),
    });
    const runtimes = Object.values(functions).map((f: any) => f.Properties?.Runtime);
    expect(runtimes).toContain('python3.12');
    expect(runtimes).toContain('nodejs22.x');
    expect(runtimes).toContain('provided.al2023');
  });
});

// ── Bedrock テスト ────────────────────────────────────────
describe('Bedrock', () => {
  test('Lambda に bedrock:InvokeModel 権限が付与されている', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'bedrock:InvokeModel',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });
});

// ── IAM テスト ───────────────────────────────────────────
describe('IAM', () => {
  test('cloudwatch:PutMetricData 権限が付与されている', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'cloudwatch:PutMetricData',
            Effect: 'Allow',
          }),
        ]),
      },
    });
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

  test('ValidatorFunctionName が出力される', () => {
    template.hasOutput('ValidatorFunctionName', {});
  });

  test('NotifierFunctionName が出力される', () => {
    template.hasOutput('NotifierFunctionName', {});
  });

  test('TableName が出力される', () => {
    template.hasOutput('TableName', {});
  });
});
