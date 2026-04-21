import base64
import json
import logging
import os
from datetime import datetime, timezone

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# ── 定数 ─────────────────────────────────────────────────
TABLE_NAME = os.environ["TABLE_NAME"]
MODEL_ID = os.environ.get("MODEL_ID", "anthropic.claude-3-haiku-20240307-v1:0")
REGION = os.environ.get("AWS_DEFAULT_REGION", "ap-northeast-1")

SUPPORTED_IMAGE_TYPES: dict[str, str] = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
}

# ── AWS クライアント ───────────────────────────────────────
s3_client = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")
bedrock_client = boto3.client("bedrock-runtime", region_name=REGION)


# ── ヘルパー関数 ──────────────────────────────────────────
def get_media_type(key: str) -> str | None:
    """ファイル拡張子からメディアタイプを返す。非対応の場合は None。"""
    ext = "." + key.rsplit(".", 1)[-1].lower() if "." in key else ""
    return SUPPORTED_IMAGE_TYPES.get(ext)


def fetch_image_base64(bucket: str, key: str) -> str:
    """S3 から画像を取得して Base64 エンコードした文字列を返す。"""
    response = s3_client.get_object(Bucket=bucket, Key=key)
    image_bytes = response["Body"].read()
    return base64.standard_b64encode(image_bytes).decode("utf-8")


def analyze_image(image_base64: str, media_type: str) -> str:
    """Bedrock Claude にマルチモーダルリクエストを送り、画像分析テキストを返す。"""
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

    response = bedrock_client.invoke_model(
        modelId=MODEL_ID,
        contentType="application/json",
        accept="application/json",
        body=json.dumps(body),
    )
    result = json.loads(response["body"].read())
    return result["content"][0]["text"]


# ── メイン処理 ────────────────────────────────────────────
def lambda_handler(event: dict, context: object) -> dict:
    """S3 ObjectCreated イベントを受け取り、画像は Bedrock で分析して DynamoDB に記録する。"""

    table = dynamodb.Table(TABLE_NAME)
    records = event.get("Records", [])
    logger.info(f"受信レコード数: {len(records)}")

    for record in records:
        bucket = record["s3"]["bucket"]["name"]
        key = record["s3"]["object"]["key"]
        size = record["s3"]["object"].get("size", 0)
        uploaded_at = datetime.now(timezone.utc).isoformat()
        media_type = get_media_type(key)

        logger.info(f"ファイルアップロード検知: bucket={bucket}, key={key}, size={size} bytes")

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
            logger.info(f"画像ファイル検知（{media_type}）: Bedrock で分析開始")
            try:
                image_base64 = fetch_image_base64(bucket, key)
                analysis = analyze_image(image_base64, media_type)
                item["analysisResult"] = analysis
                logger.info(f"Bedrock 分析完了: {len(analysis)} 文字")
            except Exception as e:
                logger.error(f"Bedrock 分析エラー: {e}")
                item["analysisResult"] = f"分析エラー: {str(e)}"
        else:
            # ── 非画像ファイル：メタデータのみ記録 ───────────
            logger.info("非画像ファイル: メタデータのみ記録")

        # None 値を持つキーを除去（DynamoDB は None 非対応）
        item = {k: v for k, v in item.items() if v is not None}

        table.put_item(Item=item)
        logger.info(f"DynamoDB 書き込み完了: fileKey={key}")

    return {
        "statusCode": 200,
        "body": json.dumps({"message": "processed", "records": len(records)}),
    }
