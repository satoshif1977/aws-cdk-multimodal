module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test', '<rootDir>/lambda_src'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  },
  setupFilesAfterEnv: ['aws-cdk-lib/testhelpers/jest-autoclean'],
};
