"""
process_doc/lambda_function.py 詳細ユニットテスト

get_media_type / fetch_image_base64 / analyze_image / lambda_handler の
境界値・フィールド内容・Bedrock リクエスト構造を検証する。
"""

from __future__ import annotations

import base64
import json
import os
import re
import sys
from unittest.mock import MagicMock, patch

import pytest

# ── モジュールの再利用（test_lambda_function.py と同一プロセスで実行される場合）──
os.environ.setdefault("TABLE_NAME", "test-analysis-table")
os.environ.setdefault("MODEL_ID", "test-model-id")

if "lambda_function" in sys.modules:
    import lambda_function as lf
else:
    _mock_s3 = MagicMock()
    _mock_dynamodb = MagicMock()
    _mock_bedrock = MagicMock()
    with (
        patch(
            "boto3.client",
            side_effect=lambda svc, **kw: _mock_s3 if svc == "s3" else _mock_bedrock,
        ),
        patch("boto3.resource", return_value=_mock_dynamodb),
    ):
        import lambda_function as lf


# ── ヘルパー ──────────────────────────────────────────────


def make_event(
    bucket: str = "test-bucket", key: str = "photo.jpg", size: int = 1024
) -> dict:
    return {
        "detail": {
            "bucket": {"name": bucket},
            "object": {"key": key, "size": size},
        }
    }


def make_bedrock_response(text: str = "テスト分析結果") -> dict:
    body_bytes = json.dumps({"content": [{"text": text}]}).encode()
    mock_body = MagicMock()
    mock_body.read.return_value = body_bytes
    return {"body": mock_body}


# ── get_media_type 詳細 ────────────────────────────────────


class TestGetMediaTypeDetail:
    def test_複合拡張子はgz扱い(self):
        # "archive.tar.gz" → rsplit(".", 1) = ["archive.tar", "gz"] → None
        assert lf.get_media_type("archive.tar.gz") is None

    def test_空文字はNone(self):
        assert lf.get_media_type("") is None

    def test_ドット始まりのjpgはimage_jpeg(self):
        # ".jpg" → "." in ".jpg" is True → ext = ".jpg" → "image/jpeg"
        assert lf.get_media_type(".jpg") == "image/jpeg"

    def test_パスつきでも大文字小文字混在で正しい型(self):
        assert lf.get_media_type("uploads/2024/PHOTO.JPEG") == "image/jpeg"

    def test_csvはNone(self):
        assert lf.get_media_type("data.csv") is None


# ── fetch_image_base64 詳細 ───────────────────────────────


class TestFetchImageBase64Detail:
    def setup_method(self):
        lf.s3_client.reset_mock()

    def test_get_objectにbucketとkeyが渡される(self):
        mock_body = MagicMock()
        mock_body.read.return_value = b"img"
        lf.s3_client.get_object.return_value = {"Body": mock_body}

        lf.fetch_image_base64("my-bucket", "path/to/image.jpg")

        lf.s3_client.get_object.assert_called_once_with(
            Bucket="my-bucket", Key="path/to/image.jpg"
        )

    def test_返り値はbase64文字列(self):
        image_data = b"test-image-data"
        mock_body = MagicMock()
        mock_body.read.return_value = image_data
        lf.s3_client.get_object.return_value = {"Body": mock_body}

        result = lf.fetch_image_base64("bucket", "key.jpg")
        expected = base64.standard_b64encode(image_data).decode("utf-8")
        assert result == expected

    def test_空バイトは空文字列のbase64(self):
        mock_body = MagicMock()
        mock_body.read.return_value = b""
        lf.s3_client.get_object.return_value = {"Body": mock_body}

        result = lf.fetch_image_base64("bucket", "empty.jpg")
        assert result == ""


# ── analyze_image 詳細 ────────────────────────────────────


class TestAnalyzeImageDetail:
    def setup_method(self):
        lf.bedrock_client.reset_mock()
        lf.bedrock_client.invoke_model.side_effect = None

    def test_invoke_modelにMODEL_IDが渡される(self):
        lf.bedrock_client.invoke_model.return_value = make_bedrock_response("OK")

        lf.analyze_image("base64data", "image/png")

        call_kwargs = lf.bedrock_client.invoke_model.call_args.kwargs
        assert call_kwargs["modelId"] == lf.MODEL_ID

    def test_bodyにanthropic_versionが含まれる(self):
        lf.bedrock_client.invoke_model.return_value = make_bedrock_response("OK")

        lf.analyze_image("base64data", "image/jpeg")

        call_kwargs = lf.bedrock_client.invoke_model.call_args.kwargs
        body = json.loads(call_kwargs["body"])
        assert body["anthropic_version"] == "bedrock-2023-05-31"

    def test_bodyのimageブロックにmedia_typeが含まれる(self):
        lf.bedrock_client.invoke_model.return_value = make_bedrock_response("OK")

        lf.analyze_image("base64data", "image/gif")

        call_kwargs = lf.bedrock_client.invoke_model.call_args.kwargs
        body = json.loads(call_kwargs["body"])
        image_block = body["messages"][0]["content"][0]
        assert image_block["source"]["media_type"] == "image/gif"
        assert image_block["source"]["data"] == "base64data"

    def test_返り値はBedrockのtextフィールド(self):
        lf.bedrock_client.invoke_model.return_value = make_bedrock_response(
            "山の写真です"
        )

        result = lf.analyze_image("base64data", "image/jpeg")
        assert result == "山の写真です"


# ── lambda_handler アイテムフィールド検証 ─────────────────


class TestLambdaHandlerItemDetail:
    def setup_method(self):
        lf.s3_client.reset_mock()
        lf.dynamodb.reset_mock()
        lf.bedrock_client.reset_mock()
        lf.bedrock_client.invoke_model.side_effect = None
        lf.s3_client.get_object.side_effect = None

        mock_body = MagicMock()
        mock_body.read.return_value = b"fake-image"
        lf.s3_client.get_object.return_value = {"Body": mock_body}
        lf.bedrock_client.invoke_model.return_value = make_bedrock_response(
            "分析完了テキスト"
        )

        self.mock_table = MagicMock()
        lf.dynamodb.Table.return_value = self.mock_table

    def test_fileKeyがS3キーと一致する(self):
        lf.lambda_handler(make_event(key="reports/img.png"), None)
        item = self.mock_table.put_item.call_args.kwargs["Item"]
        assert item["fileKey"] == "reports/img.png"

    def test_bucketが記録される(self):
        lf.lambda_handler(make_event(bucket="my-bucket", key="img.jpg"), None)
        item = self.mock_table.put_item.call_args.kwargs["Item"]
        assert item["bucket"] == "my-bucket"

    def test_sizeが記録される(self):
        lf.lambda_handler(make_event(key="img.jpg", size=99999), None)
        item = self.mock_table.put_item.call_args.kwargs["Item"]
        assert item["size"] == 99999

    def test_uploadedAtがISO形式でUTCオフセット含む(self):
        lf.lambda_handler(make_event(key="img.jpg"), None)
        item = self.mock_table.put_item.call_args.kwargs["Item"]
        assert re.match(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*\+00:00", item["uploadedAt"]
        )

    def test_画像ファイルのanalysisResultがBedrockテキスト(self):
        lf.lambda_handler(make_event(key="img.png"), None)
        item = self.mock_table.put_item.call_args.kwargs["Item"]
        assert item["analysisResult"] == "分析完了テキスト"

    def test_DynamoDBのテーブル名がTABLE_NAMEと一致する(self):
        lf.lambda_handler(make_event(key="img.jpg"), None)
        lf.dynamodb.Table.assert_called_once_with(lf.TABLE_NAME)


# ── None 除去・非画像アイテム検証 ─────────────────────────


class TestLambdaHandlerNoneRemoval:
    def setup_method(self):
        lf.s3_client.reset_mock()
        lf.dynamodb.reset_mock()
        lf.bedrock_client.reset_mock()

        self.mock_table = MagicMock()
        lf.dynamodb.Table.return_value = self.mock_table

    def test_非画像のmodelIdはitemに含まれない(self):
        # 非画像ファイルは modelId=None → DynamoDB は None 非対応なので除去される
        lf.lambda_handler(make_event(key="doc.pdf"), None)
        item = self.mock_table.put_item.call_args.kwargs["Item"]
        assert "modelId" not in item

    def test_非画像のanalysisResultはitemに含まれない(self):
        lf.lambda_handler(make_event(key="data.csv"), None)
        item = self.mock_table.put_item.call_args.kwargs["Item"]
        assert "analysisResult" not in item

    def test_put_itemが正確に1回だけ呼ばれる(self):
        lf.lambda_handler(make_event(key="doc.txt"), None)
        assert self.mock_table.put_item.call_count == 1


# ── Bedrock エラー時のフォールバック検証 ─────────────────


class TestLambdaHandlerBedrockError:
    def setup_method(self):
        lf.s3_client.reset_mock()
        lf.dynamodb.reset_mock()
        lf.bedrock_client.reset_mock()

        mock_body = MagicMock()
        mock_body.read.return_value = b"fake-image"
        lf.s3_client.get_object.return_value = {"Body": mock_body}

        self.mock_table = MagicMock()
        lf.dynamodb.Table.return_value = self.mock_table

    def test_BedrockエラーでもstatusCode200を返す(self):
        lf.bedrock_client.invoke_model.side_effect = Exception("Bedrock 障害")
        result = lf.lambda_handler(make_event(key="photo.jpg"), None)
        assert result["statusCode"] == 200

    def test_Bedrockエラー時はanalysisResultにエラーメッセージが入る(self):
        lf.bedrock_client.invoke_model.side_effect = Exception("タイムアウト")
        lf.lambda_handler(make_event(key="photo.jpg"), None)
        item = self.mock_table.put_item.call_args.kwargs["Item"]
        assert "分析エラー" in item["analysisResult"]
        assert "タイムアウト" in item["analysisResult"]

    def test_Bedrockエラーでも必ずput_itemが呼ばれる(self):
        lf.bedrock_client.invoke_model.side_effect = Exception("エラー")
        lf.lambda_handler(make_event(key="photo.jpg"), None)
        assert self.mock_table.put_item.called
