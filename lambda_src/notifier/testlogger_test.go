package main

import (
	"io"
	"log/slog"
)

// testLogger returns a logger that discards output.
// Tests that assert on log content build their own logger with a buffer.
func testLogger() *slog.Logger {
	return NewLogger(LoggerOptions{Level: LogLevelSilent, Writer: io.Discard})
}
