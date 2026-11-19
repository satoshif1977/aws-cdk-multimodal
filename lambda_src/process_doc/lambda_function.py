"""
process_doc Lambda

EventBridge の S3 "Object Created" イベントを受け取り、画像なら Bedrock で分析して
DynamoDB に記録する。

可観測性は同じディレクトリの 3 つのユーティリティで組み立てている。
  logger.py  … 1 行 JSON の構造化ログ（機密キーは自動マスキング）
  metrics.py … EMF 形式のカスタムメトリクス
  retry.py   … 指数バックオフ + フルジッター

★ S3 のオブジェクトキーやファイル名には顧客名が入りうる（例: 請求書_山田商事.png）。
  マスキングは「キー名」で判定するため、message に埋め込むと素通りする。
  必ずフィールド（キーワード引数）で渡すこと。
"""

import base64
import json
import os
import sys
from datetime import UTC, datetime

import boto3

sys.path.insert(0, os.path.dirname(__file__))
from logger import (  # noqa: E402
    StructuredLogger,
    create_logger_from_env,
    retry_logger,
)
from metrics import (  # noqa: E402
    MetricsCollector,
    create_metrics_from_env,
    retry_metrics,
)
from retry import RetryConfig, retry_call  # noqa: E402

# ── ロガー ─────────────────────────────────────────────────
logger = create_logger_from_env()

# ── 定数 ─────────────────────────────────────────────────
TABLE_NAME = os.environ["TABLE_NAME"]
MODEL_ID = os.environ.get("MODEL_ID", "jp.anthropic.claude-haiku-4-5-20251001-v1:0")
REGION = os.environ.get("AWS_DEFAULT_REGION", "ap-northeast-1")

SUPPORTED_IMAGE_TYPES: dict[str, str] = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
}

# ── リトライ設定 ───────────────────────────────────────────
# Bedrock は同時実行が増えると ThrottlingException を返すため、
# 指数バックオフ + フルジッターで自動リトライする（retry.py を参照）
RETRY_CONFIG = RetryConfig(
    max_attempts=int(os.environ.get("RETRY_MAX_ATTEMPTS", "4")),
    base_delay=float(os.environ.get("RETRY_BASE_DELAY", "0.5")),
    max_delay=float(os.environ.get("RETRY_MAX_DELAY", "8.0")),
)


def retry_hooks(
    operation: str,
    log: StructuredLogger,
    metrics: MetricsCollector | None,
):
    """retry_call(on_retry=...) に渡すフックを1つにまとめる。

    logger.py の retry_logger() と metrics.py の retry_metrics() は
    どちらも (試行回数, 待機秒数, 例外) を受ける同じ形なので、まとめて呼べる。
    metrics が None のときはログだけに絞る。

    束ねる役を呼び出し側に置くことで、logger.py と metrics.py が
    互いを import せずに済む（依存の向きを増やさない）。
    """
    hooks = [retry_logger(log, operation)]
    if metrics is not None:
        hooks.append(retry_metrics(metrics, operation))

    def on_retry(attempt: int, delay_seconds: float, exc: BaseException) -> None:
        for hook in hooks:
            hook(attempt, delay_seconds, exc)

    return on_retry


# ── AWS クライアント ───────────────────────────────────────
s3_client = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")
bedrock_client = boto3.client("bedrock-runtime", region_name=REGION)


# ── ヘルパー関数 ──────────────────────────────────────────
def get_media_type(key: str) -> str | None:
    """ファイル拡張子からメディアタイプを返す。非対応の場合は None。"""
    ext = "." + key.rsplit(".", 1)[-1].lower() if "." in key else ""
    return SUPPORTED_IMAGE_TYPES.get(ext)


def fetch_image_base64(
    bucket: str,
    key: str,
    log: StructuredLogger | None = None,
    metrics: MetricsCollector | None = None,
) -> str:
    """
    S3 から画像を取得して Base64 エンコードした文字列を返す。

    SlowDown（S3 のスロットリング）は retry.py の指数バックオフで自動リトライする。
    """
    log = log or logger
    response = retry_call(
        s3_client.get_object,
        Bucket=bucket,
        Key=key,
        config=RETRY_CONFIG,
        on_retry=retry_hooks("s3.get_object", log, metrics),
    )
    image_bytes = response["Body"].read()
    return base64.standard_b64encode(image_bytes).decode("utf-8")


def analyze_image(
    image_base64: str,
    media_type: str,
    log: StructuredLogger | None = None,
    metrics: MetricsCollector | None = None,
) -> str:
    """
    Bedrock Claude にマルチモーダルリクエストを送り、画像分析テキストを返す。

    ThrottlingException / ModelNotReadyException は retry.py の
    指数バックオフで自動リトライする。
    """
    log = log or logger
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 1024,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": image_base64,
                        },
                    },
                    {
                        "type": "text",
                        "text": (
                            "この画像を詳しく分析してください。以下の項目を日本語で説明してください：\n"
                            "1. 画像に写っているもの・場所・シーン\n"
                            "2. 主要な要素と特徴\n"
                            "3. 色彩・雰囲気\n"
                            "4. その他の注目点"
                        ),
                    },
                ],
            }
        ],
    }

    response = retry_call(
        bedrock_client.invoke_model,
        modelId=MODEL_ID,
        contentType="application/json",
        accept="application/json",
        body=json.dumps(body),
        config=RETRY_CONFIG,
        on_retry=retry_hooks("bedrock.invoke_model", log, metrics),
    )
    result = json.loads(response["body"].read())
    return result["content"][0]["text"]


# ── メイン処理 ────────────────────────────────────────────
def lambda_handler(event: dict, context: object) -> dict:
    """EventBridge S3 ObjectCreated イベントを受け取り、画像は Bedrock で分析して DynamoDB に記録する。"""

    table = dynamodb.Table(TABLE_NAME)
    metrics = create_metrics_from_env(
        FunctionName=os.environ.get("AWS_LAMBDA_FUNCTION_NAME", "process_doc")
    )

    # EventBridge S3 "Object Created" イベント形式: event["detail"]["bucket"]["name"] 等
    detail = event.get("detail", {})
    bucket = detail.get("bucket", {}).get("name", "")
    key = detail.get("object", {}).get("key", "")
    size = detail.get("object", {}).get("size", 0)

    if not bucket or not key:
        # detail をそのまま message へ入れると顧客名入りのキーが生ログに残る。
        # redact を通すフィールドとして渡す。
        logger.error("イベント形式が不正です", detail=detail)
        metrics.add_metric("InvalidEvents", 1, unit="Count")
        metrics.flush()
        return {"statusCode": 400, "body": json.dumps({"message": "invalid event"})}

    # 以降のログに bucket / key を自動で付ける（message には埋めない）
    log = logger.child(s3_bucket=bucket, s3_key=key)
    log.info("イベントを受信しました", size_bytes=size)

    records = [{"bucket": bucket, "key": key, "size": size}]

    for record in records:
        bucket = record["bucket"]
        key = record["key"]
        size = record["size"]
        uploaded_at = datetime.now(UTC).isoformat()
        media_type = get_media_type(key)

        item: dict = {
            "fileKey": key,
            "bucket": bucket,
            "size": size,
            "uploadedAt": uploaded_at,
            "fileType": "image" if media_type else "document",
            "modelId": MODEL_ID if media_type else None,
        }

        if media_type:
            # ── 画像ファイル：Bedrock で分析 ─────────────────
            log.info("画像ファイルを検知しました", media_type=media_type)
            try:
                with metrics.timer("AnalysisDuration"):
                    image_base64 = fetch_image_base64(bucket, key, log, metrics)
                    analysis = analyze_image(image_base64, media_type, log, metrics)
                item["analysisResult"] = analysis
                log.info("Bedrock の分析が完了しました", analysis_length=len(analysis))
                metrics.add_metric("AnalysisSucceeded", 1, unit="Count")
            except Exception as e:
                # 例外オブジェクトを渡すと logger.py が type/message/stack に展開する
                log.error("Bedrock の分析に失敗しました", error=e)
                item["analysisResult"] = f"分析エラー: {str(e)}"
                metrics.add_metric("AnalysisFailed", 1, unit="Count")
        else:
            # ── 非画像ファイル：メタデータのみ記録 ───────────
            log.info("非画像ファイルのためメタデータのみ記録します")
            metrics.add_metric("MetadataOnly", 1, unit="Count")

        # None 値を持つキーを除去（DynamoDB は None 非対応）
        item = {k: v for k, v in item.items() if v is not None}

        # ProvisionedThroughputExceededException に備えてリトライ付きで書き込む
        retry_call(
            table.put_item,
            Item=item,
            config=RETRY_CONFIG,
            on_retry=retry_hooks("dynamodb.put_item", log, metrics),
        )
        log.info("DynamoDB への書き込みが完了しました")
        metrics.add_metric("ProcessedFiles", 1, unit="Count")
        metrics.add_metric("FileSize", size, unit="Bytes")

    metrics.flush()

    return {
        "statusCode": 200,
        "body": json.dumps({"message": "processed", "key": key}),
    }
