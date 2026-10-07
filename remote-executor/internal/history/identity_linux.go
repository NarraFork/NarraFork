//go:build linux

package history

import (
	"fmt"
	"golang.org/x/sys/unix"
)

// Birth time distinguishes deletion/recreation even when the inode is reused.
// Filesystems without that proof are explicitly unsupported, never guessed.
func rootIdentity(path string) (string, error) {
	var stat unix.Statx_t
	if err := unix.Statx(unix.AT_FDCWD, path, unix.AT_SYMLINK_NOFOLLOW, unix.STATX_INO|unix.STATX_BTIME, &stat); err != nil {
		return "", err
	}
	if stat.Mask&unix.STATX_BTIME == 0 {
		return "", fmt.Errorf("unsupported_root_identity: filesystem has no birth-time proof")
	}
	return fmt.Sprintf("%d:%d:%d:%d:%d", stat.Dev_major, stat.Dev_minor, stat.Ino, stat.Btime.Sec, stat.Btime.Nsec), nil
}
