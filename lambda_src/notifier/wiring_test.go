// wiring_test.go verifies that logger.go is actually used by the production
// code path, not just defined. It guards against regressing to log.Printf.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/aws/aws-lambda-go/events"
)

// wiringLogger returns a logger writing structured lines into a buffer.
func wiringLogger() (*slog.Logger, *bytes.Buffer) {
	buf := &bytes.Buffer{}
	return NewLogger(LoggerOptions{Level: LogLevelDebug, Writer: buf}), buf
}

// decodeLines parses every JSON line written by the logger.
func decodeLines(t *testing.T, buf *bytes.Buffer) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if line == "" {
			continue
		}
		var rec map[string]any
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			t.Fatalf("failed to parse log line: %v\n%s", err, line)
		}
		out = append(out, rec)
	}
	return out
}

func messages(recs []map[string]any) []string {
	var out []string
	for _, r := range recs {
		if m, ok := r["message"].(string); ok {
			out = append(out, m)
		}
	}
	return out
}

// ── package wiring ───────────────────────────────────────────

func TestPackageLoggerIsInitialized(t *testing.T) {
	if logger == nil {
		t.Fatal("package logger is nil; logger.go is not wired into main.go")
	}
}

// ── processRecords emits structured logs ─────────────────────

func TestProcessRecordsLogsPublishedMetric(t *testing.T) {
	l, buf := wiringLogger()
	mock := &mockMetricPutter{}

	count, err := processRecords(context.Background(), events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{insertRecord("report.pdf")},
	}, mock, l)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if count != 1 {
		t.Fatalf("count = %d, want 1", count)
	}

	recs := decodeLines(t, buf)
	var found bool
	for _, r := range recs {
		if r["message"] == "published metric" {
			found = true
			if r["metric"] != "DocumentAnalyzed" {
				t.Errorf("metric = %v, want DocumentAnalyzed", r["metric"])
			}
			if r["fileKey"] != "report.pdf" {
				t.Errorf("fileKey = %v, want report.pdf", r["fileKey"])
			}
		}
	}
	if !found {
		t.Errorf("no \"published metric\" log line:\n%v", messages(recs))
	}
}

func TestProcessRecordsLogsErrorOnFailure(t *testing.T) {
	l, buf := wiringLogger()
	mock := &mockMetricPutter{retErr: errors.New("throttled")}

	_, err := processRecords(context.Background(), events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{insertRecord("report.pdf")},
	}, mock, l)
	if err == nil {
		t.Fatal("expected an error")
	}

	var found bool
	for _, r := range decodeLines(t, buf) {
		if r["message"] == "failed to publish metric" {
			found = true
			if r["level"] != "error" {
				t.Errorf("level = %v, want error", r["level"])
			}
		}
	}
	if !found {
		t.Error("the failure was returned but never logged")
	}
}

func TestProcessRecordsCountsSkippedRecords(t *testing.T) {
	l, buf := wiringLogger()
	mock := &mockMetricPutter{}

	modify := insertRecord("ignored.pdf")
	modify.EventName = "MODIFY"

	count, err := processRecords(context.Background(), events.DynamoDBEvent{
		Records: []events.DynamoDBEventRecord{insertRecord("a.pdf"), modify},
	}, mock, l)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if count != 1 {
		t.Fatalf("count = %d, want 1", count)
	}

	var checked bool
	for _, r := range decodeLines(t, buf) {
		if r["message"] == "finished scanning stream records" {
			checked = true
			if r["total"] != float64(2) {
				t.Errorf("total = %v, want 2", r["total"])
			}
			if r["published"] != float64(1) {
				t.Errorf("published = %v, want 1", r["published"])
			}
			if r["skipped"] != float64(1) {
				t.Errorf("skipped = %v, want 1", r["skipped"])
			}
		}
	}
	if !checked {
		t.Error("no summary log line was emitted")
	}
}

// ── masking ──────────────────────────────────────────────────

func TestLoggerMasksSensitiveKeys(t *testing.T) {
	l, buf := wiringLogger()
	l.Info("test", "password", "p@ssw0rd", "fileKey", "report.pdf")

	recs := decodeLines(t, buf)
	if len(recs) != 1 {
		t.Fatalf("log lines = %d, want 1", len(recs))
	}
	if recs[0]["password"] == "p@ssw0rd" {
		t.Error("password was not masked")
	}
	if recs[0]["fileKey"] != "report.pdf" {
		t.Errorf("fileKey = %v; non-sensitive values must survive", recs[0]["fileKey"])
	}
}
