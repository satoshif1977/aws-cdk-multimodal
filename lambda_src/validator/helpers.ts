/**
 * validator ヘルパー関数・定数
 * S3 オブジェクト検証ロジックを index.ts から分離。
 */

// ── 定数 ─────────────────────────────────────────────────────
export const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
export const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

// ── 型定義 ───────────────────────────────────────────────────
export interface ValidationResult {
  valid: boolean;
  fileKey: string;
  reason?: string;
}

// ── ヘルパー関数 ──────────────────────────────────────────────

/**
 * URL エンコードされた S3 オブジェクトキーをデコードする。
 * '+' をスペースに変換してから decodeURIComponent を適用する。
 */
export function decodeS3Key(rawKey: string): string {
  return decodeURIComponent(rawKey.replace(/\+/g, ' '));
}

/**
 * ファイルキーから拡張子を小文字で取得する。
 */
export function extractExtension(fileKey: string): string {
  return fileKey.slice(fileKey.lastIndexOf('.')).toLowerCase();
}

/**
 * S3 オブジェクトのキーとサイズを検証する。
 * 拡張子チェック → サイズチェック の順で判定する。
 */
export function validateObject(rawKey: string, sizeBytes: number): ValidationResult {
  const fileKey = decodeS3Key(rawKey);
  const ext = extractExtension(fileKey);

  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { valid: false, fileKey, reason: `unsupported extension: ${ext}` };
  }

  if (sizeBytes > MAX_SIZE_BYTES) {
    return { valid: false, fileKey, reason: `size ${sizeBytes} exceeds limit ${MAX_SIZE_BYTES}` };
  }

  return { valid: true, fileKey };
}
