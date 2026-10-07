//go:build darwin

package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
)

type historyDarwinMetadata struct {
	Version  int                    `json:"version"`
	Platform string                 `json:"platform"`
	Snapshot darwinMetadataSnapshot `json:"snapshot"`
}

func captureHistoryMetadata(ctx context.Context, file *os.File) ([]byte, error) {
	native, err := captureConditionalMetadata(file, ctx)
	if err != nil {
		return nil, err
	}
	return json.Marshal(historyDarwinMetadata{1, "darwin", native.(*darwinConditionalMetadata).snapshot})
}
func decodeHistoryMetadata(ctx context.Context, data []byte) (conditionalMetadata, error) {
	if len(data) > 512<<10 {
		return nil, fmt.Errorf("native metadata budget")
	}
	var m historyDarwinMetadata
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	if m.Version != 1 || m.Platform != "darwin" || m.Snapshot.Mode & ^uint16(0777) != 0 || len(m.Snapshot.Attrs) > 256 {
		return nil, fmt.Errorf("invalid macOS native metadata backup")
	}
	total := len(m.Snapshot.ACL)
	for key, value := range m.Snapshot.Attrs {
		total += len(key) + len(value)
	}
	if total > darwinMaxMetadataBytes {
		return nil, fmt.Errorf("native metadata budget")
	}
	return &darwinConditionalMetadata{ctx: ctx, snapshot: m.Snapshot}, nil
}
func historyMetadataWithMode(ctx context.Context, data []byte, mode uint32) ([]byte, error) {
	if mode & ^uint32(0777) != 0 {
		return nil, fmt.Errorf("invalid mode")
	}
	if _, err := decodeHistoryMetadata(ctx, data); err != nil {
		return nil, err
	}
	var m historyDarwinMetadata
	json.Unmarshal(data, &m)
	m.Snapshot.Mode = uint16(mode)
	return json.Marshal(m)
}
