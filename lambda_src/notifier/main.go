package main

import (
	"context"
	"fmt"
	"log"
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

func init() {
	cfg, err := config.LoadDefaultConfig(context.Background())
	if err != nil {
		log.Fatalf("failed to load AWS config: %v", err)
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
func processRecords(ctx context.Context, event events.DynamoDBEvent, client MetricPutter) (int, error) {
	var published int

	for _, record := range event.Records {
		if record.EventName != "INSERT" {
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
			return published, fmt.Errorf("PutMetricData failed for %s: %w", fileKey, err)
		}

		log.Printf("[METRIC] DocumentAnalyzed fileKey=%s", fileKey)
		published++
	}

	return published, nil
}

// ProcessRecords sends a CloudWatch custom metric for each INSERT record
// in the DynamoDB stream event. Returns the count of metrics published.
func ProcessRecords(ctx context.Context, event events.DynamoDBEvent) (int, error) {
	return processRecords(ctx, event, cwClient)
}

func handler(ctx context.Context, event events.DynamoDBEvent) error {
	count, err := ProcessRecords(ctx, event)
	if err != nil {
		return err
	}
	log.Printf("[DONE] published %d metrics", count)
	return nil
}

func main() {
	lambda.Start(handler)
}
