import { validateRecord, handler } from './index';
import { S3EventRecord } from 'aws-lambda';

// ── ヘルパー ──────────────────────────────────────────────
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

interface EventBridgeS3Event {
  source: string;
  'detail-type': string;
  detail: {
    bucket: { name: string };
    object: { key: string; size: number };
  };
}

function makeEvent(key: string, size: number): EventBridgeS3Event {
  return {
    source: 'aws.s3',
    'detail-type': 'Object Created',
    detail: {
      bucket: { name: 'test-bucket' },
      object: { key, size },
    },
  };
}

// ── validateRecord ────────────────────────────────────────
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

  test('exactly at 10MB limit is valid', () => {
    const result = validateRecord(makeRecord('edge.png', 10 * 1024 * 1024));
    expect(result.valid).toBe(true);
  });

  test('1 byte over 10MB limit is invalid', () => {
    const result = validateRecord(makeRecord('over.png', 10 * 1024 * 1024 + 1));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('exceeds limit');
  });

  test('gif extension is valid', () => {
    const result = validateRecord(makeRecord('anim.gif', 4096));
    expect(result.valid).toBe(true);
  });

  test('拡張子なしのファイルは invalid である', () => {
    const result = validateRecord(makeRecord('noextension', 1024));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('unsupported extension');
  });

  test('大文字拡張子 .JPG は toLowerCase により valid である', () => {
    const result = validateRecord(makeRecord('PHOTO.JPG', 1024));
    expect(result.valid).toBe(true);
  });

  test('size 0 のファイルは valid である（0 <= 10MB）', () => {
    const result = validateRecord(makeRecord('empty.png', 0));
    expect(result.valid).toBe(true);
  });

  test('複数ドットのファイル名は最後の拡張子で判定される', () => {
    const result = validateRecord(makeRecord('my.photo.2024.jpg', 2048));
    expect(result.valid).toBe(true);
    expect(result.fileKey).toBe('my.photo.2024.jpg');
  });
});

// ── handler（EventBridge S3 ObjectCreated イベント） ───────
describe('handler', () => {
  test('valid jpeg returns valid=true', async () => {
    const result = await handler(makeEvent('photo.jpg', 1024));
    expect(result.valid).toBe(true);
    expect(result.fileKey).toBe('photo.jpg');
  });

  test('valid png returns valid=true', async () => {
    const result = await handler(makeEvent('image.png', 2 * 1024 * 1024));
    expect(result.valid).toBe(true);
  });

  test('invalid extension returns valid=false', async () => {
    const result = await handler(makeEvent('report.pdf', 100));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('unsupported extension');
  });

  test('oversized file returns valid=false', async () => {
    const result = await handler(makeEvent('big.jpg', 20 * 1024 * 1024));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('exceeds limit');
  });

  test('URL-encoded key decoded correctly in handler', async () => {
    const result = await handler(makeEvent('%E6%97%A5%E6%9C%AC%E8%AA%9E.png', 512));
    expect(result.valid).toBe(true);
    expect(result.fileKey).toBe('日本語.png');
  });

  test('webp is valid in handler', async () => {
    const result = await handler(makeEvent('clip.webp', 1024));
    expect(result.valid).toBe(true);
  });

  test('exactly at 10MB limit is valid in handler', async () => {
    const result = await handler(makeEvent('edge.jpeg', 10 * 1024 * 1024));
    expect(result.valid).toBe(true);
  });

  test('txt extension returns valid=false in handler', async () => {
    const result = await handler(makeEvent('memo.txt', 100));
    expect(result.valid).toBe(false);
  });

  test('fileKey is returned in result', async () => {
    const result = await handler(makeEvent('sample.jpg', 2048));
    expect(result.fileKey).toBe('sample.jpg');
  });

  test('plus-encoded key decoded correctly in handler', async () => {
    const result = await handler(makeEvent('my+image.png', 1024));
    expect(result.valid).toBe(true);
    expect(result.fileKey).toBe('my image.png');
  });

  test('拡張子なし → invalid in handler', async () => {
    const result = await handler(makeEvent('noextension', 512));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('unsupported extension');
  });

  test('大文字拡張子 .PNG → valid in handler（toLowerCase あり）', async () => {
    const result = await handler(makeEvent('IMAGE.PNG', 1024));
    expect(result.valid).toBe(true);
  });

  test('size 0 → valid in handler', async () => {
    const result = await handler(makeEvent('empty.jpeg', 0));
    expect(result.valid).toBe(true);
    expect(result.fileKey).toBe('empty.jpeg');
  });

  test('invalid 時の reason に拡張子情報が含まれる', async () => {
    const result = await handler(makeEvent('document.docx', 100));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('.docx');
  });
});
