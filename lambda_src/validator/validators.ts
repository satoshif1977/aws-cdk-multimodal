/**
 * Bedrock マルチモーダルリクエスト バリデーター
 *
 * Bedrock API に送信する画像データ・マルチモーダルペイロードを
 * 事前検証する純粋関数群。AWS SDK に依存しないため単体テストが容易。
 *
 * 検証内容:
 *   - Bedrock がサポートする画像 MIME タイプ
 *   - 画像サイズ制約（ファイルサイズ・Base64 エンコード後サイズ）
 *   - 画像解像度（幅×高さ上限）
 *   - Base64 エンコード文字列の妥当性
 *   - マルチモーダルペイロード構造（テキスト + 画像）
 *   - S3 オブジェクト検証との整合性
 */

// ── 型定義 ────────────────────────────────────────────────────

export interface ValidationError {
  field: string;
  message: string;
  severity: "error" | "warning";
}

export interface ImageInput {
  base64?: string;
  mediaType?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
}

export interface MultimodalPayload {
  prompt?: string;
  images?: ImageInput[];
  modelId?: string;
  maxTokens?: number;
}

// ── 定数 ─────────────────────────────────────────────────────

/** Bedrock がサポートする画像 MIME タイプ */
export const SUPPORTED_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

/** 拡張子 → MIME タイプ マッピング */
export const EXT_TO_MEDIA_TYPE: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

/** Bedrock API の画像ペイロード上限（Base64 後）: 約 25 MB */
export const MAX_BASE64_SIZE = 25 * 1024 * 1024;

/** S3 からの入力画像の推奨最大ファイルサイズ: 20 MB */
export const MAX_IMAGE_FILE_SIZE = 20 * 1024 * 1024;

/** Bedrock Claude の推奨最大解像度（幅 or 高さ） */
export const MAX_DIMENSION = 8000;

/** 解像度の最大総ピクセル数（幅×高さ）: 約 32 MP */
export const MAX_TOTAL_PIXELS = 32_000_000;

/** 1リクエストあたりの最大画像数（Claude 3.x） */
export const MAX_IMAGES_PER_REQUEST = 20;

/** プロンプトの最大文字数 */
export const MAX_PROMPT_LENGTH = 200_000;

/** Base64 文字列の正規表現パターン */
export const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** Bedrock Claude モデル ID パターン */
export const CLAUDE_MODEL_PATTERN =
  /^(anthropic\.claude-|us\.anthropic\.claude-)/;

// ── 画像フォーマットバリデーション ────────────────────────────

/** MIME タイプが Bedrock サポート対象か */
export function isSupportedMediaType(mediaType: string): boolean {
  return (SUPPORTED_MEDIA_TYPES as readonly string[]).includes(mediaType);
}

/** 拡張子から MIME タイプを推定する（不明は空文字） */
export function inferMediaType(extension: string): string {
  const ext = extension.toLowerCase().replace(/^\./, "");
  return EXT_TO_MEDIA_TYPE[ext] ?? "";
}

/** MIME タイプを検証する */
export function validateMediaType(mediaType: string): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!mediaType) {
    errors.push({
      field: "mediaType",
      message: "mediaType が未指定です",
      severity: "error",
    });
    return errors;
  }

  if (!isSupportedMediaType(mediaType)) {
    errors.push({
      field: "mediaType",
      message: `Bedrock 未サポートの MIME タイプ: "${mediaType}"。サポート: ${SUPPORTED_MEDIA_TYPES.join(", ")}`,
      severity: "error",
    });
  }

  return errors;
}

// ── Base64 バリデーション ─────────────────────────────────────

/** Base64 文字列が有効なフォーマットか */
export function isValidBase64(value: string): boolean {
  if (value.length === 0) return false;
  if (value.length % 4 !== 0) return false;
  return BASE64_PATTERN.test(value);
}

/** Base64 文字列からデコード後のバイト数を推定する */
export function estimateDecodedSize(base64Length: number): number {
  return Math.floor((base64Length * 3) / 4);
}

/** Base64 データを検証する */
export function validateBase64(base64: string): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!base64) {
    errors.push({
      field: "base64",
      message: "Base64 データが空です",
      severity: "error",
    });
    return errors;
  }

  if (!isValidBase64(base64)) {
    errors.push({
      field: "base64",
      message: "無効な Base64 フォーマットです",
      severity: "error",
    });
    return errors;
  }

  if (base64.length > MAX_BASE64_SIZE) {
    errors.push({
      field: "base64",
      message: `Base64 データが上限 ${MAX_BASE64_SIZE} バイトを超えています（${base64.length} バイト）`,
      severity: "error",
    });
  }

  return errors;
}

// ── 画像サイズ・解像度バリデーション ──────────────────────────

/** ファイルサイズが推奨範囲内か */
export function isWithinFileSizeLimit(sizeBytes: number): boolean {
  return sizeBytes >= 0 && sizeBytes <= MAX_IMAGE_FILE_SIZE;
}

/** 解像度が推奨範囲内か */
export function isWithinResolutionLimit(
  width: number,
  height: number
): boolean {
  if (width <= 0 || height <= 0) return false;
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) return false;
  return width * height <= MAX_TOTAL_PIXELS;
}

/** 画像サイズ・解像度を検証する */
export function validateImageDimensions(
  input: ImageInput
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (input.sizeBytes !== undefined) {
    if (input.sizeBytes < 0) {
      errors.push({
        field: "sizeBytes",
        message: `ファイルサイズが負の値です: ${input.sizeBytes}`,
        severity: "error",
      });
    } else if (input.sizeBytes === 0) {
      errors.push({
        field: "sizeBytes",
        message: "ファイルサイズが 0 です（空ファイル）",
        severity: "warning",
      });
    } else if (!isWithinFileSizeLimit(input.sizeBytes)) {
      errors.push({
        field: "sizeBytes",
        message: `ファイルサイズ（${input.sizeBytes} バイト）が推奨上限 ${MAX_IMAGE_FILE_SIZE} バイトを超えています`,
        severity: "warning",
      });
    }
  }

  if (input.width !== undefined && input.height !== undefined) {
    if (input.width <= 0 || input.height <= 0) {
      errors.push({
        field: "dimensions",
        message: `解像度が無効です: ${input.width}x${input.height}`,
        severity: "error",
      });
    } else {
      if (input.width > MAX_DIMENSION || input.height > MAX_DIMENSION) {
        errors.push({
          field: "dimensions",
          message: `解像度（${input.width}x${input.height}）が推奨上限 ${MAX_DIMENSION}px を超えています`,
          severity: "warning",
        });
      }

      if (input.width * input.height > MAX_TOTAL_PIXELS) {
        errors.push({
          field: "dimensions",
          message: `総ピクセル数（${input.width * input.height}）が上限 ${MAX_TOTAL_PIXELS} を超えています`,
          severity: "error",
        });
      }
    }
  }

  return errors;
}

// ── 画像入力バリデーション ────────────────────────────────────

/** 画像入力を検証する */
export function validateImageInput(input: ImageInput): ValidationError[] {
  const errors: ValidationError[] = [];

  if (input.mediaType !== undefined) {
    errors.push(...validateMediaType(input.mediaType));
  } else {
    errors.push({
      field: "mediaType",
      message: "mediaType が未指定です。Bedrock API に必須のフィールドです",
      severity: "error",
    });
  }

  if (input.base64 !== undefined) {
    errors.push(...validateBase64(input.base64));
  }

  errors.push(...validateImageDimensions(input));

  return errors;
}

// ── マルチモーダルペイロードバリデーション ────────────────────

/** プロンプトを検証する */
export function validatePrompt(prompt: string): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!prompt.trim()) {
    errors.push({
      field: "prompt",
      message: "プロンプトが空です",
      severity: "error",
    });
    return errors;
  }

  if ([...prompt].length > MAX_PROMPT_LENGTH) {
    errors.push({
      field: "prompt",
      message: `プロンプトが上限 ${MAX_PROMPT_LENGTH} 文字を超えています`,
      severity: "error",
    });
  }

  return errors;
}

/** モデル ID が Claude パターンに一致するか */
export function isClaudeModel(modelId: string): boolean {
  return CLAUDE_MODEL_PATTERN.test(modelId);
}

/** マルチモーダルペイロードを検証する */
export function validatePayload(
  payload: MultimodalPayload
): ValidationError[] {
  const errors: ValidationError[] = [];

  // prompt
  if (payload.prompt !== undefined) {
    errors.push(...validatePrompt(payload.prompt));
  } else {
    errors.push({
      field: "prompt",
      message: "prompt が未定義です",
      severity: "error",
    });
  }

  // images
  if (!payload.images || payload.images.length === 0) {
    errors.push({
      field: "images",
      message:
        "画像が含まれていません。マルチモーダルリクエストには最低1枚の画像が必要です",
      severity: "error",
    });
  } else {
    if (payload.images.length > MAX_IMAGES_PER_REQUEST) {
      errors.push({
        field: "images",
        message: `画像数（${payload.images.length}）が上限 ${MAX_IMAGES_PER_REQUEST} を超えています`,
        severity: "error",
      });
    }

    payload.images.forEach((img, idx) => {
      const imgErrors = validateImageInput(img);
      imgErrors.forEach((e) => {
        errors.push({
          ...e,
          field: `images[${idx}].${e.field}`,
        });
      });
    });
  }

  // modelId
  if (payload.modelId !== undefined && !isClaudeModel(payload.modelId)) {
    errors.push({
      field: "modelId",
      message: `Claude モデル以外が指定されています: "${payload.modelId}"。マルチモーダルは Claude 3.x 以降が必要です`,
      severity: "warning",
    });
  }

  // maxTokens
  if (payload.maxTokens !== undefined) {
    if (!Number.isInteger(payload.maxTokens) || payload.maxTokens <= 0) {
      errors.push({
        field: "maxTokens",
        message: `maxTokens は正の整数である必要があります（現在: ${payload.maxTokens}）`,
        severity: "error",
      });
    }
  }

  return errors;
}

// ── ユーティリティ ────────────────────────────────────────────

/** エラーの有無を判定する（warning は含まない） */
export function hasErrors(errors: ValidationError[]): boolean {
  return errors.some((e) => e.severity === "error");
}

/** エラーをフォーマットする */
export function formatErrors(errors: ValidationError[]): string {
  if (errors.length === 0) return "すべてのチェックが通過しました";
  return errors
    .map((e) => `[${e.severity.toUpperCase()}] ${e.field}: ${e.message}`)
    .join("\n");
}
