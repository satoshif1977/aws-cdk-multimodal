/**
 * metrics.ts の単体テスト
 *
 * EMF は「CloudWatch が黙って破棄する」種類の失敗が多い。
 * 壊れた文書を出さないことを、出力そのものを読んで確かめる。
 */

import {
  DEFAULT_NAMESPACE,
  DEFAULT_UNIT,
  HIGH_RESOLUTION,
  MAX_DIMENSION_KEYS,
  MAX_DIMENSION_VALUE_LENGTH,
  MAX_METRICS_PER_DOCUMENT,
  MAX_NAME_LENGTH,
  MAX_VALUES_PER_METRIC,
  METRIC_UNITS,
  RESERVED_ROOT_KEY,
  STANDARD_RESOLUTION,
  consoleMetricsSink,
  createMetrics,
  createMetricsFromEnv,
} from './metrics';
import type { Metrics, MetricsOptions } from './metrics';

// ── テスト用ヘルパー ──────────────────────────────────────────

interface Harness {
  metrics: Metrics;
  lines: string[];
  docs: () => Record<string, unknown>[];
  setNow: (ms: number) => void;
}

function makeMetrics(options: Partial<MetricsOptions> = {}): Harness {
  const lines: string[] = [];
  let current = 1_700_000_000_000;
  const metrics = createMetrics({
    namespace: 'TestNs',
    sink: (line) => lines.push(line),
    now: () => current,
    ...options,
  });
  return {
    metrics,
    lines,
    docs: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
    setNow: (ms) => {
      current = ms;
    },
  };
}

function directive(doc: Record<string, unknown>): Record<string, unknown> {
  const aws = doc[RESERVED_ROOT_KEY] as Record<string, unknown>;
  const list = aws.CloudWatchMetrics as Record<string, unknown>[];
  return list[0];
}

function metricNames(doc: Record<string, unknown>): string[] {
  const defs = directive(doc).Metrics as { Name: string }[];
  return defs.map((d) => d.Name);
}

// ── 生成 ──────────────────────────────────────────────────────

describe('createMetrics の生成時の検証', () => {
  it('名前空間が空なら例外にする', () => {
    expect(() => createMetrics({ namespace: '' })).toThrow(TypeError);
    expect(() => createMetrics({ namespace: '   ' })).toThrow(/名前空間が空/);
  });

  it('名前空間が上限を超えたら例外にする', () => {
    expect(() => createMetrics({ namespace: 'a'.repeat(MAX_NAME_LENGTH + 1) })).toThrow(RangeError);
  });

  it('名前空間の前後の空白は落とす', () => {
    const { metrics } = makeMetrics({ namespace: '  Padded  ' });
    expect(metrics.namespace).toBe('Padded');
  });

  it('不正なディメンションは生成時に弾く', () => {
    expect(() => makeMetrics({ dimensions: { '': 'v' } })).toThrow(RangeError);
    expect(() => makeMetrics({ dimensions: { k: '' } })).toThrow(TypeError);
    expect(() => makeMetrics({ dimensions: { [RESERVED_ROOT_KEY]: 'v' } })).toThrow(TypeError);
  });

  it('ディメンション値が上限を超えたら例外にする', () => {
    const long = 'v'.repeat(MAX_DIMENSION_VALUE_LENGTH + 1);
    expect(() => makeMetrics({ dimensions: { k: long } })).toThrow(RangeError);
  });

  it('ディメンションのキー数が上限を超えたら例外にする', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i <= MAX_DIMENSION_KEYS; i++) many[`k${i}`] = 'v';
    expect(() => makeMetrics({ dimensions: many })).toThrow(RangeError);
  });
});

// ── 値の検証 ──────────────────────────────────────────────────

describe('メトリクス値の検証', () => {
  it('NaN と Infinity は受け付けない', () => {
    const { metrics } = makeMetrics();
    // JSON.stringify がこれらを null にするため、黙って欠落する前に弾く
    expect(() => metrics.putMetric('M', Number.NaN)).toThrow(/NaN または Infinity/);
    expect(() => metrics.putMetric('M', Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => metrics.putMetric('M', Number.NEGATIVE_INFINITY)).toThrow(TypeError);
  });

  it('数値でない値は受け付けない', () => {
    const { metrics } = makeMetrics();
    expect(() => metrics.putMetric('M', '1' as unknown as number)).toThrow(/数値ではありません/);
  });

  it('負の値とゼロは受け付ける', () => {
    const { metrics, docs } = makeMetrics();
    metrics.putMetric('Neg', -1);
    metrics.putMetric('Zero', 0);
    metrics.flush();
    expect(docs()[0].Neg).toBe(-1);
    expect(docs()[0].Zero).toBe(0);
  });

  it('メトリクス名が空・長すぎ・予約キーなら例外にする', () => {
    const { metrics } = makeMetrics();
    expect(() => metrics.putMetric('', 1)).toThrow(/メトリクス名が空/);
    expect(() => metrics.putMetric('a'.repeat(MAX_NAME_LENGTH + 1), 1)).toThrow(RangeError);
    expect(() => metrics.putMetric(RESERVED_ROOT_KEY, 1)).toThrow(/予約キー/);
  });

  it('サポート外の単位は例外にする', () => {
    const { metrics } = makeMetrics();
    // CloudWatch は大文字小文字を区別する。小文字は無効。
    expect(() => metrics.putMetric('M', 1, { unit: 'milliseconds' as never })).toThrow(
      /サポートしていません/,
    );
  });

  it('公式の単位はすべて受け付ける', () => {
    const { metrics } = makeMetrics();
    for (const unit of METRIC_UNITS) {
      expect(() => metrics.putMetric(`M_${unit.replace(/\W/g, '_')}`, 1, { unit })).not.toThrow();
    }
  });
});

// ── 出力の形 ──────────────────────────────────────────────────

describe('EMF ドキュメントの形', () => {
  it('メトリクスが無ければ何も出さない', () => {
    const { metrics, lines } = makeMetrics();
    metrics.flush();
    expect(lines).toHaveLength(0);
  });

  it('flush 後は定義がリセットされ、二重に出ない', () => {
    const { metrics, lines } = makeMetrics();
    metrics.count('A');
    metrics.flush();
    metrics.flush();
    expect(lines).toHaveLength(1);
  });

  it('Timestamp はエポックミリ秒で入る', () => {
    const { metrics, docs, setNow } = makeMetrics();
    setNow(1_234_567_890_123);
    metrics.count('A');
    metrics.flush();
    const aws = docs()[0][RESERVED_ROOT_KEY] as Record<string, unknown>;
    expect(aws.Timestamp).toBe(1_234_567_890_123);
  });

  it('値が1件ならスカラー、複数なら配列で出る', () => {
    const { metrics, docs } = makeMetrics();
    metrics.count('Single');
    metrics.count('Multi');
    metrics.count('Multi');
    metrics.flush();
    expect(docs()[0].Single).toBe(1);
    expect(docs()[0].Multi).toEqual([1, 1]);
  });

  it('既定の単位と標準解像度は出力から省く', () => {
    const { metrics, docs } = makeMetrics();
    metrics.putMetric('Plain', 1);
    metrics.flush();
    const def = (directive(docs()[0]).Metrics as Record<string, unknown>[])[0];
    expect(def).toEqual({ Name: 'Plain' });
    expect(DEFAULT_UNIT).toBe('None');
    expect(STANDARD_RESOLUTION).toBe(60);
  });

  it('高解像度を指定したときだけ StorageResolution を出す', () => {
    const { metrics, docs } = makeMetrics();
    metrics.putMetric('Fast', 1, { unit: 'Count', highResolution: true });
    metrics.flush();
    const def = (directive(docs()[0]).Metrics as Record<string, unknown>[])[0];
    expect(def).toEqual({ Name: 'Fast', Unit: 'Count', StorageResolution: HIGH_RESOLUTION });
  });

  it('ディメンションが無くても空の DimensionSet を 1 つ置く', () => {
    const { metrics, docs } = makeMetrics();
    metrics.count('A');
    metrics.flush();
    expect(directive(docs()[0]).Dimensions).toEqual([[]]);
  });

  it('ディメンションはキー順で安定して並ぶ', () => {
    const { metrics, docs } = makeMetrics({ dimensions: { Zeta: '1', Alpha: '2' } });
    metrics.count('A');
    metrics.flush();
    expect(directive(docs()[0]).Dimensions).toEqual([['Alpha', 'Zeta']]);
    expect(docs()[0].Alpha).toBe('2');
    expect(docs()[0].Zeta).toBe('1');
  });

  it('名前空間が MetricDirective に入る', () => {
    const { metrics, docs } = makeMetrics({ namespace: 'MyNs' });
    metrics.count('A');
    metrics.flush();
    expect(directive(docs()[0]).Namespace).toBe('MyNs');
  });
});

// ── 糖衣 ──────────────────────────────────────────────────────

describe('count / duration / timer', () => {
  it('count は単位 Count・既定値 1', () => {
    const { metrics, docs } = makeMetrics();
    metrics.count('Hits');
    metrics.count('Hits', 5);
    metrics.flush();
    const def = (directive(docs()[0]).Metrics as Record<string, unknown>[])[0];
    expect(def).toEqual({ Name: 'Hits', Unit: 'Count' });
    expect(docs()[0].Hits).toEqual([1, 5]);
  });

  it('duration は単位 Milliseconds', () => {
    const { metrics, docs } = makeMetrics();
    metrics.duration('Elapsed', 42);
    metrics.flush();
    const def = (directive(docs()[0]).Metrics as Record<string, unknown>[])[0];
    expect(def).toEqual({ Name: 'Elapsed', Unit: 'Milliseconds' });
    expect(docs()[0].Elapsed).toBe(42);
  });

  it('timer は停止時に経過ミリ秒を記録する', () => {
    const { metrics, docs, setNow } = makeMetrics();
    setNow(1000);
    const stop = metrics.timer('Latency');
    setNow(1250);
    stop();
    metrics.flush();
    expect(docs()[0].Latency).toBe(250);
  });

  it('timer を止めなければ何も記録されない', () => {
    const { metrics, lines } = makeMetrics();
    metrics.timer('Latency');
    metrics.flush();
    expect(lines).toHaveLength(0);
  });
});

// ── プロパティ ────────────────────────────────────────────────

describe('setProperty', () => {
  it('プロパティはルート直下に載るがメトリクス定義には入らない', () => {
    const { metrics, docs } = makeMetrics();
    metrics.count('A');
    metrics.setProperty('requestId', 'abc-123');
    metrics.flush();
    expect(docs()[0].requestId).toBe('abc-123');
    expect(metricNames(docs()[0])).toEqual(['A']);
  });

  it('オブジェクトや null も載せられる', () => {
    const { metrics, docs } = makeMetrics();
    metrics.count('A');
    metrics.setProperty('detail', { nested: true });
    metrics.setProperty('empty', null);
    metrics.flush();
    expect(docs()[0].detail).toEqual({ nested: true });
    expect(docs()[0].empty).toBeNull();
  });

  it('キーが空・予約キーなら例外にする', () => {
    const { metrics } = makeMetrics();
    expect(() => metrics.setProperty('', 1)).toThrow(/キーが空/);
    expect(() => metrics.setProperty(RESERVED_ROOT_KEY, 1)).toThrow(/予約キー/);
  });

  it('flush してもプロパティは残る（同じ呼び出しの付帯情報のため）', () => {
    const { metrics, docs } = makeMetrics();
    metrics.setProperty('requestId', 'abc');
    metrics.count('A');
    metrics.flush();
    metrics.count('B');
    metrics.flush();
    expect(docs()[1].requestId).toBe('abc');
  });
});

// ── 名前の衝突 ────────────────────────────────────────────────

describe('名前の衝突を検出する', () => {
  it('メトリクス名がディメンション名と衝突したら例外にする', () => {
    const { metrics } = makeMetrics({ dimensions: { Service: 'v' } });
    expect(() => metrics.count('Service')).toThrow(/ディメンション名と衝突/);
  });

  it('メトリクス名がプロパティ名と衝突したら例外にする', () => {
    const { metrics } = makeMetrics();
    metrics.setProperty('dup', 1);
    expect(() => metrics.count('dup')).toThrow(/プロパティ名と衝突/);
  });

  it('ディメンション名がメトリクス名と衝突したら例外にする', () => {
    const { metrics } = makeMetrics();
    metrics.count('Dup');
    expect(() => metrics.setDimensions({ Dup: 'v' })).toThrow(/メトリクス名と衝突/);
  });

  it('プロパティ名がディメンション名と衝突したら例外にする', () => {
    const { metrics } = makeMetrics({ dimensions: { Service: 'v' } });
    expect(() => metrics.setProperty('Service', 1)).toThrow(/ディメンション名と衝突/);
  });

  it('プロパティ名がメトリクス名と衝突したら例外にする', () => {
    const { metrics } = makeMetrics();
    metrics.count('Dup');
    expect(() => metrics.setProperty('Dup', 1)).toThrow(/メトリクス名と衝突/);
  });
});

// ── 1 MB 上限 ────────────────────────────────────────────────

describe('EMF ドキュメントのサイズ上限', () => {
  it('1 MB を超えたら例外にする', () => {
    const { metrics } = makeMetrics();
    metrics.count('A');
    // プロパティは自動 flush の対象外なので、ここだけは上限を超えうる
    metrics.setProperty('huge', 'x'.repeat(1024 * 1024 + 1));
    expect(() => metrics.flush()).toThrow(/1 MB を超えました/);
  });
});

// ── 上限 ──────────────────────────────────────────────────────

describe('上限に達したら自動で flush する', () => {
  it('1 メトリクスの値が上限に達したら区切る', () => {
    const { metrics, lines, docs } = makeMetrics();
    for (let i = 0; i < MAX_VALUES_PER_METRIC + 1; i++) metrics.count('A');
    expect(lines).toHaveLength(1);
    expect((docs()[0].A as number[]).length).toBe(MAX_VALUES_PER_METRIC);
    metrics.flush();
    expect(docs()[1].A).toBe(1);
  });

  it('メトリクス定義の数が上限に達したら区切る', () => {
    const { metrics, lines, docs } = makeMetrics();
    for (let i = 0; i < MAX_METRICS_PER_DOCUMENT + 1; i++) metrics.count(`M${i}`);
    expect(lines).toHaveLength(1);
    expect(metricNames(docs()[0])).toHaveLength(MAX_METRICS_PER_DOCUMENT);
    metrics.flush();
    expect(metricNames(docs()[1])).toEqual([`M${MAX_METRICS_PER_DOCUMENT}`]);
  });

  it('上限到達では例外を投げない（メトリクスは副次処理のため）', () => {
    const { metrics } = makeMetrics();
    expect(() => {
      for (let i = 0; i < MAX_METRICS_PER_DOCUMENT * 2; i++) metrics.count(`M${i}`);
    }).not.toThrow();
  });
});

// ── 既定のシンク ──────────────────────────────────────────────

describe('consoleMetricsSink', () => {
  it('console.log に 1 行で書く', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      consoleMetricsSink('{"a":1}');
      expect(spy).toHaveBeenCalledWith('{"a":1}');
    } finally {
      spy.mockRestore();
    }
  });

  it('sink を省略すると console.log が使われる', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const m = createMetrics({ namespace: 'N', now: () => 1 });
      m.count('A');
      m.flush();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(() => JSON.parse(spy.mock.calls[0][0] as string)).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

// ── 環境変数からの生成 ────────────────────────────────────────

describe('createMetricsFromEnv', () => {
  it('環境変数が無ければ既定の名前空間と Service を使う', () => {
    const lines: string[] = [];
    const m = createMetricsFromEnv({}, { sink: (l) => lines.push(l), now: () => 1 });
    expect(m.namespace).toBe(DEFAULT_NAMESPACE);
    m.count('A');
    m.flush();
    const doc = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(doc.Service).toBe('validator');
    expect(directive(doc).Dimensions).toEqual([['Service']]);
  });

  it('METRICS_NAMESPACE / METRICS_SERVICE を反映する', () => {
    const lines: string[] = [];
    const m = createMetricsFromEnv(
      { METRICS_NAMESPACE: 'Custom', METRICS_SERVICE: 'other' },
      { sink: (l) => lines.push(l), now: () => 1 },
    );
    expect(m.namespace).toBe('Custom');
    m.count('A');
    m.flush();
    expect((JSON.parse(lines[0]) as Record<string, unknown>).Service).toBe('other');
  });

  it('METRICS_STAGE があるときだけ Stage ディメンションを足す', () => {
    const lines: string[] = [];
    const m = createMetricsFromEnv(
      { METRICS_STAGE: 'prod' },
      { sink: (l) => lines.push(l), now: () => 1 },
    );
    m.count('A');
    m.flush();
    const doc = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(doc.Stage).toBe('prod');
    expect(directive(doc).Dimensions).toEqual([['Service', 'Stage']]);
  });

  it('空文字や空白だけの環境変数は既定値に落とす', () => {
    const lines: string[] = [];
    const m = createMetricsFromEnv(
      { METRICS_NAMESPACE: '   ', METRICS_SERVICE: '', METRICS_STAGE: '  ' },
      { sink: (l) => lines.push(l), now: () => 1 },
    );
    expect(m.namespace).toBe(DEFAULT_NAMESPACE);
    m.count('A');
    m.flush();
    const doc = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(doc.Service).toBe('validator');
    expect(doc.Stage).toBeUndefined();
  });
});
