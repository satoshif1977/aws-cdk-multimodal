import json
import logging
import os
from datetime import datetime, timezone

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

dynamodb = boto3.resource("dynamodb")
TABLE_NAME = os.environ["TABLE_NAME"]


def lambda_handler(event: dict, context: object) -> dict:
    """S3 ObjectCreated イベントを受け取り、ファイル情報を DynamoDB に記録する。"""

    table = dynamodb.Table(TABLE_NAME)
    records = event.get("Records", [])
    logger.info(f"受信レコード数: {len(records)}")

    for record in records:
        bucket = record["s3"]["bucket"]["name"]
        key = record["s3"]["object"]["key"]
        size = record["s3"]["object"].get("size", 0)
        uploaded_at = datetime.now(timezone.utc).isoformat()

        logger.info(f"ファイルアップロード検知: bucket={bucket}, key={key}, size={size} bytes")

        # DynamoDB にアップロード履歴を記録
        table.put_item(
            Item={
                "fileKey": key,
                "bucket": bucket,
                "size": size,
                "uploadedAt": uploaded_at,
            }
        )
        logger.info(f"DynamoDB 書き込み完了: fileKey={key}")

    return {
        "statusCode": 200,
        "body": json.dumps({"message": "processed", "records": len(records)}),
    }
