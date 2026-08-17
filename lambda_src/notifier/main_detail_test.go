package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/aws/aws-lambda-go/events"
)

// ── processRecords 追加テスト ─────────────────────────────────

func TestProcessRecords_MetricNameIsDocumentAnalyzed(t *testing.T) {
	mock := &mockMetricPutter{}
	_, _ = processRecords(context.Background(), events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{insertRecord("report.pdf")},
	}, mock)
	if len(mock.calls) == 0 {
		t.Fatal("expected at least 1 CW call")
	}
	if got := *mock.calls[0].MetricData[0].MetricName; got != "DocumentAnalyzed" {
		t.Errorf("MetricName: want DocumentAnalyzed, got %q", got)
	}
}

func TestProcessRecords_TimestampNotNil(t *testing.T) {
	mock := &mockMetricPutter{}
	_, _ = processRecords(context.Background(), events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{insertRecord("ts.pdf")},
	}, mock)
	if len(mock.calls) == 0 {
		t.Fatal("expected at least 1 CW call")
	}
	if mock.calls[0].MetricData[0].Timestamp == nil {
		t.Error("Timestamp should not be nil")
	}
}

func TestProcessRecords_SingleMetricDataPerCall(t *testing.T) {
	// 1 件の INSERT につき MetricData は 1 件のみ送信されること
	mock := &mockMetricPutter{}
	_, _ = processRecords(context.Background(), events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{insertRecord("single.pdf")},
	}, mock)
	if len(mock.calls) == 0 {
		t.Fatal("expected at least 1 CW call")
	}
	if got := len(mock.calls[0].MetricData); got != 1 {
		t.Errorf("MetricData per call: want 1, got %d", got)
	}
}

func TestProcessRecords_DimensionCount(t *testing.T) {
	// 各コールの Dimensions は 1 件（FileKey のみ）であること
	mock := &mockMetricPutter{}
	_, _ = processRecords(context.Background(), events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{insertRecord("dim.pdf")},
	}, mock)
	if len(mock.calls) == 0 {
		t.Fatal("expected at least 1 CW call")
	}
	dims := mock.calls[0].MetricData[0].Dimensions
	if got := len(dims); got != 1 {
		t.Errorf("Dimensions count: want 1, got %d", got)
	}
}

func TestProcessRecords_CountMatchesCalls(t *testing.T) {
	// 返り値 count と mock.calls の件数が常に一致すること
	mock := &mockMetricPutter{}
	event := events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{
			insertRecord("a.pdf"),
			insertRecord("b.pdf"),
			{EventName: "MODIFY"},
			insertRecord("c.pdf"),
		},
	}
	count, err := processRecords(context.Background(), event, mock)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if count != len(mock.calls) {
		t.Errorf("count (%d) != CW calls (%d)", count, len(mock.calls))
	}
}

func TestProcessRecords_FileKeyInErrorMessage(t *testing.T) {
	// エラー時のメッセージに fileKey が含まれること
	mock := &mockMetricPutter{retErr: errors.New("CW down")}
	event := events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{insertRecord("problem-file.pdf")},
	}
	_, err := processRecords(context.Background(), event, mock)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "problem-file.pdf") {
		t.Errorf("error message should contain fileKey, got: %v", err)
	}
}

func TestProcessRecords_FiveBatch(t *testing.T) {
	// 5 件の INSERT が全て CloudWatch に送信されること
	mock := &mockMetricPutter{}
	records := make([]events.DynamoDBEventRecord, 5)
	for i := range records {
		records[i] = insertRecord(fmt.Sprintf("batch%d.pdf", i))
	}
	count, err := processRecords(context.Background(), events.DynamoDBEvent{Records: records}, mock)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if count != 5 {
		t.Errorf("count: want 5, got %d", count)
	}
	if len(mock.calls) != 5 {
		t.Errorf("CW calls: want 5, got %d", len(mock.calls))
	}
}

func TestProcessRecords_SkipsUnknownEventName(t *testing.T) {
	// 不明な EventName は INSERT 以外とみなしてスキップされること
	mock := &mockMetricPutter{}
	event := events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{
			{EventName: "UNKNOWN"},
			{EventName: "SYNC"},
		},
	}
	count, err := processRecords(context.Background(), event, mock)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if count != 0 {
		t.Errorf("count: want 0 for unknown events, got %d", count)
	}
	if len(mock.calls) != 0 {
		t.Errorf("CW calls: want 0 for unknown events, got %d", len(mock.calls))
	}
}

// ── handler 追加テスト ────────────────────────────────────────

func TestHandler_EmptyEvent(t *testing.T) {
	mock := &mockMetricPutter{}
	orig := cwClient
	cwClient = mock
	defer func() { cwClient = orig }()

	if err := handler(context.Background(), events.DynamoDBEvent{}); err != nil {
		t.Errorf("empty event: expected nil error, got %v", err)
	}
	if len(mock.calls) != 0 {
		t.Errorf("empty event: expected 0 CW calls, got %d", len(mock.calls))
	}
}

func TestHandler_NoInserts(t *testing.T) {
	// INSERT なし（全て MODIFY）のとき handler は nil を返すこと
	mock := &mockMetricPutter{}
	orig := cwClient
	cwClient = mock
	defer func() { cwClient = orig }()

	event := events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{
			{EventName: "MODIFY"},
			{EventName: "REMOVE"},
		},
	}
	if err := handler(context.Background(), event); err != nil {
		t.Errorf("no inserts: expected nil error, got %v", err)
	}
	if len(mock.calls) != 0 {
		t.Errorf("no inserts: expected 0 CW calls, got %d", len(mock.calls))
	}
}

// ── namespace 追加テスト ──────────────────────────────────────

func TestNamespace_LongString(t *testing.T) {
	long := strings.Repeat("A", 256)
	t.Setenv("CW_NAMESPACE", long)
	if got := namespace(); got != long {
		t.Errorf("long namespace: want %q, got %q", long, got)
	}
}

func TestNamespace_SpecialChars(t *testing.T) {
	special := "My/App-Namespace_2026"
	t.Setenv("CW_NAMESPACE", special)
	if got := namespace(); got != special {
		t.Errorf("special chars namespace: want %q, got %q", special, got)
	}
}

// ── Fuzz テスト ───────────────────────────────────────────────

func FuzzProcessRecordsNoPanic(f *testing.F) {
	seeds := []struct{ eventName, fileKey string }{
		{"INSERT", "doc/sample.pdf"},
		{"INSERT", ""},
		{"MODIFY", "mod.pdf"},
		{"REMOVE", "rem.pdf"},
		{"INSERT", "path/to/deep/file.pdf"},
		{"UNKNOWN", "unknown.pdf"},
		{"INSERT", "日本語ファイル.pdf"},
		{"insert", "lowercase.pdf"},
		{"INSERT", "file with spaces.pdf"},
		{"INSERT", "special!@#$%.pdf"},
	}
	for _, s := range seeds {
		f.Add(s.eventName, s.fileKey)
	}
	f.Fuzz(func(t *testing.T, eventName, fileKey string) {
		if !utf8.ValidString(eventName) || !utf8.ValidString(fileKey) {
			t.Skip()
		}
		mock := &mockMetricPutter{}
		img := map[string]events.DynamoDBAttributeValue{}
		if fileKey != "" {
			img["fileKey"] = events.NewStringAttribute(fileKey)
		}
		event := events.DynamoDBEvent{
			Records: []events.DynamoDBEventRecord{
				{
					EventName: eventName,
					Change:    events.DynamoDBStreamRecord{NewImage: img},
				},
			},
		}
		count, err := processRecords(context.Background(), event, mock)
		// INSERT のとき: count=1, err=nil（CW 成功）
		// その他のとき: count=0, err=nil
		if eventName == "INSERT" {
			if err != nil {
				t.Errorf("INSERT event: unexpected error: %v", err)
			}
			if count != 1 {
				t.Errorf("INSERT event: count want 1, got %d", count)
			}
		} else {
			if err != nil {
				t.Errorf("non-INSERT event: unexpected error: %v", err)
			}
			if count != 0 {
				t.Errorf("non-INSERT event: count want 0, got %d", count)
			}
		}
	})
}

func FuzzNamespace(f *testing.F) {
	f.Add("")
	f.Add("MultimodalApp")
	f.Add("MyApp")
	f.Add("   ")
	f.Add("My/App-NS_2026")
	f.Add(strings.Repeat("X", 256))
	f.Add("日本語")
	f.Add("app:namespace")
	f.Fuzz(func(t *testing.T, ns string) {
		if !utf8.ValidString(ns) {
			t.Skip()
		}
		t.Setenv("CW_NAMESPACE", ns)
		got := namespace()
		if ns == "" {
			// 空のとき → デフォルト "MultimodalApp"
			if got != "MultimodalApp" {
				t.Errorf("empty env: want MultimodalApp, got %q", got)
			}
		} else {
			// 非空のとき → env の値そのまま返る
			if got != ns {
				t.Errorf("non-empty env: want %q, got %q", ns, got)
			}
		}
	})
}

func FuzzInsertRecordFileKey(f *testing.F) {
	f.Add("simple.pdf")
	f.Add("")
	f.Add("path/to/file.pdf")
	f.Add("日本語ファイル名.pdf")
	f.Add("file with spaces.pdf")
	f.Add("very-long-" + strings.Repeat("x", 100) + ".pdf")
	f.Add("special!@#$.pdf")
	f.Add("UPPERCASE.PDF")
	f.Add("123456789.pdf")
	f.Add("../relative/path.pdf")
	f.Fuzz(func(t *testing.T, fileKey string) {
		if !utf8.ValidString(fileKey) {
			t.Skip()
		}
		mock := &mockMetricPutter{}
		event := events.DynamoDBEvent{
			Records: []events.DynamoDBEventRecord{insertRecord(fileKey)},
		}
		count, err := processRecords(context.Background(), event, mock)
		if err != nil {
			t.Errorf("fileKey=%q: unexpected error: %v", fileKey, err)
		}
		if count != 1 {
			t.Errorf("fileKey=%q: count want 1, got %d", fileKey, count)
		}
		// FileKey ディメンションが正しく設定されていること
		if len(mock.calls) > 0 {
			dims := mock.calls[0].MetricData[0].Dimensions
			if len(dims) > 0 && *dims[0].Value != fileKey {
				t.Errorf("dimension fileKey: want %q, got %q", fileKey, *dims[0].Value)
			}
		}
	})
}
