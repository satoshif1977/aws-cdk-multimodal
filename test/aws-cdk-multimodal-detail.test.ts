import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AwsCdkMultimodalStack } from '../lib/aws-cdk-multimodal-stack';

const app = new cdk.App();
const stack = new AwsCdkMultimodalStack(app, 'TestStack', {
  env: { account: '123456789012', region: 'ap-northeast-1' },
});
const template = Template.fromStack(stack);

// ── Lambda 環境変数 ───────────────────────────────────────────────
describe('Lambda 環境変数', () => {
  test('processDocFn に BUCKET_NAME 環境変数が設定されている', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.12',
      Environment: {
        Variables: Match.objectLike({
          BUCKET_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test('processDocFn に TABLE_NAME 環境変数が設定されている', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.12',
      Environment: {
        Variables: Match.objectLike({
          TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });
});

// ── S3 EventBridge 通知 ──────────────────────────────────────────
describe('S3 EventBridge 通知', () => {
  test('S3 バケットの EventBridge 通知が有効化されている', () => {
    // CDK は Custom::S3BucketNotifications リソースで EventBridgeConfiguration を設定する
    const templateJson = JSON.stringify(template.toJSON());
    expect(templateJson).toContain('EventBridgeConfiguration');
  });
});

// ── DynamoDB Event Source Mapping 詳細 ───────────────────────────
describe('DynamoDB Event Source Mapping 詳細', () => {
  test('EventSourceMapping の StartingPosition が LATEST である', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      StartingPosition: 'LATEST',
    });
  });
});

// ── EventBridge ルール詳細 ────────────────────────────────────────
describe('EventBridge ルール詳細', () => {
  test('EventBridge ルールの状態が ENABLED である', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      State: 'ENABLED',
    });
  });

  test('EventBridge ルールのソースが aws.s3 である', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({
        source: ['aws.s3'],
      }),
    });
  });
});

// ── IAM 詳細 ─────────────────────────────────────────────────────
describe('IAM 詳細', () => {
  test('Bedrock モデル ARN に anthropic.claude-haiku が含まれる', () => {
    const templateJson = JSON.stringify(template.toJSON());
    expect(templateJson).toContain('anthropic.claude-haiku');
  });

  test('DynamoDB Stream IAM に dynamodb:GetRecords 権限が含まれる', () => {
    const templateJson = JSON.stringify(template.toJSON());
    expect(templateJson).toContain('dynamodb:GetRecords');
  });

  test('DynamoDB Stream IAM に dynamodb:GetShardIterator 権限が含まれる', () => {
    const templateJson = JSON.stringify(template.toJSON());
    expect(templateJson).toContain('dynamodb:GetShardIterator');
  });

  test('Lambda 実行ロールが 3 件以上作成される（Python / TypeScript / Go + CDK カスタムリソース）', () => {
    const roles = template.findResources('AWS::IAM::Role', {
      Properties: {
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: { Service: 'lambda.amazonaws.com' },
            }),
          ]),
        }),
      },
    });
    expect(Object.keys(roles).length).toBeGreaterThanOrEqual(3);
  });

  test('S3 バケットポリシーが作成される（autoDeleteObjects 用）', () => {
    template.resourceCountIs('AWS::S3::BucketPolicy', 1);
  });
});

// ── Lambda メモリ・設定詳細 ────────────────────────────────────────
describe('Lambda 設定詳細', () => {
  test('ProcessDoc Lambda のメモリサイズがデフォルト 128MB である', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.12',
      MemorySize: Match.absent(),
    });
  });

  test('Notifier Lambda のタイムアウトが 30 秒である', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'provided.al2023',
      Timeout: 30,
    });
  });

  test('EventBridge イベントパターンにバケット名フィルターが含まれる', () => {
    const rules = template.findResources('AWS::Events::Rule');
    const patterns = Object.values(rules).map((r: any) => JSON.stringify(r.Properties?.EventPattern ?? {}));
    expect(patterns.some((p) => p.includes('name'))).toBe(true);
  });

  test('DynamoDB KeySchema の attributeType が STRING である', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      AttributeDefinitions: Match.arrayWith([
        Match.objectLike({ AttributeName: 'fileKey', AttributeType: 'S' }),
      ]),
    });
  });
});

// ── インフラ詳細（追加） ──────────────────────────────────────────
describe('インフラ詳細', () => {
  test('ProcessDoc Lambda の handler が lambda_function.lambda_handler である', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'lambda_function.lambda_handler',
    });
  });

  test('Validator Lambda の handler が index.handler である', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
    });
  });

  test('IAM に foundation-model ARN が含まれる', () => {
    const templateJson = JSON.stringify(template.toJSON());
    expect(templateJson).toContain('foundation-model');
  });

  test('CfnOutput が 5 件存在する', () => {
    const outputs = template.toJSON().Outputs;
    expect(Object.keys(outputs ?? {}).length).toBe(5);
  });

  test('DynamoDB PITR が absent（dev 環境）', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: Match.absent(),
    });
  });

  test('S3 LifecycleConfiguration が absent（dev 環境）', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: Match.absent(),
    });
  });

  test('Lambda EventSourceMapping に BisectBatchOnFunctionError が設定されていない', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BisectBatchOnFunctionError: Match.absent(),
    });
  });

  test('notifierFn Runtime と CW_NAMESPACE の組み合わせが正しい', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'provided.al2023',
      Environment: {
        Variables: Match.objectLike({
          CW_NAMESPACE: 'MultimodalApp',
        }),
      },
    });
  });
});
