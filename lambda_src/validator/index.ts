import { S3EventRecord } from 'aws-lambda';

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

export interface ValidationResult {
  valid: boolean;
  fileKey: string;
  reason?: string;
}

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
  const rawKey = record.s3.object.key;
  const fileKey = decodeURIComponent(rawKey.replace(/\+/g, ' '));
  const sizeBytes = record.s3.object.size;

  const ext = fileKey.slice(fileKey.lastIndexOf('.')).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { valid: false, fileKey, reason: `unsupported extension: ${ext}` };
  }

  if (sizeBytes > MAX_SIZE_BYTES) {
    return { valid: false, fileKey, reason: `size ${sizeBytes} exceeds limit ${MAX_SIZE_BYTES}` };
  }

  return { valid: true, fileKey };
}

/** EventBridge 経由で S3 ObjectCreated を受け取るハンドラー */
export const handler = async (event: EventBridgeS3Event): Promise<ValidationResult> => {
  const rawKey = event.detail.object.key;
  const fileKey = decodeURIComponent(rawKey.replace(/\+/g, ' '));
  const sizeBytes = event.detail.object.size;

  const ext = fileKey.slice(fileKey.lastIndexOf('.')).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    console.warn(`[INVALID] ${fileKey}: unsupported extension: ${ext}`);
    return { valid: false, fileKey, reason: `unsupported extension: ${ext}` };
  }

  if (sizeBytes > MAX_SIZE_BYTES) {
    console.warn(`[INVALID] ${fileKey}: size ${sizeBytes} exceeds limit ${MAX_SIZE_BYTES}`);
    return { valid: false, fileKey, reason: `size ${sizeBytes} exceeds limit ${MAX_SIZE_BYTES}` };
  }

  console.log(`[VALID] ${fileKey}`);
  return { valid: true, fileKey };
};
