/**
 * validator ハンドラーのメトリクス結線テスト
 *
 * 「metrics.ts を置いただけ」に戻らないよう、実際の出力で確認する。
 *   1. ハンドラーを呼ぶと EMF ドキュメントが 1 行 JSON で出ること
 *   2. 成功と失敗でメトリクス名が切り替わること
 *   3. ★ S3 のバケット名・オブジェクトキーがディメンションに入っていないこと
 *      （入れると値の種類の数だけ課金対象のメトリクスが作られる）
 *   4. メトリクスの出力に失敗してもハンドラーが結果を返すこと
 */

import { handler } from './index';
import { RESERVED_ROOT_KEY } from './metrics';

const SENSITIVE_KEY = 'uploads/請求書_山田商事.png';

let logged: string[];
let warned: string[];
let spies: jest.SpyInstance[];

beforeEach(() => {
  logged = [];
  warned = [];
  spies = [
    jest.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logged.push(String(line));
    }),
    jest.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      warned.push(String(line));
    }),
    jest.spyOn(console, 'error').mockImplementation(() => undefined),
  ];
});

afterEach(() => {
  spies.forEach((s) => s.mockRestore());
  delete process.env.METRICS_NAMESPACE;
  delete process.env.METRICS_SERVICE;
  delete process.env.METRICS_STAGE;
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

/** console.log / console.warn の全行から EMF ドキュメントだけを拾う */
function emfDocs(): Record<string, unknown>[] {
  return [...logged, ...warned]
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((doc): doc is Record<string, unknown> => doc !== null && RESERVED_ROOT_KEY in doc);
}

function directive(doc: Record<string, unknown>): Record<string, unknown> {
  const aws = doc[RESERVED_ROOT_KEY] as Record<string, unknown>;
  return (aws.CloudWatchMetrics as Record<string, unknown>[])[0];
}

function metricNames(doc: Record<string, unknown>): string[] {
  return (directive(doc).Metrics as { Name: string }[]).map((d) => d.Name);
}

describe('ハンドラーのメトリクス結線', () => {
  it('EMF ドキュメントが 1 件だけ出る', async () => {
    await handler(makeEvent('a.png', 100));
    expect(emfDocs()).toHaveLength(1);
  });

  it('検証に成功したら ValidationSucceeded を出す', async () => {
    await handler(makeEvent('a.png', 100));
    const names = metricNames(emfDocs()[0]);
    expect(names).toContain('ValidationSucceeded');
    expect(names).not.toContain('ValidationFailed');
  });

  it('検証に失敗したら ValidationFailed を出す', async () => {
    await handler(makeEvent('a.exe', 100));
    const names = metricNames(emfDocs()[0]);
    expect(names).toContain('ValidationFailed');
    expect(names).not.toContain('ValidationSucceeded');
  });

  it('オブジェクトサイズを Bytes で出す', async () => {
    await handler(makeEvent('a.png', 4096));
    const doc = emfDocs()[0];
    expect(doc.ObjectSizeBytes).toBe(4096);
    const def = (directive(doc).Metrics as Record<string, unknown>[]).find(
      (d) => d.Name === 'ObjectSizeBytes',
    );
    expect(def).toEqual({ Name: 'ObjectSizeBytes', Unit: 'Bytes' });
  });

  it('処理時間を ValidationLatency として出す', async () => {
    await handler(makeEvent('a.png', 100));
    const doc = emfDocs()[0];
    expect(metricNames(doc)).toContain('ValidationLatency');
    expect(typeof doc.ValidationLatency).toBe('number');
    expect(doc.ValidationLatency as number).toBeGreaterThanOrEqual(0);
  });

  it('バケット名とオブジェクトキーはディメンションに入れない', async () => {
    await handler(makeEvent(SENSITIVE_KEY, 100));
    const doc = emfDocs()[0];
    const dimensionKeys = (directive(doc).Dimensions as string[][])[0];
    // 値の種類が無制限なものをディメンションにすると課金対象が際限なく増える
    expect(dimensionKeys).not.toContain('s3Bucket');
    expect(dimensionKeys).not.toContain('s3Key');
    // プロパティとしては残す（調査に要るため）
    expect(doc.s3Bucket).toBe('test-bucket');
    expect(doc.s3Key).toBe(SENSITIVE_KEY);
  });

  it('ディメンションは Service だけ（既定）', async () => {
    await handler(makeEvent('a.png', 100));
    expect((directive(emfDocs()[0]).Dimensions as string[][])[0]).toEqual(['Service']);
  });

  it('失敗理由はプロパティとして載せる', async () => {
    await handler(makeEvent('a.exe', 100));
    const doc = emfDocs()[0];
    expect(typeof doc.reason).toBe('string');
    expect(doc.reason as string).toContain('unsupported extension');
    expect(metricNames(doc)).not.toContain('reason');
  });

  it('成功時は reason を載せない', async () => {
    await handler(makeEvent('a.png', 100));
    expect(emfDocs()[0].reason).toBeUndefined();
  });

  it('METRICS_NAMESPACE / METRICS_STAGE を反映する', async () => {
    process.env.METRICS_NAMESPACE = 'CustomNs';
    process.env.METRICS_STAGE = 'prod';
    await handler(makeEvent('a.png', 100));
    const doc = emfDocs()[0];
    expect(directive(doc).Namespace).toBe('CustomNs');
    expect((directive(doc).Dimensions as string[][])[0]).toEqual(['Service', 'Stage']);
    expect(doc.Stage).toBe('prod');
  });

  it('ハンドラーの戻り値はメトリクスの有無に関わらず検証結果', async () => {
    const ok = await handler(makeEvent('a.png', 100));
    expect(ok).toEqual({ valid: true, fileKey: 'a.png' });
  });

  it('名前空間の設定ミスがあってもハンドラーは結果を返す', async () => {
    // metrics.ts は設定ミスを例外にする。ハンドラー側はそれを飲み込む。
    process.env.METRICS_NAMESPACE = ' '.repeat(3);
    process.env.METRICS_SERVICE = 'x'.repeat(2000); // ディメンション値の上限超え
    const result = await handler(makeEvent('a.png', 100));
    // 検証自体は済んでいるので、結果を返せないほうが害が大きい
    expect(result).toEqual({ valid: true, fileKey: 'a.png' });
    expect(emfDocs()).toHaveLength(0);
  });

  it('EMF が 1 MB を超えてもハンドラーは結果を返す', async () => {
    // オブジェクトキーをプロパティに載せるため、極端に長いキーで上限に触れる
    const hugeKey = `${'k'.repeat(1024 * 1024)}.png`;
    const result = await handler(makeEvent(hugeKey, 100));
    expect(result.valid).toBe(true);
    // flush が落ちるので EMF は出ないが、警告は残る
    expect(emfDocs()).toHaveLength(0);
    const messages = warned
      .map((l) => {
        try {
          return (JSON.parse(l) as { message?: string }).message ?? '';
        } catch {
          return '';
        }
      })
      .join('\n');
    expect(messages).toContain('メトリクスの出力に失敗しました');
  });

  it('設定ミスのときは warn でログに残す', async () => {
    process.env.METRICS_SERVICE = 'x'.repeat(2000);
    await handler(makeEvent('a.png', 100));
    const messages = warned
      .map((l) => {
        try {
          return (JSON.parse(l) as { message?: string }).message ?? '';
        } catch {
          return '';
        }
      })
      .join('\n');
    expect(messages).toContain('メトリクスの初期化に失敗しました');
  });
});
