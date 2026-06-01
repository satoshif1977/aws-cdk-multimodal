import { validateRecord } from './index';
import { S3EventRecord } from 'aws-lambda';

function makeRecord(key: string, size: number): S3EventRecord {
  return {
    s3: {
      object: { key, size, eTag: '', versionId: '' },
      bucket: { name: 'test-bucket', ownerIdentity: { principalId: '' }, arn: '' },
      s3SchemaVersion: '1.0',
      configurationId: '',
    },
    eventVersion: '2.1',
    eventSource: 'aws:s3',
    awsRegion: 'ap-northeast-1',
    eventTime: '',
    eventName: 'ObjectCreated:Put',
    userIdentity: { principalId: '' },
    requestParameters: { sourceIPAddress: '' },
    responseElements: { 'x-amz-request-id': '', 'x-amz-id-2': '' },
  } as S3EventRecord;
}

describe('validateRecord', () => {
  test('valid jpeg under limit', () => {
    const result = validateRecord(makeRecord('photo.jpg', 1024));
    expect(result.valid).toBe(true);
    expect(result.fileKey).toBe('photo.jpg');
  });

  test('valid png under limit', () => {
    const result = validateRecord(makeRecord('image.png', 5 * 1024 * 1024));
    expect(result.valid).toBe(true);
  });

  test('invalid extension txt', () => {
    const result = validateRecord(makeRecord('document.txt', 100));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('unsupported extension');
  });

  test('invalid extension pdf', () => {
    const result = validateRecord(makeRecord('report.pdf', 100));
    expect(result.valid).toBe(false);
  });

  test('file exceeds 10MB limit', () => {
    const result = validateRecord(makeRecord('large.png', 11 * 1024 * 1024));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('exceeds limit');
  });

  test('URL-encoded key decoded correctly', () => {
    // S3 key with URL encoding: "my photo.jpg" → "my+photo.jpg"
    const result = validateRecord(makeRecord('my+photo.jpg', 512));
    expect(result.valid).toBe(true);
    expect(result.fileKey).toBe('my photo.jpg');
  });

  test('webp extension is valid', () => {
    const result = validateRecord(makeRecord('animation.webp', 2048));
    expect(result.valid).toBe(true);
  });
});
