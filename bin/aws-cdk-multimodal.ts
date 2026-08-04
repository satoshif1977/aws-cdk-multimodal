#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { AwsCdkMultimodalStack } from '../lib/aws-cdk-multimodal-stack';

const app = new cdk.App();
new AwsCdkMultimodalStack(app, 'AwsCdkMultimodalStack', {
  // ap-northeast-1（東京）に固定
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'ap-northeast-1',
  },
});

cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
