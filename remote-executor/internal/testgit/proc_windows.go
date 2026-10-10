//go:build windows

package testgit

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"
)

func ownProcessTree(cmd *exec.Cmd) {
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		// Resolve the OS utility directly, never through the fixture PATH.
		kill := exec.CommandContext(ctx, filepath.Join(os.Getenv("SystemRoot"), "System32", "taskkill.exe"), "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid))
		kill.Stdout, kill.Stderr = io.Discard, io.Discard
		_ = kill.Run()
		return cmd.Process.Kill()
	}
}
