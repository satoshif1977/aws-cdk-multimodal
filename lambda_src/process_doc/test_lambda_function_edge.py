"""
process_doc/lambda_function.py エッジケース・境界値テスト

get_media_type / fetch_image_base64 / analyze_image / lambda_handler の
未カバー領域を網羅的にテストする。
"""

from __future__ import annotations

import json
import os
import sys
from unittest.mock import MagicMock, patch

# ── モジュールの再利用 ──
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


# ── get_media_type エッジケース ────────────────────────────


class TestGetMediaTypeEdge:
    def test_複数ドットのjpgはimage_jpeg(self):
        assert lf.get_media_type("archive.backup.jpg") == "image/jpeg"

    def test_ドットのみはNone(self):
        assert lf.get_media_type(".") is None

    def test_スペース入りファイル名(self):
        assert lf.get_media_type("my photo.png") == "image/png"

    def test_日本語ファイル名のpng(self):
        assert lf.get_media_type("写真/桜.png") == "image/png"

    def test_URLエンコードされたキー(self):
        assert lf.get_media_type("photos/my%20image.webp") == "image/webp"

    def test_末尾ドットのみはNone(self):
        assert lf.get_media_type("file.") is None

    def test_docx拡張子はNone(self):
        assert lf.get_media_type("report.docx") is None

    def test_svg拡張子はNone(self):
        assert lf.get_media_type("diagram.svg") is None

    def test_大文字小文字混在のWebP(self):
        assert lf.get_media_type("photo.WeBp") == "image/webp"


# ── analyze_image リクエスト構造検証 ──────────────────────


class TestAnalyzeImageRequest:
    def setup_method(self):
        lf.bedrock_client.reset_mock()
        lf.bedrock_client.invoke_model.side_effect = None
        lf.bedrock_client.invoke_model.return_value = make_bedrock_response("OK")

    def test_max_tokensが1024(self):
        lf.analyze_image("data", "image/png")
        body = json.loads(lf.bedrock_client.invoke_model.call_args.kwargs["body"])
        assert body["max_tokens"] == 1024

    def test_contentTypeがapplication_json(self):
        lf.analyze_image("data", "image/png")
        kwargs = lf.bedrock_client.invoke_model.call_args.kwargs
        assert kwargs["contentType"] == "application/json"

    def test_acceptがapplication_json(self):
        lf.analyze_image("data", "image/png")
        kwargs = lf.bedrock_client.invoke_model.call_args.kwargs
        assert kwargs["accept"] == "application/json"

    def test_メッセージロールがuser(self):
        lf.analyze_image("data", "image/jpeg")
        body = json.loads(lf.bedrock_client.invoke_model.call_args.kwargs["body"])
        assert body["messages"][0]["role"] == "user"

    def test_contentブロックが2つ(self):
        lf.analyze_image("data", "image/jpeg")
        body = json.loads(lf.bedrock_client.invoke_model.call_args.kwargs["body"])
        assert len(body["messages"][0]["content"]) == 2

    def test_最初のブロックがimage型(self):
        lf.analyze_image("data", "image/jpeg")
        body = json.loads(lf.bedrock_client.invoke_model.call_args.kwargs["body"])
        assert body["messages"][0]["content"][0]["type"] == "image"

    def test_2番目のブロックがtext型(self):
        lf.analyze_image("data", "image/jpeg")
        body = json.loads(lf.bedrock_client.invoke_model.call_args.kwargs["body"])
        assert body["messages"][0]["content"][1]["type"] == "text"

    def test_プロンプトに日本語の分析指示が含まれる(self):
        lf.analyze_image("data", "image/jpeg")
        body = json.loads(lf.bedrock_client.invoke_model.call_args.kwargs["body"])
        prompt = body["messages"][0]["content"][1]["text"]
        assert "分析" in prompt

    def test_imageソースタイプがbase64(self):
        lf.analyze_image("data", "image/gif")
        body = json.loads(lf.bedrock_client.invoke_model.call_args.kwargs["body"])
        source = body["messages"][0]["content"][0]["source"]
        assert source["type"] == "base64"


# ── lambda_handler エッジケース ────────────────────────────


class TestLambdaHandlerEdge:
    def setup_method(self):
        lf.s3_client.reset_mock()
        lf.dynamodb.reset_mock()
        lf.bedrock_client.reset_mock()
        lf.bedrock_client.invoke_model.side_effect = None
        lf.s3_client.get_object.side_effect = None

        self.mock_table = MagicMock()
        lf.dynamodb.Table.return_value = self.mock_table

    def test_detailキー欠落で400(self):
        result = lf.lambda_handler({}, None)
        assert result["statusCode"] == 400

    def test_size_0でも正常処理(self):
        result = lf.lambda_handler(make_event(key="doc.pdf", size=0), None)
        assert result["statusCode"] == 200
        item = self.mock_table.put_item.call_args.kwargs["Item"]
        assert item["size"] == 0

    def test_画像のmodelIdがMODEL_ID(self):
        mock_body = MagicMock()
        mock_body.read.return_value = b"img"
        lf.s3_client.get_object.return_value = {"Body": mock_body}
        lf.bedrock_client.invoke_model.return_value = make_bedrock_response("OK")

        lf.lambda_handler(make_event(key="photo.gif"), None)
        item = self.mock_table.put_item.call_args.kwargs["Item"]
        assert item["modelId"] == lf.MODEL_ID

    def test_レスポンスbodyのmessageがprocessed(self):
        result = lf.lambda_handler(make_event(key="doc.txt"), None)
        body = json.loads(result["body"])
        assert body["message"] == "processed"

    def test_400レスポンスのmessageがinvalid_event(self):
        result = lf.lambda_handler({"detail": {}}, None)
        body = json.loads(result["body"])
        assert body["message"] == "invalid event"

    def test_S3エラーでも200を返しエラーメッセージ記録(self):
        from botocore.exceptions import ClientError

        lf.s3_client.get_object.side_effect = ClientError(
            {"Error": {"Code": "NoSuchKey", "Message": "Not found"}},
            "GetObject",
        )
        result = lf.lambda_handler(make_event(key="photo.jpg"), None)
        assert result["statusCode"] == 200
        item = self.mock_table.put_item.call_args.kwargs["Item"]
        assert "分析エラー" in item["analysisResult"]

    def test_webpファイルで正常処理(self):
        mock_body = MagicMock()
        mock_body.read.return_value = b"webp-data"
        lf.s3_client.get_object.return_value = {"Body": mock_body}
        lf.bedrock_client.invoke_model.return_value = make_bedrock_response("WebP画像")

        result = lf.lambda_handler(make_event(key="photo.webp"), None)
        assert result["statusCode"] == 200
        item = self.mock_table.put_item.call_args.kwargs["Item"]
        assert item["fileType"] == "image"

    def test_gifファイルで正常処理(self):
        mock_body = MagicMock()
        mock_body.read.return_value = b"gif-data"
        lf.s3_client.get_object.return_value = {"Body": mock_body}
        lf.bedrock_client.invoke_model.return_value = make_bedrock_response("GIF画像")

        result = lf.lambda_handler(make_event(key="anim.gif"), None)
        assert result["statusCode"] == 200
        item = self.mock_table.put_item.call_args.kwargs["Item"]
        assert item["analysisResult"] == "GIF画像"

    def test_深いパスのドキュメントでfileKeyが保持される(self):
        lf.lambda_handler(make_event(key="a/b/c/d/e/report.pdf", size=500), None)
        item = self.mock_table.put_item.call_args.kwargs["Item"]
        assert item["fileKey"] == "a/b/c/d/e/report.pdf"

    def test_Bedrockエラー時のmodelIdが保持される(self):
        mock_body = MagicMock()
        mock_body.read.return_value = b"img"
        lf.s3_client.get_object.return_value = {"Body": mock_body}
        lf.bedrock_client.invoke_model.side_effect = Exception("throttle")

        lf.lambda_handler(make_event(key="photo.jpg"), None)
        item = self.mock_table.put_item.call_args.kwargs["Item"]
        assert item["modelId"] == lf.MODEL_ID
