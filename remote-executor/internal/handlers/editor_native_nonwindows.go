//go:build !windows

package handlers

import (
	"context"
	"errors"
	"fmt"
	"os"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

func ensureEditorPrivateDirectory(path string) error {
	if err := os.Mkdir(path, 0o700); err != nil && !os.IsExist(err) {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || info.Mode().Perm()&0o077 != 0 || !ok || stat.Uid != uint32(os.Geteuid()) {
		return fmt.Errorf("editor state directory must be owner-only and non-symlink")
	}
	return nil
}
func validateEditorSourceWritable(_ *os.File) error { return nil }
func validateEditorHostRecordFile(file *os.File) error {
	info, err := file.Stat()
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || stat.Uid != uint32(os.Geteuid()) || stat.Nlink != 1 {
		return fmt.Errorf("Host receipt file must be private, regular and single-link")
	}
	return nil
}
func syncEditorDirectory(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}
func lockEditorFile(ctx context.Context, f *os.File) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			return nil
		}
		if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) {
			return err
		}
		timer := time.NewTimer(10 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}
func unlockEditorFile(f *os.File) { _ = unix.Flock(int(f.Fd()), unix.LOCK_UN) }
func verifyEditorPreparedMetadata(metadata conditionalMetadata, f *os.File) error {
	return metadata.matches(f)
}
func commitEditorReplacement(target, tmp string, original os.FileInfo, metadata conditionalMetadata, _ string, _ int64) error {
	if original == nil {
		// link is an atomic no-replace install on POSIX (Rename would overwrite).
		// Unsupported filesystems fail explicitly rather than falling back to rename.
		if err := os.Link(tmp, target); err != nil {
			return err
		}
		return os.Remove(tmp)
	}
	return commitConditionalReplacement(context.Background(), target, tmp, original, metadata, nil)
}
