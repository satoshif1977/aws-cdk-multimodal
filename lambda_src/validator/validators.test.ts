import {
  // 型
  ValidationError,
  ImageInput,
  MultimodalPayload,
  // 定数
  SUPPORTED_MEDIA_TYPES,
  EXT_TO_MEDIA_TYPE,
  MAX_BASE64_SIZE,
  MAX_IMAGE_FILE_SIZE,
  MAX_DIMENSION,
  MAX_TOTAL_PIXELS,
  MAX_IMAGES_PER_REQUEST,
  MAX_PROMPT_LENGTH,
  BASE64_PATTERN,
  CLAUDE_MODEL_PATTERN,
  // 画像フォーマット
  isSupportedMediaType,
  inferMediaType,
  validateMediaType,
  // Base64
  isValidBase64,
  estimateDecodedSize,
  validateBase64,
  // サイズ・解像度
  isWithinFileSizeLimit,
  isWithinResolutionLimit,
  validateImageDimensions,
  // 画像入力
  validateImageInput,
  // プロンプト
  validatePrompt,
  // モデル
  isClaudeModel,
  // ペイロード
  validatePayload,
  // ユーティリティ
  hasErrors,
  formatErrors,
} from "./validators";

// ── テストヘルパー ────────────────────────────────────────────

function errorsOnly(errors: ValidationError[]): ValidationError[] {
  return errors.filter((e) => e.severity === "error");
}

function warningsOnly(errors: ValidationError[]): ValidationError[] {
  return errors.filter((e) => e.severity === "warning");
}

// 4文字のBase64（3バイトデータ相当）
const VALID_BASE64_4CHAR = "AAAA";
// 有効なBase64（短め）
const VALID_BASE64_SHORT = "SGVsbG8gV29ybGQ=";

function validPayload(overrides?: Partial<MultimodalPayload>): MultimodalPayload {
  return {
    prompt: "この画像を説明してください",
    images: [{ mediaType: "image/jpeg", base64: VALID_BASE64_SHORT }],
    modelId: "anthropic.claude-3-sonnet-20240229-v1:0",
    maxTokens: 1024,
    ...overrides,
  };
}

// ── 定数 ─────────────────────────────────────────────────────

describe("定数", () => {
  test("SUPPORTED_MEDIA_TYPES は 4 種類", () => {
    expect(SUPPORTED_MEDIA_TYPES).toHaveLength(4);
    expect(SUPPORTED_MEDIA_TYPES).toContain("image/jpeg");
    expect(SUPPORTED_MEDIA_TYPES).toContain("image/png");
    expect(SUPPORTED_MEDIA_TYPES).toContain("image/gif");
    expect(SUPPORTED_MEDIA_TYPES).toContain("image/webp");
  });

  test("EXT_TO_MEDIA_TYPE は jpg/jpeg 両対応", () => {
    expect(EXT_TO_MEDIA_TYPE["jpg"]).toBe("image/jpeg");
    expect(EXT_TO_MEDIA_TYPE["jpeg"]).toBe("image/jpeg");
  });

  test("MAX_IMAGES_PER_REQUEST は 20", () => {
    expect(MAX_IMAGES_PER_REQUEST).toBe(20);
  });

  test("MAX_DIMENSION は 8000", () => {
    expect(MAX_DIMENSION).toBe(8000);
  });

  test("MAX_TOTAL_PIXELS は 32MP", () => {
    expect(MAX_TOTAL_PIXELS).toBe(32_000_000);
  });
});

// ── isSupportedMediaType ─────────────────────────────────────

describe("isSupportedMediaType", () => {
  test.each(["image/jpeg", "image/png", "image/gif", "image/webp"])(
    '"%s" はサポート',
    (t) => {
      expect(isSupportedMediaType(t)).toBe(true);
    }
  );

  test.each(["image/svg+xml", "image/bmp", "text/plain", "application/pdf", ""])(
    '"%s" は非サポート',
    (t) => {
      expect(isSupportedMediaType(t)).toBe(false);
    }
  );
});

// ── inferMediaType ───────────────────────────────────────────

describe("inferMediaType", () => {
  test("jpg → image/jpeg", () => {
    expect(inferMediaType("jpg")).toBe("image/jpeg");
  });

  test(".png → image/png（ドット付き）", () => {
    expect(inferMediaType(".png")).toBe("image/png");
  });

  test("GIF → image/gif（大文字）", () => {
    expect(inferMediaType("GIF")).toBe("image/gif");
  });

  test("bmp → 空文字（未対応）", () => {
    expect(inferMediaType("bmp")).toBe("");
  });

  test("空文字 → 空文字", () => {
    expect(inferMediaType("")).toBe("");
  });
});

// ── validateMediaType ────────────────────────────────────────

describe("validateMediaType", () => {
  test("image/jpeg はエラーなし", () => {
    expect(validateMediaType("image/jpeg")).toHaveLength(0);
  });

  test("空文字は error", () => {
    const result = errorsOnly(validateMediaType(""));
    expect(result).toHaveLength(1);
  });

  test("image/bmp は error", () => {
    const result = errorsOnly(validateMediaType("image/bmp"));
    expect(result.some((e) => e.field === "mediaType")).toBe(true);
  });
});

// ── isValidBase64 ────────────────────────────────────────────

describe("isValidBase64", () => {
  test("有効な Base64", () => {
    expect(isValidBase64(VALID_BASE64_SHORT)).toBe(true);
  });

  test("4文字（最小有効）", () => {
    expect(isValidBase64(VALID_BASE64_4CHAR)).toBe(true);
  });

  test("パディング付き", () => {
    expect(isValidBase64("aGVsbA==")).toBe(true);
  });

  test("空文字は false", () => {
    expect(isValidBase64("")).toBe(false);
  });

  test("不正文字（スペース）", () => {
    expect(isValidBase64("SGVs bG8=")).toBe(false);
  });

  test("長さが4の倍数でない", () => {
    expect(isValidBase64("abc")).toBe(false);
  });
});

// ── estimateDecodedSize ──────────────────────────────────────

describe("estimateDecodedSize", () => {
  test("4文字 → 3バイト", () => {
    expect(estimateDecodedSize(4)).toBe(3);
  });

  test("16文字 → 12バイト", () => {
    expect(estimateDecodedSize(16)).toBe(12);
  });

  test("0文字 → 0バイト", () => {
    expect(estimateDecodedSize(0)).toBe(0);
  });
});

// ── validateBase64 ───────────────────────────────────────────

describe("validateBase64", () => {
  test("有効な Base64 はエラーなし", () => {
    expect(validateBase64(VALID_BASE64_SHORT)).toHaveLength(0);
  });

  test("空文字は error", () => {
    const result = errorsOnly(validateBase64(""));
    expect(result).toHaveLength(1);
  });

  test("不正フォーマットは error", () => {
    const result = errorsOnly(validateBase64("!!!invalid!!!"));
    expect(result.some((e) => e.message.includes("Base64"))).toBe(true);
  });
});

// ── isWithinFileSizeLimit ────────────────────────────────────

describe("isWithinFileSizeLimit", () => {
  test("0 は有効", () => {
    expect(isWithinFileSizeLimit(0)).toBe(true);
  });

  test("20MB は有効", () => {
    expect(isWithinFileSizeLimit(MAX_IMAGE_FILE_SIZE)).toBe(true);
  });

  test("20MB+1 は無効", () => {
    expect(isWithinFileSizeLimit(MAX_IMAGE_FILE_SIZE + 1)).toBe(false);
  });

  test("負の値は無効", () => {
    expect(isWithinFileSizeLimit(-1)).toBe(false);
  });
});

// ── isWithinResolutionLimit ──────────────────────────────────

describe("isWithinResolutionLimit", () => {
  test("通常解像度 1920x1080 は有効", () => {
    expect(isWithinResolutionLimit(1920, 1080)).toBe(true);
  });

  test("8000x4000（32MP）は有効", () => {
    expect(isWithinResolutionLimit(8000, 4000)).toBe(true);
  });

  test("8001x1 は無効（幅超過）", () => {
    expect(isWithinResolutionLimit(8001, 1)).toBe(false);
  });

  test("1x8001 は無効（高さ超過）", () => {
    expect(isWithinResolutionLimit(1, 8001)).toBe(false);
  });

  test("8000x4001 は無効（総ピクセル超過）", () => {
    expect(isWithinResolutionLimit(8000, 4001)).toBe(false);
  });

  test("0x100 は無効", () => {
    expect(isWithinResolutionLimit(0, 100)).toBe(false);
  });

  test("負の値は無効", () => {
    expect(isWithinResolutionLimit(-1, 100)).toBe(false);
  });
});

// ── validateImageDimensions ──────────────────────────────────

describe("validateImageDimensions", () => {
  test("情報なしはエラーなし", () => {
    expect(validateImageDimensions({})).toHaveLength(0);
  });

  test("正常なサイズはエラーなし", () => {
    expect(
      validateImageDimensions({ sizeBytes: 1024, width: 800, height: 600 })
    ).toHaveLength(0);
  });

  test("負のファイルサイズは error", () => {
    const result = errorsOnly(validateImageDimensions({ sizeBytes: -1 }));
    expect(result).toHaveLength(1);
  });

  test("0バイトは warning", () => {
    const result = warningsOnly(validateImageDimensions({ sizeBytes: 0 }));
    expect(result).toHaveLength(1);
  });

  test("20MB超は warning", () => {
    const result = warningsOnly(
      validateImageDimensions({ sizeBytes: MAX_IMAGE_FILE_SIZE + 1 })
    );
    expect(result).toHaveLength(1);
  });

  test("解像度超過は warning", () => {
    const result = warningsOnly(
      validateImageDimensions({ width: 8001, height: 100 })
    );
    expect(result.some((e) => e.field === "dimensions")).toBe(true);
  });

  test("総ピクセル超過は error", () => {
    const result = errorsOnly(
      validateImageDimensions({ width: 8000, height: 4001 })
    );
    expect(result.some((e) => e.field === "dimensions")).toBe(true);
  });

  test("幅0は error", () => {
    const result = errorsOnly(
      validateImageDimensions({ width: 0, height: 100 })
    );
    expect(result.some((e) => e.field === "dimensions")).toBe(true);
  });
});

// ── validateImageInput ───────────────────────────────────────

describe("validateImageInput", () => {
  test("正常な入力はエラーなし", () => {
    const input: ImageInput = {
      mediaType: "image/jpeg",
      base64: VALID_BASE64_SHORT,
      sizeBytes: 1024,
    };
    expect(errorsOnly(validateImageInput(input))).toHaveLength(0);
  });

  test("mediaType 未指定は error", () => {
    const input: ImageInput = { base64: VALID_BASE64_SHORT };
    const result = errorsOnly(validateImageInput(input));
    expect(result.some((e) => e.field === "mediaType")).toBe(true);
  });

  test("不正な mediaType は error", () => {
    const input: ImageInput = { mediaType: "image/bmp" };
    const result = errorsOnly(validateImageInput(input));
    expect(result.some((e) => e.field === "mediaType")).toBe(true);
  });

  test("不正な base64 は error", () => {
    const input: ImageInput = { mediaType: "image/png", base64: "!!!" };
    const result = errorsOnly(validateImageInput(input));
    expect(result.some((e) => e.field === "base64")).toBe(true);
  });

  test("base64 なしでも mediaType だけで動く", () => {
    const input: ImageInput = { mediaType: "image/png" };
    expect(errorsOnly(validateImageInput(input))).toHaveLength(0);
  });
});

// ── validatePrompt ───────────────────────────────────────────

describe("validatePrompt", () => {
  test("通常のプロンプトはエラーなし", () => {
    expect(validatePrompt("この画像を説明してください")).toHaveLength(0);
  });

  test("空文字は error", () => {
    const result = errorsOnly(validatePrompt(""));
    expect(result).toHaveLength(1);
  });

  test("空白のみは error", () => {
    const result = errorsOnly(validatePrompt("   "));
    expect(result).toHaveLength(1);
  });

  test("上限超過は error", () => {
    const longPrompt = "あ".repeat(MAX_PROMPT_LENGTH + 1);
    const result = errorsOnly(validatePrompt(longPrompt));
    expect(result).toHaveLength(1);
  });

  test("上限ちょうどはエラーなし", () => {
    const maxPrompt = "a".repeat(MAX_PROMPT_LENGTH);
    expect(validatePrompt(maxPrompt)).toHaveLength(0);
  });
});

// ── isClaudeModel ────────────────────────────────────────────

describe("isClaudeModel", () => {
  test("anthropic.claude-3-sonnet は true", () => {
    expect(isClaudeModel("anthropic.claude-3-sonnet-20240229-v1:0")).toBe(true);
  });

  test("us.anthropic.claude-3-haiku は true", () => {
    expect(isClaudeModel("us.anthropic.claude-3-haiku-20240307-v1:0")).toBe(
      true
    );
  });

  test("anthropic.claude-3-5-sonnet は true", () => {
    expect(isClaudeModel("anthropic.claude-3-5-sonnet-20241022-v2:0")).toBe(
      true
    );
  });

  test("amazon.titan は false", () => {
    expect(isClaudeModel("amazon.titan-image-generator-v1")).toBe(false);
  });

  test("空文字は false", () => {
    expect(isClaudeModel("")).toBe(false);
  });
});

// ── validatePayload ──────────────────────────────────────────

describe("validatePayload", () => {
  test("正常なペイロードはエラーなし", () => {
    const result = validatePayload(validPayload());
    expect(errorsOnly(result)).toHaveLength(0);
  });

  test("prompt 未定義は error", () => {
    const result = errorsOnly(
      validatePayload(validPayload({ prompt: undefined }))
    );
    expect(result.some((e) => e.field === "prompt")).toBe(true);
  });

  test("images 空配列は error", () => {
    const result = errorsOnly(validatePayload(validPayload({ images: [] })));
    expect(result.some((e) => e.field === "images")).toBe(true);
  });

  test("images 未定義は error", () => {
    const result = errorsOnly(
      validatePayload(validPayload({ images: undefined }))
    );
    expect(result.some((e) => e.field === "images")).toBe(true);
  });

  test("画像数超過は error", () => {
    const images = Array.from({ length: 21 }, () => ({
      mediaType: "image/jpeg" as const,
      base64: VALID_BASE64_SHORT,
    }));
    const result = errorsOnly(validatePayload(validPayload({ images })));
    expect(result.some((e) => e.field === "images")).toBe(true);
  });

  test("画像の mediaType エラーが伝播する", () => {
    const result = errorsOnly(
      validatePayload(
        validPayload({
          images: [{ mediaType: "image/bmp" }],
        })
      )
    );
    expect(result.some((e) => e.field === "images[0].mediaType")).toBe(true);
  });

  test("非 Claude モデルは warning", () => {
    const result = warningsOnly(
      validatePayload(
        validPayload({ modelId: "amazon.titan-image-generator-v1" })
      )
    );
    expect(result.some((e) => e.field === "modelId")).toBe(true);
  });

  test("modelId 未指定は warning なし", () => {
    const result = warningsOnly(
      validatePayload(validPayload({ modelId: undefined }))
    );
    expect(result.every((e) => e.field !== "modelId")).toBe(true);
  });

  test("maxTokens が 0 は error", () => {
    const result = errorsOnly(
      validatePayload(validPayload({ maxTokens: 0 }))
    );
    expect(result.some((e) => e.field === "maxTokens")).toBe(true);
  });

  test("maxTokens が負は error", () => {
    const result = errorsOnly(
      validatePayload(validPayload({ maxTokens: -100 }))
    );
    expect(result.some((e) => e.field === "maxTokens")).toBe(true);
  });

  test("maxTokens が小数は error", () => {
    const result = errorsOnly(
      validatePayload(validPayload({ maxTokens: 1.5 }))
    );
    expect(result.some((e) => e.field === "maxTokens")).toBe(true);
  });

  test("maxTokens 未指定はエラーなし", () => {
    const result = validatePayload(validPayload({ maxTokens: undefined }));
    expect(errorsOnly(result)).toHaveLength(0);
  });
});

// ── hasErrors / formatErrors ─────────────────────────────────

describe("hasErrors", () => {
  test("error ありは true", () => {
    expect(hasErrors([{ field: "x", message: "e", severity: "error" }])).toBe(
      true
    );
  });

  test("warning のみは false", () => {
    expect(
      hasErrors([{ field: "x", message: "w", severity: "warning" }])
    ).toBe(false);
  });

  test("空配列は false", () => {
    expect(hasErrors([])).toBe(false);
  });
});

describe("formatErrors", () => {
  test("空配列は通過メッセージ", () => {
    expect(formatErrors([])).toBe("すべてのチェックが通過しました");
  });

  test("error フォーマット", () => {
    const errors: ValidationError[] = [
      { field: "mediaType", message: "テスト", severity: "error" },
    ];
    expect(formatErrors(errors)).toBe("[ERROR] mediaType: テスト");
  });

  test("複数件は改行区切り", () => {
    const errors: ValidationError[] = [
      { field: "a", message: "e1", severity: "error" },
      { field: "b", message: "w1", severity: "warning" },
    ];
    expect(formatErrors(errors).split("\n")).toHaveLength(2);
  });
});
