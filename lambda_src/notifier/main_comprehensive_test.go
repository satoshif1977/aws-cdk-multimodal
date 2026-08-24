package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatch/types"
)

// ── namespace テーブル駆動テスト ────────────────────────────────────

func TestNamespace_Table(t *testing.T) {
	tests := []struct {
		name string
		env  string
		want string
	}{
		{"empty returns default", "", "MultimodalApp"},
		{"custom value", "CustomNS", "CustomNS"},
		{"with slash", "My/Namespace", "My/Namespace"},
		{"with hyphen", "app-namespace", "app-namespace"},
		{"with underscore", "app_ns_2026", "app_ns_2026"},
		{"Japanese", "日本語NS", "日本語NS"},
		{"single char", "X", "X"},
		{"numeric", "12345", "12345"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("CW_NAMESPACE", tt.env)
			if got := namespace(); got != tt.want {
				t.Errorf("namespace() = %q, want %q", got, tt.want)
			}
		})
	}
}

// ── processRecords イベントフィルタリング テーブル駆動テスト ─────────

func TestProcessRecords_EventFilter_Table(t *testing.T) {
	tests := []struct {
		name      string
		events    []string
		wantCount int
	}{
		{"single INSERT", []string{"INSERT"}, 1},
		{"single MODIFY", []string{"MODIFY"}, 0},
		{"single REMOVE", []string{"REMOVE"}, 0},
		{"all INSERT", []string{"INSERT", "INSERT", "INSERT"}, 3},
		{"all MODIFY", []string{"MODIFY", "MODIFY"}, 0},
		{"INSERT + MODIFY", []string{"INSERT", "MODIFY"}, 1},
		{"MODIFY + INSERT", []string{"MODIFY", "INSERT"}, 1},
		{"INSERT + REMOVE + INSERT", []string{"INSERT", "REMOVE", "INSERT"}, 2},
		{"empty string event", []string{""}, 0},
		{"lowercase insert", []string{"insert"}, 0},
		{"UNKNOWN event", []string{"UNKNOWN"}, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mock := &mockMetricPutter{}
			records := make([]events.DynamoDBEventRecord, len(tt.events))
			for i, name := range tt.events {
				if name == "INSERT" {
					records[i] = insertRecord(fmt.Sprintf("file%d.pdf", i))
				} else {
					records[i] = events.DynamoDBEventRecord{EventName: name}
				}
			}
			count, err := processRecords(context.Background(), events.DynamoDBEvent{Records: records}, mock)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if count != tt.wantCount {
				t.Errorf("count = %d, want %d", count, tt.wantCount)
			}
			if len(mock.calls) != tt.wantCount {
				t.Errorf("CW calls = %d, want %d", len(mock.calls), tt.wantCount)
			}
		})
	}
}

// ── processRecords nil Records ──────────────────────────────────────

func TestProcessRecords_NilRecords(t *testing.T) {
	mock := &mockMetricPutter{}
	count, err := processRecords(context.Background(), events.DynamoDBEvent{Records: nil}, mock)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if count != 0 {
		t.Errorf("nil records: count = %d, want 0", count)
	}
}

// ── エラーラップ検証 ────────────────────────────────────────────────

func TestProcessRecords_ErrorWrapsOriginal(t *testing.T) {
	originalErr := errors.New("throttled")
	mock := &mockMetricPutter{retErr: originalErr}
	event := events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{insertRecord("test.pdf")},
	}
	_, err := processRecords(context.Background(), event, mock)
	if !errors.Is(err, originalErr) {
		t.Errorf("error should wrap original: got %v", err)
	}
}

func TestProcessRecords_ErrorContainsPutMetricDataFailed(t *testing.T) {
	mock := &mockMetricPutter{retErr: errors.New("timeout")}
	event := events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{insertRecord("err.pdf")},
	}
	_, err := processRecords(context.Background(), event, mock)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "PutMetricData failed") {
		t.Errorf("error message should contain 'PutMetricData failed': %v", err)
	}
}

// ── メトリクス構造の一括検証 ────────────────────────────────────────

func TestProcessRecords_MetricStructure(t *testing.T) {
	t.Setenv("CW_NAMESPACE", "TestStructure")
	mock := &mockMetricPutter{}
	event := events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{insertRecord("structure/test.pdf")},
	}
	count, err := processRecords(context.Background(), event, mock)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if count != 1 {
		t.Fatalf("count = %d, want 1", count)
	}
	if len(mock.calls) != 1 {
		t.Fatalf("CW calls = %d, want 1", len(mock.calls))
	}

	call := mock.calls[0]

	// Namespace
	if *call.Namespace != "TestStructure" {
		t.Errorf("Namespace = %q, want TestStructure", *call.Namespace)
	}

	// MetricData 件数
	if len(call.MetricData) != 1 {
		t.Fatalf("MetricData count = %d, want 1", len(call.MetricData))
	}

	md := call.MetricData[0]

	// MetricName
	if *md.MetricName != "DocumentAnalyzed" {
		t.Errorf("MetricName = %q, want DocumentAnalyzed", *md.MetricName)
	}

	// Value
	if *md.Value != 1.0 {
		t.Errorf("Value = %f, want 1.0", *md.Value)
	}

	// Unit
	if md.Unit != types.StandardUnitCount {
		t.Errorf("Unit = %v, want Count", md.Unit)
	}

	// Timestamp
	if md.Timestamp == nil {
		t.Error("Timestamp should not be nil")
	}

	// Dimensions
	if len(md.Dimensions) != 1 {
		t.Fatalf("Dimensions count = %d, want 1", len(md.Dimensions))
	}
	if *md.Dimensions[0].Name != "FileKey" {
		t.Errorf("Dimension Name = %q, want FileKey", *md.Dimensions[0].Name)
	}
	if *md.Dimensions[0].Value != "structure/test.pdf" {
		t.Errorf("Dimension Value = %q, want structure/test.pdf", *md.Dimensions[0].Value)
	}
}

// ── 複数レコードでの各メトリクスの fileKey 検証 ─────────────────────

func TestProcessRecords_EachRecordGetsOwnFileKey(t *testing.T) {
	mock := &mockMetricPutter{}
	event := events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{
			insertRecord("alpha.pdf"),
			insertRecord("beta.pdf"),
			insertRecord("gamma.pdf"),
		},
	}
	count, err := processRecords(context.Background(), event, mock)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if count != 3 {
		t.Fatalf("count = %d, want 3", count)
	}

	expected := []string{"alpha.pdf", "beta.pdf", "gamma.pdf"}
	for i, want := range expected {
		got := *mock.calls[i].MetricData[0].Dimensions[0].Value
		if got != want {
			t.Errorf("call[%d] fileKey = %q, want %q", i, got, want)
		}
	}
}

// ── handler 追加テスト ──────────────────────────────────────────────

func TestHandler_MultipleInserts(t *testing.T) {
	mock := &mockMetricPutter{}
	orig := cwClient
	cwClient = mock
	defer func() { cwClient = orig }()

	event := events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{
			insertRecord("a.pdf"),
			insertRecord("b.pdf"),
			insertRecord("c.pdf"),
		},
	}
	if err := handler(context.Background(), event); err != nil {
		t.Errorf("expected nil error, got %v", err)
	}
	if len(mock.calls) != 3 {
		t.Errorf("expected 3 CW calls, got %d", len(mock.calls))
	}
}

func TestHandler_ErrorContainsFileKey(t *testing.T) {
	mock := &mockMetricPutter{retErr: errors.New("fail")}
	orig := cwClient
	cwClient = mock
	defer func() { cwClient = orig }()

	event := events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{insertRecord("important-doc.pdf")},
	}
	err := handler(context.Background(), event)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "important-doc.pdf") {
		t.Errorf("error should contain fileKey: %v", err)
	}
}

func TestHandler_MixedEventsOnlyPublishesInserts(t *testing.T) {
	mock := &mockMetricPutter{}
	orig := cwClient
	cwClient = mock
	defer func() { cwClient = orig }()

	event := events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{
			{EventName: "REMOVE"},
			insertRecord("only-this.pdf"),
			{EventName: "MODIFY"},
		},
	}
	if err := handler(context.Background(), event); err != nil {
		t.Errorf("expected nil error, got %v", err)
	}
	if len(mock.calls) != 1 {
		t.Errorf("expected 1 CW call, got %d", len(mock.calls))
	}
}

// ── processRecords エラー停止位置の検証 ─────────────────────────────

func TestProcessRecords_StopsAtFirstError(t *testing.T) {
	// 2件目でエラー → 3件目は処理されない
	mock := &mockMetricPutterN{succeedFor: 1, retErr: errors.New("quota")}
	event := events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{
			insertRecord("first.pdf"),
			insertRecord("second.pdf"),
			insertRecord("third.pdf"),
		},
	}
	count, err := processRecords(context.Background(), event, mock)
	if err == nil {
		t.Fatal("expected error on second record")
	}
	if count != 1 {
		t.Errorf("count = %d, want 1 (stopped before third)", count)
	}
	// 2件目まで呼ばれ、3件目は呼ばれない
	if len(mock.calls) != 2 {
		t.Errorf("CW calls = %d, want 2", len(mock.calls))
	}
}

// ── fileKey 特殊パターン ────────────────────────────────────────────

func TestProcessRecords_FileKey_Table(t *testing.T) {
	tests := []struct {
		name    string
		fileKey string
	}{
		{"simple path", "doc/sample.pdf"},
		{"deep path", "a/b/c/d/e/file.pdf"},
		{"Japanese name", "資料/報告書.pdf"},
		{"with spaces", "my documents/file name.pdf"},
		{"with special chars", "file!@#$%.pdf"},
		{"UUID filename", "550e8400-e29b-41d4-a716-446655440000.pdf"},
		{"very long name", strings.Repeat("x", 200) + ".pdf"},
		{"dot only", ".hidden"},
		{"no extension", "README"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mock := &mockMetricPutter{}
			event := events.DynamoDBEvent{
				Records: []events.DynamoDBEventRecord{insertRecord(tt.fileKey)},
			}
			count, err := processRecords(context.Background(), event, mock)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if count != 1 {
				t.Errorf("count = %d, want 1", count)
			}
			got := *mock.calls[0].MetricData[0].Dimensions[0].Value
			if got != tt.fileKey {
				t.Errorf("fileKey = %q, want %q", got, tt.fileKey)
			}
		})
	}
}

// ── ベンチマーク ────────────────────────────────────────────────────

func BenchmarkProcessRecords_SingleInsert(b *testing.B) {
	mock := &mockMetricPutter{}
	event := events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{insertRecord("bench.pdf")},
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		processRecords(context.Background(), event, mock)
	}
}

func BenchmarkProcessRecords_TenInserts(b *testing.B) {
	mock := &mockMetricPutter{}
	records := make([]events.DynamoDBEventRecord, 10)
	for i := range records {
		records[i] = insertRecord(fmt.Sprintf("bench%d.pdf", i))
	}
	event := events.DynamoDBEvent{Records: records}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		processRecords(context.Background(), event, mock)
	}
}

func BenchmarkNamespace(b *testing.B) {
	b.Setenv("CW_NAMESPACE", "BenchNS")
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		namespace()
	}
}
