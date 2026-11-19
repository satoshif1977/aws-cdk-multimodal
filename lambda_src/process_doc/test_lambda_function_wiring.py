"""
lambda_function.py の可観測性まわりの結線テスト

「ユーティリティを置いただけ」にならないよう、次の 3 点を実際の出力で確認する。
  1. 構造化ロガーが使われ、S3 キーが message ではなくフィールドに入っていること
  2. EMF メトリクスが出力されていること
  3. retry_call に on_retry が渡り、ログとメトリクスの両方へ届くこと
"""

from __future__ import annotations

import json
import os
from unittest.mock import MagicMock, patch

import pytest

os.environ.setdefault("TABLE_NAME", "test-analysis-table")
os.environ.setdefault("MODEL_ID", "test-model-id")

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

from logger import StructuredLogger  # noqa: E402
from metrics import MetricsCollector  # noqa: E402

# 顧客名が入りうるファイル名。これが message に出たらマスキングを素通りしている。
SENSITIVE_KEY = "uploads/請求書_山田商事.png"


def make_event(
    bucket: str = "test-bucket", key: str = SENSITIVE_KEY, size: int = 2048
) -> dict:
    return {
        "detail": {
            "bucket": {"name": bucket},
            "object": {"key": key, "size": size},
        }
    }


def make_bedrock_response(text: str = "分析結果テキスト") -> dict:
    body = MagicMock()
    body.read.return_value = json.dumps({"content": [{"text": text}]}).encode()
    return {"body": body}


def read_lines(capsys) -> tuple[list[dict], list[dict]]:
    """標準出力と標準エラーを JSON 行に分けて返す。

    logger.py の stdout_sink は warn / error を stderr へ振り分けるため、
    両方を読まないとエラーログを取りこぼす。
    """
    captured = capsys.readouterr()
    logs: list[dict] = []
    emf: list[dict] = []
    for stream in (captured.out, captured.err):
        for line in stream.splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "_aws" in parsed:
                emf.append(parsed)
            else:
                logs.append(parsed)
    return logs, emf


@pytest.fixture(autouse=True)
def _reset_mocks():
    """各テストの間だけ lambda_function のクライアントを差し替える。

    lambda_function は他のテストファイルからも import され、モジュール変数は
    最初に import した側のモックに束縛されている。import 時の patch だけに
    頼ると、単体では通るのに全体実行で落ちる。属性を直接差し替えて避ける。
    """
    _mock_s3.reset_mock()
    _mock_dynamodb.reset_mock()
    _mock_bedrock.reset_mock()
    _mock_s3.get_object.side_effect = None
    _mock_bedrock.invoke_model.side_effect = None
    body = MagicMock()
    body.read.return_value = b"image-bytes"
    _mock_s3.get_object.return_value = {"Body": body}
    _mock_bedrock.invoke_model.return_value = make_bedrock_response()

    with (
        patch.object(lf, "s3_client", _mock_s3),
        patch.object(lf, "bedrock_client", _mock_bedrock),
        patch.object(lf, "dynamodb", _mock_dynamodb),
    ):
        yield


# ── 1. 構造化ロガーが結線されているか ─────────────────────────
class TestLoggerWiring:
    def test_logger_is_structured_logger(self) -> None:
        assert isinstance(lf.logger, StructuredLogger)

    def test_logs_are_single_line_json(self, capsys) -> None:
        lf.lambda_handler(make_event(), None)
        logs, _ = read_lines(capsys)
        assert logs, "構造化ログが 1 行も出ていない"
        for entry in logs:
            assert {"timestamp", "level", "message"} <= set(entry)

    def test_s3_key_is_a_field_not_in_message(self, capsys) -> None:
        """S3 キーは message に埋めずフィールドで渡す（マスキングはキー名判定のため）。"""
        lf.lambda_handler(make_event(), None)
        logs, _ = read_lines(capsys)
        assert any(
            e.get("s3_key") == SENSITIVE_KEY for e in logs
        ), "s3_key フィールドが無い"
        for entry in logs:
            assert (
                SENSITIVE_KEY not in entry["message"]
            ), f"message に S3 キーが露出: {entry['message']}"

    def test_bucket_is_a_field(self, capsys) -> None:
        lf.lambda_handler(make_event(), None)
        logs, _ = read_lines(capsys)
        assert any(e.get("s3_bucket") == "test-bucket" for e in logs)

    def test_invalid_event_does_not_put_detail_in_message(self, capsys) -> None:
        result = lf.lambda_handler({"detail": {"object": {"key": SENSITIVE_KEY}}}, None)
        assert result["statusCode"] == 400
        logs, _ = read_lines(capsys)
        errors = [e for e in logs if e["level"] == "error"]
        assert errors, "エラーログが出ていない"
        for entry in errors:
            assert SENSITIVE_KEY not in entry["message"]

    def test_analysis_length_logged_not_content(self, capsys) -> None:
        """分析結果の本文ではなく長さだけを残す。"""
        _mock_bedrock.invoke_model.return_value = make_bedrock_response(
            "秘密の分析結果"
        )
        lf.lambda_handler(make_event(), None)
        logs, _ = read_lines(capsys)
        assert any(e.get("analysis_length") == len("秘密の分析結果") for e in logs)
        for entry in logs:
            assert "秘密の分析結果" not in entry["message"]


# ── 2. メトリクスが結線されているか ───────────────────────────
class TestMetricsWiring:
    def test_emf_document_is_emitted(self, capsys) -> None:
        lf.lambda_handler(make_event(), None)
        _, emf = read_lines(capsys)
        assert emf, "EMF ドキュメントが出ていない"

    def test_processed_files_metric(self, capsys) -> None:
        lf.lambda_handler(make_event(), None)
        _, emf = read_lines(capsys)
        names = {n for doc in emf for n in doc if not n.startswith("_")}
        assert "ProcessedFiles" in names
        assert "FileSize" in names

    def test_analysis_succeeded_metric(self, capsys) -> None:
        lf.lambda_handler(make_event(), None)
        _, emf = read_lines(capsys)
        names = {n for doc in emf for n in doc if not n.startswith("_")}
        assert "AnalysisSucceeded" in names
        assert "AnalysisDuration" in names

    def test_analysis_failed_metric(self, capsys) -> None:
        _mock_bedrock.invoke_model.side_effect = ValueError("boom")
        lf.lambda_handler(make_event(), None)
        _, emf = read_lines(capsys)
        names = {n for doc in emf for n in doc if not n.startswith("_")}
        assert "AnalysisFailed" in names

    def test_metadata_only_metric_for_non_image(self, capsys) -> None:
        lf.lambda_handler(make_event(key="docs/manual.pdf"), None)
        _, emf = read_lines(capsys)
        names = {n for doc in emf for n in doc if not n.startswith("_")}
        assert "MetadataOnly" in names

    def test_invalid_event_metric(self, capsys) -> None:
        lf.lambda_handler({"detail": {}}, None)
        _, emf = read_lines(capsys)
        names = {n for doc in emf for n in doc if not n.startswith("_")}
        assert "InvalidEvents" in names


# ── 3. retry のフックが結線されているか ───────────────────────
class TestRetryHookWiring:
    def test_hook_reaches_logger_and_metrics(self) -> None:
        lines: list[str] = []
        emitted: list[str] = []
        log = StructuredLogger(
            level="debug", sink=lambda line, level: lines.append(line)
        )
        metrics = MetricsCollector(namespace="Test", sink=emitted.append)

        hook = lf.retry_hooks("s3.get_object", log, metrics)
        hook(1, 0.5, ValueError("throttled"))

        assert lines, "リトライがログに出ていない"
        entry = json.loads(lines[0])
        assert entry["operation"] == "s3.get_object"
        assert entry["attempt"] == 1

        metrics.flush()
        assert emitted, "リトライがメトリクスに出ていない"
        doc = json.loads(emitted[0])
        assert "RetryAttempts" in doc
        assert doc["retry_operation"] == "s3.get_object"

    def test_hook_works_without_metrics(self) -> None:
        lines: list[str] = []
        log = StructuredLogger(
            level="debug", sink=lambda line, level: lines.append(line)
        )
        hook = lf.retry_hooks("bedrock.invoke_model", log, None)
        hook(2, 1.0, RuntimeError("retry"))
        assert len(lines) == 1

    def test_on_retry_passed_to_s3(self) -> None:
        """retry_call へ on_retry が渡っているか（引数で確認する）。"""
        body = MagicMock()
        body.read.return_value = b"image-bytes"
        with patch("lambda_function.retry_call") as mocked:
            mocked.return_value = {"Body": body}
            lf.fetch_image_base64("b", "k")
        assert mocked.call_args.kwargs["on_retry"] is not None

    def test_on_retry_passed_to_bedrock(self) -> None:
        with patch("lambda_function.retry_call") as mocked:
            mocked.return_value = make_bedrock_response()
            lf.analyze_image("base64", "image/png")
        assert mocked.call_args.kwargs["on_retry"] is not None

    def test_on_retry_passed_to_dynamodb(self, capsys) -> None:
        with patch("lambda_function.retry_call") as mocked:
            body = MagicMock()
            body.read.return_value = b"image-bytes"
            mocked.side_effect = [
                {"Body": body},
                make_bedrock_response(),
                None,
            ]
            lf.lambda_handler(make_event(), None)
        operations = [c.kwargs.get("on_retry") for c in mocked.call_args_list]
        assert all(op is not None for op in operations)
        assert len(operations) == 3
