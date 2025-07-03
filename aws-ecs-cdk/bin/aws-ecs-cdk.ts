#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsEcsCdkStack } from '../lib/aws-ecs-cdk-stack';

const app = new cdk.App();
new AwsEcsCdkStack(app, 'AwsEcsCdkStack', {
  synthesizer: new cdk.DefaultStackSynthesizer({
    qualifier: 'otel',
  }),

});