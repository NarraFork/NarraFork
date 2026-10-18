//go:build !windows

package handlers

import (
	"fmt"
	"os"
	"syscall"
)

func editorFileIdentity(_ *os.File, info os.FileInfo) (string, error) {
	return editorObjectIdentity("", info)
}

func editorObjectIdentity(_ string, info os.FileInfo) (string, error) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", fmt.Errorf("EDITOR_PROVIDER_UNSUPPORTED: filesystem identity unavailable")
	}
	return fmt.Sprintf("%x:%x", stat.Dev, stat.Ino), nil
}
