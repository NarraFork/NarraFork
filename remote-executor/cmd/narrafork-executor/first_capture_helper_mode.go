package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"

	"github.com/narrafork/remote-executor/internal/handlers"
)

// Explicit operator command, not automatic service installation/startup. This
// path reads only preinstalled private helper config; normal executor credentials
// and hello_ack do not enroll a helper or mint a signing key.
func runFirstCaptureHelperMode(ctx context.Context, args []string) (bool, error) {
	if len(args) == 0 || args[0] != "windows-backup-helper" {
		return false, nil
	}
	if len(args) != 3 || args[1] != "--config" || !filepath.IsAbs(args[2]) {
		return true, fmt.Errorf("windows-backup-helper requires an administrator-protected absolute --config path")
	}
	ctx, cancel := signal.NotifyContext(ctx, os.Interrupt)
	defer cancel()
	return true, handlers.RunConfiguredWindowsBackupHelper(ctx, args[2])
}
