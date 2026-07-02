package main

import (
	"context"
	"errors"
	"testing"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatch"
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

// Ensure exported symbols compile.
var _ = handler
var _ = context.Background
