//go:build windows

package handlers

import (
	"context"
	"os/exec"
	"time"
)

// configureProcAttr is a no-op on Windows (no POSIX process groups). Tree-kill
// is best-effort via taskkill in killProcessGroup.
func configureProcAttr(cmd *exec.Cmd) {}

// killProcessGroup terminates the child and its descendants via taskkill /T.
func killProcessGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	pid := cmd.Process.Pid
	// Non-PTY legacy exec only. Native ConPTY uses its parent's Job Object,
	// never PID-based taskkill as lifecycle evidence.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = exec.CommandContext(ctx, "taskkill.exe", "/T", "/F", "/PID", itoa(pid)).Run()
	_ = cmd.Process.Kill()
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
