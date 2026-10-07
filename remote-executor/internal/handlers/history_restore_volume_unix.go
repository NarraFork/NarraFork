//go:build !windows && !linux

package handlers

import (
	"fmt"
	"os"
	"syscall"
)

func historyFilesystemIdentity(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", fmt.Errorf("unsupported native filesystem identity")
	}
	return fmt.Sprintf("%d", stat.Dev), nil
}
