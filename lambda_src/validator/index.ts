import { S3Event, S3EventRecord } from 'aws-lambda';

const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

export interface ValidationResult {
  valid: boolean;
  fileKey: string;
  reason?: string;
}

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

export const handler = async (event: S3Event): Promise<ValidationResult[]> => {
  const results = event.Records.map(validateRecord);

  results.forEach((r) => {
    if (r.valid) {
      console.log(`[VALID] ${r.fileKey}`);
    } else {
      console.warn(`[INVALID] ${r.fileKey}: ${r.reason}`);
    }
  });

  return results;
};
