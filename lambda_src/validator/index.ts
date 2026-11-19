/**
 * validator Lambda
 *
 * EventBridge の S3 "Object Created" を受け取り、拡張子とサイズを検証する。
 *
 * ログは同じディレクトリの logger.ts（1 行 JSON・機密キーは自動マスキング）を使う。
 * ★ S3 のオブジェクトキーには顧客名が入りうる（例: 請求書_山田商事.png）。
 *   マスキングは「キー名」で判定するため、message に埋め込むと素通りする。
 *   必ず context のフィールドとして渡すこと。
 *
 * メトリクスは同じディレクトリの metrics.ts（EMF・標準出力に 1 行 JSON）を使う。
 * ★ バケット名とオブジェクトキーはディメンションに入れない。値の種類の数だけ
 *   課金対象のカスタムメトリクスが作られるため、setProperty() で持たせる。
 */

import { S3EventRecord } from 'aws-lambda';
import { validateObject } from './helpers';
import type { ValidationResult } from './helpers';
import { createLoggerFromEnv } from './logger';
import { createMetricsFromEnv } from './metrics';
import type { Metrics } from './metrics';

// ── re-export ────────────────────────────────────────────────
export type { ValidationResult } from './helpers';
export { decodeS3Key, extractExtension, validateObject } from './helpers';

// ── ロガー ───────────────────────────────────────────────────
const logger = createLoggerFromEnv();

// EventBridge S3 "Object Created" イベント型（aws-lambda 型定義に含まれないため独自定義）
interface EventBridgeS3Event {
  source: string;
  'detail-type': string;
  detail: {
    bucket: { name: string };
    object: { key: string; size: number };
  };
}

/** S3EventRecord から検証（ユニットテスト用・純粋関数） */
export function validateRecord(record: S3EventRecord): ValidationResult {
  return validateObject(record.s3.object.key, record.s3.object.size);
}

/** EventBridge 経由で S3 ObjectCreated を受け取るハンドラー */
export const handler = async (event: EventBridgeS3Event): Promise<ValidationResult> => {
  const { name: bucket } = event.detail.bucket;
  const { size: sizeBytes } = event.detail.object;

  // メトリクスは呼び出しごとに作る。モジュール直下に置くと、同じ実行環境が
  // 使い回されたときに前回のプロパティが残る。
  const metrics = tryCreateMetrics();
  const stopTimer = metrics?.timer('ValidationLatency');

  const result = validateObject(event.detail.object.key, sizeBytes);

  // bucket / key は message に埋めず、以降のログへ自動で付ける
  const log = logger.child({ s3Bucket: bucket, s3Key: result.fileKey });

  if (!result.valid) {
    log.warn('オブジェクトの検証に失敗しました', { reason: result.reason, sizeBytes });
  } else {
    log.info('オブジェクトの検証に成功しました', { sizeBytes });
  }

  stopTimer?.();
  if (metrics) emitValidationMetrics(metrics, result, bucket, sizeBytes);

  return result;
};

/**
 * メトリクスレコーダを作る。作れなければ null を返す。
 *
 * metrics.ts は設定ミス（空の名前空間・不正な単位）を例外にする。
 * CloudWatch が不正な EMF を黙って破棄するため、モジュール単体では
 * 大きな声で失敗させたい。ただしハンドラーの仕事は検証であって、
 * 環境変数の設定ミスで検証まで落とすのは割に合わない。
 */
function tryCreateMetrics(): Metrics | null {
  try {
    return createMetricsFromEnv();
  } catch (err) {
    logger.warn('メトリクスの初期化に失敗しました', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * 検証結果をメトリクスとして出す。
 *
 * メトリクスは副次処理なので、ここでの失敗でハンドラーを落とさない
 * （検証自体は済んでおり、結果を返せないほうが害が大きい）。
 */
function emitValidationMetrics(
  metrics: Metrics,
  result: ValidationResult,
  bucket: string,
  sizeBytes: number,
): void {
  try {
    metrics.count(result.valid ? 'ValidationSucceeded' : 'ValidationFailed');
    metrics.putMetric('ObjectSizeBytes', sizeBytes, { unit: 'Bytes' });

    // バケット名・オブジェクトキー・理由は種類が多いためプロパティに置く
    metrics.setProperty('s3Bucket', bucket);
    metrics.setProperty('s3Key', result.fileKey);
    if (result.reason) metrics.setProperty('reason', result.reason);

    metrics.flush();
  } catch (err) {
    logger.warn('メトリクスの出力に失敗しました', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
