package handlers

import (
	"context"
	"github.com/narrafork/remote-executor/internal/windowsbackup"
)

// Set once by explicit administrator configuration. This object shares ONLY
// immutable configuration and bounded ownership, never a mutable global issuer
// or MetadataChannel for history operations.
type WindowsFirstCaptureExecutor interface {
	MetadataPreauthorize(context.Context, map[string]any) (any, error)
	MetadataCapture(context.Context, map[string]any) (any, error)
	Disconnect(string) error
	Expire() error
}

func (h *Handlers) SetWindowsFirstCaptureExecutor(executor WindowsFirstCaptureExecutor) {
	h.firstCapture = executor
}
func (h *Handlers) WindowsMetadataFirstCapture(ctx context.Context, method string, params map[string]any) (any, error) {
	if h.firstCapture == nil {
		return nil, windowsbackup.ErrFirstCaptureNotReady
	}
	switch method {
	case windowsbackup.FirstCapturePreauthorizeMethod:
		return h.firstCapture.MetadataPreauthorize(ctx, params)
	case windowsbackup.FirstCaptureMethod:
		return h.firstCapture.MetadataCapture(ctx, params)
	default:
		return nil, windowsbackup.ErrFirstCaptureNotReady
	}
}
func (h *Handlers) DisconnectWindowsFirstCapture(connection string) error {
	if h.firstCapture == nil {
		return nil
	}
	return h.firstCapture.Disconnect(connection)
}
