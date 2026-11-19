/**
 * validator ハンドラーのログ結線テスト
 *
 * 「logger.ts を置いただけ」に戻らないよう、実際の出力で確認する。
 *   1. console.log の素の文字列ではなく、1 行 JSON で出ていること
 *   2. S3 キーが message ではなくフィールドに入っていること
 *   3. level に応じて console のメソッドが使い分けられていること
 */

import { handler } from './index';

// 顧客名が入りうるファイル名。これが message に出たらマスキングを素通りしている。
const SENSITIVE_KEY = 'uploads/請求書_山田商事.png';

interface Captured {
  log: string[];
  warn: string[];
  error: string[];
}

let captured: Captured;
let spies: jest.SpyInstance[];

beforeEach(() => {
  captured = { log: [], warn: [], error: [] };
  spies = [
    jest.spyOn(console, 'log').mockImplementation((line: unknown) => {
      captured.log.push(String(line));
    }),
    jest.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      captured.warn.push(String(line));
    }),
    jest.spyOn(console, 'error').mockImplementation((line: unknown) => {
      captured.error.push(String(line));
    }),
  ];
});

afterEach(() => {
  spies.forEach((s) => s.mockRestore());
});

function makeEvent(key: string, size: number) {
  return {
    source: 'aws.s3',
    'detail-type': 'Object Created',
    detail: {
      bucket: { name: 'test-bucket' },
      object: { key, size },
    },
  };
}

function parseAll(lines: string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('ログの形式', () => {
  it('素の文字列ではなく 1 行 JSON で出る', async () => {
    await handler(makeEvent('photo.png', 1024));
    expect(captured.log).toHaveLength(1);
    const entry = JSON.parse(captured.log[0]);
    expect(entry).toMatchObject({ level: 'info' });
    expect(typeof entry.timestamp).toBe('string');
    expect(typeof entry.message).toBe('string');
  });

  it('1 行に収まっている（Logs Insights の前提）', async () => {
    await handler(makeEvent('photo.png', 1024));
    expect(captured.log[0]).not.toContain('\n');
  });

  it('[VALID] のような独自プレフィックスを使っていない', async () => {
    await handler(makeEvent('photo.png', 1024));
    expect(captured.log[0]).not.toContain('[VALID]');
  });
});

describe('S3 キーの扱い', () => {
  it('成功時: キーは message ではなくフィールドに入る', async () => {
    await handler(makeEvent(SENSITIVE_KEY, 1024));
    const [entry] = parseAll(captured.log);
    expect(entry.s3Key).toBe(SENSITIVE_KEY);
    expect(entry.message).not.toContain(SENSITIVE_KEY);
  });

  it('失敗時: キーは message ではなくフィールドに入る', async () => {
    await handler(makeEvent('uploads/請求書_山田商事.exe', 1024));
    const [entry] = parseAll(captured.warn);
    expect(entry.s3Key).toBe('uploads/請求書_山田商事.exe');
    expect(entry.message).not.toContain('請求書_山田商事');
  });

  it('バケット名もフィールドに入る', async () => {
    await handler(makeEvent('photo.png', 1024));
    const [entry] = parseAll(captured.log);
    expect(entry.s3Bucket).toBe('test-bucket');
  });

  it('URL エンコードされたキーはデコード後の値が入る', async () => {
    await handler(makeEvent('uploads/%E8%AB%8B%E6%B1%82%E6%9B%B8.png', 1024));
    const [entry] = parseAll(captured.log);
    expect(entry.s3Key).toBe('uploads/請求書.png');
  });
});

describe('level の使い分け', () => {
  it('検証成功は info（console.log）', async () => {
    await handler(makeEvent('photo.jpg', 2048));
    expect(captured.log).toHaveLength(1);
    expect(captured.warn).toHaveLength(0);
    expect(parseAll(captured.log)[0].level).toBe('info');
  });

  it('拡張子エラーは warn（console.warn）', async () => {
    await handler(makeEvent('doc.pdf', 2048));
    expect(captured.warn).toHaveLength(1);
    expect(captured.log).toHaveLength(0);
    expect(parseAll(captured.warn)[0].level).toBe('warn');
  });

  it('サイズ超過も warn', async () => {
    await handler(makeEvent('big.png', 11 * 1024 * 1024));
    expect(captured.warn).toHaveLength(1);
    expect(parseAll(captured.warn)[0].level).toBe('warn');
  });

  it('error は使っていない（検証失敗は異常ではない）', async () => {
    await handler(makeEvent('doc.pdf', 2048));
    expect(captured.error).toHaveLength(0);
  });
});

describe('付随するフィールド', () => {
  it('失敗の理由がフィールドで残る', async () => {
    await handler(makeEvent('doc.pdf', 2048));
    const [entry] = parseAll(captured.warn);
    expect(entry.reason).toContain('unsupported extension');
  });

  it('サイズが数値のフィールドで残る（Insights で集計できる）', async () => {
    await handler(makeEvent('photo.png', 4096));
    const [entry] = parseAll(captured.log);
    expect(entry.sizeBytes).toBe(4096);
  });

  it('戻り値はこれまでどおり ValidationResult', async () => {
    const result = await handler(makeEvent('photo.png', 1024));
    expect(result).toEqual({ valid: true, fileKey: 'photo.png' });
  });
});
