"""
process_doc/lambda_function.py のユニットテスト

boto3 クライアントを unittest.mock.patch で差し替えることで
AWS 接続なしに全関数を網羅的にテストする。
"""

from __future__ import annotations

import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

# ── モジュールレベルの env var と boto3 クライアントを差し替えてから import ──
os.environ.setdefault("TABLE_NAME", "test-analysis-table")
os.environ.setdefault("MODEL_ID",   "test-model-id")

# boto3 のグローバルクライアントを mock で差し替え
_mock_s3       = MagicMock()
_mock_dynamodb = MagicMock()
_mock_bedrock  = MagicMock()

with (
    patch("boto3.client", side_effect=lambda svc, **kw: _mock_s3 if svc == "s3" else _mock_bedrock),
    patch("boto3.resource", return_value=_mock_dynamodb),
):
    import lambda_function as lf


# ── ヘルパー ──────────────────────────────────────────────────
def make_event(bucket: str = "test-bucket", key: str = "photo.jpg", size: int = 1024) -> dict:
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


# ── get_media_type テスト ──────────────────────────────────────
class TestGetMediaType:
    def test_jpg(self) -> None:
        assert lf.get_media_type("photo.jpg") == "image/jpeg"

    def test_jpeg(self) -> None:
        assert lf.get_media_type("photo.jpeg") == "image/jpeg"

    def test_png(self) -> None:
        assert lf.get_media_type("image.PNG") == "image/png"

    def test_gif(self) -> None:
        assert lf.get_media_type("anim.gif") == "image/gif"

    def test_webp(self) -> None:
        assert lf.get_media_type("photo.webp") == "image/webp"

    def test_pdf_returns_none(self) -> None:
        assert lf.get_media_type("doc.pdf") is None

    def test_txt_returns_none(self) -> None:
        assert lf.get_media_type("readme.txt") is None

    def test_no_extension_returns_none(self) -> None:
        assert lf.get_media_type("noextension") is None

    def test_case_insensitive(self) -> None:
        assert lf.get_media_type("PHOTO.JPG") == "image/jpeg"

    def test_path_with_dirs(self) -> None:
        assert lf.get_media_type("uploads/2024/photo.png") == "image/png"


# ── lambda_handler テスト（画像ファイル） ─────────────────────
class TestLambdaHandlerImage:
    def setup_method(self) -> None:
        _mock_s3.reset_mock()
        _mock_dynamodb.reset_mock()
        _mock_bedrock.reset_mock()

        # S3 から画像取得
        mock_body = MagicMock()
        mock_body.read.return_value = b"fake-image-bytes"
        _mock_s3.get_object.return_value = {"Body": mock_body}

        # Bedrock 分析結果
        _mock_bedrock.invoke_model.return_value = make_bedrock_response("美しい山の写真です")

        # DynamoDB テーブル
        _mock_table = MagicMock()
        _mock_dynamodb.Table.return_value = _mock_table
        self.mock_table = _mock_table

    def test_success_status_200(self) -> None:
        result = lf.lambda_handler(make_event(key="photo.jpg"), None)
        assert result["statusCode"] == 200

    def test_success_body_contains_key(self) -> None:
        result = lf.lambda_handler(make_event(key="photo.jpg"), None)
        body = json.loads(result["body"])
        assert body["key"] == "photo.jpg"

    def test_dynamodb_put_called(self) -> None:
        lf.lambda_handler(make_event(key="photo.jpg"), None)
        assert self.mock_table.put_item.called

    def test_analysis_result_in_item(self) -> None:
        lf.lambda_handler(make_event(key="photo.jpg"), None)
        call_args = self.mock_table.put_item.call_args
        item = call_args.kwargs["Item"] if call_args.kwargs else call_args[1]["Item"]
        assert "analysisResult" in item

    def test_file_type_is_image(self) -> None:
        lf.lambda_handler(make_event(key="photo.png"), None)
        call_args = self.mock_table.put_item.call_args
        item = call_args.kwargs.get("Item") or call_args[1]["Item"]
        assert item["fileType"] == "image"

    def test_bedrock_invoked(self) -> None:
        lf.lambda_handler(make_event(key="photo.jpg"), None)
        assert _mock_bedrock.invoke_model.called


# ── lambda_handler テスト（非画像ファイル） ───────────────────
class TestLambdaHandlerDocument:
    def setup_method(self) -> None:
        _mock_s3.reset_mock()
        _mock_dynamodb.reset_mock()
        _mock_bedrock.reset_mock()

        _mock_table = MagicMock()
        _mock_dynamodb.Table.return_value = _mock_table
        self.mock_table = _mock_table

    def test_success_status_200(self) -> None:
        result = lf.lambda_handler(make_event(key="report.pdf"), None)
        assert result["statusCode"] == 200

    def test_bedrock_not_invoked(self) -> None:
        lf.lambda_handler(make_event(key="report.pdf"), None)
        assert not _mock_bedrock.invoke_model.called

    def test_file_type_is_document(self) -> None:
        lf.lambda_handler(make_event(key="report.pdf"), None)
        call_args = self.mock_table.put_item.call_args
        item = call_args.kwargs.get("Item") or call_args[1]["Item"]
        assert item["fileType"] == "document"

    def test_analysis_result_not_in_item(self) -> None:
        lf.lambda_handler(make_event(key="report.txt"), None)
        call_args = self.mock_table.put_item.call_args
        item = call_args.kwargs.get("Item") or call_args[1]["Item"]
        assert "analysisResult" not in item

    def test_dynamodb_put_called(self) -> None:
        lf.lambda_handler(make_event(key="data.csv"), None)
        assert self.mock_table.put_item.called


# ── lambda_handler テスト（異常系） ──────────────────────────
class TestLambdaHandlerError:
    def setup_method(self) -> None:
        _mock_s3.reset_mock()
        _mock_dynamodb.reset_mock()
        _mock_bedrock.reset_mock()
        _mock_dynamodb.Table.return_value = MagicMock()

    def test_missing_bucket_returns_400(self) -> None:
        event = {"detail": {"bucket": {"name": ""}, "object": {"key": "photo.jpg", "size": 100}}}
        result = lf.lambda_handler(event, None)
        assert result["statusCode"] == 400

    def test_missing_key_returns_400(self) -> None:
        event = {"detail": {"bucket": {"name": "bucket"}, "object": {"key": "", "size": 100}}}
        result = lf.lambda_handler(event, None)
        assert result["statusCode"] == 400

    def test_empty_detail_returns_400(self) -> None:
        result = lf.lambda_handler({"detail": {}}, None)
        assert result["statusCode"] == 400

    def test_bedrock_error_still_saves_to_dynamodb(self) -> None:
        """Bedrock エラー時もフォールバックして DynamoDB に書き込む。"""
        mock_body = MagicMock()
        mock_body.read.return_value = b"fake-image-bytes"
        _mock_s3.get_object.return_value = {"Body": mock_body}
        _mock_bedrock.invoke_model.side_effect = Exception("Bedrock エラー")

        mock_table = MagicMock()
        _mock_dynamodb.Table.return_value = mock_table

        result = lf.lambda_handler(make_event(key="photo.jpg"), None)
        assert result["statusCode"] == 200
        assert mock_table.put_item.called
