//go:build !windows

package handlers

import (
	"context"
	"github.com/narrafork/remote-executor/internal/windowsbackup"
)

func (h *Handlers) ConfigureWindowsFirstCapture(ctx context.Context, enrollmentFile string) (func(), error) {
	if enrollmentFile == "" {
		return func() {}, nil
	}
	return nil, windowsbackup.ErrFirstCaptureNotReady
}
func RunConfiguredWindowsBackupHelper(context.Context, string) error {
	return windowsbackup.ErrFirstCaptureNotReady
}
