package main

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatch"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatch/types"
)

// ── モック ──────────────────────────────────────────────────────────────────

// mockMetricPutter records PutMetricData calls for assertion in tests.
type mockMetricPutter struct {
	calls  []*cloudwatch.PutMetricDataInput
	retErr error
}

func (m *mockMetricPutter) PutMetricData(
	_ context.Context,
	params *cloudwatch.PutMetricDataInput,
	_ ...func(*cloudwatch.Options),
) (*cloudwatch.PutMetricDataOutput, error) {
	m.calls = append(m.calls, params)
	return &cloudwatch.PutMetricDataOutput{}, m.retErr
}

// insertRecord builds a DynamoDB INSERT event record with an optional fileKey.
func insertRecord(fileKey string) events.DynamoDBEventRecord {
	img := map[string]events.DynamoDBAttributeValue{}
	if fileKey != "" {
		img["fileKey"] = events.NewStringAttribute(fileKey)
	}
	return events.DynamoDBEventRecord{
		EventName: "INSERT",
		Change:    events.DynamoDBStreamRecord{NewImage: img},
	}
}

// ── namespace テスト ─────────────────────────────────────────────────────────

func TestNamespace_Default(t *testing.T) {
	t.Setenv("CW_NAMESPACE", "")
	if got := namespace(); got != "MultimodalApp" {
		t.Errorf("expected MultimodalApp, got %s", got)
	}
}

func TestNamespace_EnvOverride(t *testing.T) {
	t.Setenv("CW_NAMESPACE", "MyApp")
	if got := namespace(); got != "MyApp" {
		t.Errorf("expected MyApp, got %s", got)
	}
}

// ── processRecords テスト ────────────────────────────────────────────────────

func TestProcessRecords_EmptyEvent(t *testing.T) {
	mock := &mockMetricPutter{}
	count, err := processRecords(context.Background(), events.DynamoDBEvent{}, mock)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if count != 0 {
		t.Errorf("expected 0, got %d", count)
	}
	if len(mock.calls) != 0 {
		t.Errorf("expected no CW calls, got %d", len(mock.calls))
	}
}

func TestProcessRecords_SkipsModify(t *testing.T) {
	mock := &mockMetricPutter{}
	event := events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{{EventName: "MODIFY"}},
	}
	count, err := processRecords(context.Background(), event, mock)
	if err != nil || count != 0 || len(mock.calls) != 0 {
		t.Errorf("MODIFY should be skipped: count=%d err=%v calls=%d", count, err, len(mock.calls))
	}
}

func TestProcessRecords_SkipsRemove(t *testing.T) {
	mock := &mockMetricPutter{}
	event := events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{{EventName: "REMOVE"}},
	}
	count, err := processRecords(context.Background(), event, mock)
	if err != nil || count != 0 || len(mock.calls) != 0 {
		t.Errorf("REMOVE should be skipped: count=%d err=%v calls=%d", count, err, len(mock.calls))
	}
}

func TestProcessRecords_SingleInsert(t *testing.T) {
	mock := &mockMetricPutter{}
	event := events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{insertRecord("doc/sample.pdf")},
	}
	count, err := processRecords(context.Background(), event, mock)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if count != 1 {
		t.Errorf("expected 1, got %d", count)
	}
	if len(mock.calls) != 1 {
		t.Errorf("expected 1 CW call, got %d", len(mock.calls))
	}
}

func TestProcessRecords_MultipleInserts(t *testing.T) {
	mock := &mockMetricPutter{}
	event := events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{
			insertRecord("a.pdf"),
			insertRecord("b.pdf"),
			insertRecord("c.pdf"),
		},
	}
	count, err := processRecords(context.Background(), event, mock)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if count != 3 {
		t.Errorf("expected 3, got %d", count)
	}
}

func TestProcessRecords_MixedEvents(t *testing.T) {
	mock := &mockMetricPutter{}
	event := events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{
			insertRecord("x.pdf"),
			{EventName: "MODIFY"},
			insertRecord("y.pdf"),
			{EventName: "REMOVE"},
		},
	}
	count, err := processRecords(context.Background(), event, mock)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if count != 2 {
		t.Errorf("expected 2 inserts published, got %d", count)
	}
	if len(mock.calls) != 2 {
		t.Errorf("expected 2 CW calls, got %d", len(mock.calls))
	}
}

func TestProcessRecords_FileKeyPassedToMetric(t *testing.T) {
	mock := &mockMetricPutter{}
	event := events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{insertRecord("reports/2026-07.pdf")},
	}
	_, _ = processRecords(context.Background(), event, mock)

	if len(mock.calls) == 0 {
		t.Fatal("expected at least 1 CW call")
	}
	dims := mock.calls[0].MetricData[0].Dimensions
	if len(dims) == 0 || *dims[0].Value != "reports/2026-07.pdf" {
		t.Errorf("expected fileKey dimension reports/2026-07.pdf, got %v", dims)
	}
}

func TestProcessRecords_EmptyFileKey(t *testing.T) {
	mock := &mockMetricPutter{}
	// INSERT record without fileKey in NewImage
	event := events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{insertRecord("")},
	}
	count, err := processRecords(context.Background(), event, mock)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if count != 1 {
		t.Errorf("expected 1 published even with empty fileKey, got %d", count)
	}
	if *mock.calls[0].MetricData[0].Dimensions[0].Value != "" {
		t.Error("expected empty string for missing fileKey dimension")
	}
}

func TestProcessRecords_ErrorPropagation(t *testing.T) {
	mock := &mockMetricPutter{retErr: errors.New("CW unavailable")}
	event := events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{insertRecord("fail.pdf")},
	}
	_, err := processRecords(context.Background(), event, mock)
	if err == nil {
		t.Error("expected error when PutMetricData fails")
	}
}

// ── handler テスト ───────────────────────────────────────────────────────────

func TestHandler_Success(t *testing.T) {
	mock := &mockMetricPutter{}
	orig := cwClient
	cwClient = mock
	defer func() { cwClient = orig }()

	event := events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{insertRecord("test.pdf")},
	}
	if err := handler(context.Background(), event); err != nil {
		t.Errorf("expected nil error, got %v", err)
	}
	if len(mock.calls) != 1 {
		t.Errorf("expected 1 CW call, got %d", len(mock.calls))
	}
}

func TestHandler_Error(t *testing.T) {
	mock := &mockMetricPutter{retErr: errors.New("CW down")}
	orig := cwClient
	cwClient = mock
	defer func() { cwClient = orig }()

	event := events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{insertRecord("fail.pdf")},
	}
	if err := handler(context.Background(), event); err == nil {
		t.Error("expected error propagated from handler")
	}
}

// ── 追加 processRecords テスト ───────────────────────────────────────────────

// mockMetricPutterN は最初の succeedFor 件を成功させ、以降はエラーを返すモック。
type mockMetricPutterN struct {
	calls      []*cloudwatch.PutMetricDataInput
	succeedFor int
	retErr     error
}

func (m *mockMetricPutterN) PutMetricData(
	_ context.Context,
	params *cloudwatch.PutMetricDataInput,
	_ ...func(*cloudwatch.Options),
) (*cloudwatch.PutMetricDataOutput, error) {
	m.calls = append(m.calls, params)
	if len(m.calls) > m.succeedFor {
		return &cloudwatch.PutMetricDataOutput{}, m.retErr
	}
	return &cloudwatch.PutMetricDataOutput{}, nil
}

func TestProcessRecords_ErrorPartialCount(t *testing.T) {
	mock := &mockMetricPutterN{succeedFor: 1, retErr: errors.New("CW timeout")}
	event := events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{
			insertRecord("ok.pdf"),
			insertRecord("fail.pdf"),
		},
	}
	count, err := processRecords(context.Background(), event, mock)
	if err == nil {
		t.Error("expected error on second record")
	}
	if count != 1 {
		t.Errorf("expected partial count=1, got %d", count)
	}
}

func TestProcessRecords_LargeBatch(t *testing.T) {
	mock := &mockMetricPutter{}
	records := make([]events.DynamoDBEventRecord, 10)
	for i := range records {
		records[i] = insertRecord(fmt.Sprintf("file%d.pdf", i))
	}
	count, err := processRecords(context.Background(), events.DynamoDBEvent{Records: records}, mock)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if count != 10 {
		t.Errorf("expected 10, got %d", count)
	}
	if len(mock.calls) != 10 {
		t.Errorf("expected 10 CW calls, got %d", len(mock.calls))
	}
}

func TestProcessRecords_AllSkipped(t *testing.T) {
	mock := &mockMetricPutter{}
	event := events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{
			{EventName: "MODIFY"},
			{EventName: "REMOVE"},
			{EventName: "MODIFY"},
		},
	}
	count, err := processRecords(context.Background(), event, mock)
	if err != nil || count != 0 || len(mock.calls) != 0 {
		t.Errorf("expected all skipped: count=%d err=%v calls=%d", count, err, len(mock.calls))
	}
}

func TestProcessRecords_MetricNamespace(t *testing.T) {
	t.Setenv("CW_NAMESPACE", "TestNS")
	mock := &mockMetricPutter{}
	_, _ = processRecords(context.Background(), events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{insertRecord("x.pdf")},
	}, mock)
	if len(mock.calls) == 0 {
		t.Fatal("expected at least 1 CW call")
	}
	if got := *mock.calls[0].Namespace; got != "TestNS" {
		t.Errorf("expected namespace TestNS, got %s", got)
	}
}

func TestProcessRecords_MetricValue(t *testing.T) {
	mock := &mockMetricPutter{}
	_, _ = processRecords(context.Background(), events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{insertRecord("v.pdf")},
	}, mock)
	if len(mock.calls) == 0 {
		t.Fatal("expected at least 1 CW call")
	}
	if got := *mock.calls[0].MetricData[0].Value; got != 1.0 {
		t.Errorf("expected metric value 1.0, got %f", got)
	}
}

func TestProcessRecords_MetricUnit(t *testing.T) {
	mock := &mockMetricPutter{}
	_, _ = processRecords(context.Background(), events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{insertRecord("u.pdf")},
	}, mock)
	if len(mock.calls) == 0 {
		t.Fatal("expected at least 1 CW call")
	}
	if got := mock.calls[0].MetricData[0].Unit; got != types.StandardUnitCount {
		t.Errorf("expected unit Count, got %v", got)
	}
}

func TestProcessRecords_DimensionName(t *testing.T) {
	mock := &mockMetricPutter{}
	_, _ = processRecords(context.Background(), events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{insertRecord("d.pdf")},
	}, mock)
	if len(mock.calls) == 0 {
		t.Fatal("expected at least 1 CW call")
	}
	dims := mock.calls[0].MetricData[0].Dimensions
	if len(dims) == 0 || *dims[0].Name != "FileKey" {
		t.Errorf("expected dimension name FileKey, got %v", dims)
	}
}

func TestNamespace_Whitespace(t *testing.T) {
	t.Setenv("CW_NAMESPACE", "   ")
	if got := namespace(); got != "   " {
		t.Errorf("expected whitespace returned as-is, got %q", got)
	}
}

// Ensure exported symbols compile.
var _ = handler
var _ = context.Background
