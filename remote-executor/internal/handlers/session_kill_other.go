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
