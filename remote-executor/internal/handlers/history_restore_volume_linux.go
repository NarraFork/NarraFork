//go:build linux

package handlers

import (
	"fmt"

	"golang.org/x/sys/unix"
)

func historyFilesystemIdentity(path string) (string, error) {
	var stat unix.Statx_t
	if err := unix.Statx(unix.AT_FDCWD, path, unix.AT_SYMLINK_NOFOLLOW, unix.STATX_MNT_ID, &stat); err != nil {
		return "", err
	}
	// Device numbers alone miss separate bind mounts of the same filesystem,
	// where rename still returns EXDEV. Require the kernel's actual mount ID.
	if stat.Mask&unix.STATX_MNT_ID == 0 {
		return "", fmt.Errorf("unsupported native mount identity")
	}
	return fmt.Sprintf("%d:%d:%d", stat.Dev_major, stat.Dev_minor, stat.Mnt_id), nil
}
