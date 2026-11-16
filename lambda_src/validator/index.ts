/**
 * validator Lambda
 *
 * EventBridge の S3 "Object Created" を受け取り、拡張子とサイズを検証する。
 *
 * ログは同じディレクトリの logger.ts（1 行 JSON・機密キーは自動マスキング）を使う。
 * ★ S3 のオブジェクトキーには顧客名が入りうる（例: 請求書_山田商事.png）。
 *   マスキングは「キー名」で判定するため、message に埋め込むと素通りする。
 *   必ず context のフィールドとして渡すこと。
 */

import { S3EventRecord } from 'aws-lambda';
import { validateObject } from './helpers';
import type { ValidationResult } from './helpers';
import { createLoggerFromEnv } from './logger';

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
  const result = validateObject(event.detail.object.key, sizeBytes);

  // bucket / key は message に埋めず、以降のログへ自動で付ける
  const log = logger.child({ s3Bucket: bucket, s3Key: result.fileKey });

  if (!result.valid) {
    log.warn('オブジェクトの検証に失敗しました', { reason: result.reason, sizeBytes });
  } else {
    log.info('オブジェクトの検証に成功しました', { sizeBytes });
  }

  return result;
};
