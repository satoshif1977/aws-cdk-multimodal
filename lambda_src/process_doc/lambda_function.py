import json
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def lambda_handler(event: dict, context: object) -> dict:
    """S3 ObjectCreated イベントを受け取り、アップロードファイル情報をログ出力する。"""

    records = event.get("Records", [])
    logger.info(f"受信レコード数: {len(records)}")

    for record in records:
        bucket = record["s3"]["bucket"]["name"]
        key = record["s3"]["object"]["key"]
        size = record["s3"]["object"].get("size", 0)
        logger.info(f"ファイルアップロード検知: bucket={bucket}, key={key}, size={size} bytes")

    return {
        "statusCode": 200,
        "body": json.dumps({"message": "processed", "records": len(records)}),
    }
