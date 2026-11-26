//go:build !linux && !windows

package handlers

import (
	"syscall"
	"time"
)

// killPtySession cannot enumerate a session's processes portably here. A hangup
// makes an interactive shell forward SIGHUP to its jobs before exiting (as when
// a real terminal closes); the shell's group is then killed in case it ignored it.
func killPtySession(sid int) {
	_ = syscall.Kill(-sid, syscall.SIGHUP)
	go func() {
		time.Sleep(500 * time.Millisecond)
		_ = syscall.Kill(-sid, syscall.SIGKILL)
	}()
}

// killExecSession stops a command without a terminal with SIGKILL to its process
// group straight away. There is no interactive shell to forward a hangup, and a
// command that caught SIGHUP could exit 0 and hide that its deadline stopped it.
func killExecSession(sid int) { _ = syscall.Kill(-sid, syscall.SIGKILL) }
