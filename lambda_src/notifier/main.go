package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatch"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatch/types"
)

// MetricPutter abstracts the CloudWatch PutMetricData call for testing.
type MetricPutter interface {
	PutMetricData(ctx context.Context, params *cloudwatch.PutMetricDataInput, optFns ...func(*cloudwatch.Options)) (*cloudwatch.PutMetricDataOutput, error)
}

var cwClient MetricPutter

// logger is the structured logger shared by this package.
// Using logger.go keeps sensitive values masked by key name and lets
// LOG_LEVEL control verbosity at runtime.
var logger = NewLoggerFromEnv(LoggerOptions{})

func init() {
	cfg, err := config.LoadDefaultConfig(context.Background())
	if err != nil {
		logger.Error("failed to load AWS config", "error", err.Error())
		os.Exit(1)
	}
	cwClient = cloudwatch.NewFromConfig(cfg)
}

// namespace returns the CloudWatch namespace from the environment variable.
func namespace() string {
	if ns := os.Getenv("CW_NAMESPACE"); ns != "" {
		return ns
	}
	return "MultimodalApp"
}

// processRecords is the testable core logic: sends a CloudWatch metric for
// each INSERT record using the provided MetricPutter.
func processRecords(
	ctx context.Context,
	event events.DynamoDBEvent,
	client MetricPutter,
	l *slog.Logger,
) (int, error) {
	var published, skipped int

	for _, record := range event.Records {
		if record.EventName != "INSERT" {
			skipped++
			continue
		}

		fileKey := ""
		if v, ok := record.Change.NewImage["fileKey"]; ok {
			fileKey = v.String()
		}

		_, err := client.PutMetricData(ctx, &cloudwatch.PutMetricDataInput{
			Namespace: aws.String(namespace()),
			MetricData: []types.MetricDatum{
				{
					MetricName: aws.String("DocumentAnalyzed"),
					Timestamp:  aws.Time(time.Now()),
					Value:      aws.Float64(1),
					Unit:       types.StandardUnitCount,
					Dimensions: []types.Dimension{
						{
							Name:  aws.String("FileKey"),
							Value: aws.String(fileKey),
						},
					},
				},
			},
		})
		if err != nil {
			l.Error("failed to publish metric",
				"metric", "DocumentAnalyzed", "fileKey", fileKey, "error", err.Error())
			return published, fmt.Errorf("PutMetricData failed for %s: %w", fileKey, err)
		}

		l.Info("published metric", "metric", "DocumentAnalyzed", "fileKey", fileKey)
		published++
	}

	l.Debug("finished scanning stream records",
		"total", len(event.Records), "published", published, "skipped", skipped)
	return published, nil
}

// ProcessRecords sends a CloudWatch custom metric for each INSERT record
// in the DynamoDB stream event. Returns the count of metrics published.
func ProcessRecords(ctx context.Context, event events.DynamoDBEvent) (int, error) {
	return processRecords(ctx, event, cwClient, logger)
}

func handler(ctx context.Context, event events.DynamoDBEvent) error {
	count, err := ProcessRecords(ctx, event)
	if err != nil {
		logger.Error("handler failed", "error", err.Error())
		return err
	}
	logger.Info("handler finished", "published", count)
	return nil
}

func main() {
	lambda.Start(handler)
}
