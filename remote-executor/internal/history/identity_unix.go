//go:build !windows

package history

import (
	"fmt"
	"os"
	"syscall"
)

func durableRename(from, to string) error { return os.Rename(from, to) }
func supportedMode(mode uint32) uint32    { return mode }

func secureDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode().Perm()&0077 != 0 {
		return fmt.Errorf("history stateDir must be private (0700)")
	}
	return nil
}

func availableBytes(path string) (uint64, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, err
	}
	return uint64(stat.Bavail) * uint64(stat.Bsize), nil
}

func lockStore(file *os.File) error {
	return syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
}
