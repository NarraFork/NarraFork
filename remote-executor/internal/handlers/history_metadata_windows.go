//go:build windows

package handlers

import (
	"context"
	"fmt"
	"os"

	"github.com/narrafork/remote-executor/internal/windowsbackup"
	"golang.org/x/sys/windows"
)

// v1 remains immutable and is never upgraded by consulting the current target.
type historyWindowsBackup struct {
	Version    int    `json:"version"`
	Platform   string `json:"platform"`
	Security   string `json:"security"`
	Label      string `json:"label"`
	Audit      string `json:"audit"`
	Attributes uint32 `json:"attributes"`
}
type historyWindowsMetadata struct {
	descriptor *windowsbackup.Descriptor
	channel    windowsbackup.MetadataChannel
	ctx        context.Context
}

func captureHistoryMetadata(ctx context.Context, file *os.File) ([]byte, error) {
	channel, err := windowsbackup.Channel(ctx)
	if err != nil {
		return nil, err
	}
	descriptor, err := channel.Capture(ctx, file)
	if err != nil {
		return nil, err
	}
	return windowsbackup.EncodeDescriptor(descriptor)
}
func decodeHistoryMetadata(ctx context.Context, data []byte) (conditionalMetadata, error) {
	// The remote object-stage API can supply arbitrary CAS bytes. Accept ONLY an
	// opaque helper proof descriptor, never a client self-relative SD/SDDL.
	descriptor, err := windowsbackup.DecodeDescriptor(data)
	if err != nil {
		return nil, fmt.Errorf("complete Windows original helper proof v2 required (legacy/raw SD is not upgraded): %w", err)
	}
	channel, err := windowsbackup.Channel(ctx)
	if err != nil {
		return nil, err
	}
	return &historyWindowsMetadata{descriptor: descriptor, channel: channel, ctx: ctx}, nil
}
func (m *historyWindowsMetadata) apply(file *os.File) error {
	// Helper performs windowsbackup.ApplyExact using ONLY its own original record,
	// unlike the legacy ReplaceFileW preparation which does not install DACL/SACL.
	if err := m.channel.ApplyOriginal(m.ctx, file, m.descriptor); err != nil {
		return err
	}
	return m.matches(file)
}
func (m *historyWindowsMetadata) matches(file *os.File) error {
	return m.channel.MatchesOriginal(m.ctx, file, m.descriptor)
}
func historyMetadataWithMode(ctx context.Context, data []byte, mode uint32) ([]byte, error) {
	if mode != 0444 && mode != 0666 {
		return nil, fmt.Errorf("Windows restore mode must be readonly/writable")
	}
	descriptor, err := windowsbackup.DecodeDescriptor(data)
	if err != nil {
		return nil, err
	}
	recordedMode := uint32(0666)
	if descriptor.Attributes&windows.FILE_ATTRIBUTE_READONLY != 0 {
		recordedMode = 0444
	}
	if mode != recordedMode {
		return nil, fmt.Errorf("Windows mode change needs a separately authorized helper-owned prepared metadata record")
	}
	// Never alter a projection and pretend that it changed the helper's original SD.
	return data, nil
}
