//go:build !windows

package handlers

import (
	"os/exec"
	"syscall"
)

// configureProcAttr puts the child in its own process group so we can kill the
// whole tree with a single signal to the negative pid.
func configureProcAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killProcessGroup sends SIGKILL to the child's process group.
func killProcessGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	pid := cmd.Process.Pid
	// Negative pid targets the whole process group.
	_ = syscall.Kill(-pid, syscall.SIGKILL)
	// Fallback: kill the direct process too.
	_ = cmd.Process.Kill()
}
