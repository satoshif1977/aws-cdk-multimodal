import { S3EventRecord } from 'aws-lambda';
import { validateObject } from './helpers';
import type { ValidationResult } from './helpers';

// ── re-export ────────────────────────────────────────────────
export type { ValidationResult } from './helpers';
export { decodeS3Key, extractExtension, validateObject } from './helpers';

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
  const result = validateObject(event.detail.object.key, event.detail.object.size);

  if (!result.valid) {
    console.warn(`[INVALID] ${result.fileKey}: ${result.reason}`);
  } else {
    console.log(`[VALID] ${result.fileKey}`);
  }

  return result;
};
