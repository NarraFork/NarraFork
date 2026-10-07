//go:build !windows

package handlers

import (
	"fmt"
	"os"
	"syscall"
)

func worktreeRootIdentity(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", fmt.Errorf("unsupported repository identity")
	}
	return fmt.Sprintf("%d:%d", stat.Dev, stat.Ino), nil
}
