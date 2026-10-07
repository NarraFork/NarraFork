//go:build !linux && !darwin && !windows

package handlers

import (
	"context"
	"fmt"
	"os"
)

func captureHistoryMetadata(ctx context.Context, file *os.File) ([]byte, error) {
	return nil, fmt.Errorf("platform has no complete native metadata provider")
}
func decodeHistoryMetadata(ctx context.Context, data []byte) (conditionalMetadata, error) {
	return nil, fmt.Errorf("platform has no complete native metadata provider")
}
func historyMetadataWithMode(ctx context.Context, data []byte, mode uint32) ([]byte, error) {
	return nil, fmt.Errorf("platform has no native mode provider")
}
