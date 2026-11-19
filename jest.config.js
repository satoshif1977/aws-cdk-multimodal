module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test', '<rootDir>/lambda_src'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  },
  // ★ .ts を .js より先に解決する。
  // 既定の解決順は js が先のため、`import './index'` が過去の tsc 出力
  // （index.js・gitignore 済み）を拾ってしまい、ソースを直してもテストが
  // 古いコードで通る（false green）状態になっていた。
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json', 'node'],
  setupFilesAfterEnv: ['aws-cdk-lib/testhelpers/jest-autoclean'],
};
