//go:build !windows

package remotepeer

import (
	"errors"
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
	"syscall"
)

func privateFile(path string, info os.FileInfo) error {
	if info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 {
		return errors.New("state_permissions")
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && stat.Uid != uint32(os.Geteuid()) {
		return errors.New("state_owner")
	}
	return nil
}
func privateParent(path string) error {
	for part := path; part != filepath.Dir(part); part = filepath.Dir(part) {
		info, err := os.Lstat(part)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("state_parent")
		}
	}
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	return privateFile(path, info)
}
func privateTemp(parent string) (*os.File, error) { return os.CreateTemp(parent, ".remote-state-*") }
func lockState(path string) (*os.File, error) {
	fd, err := unix.Open(path, unix.O_CREAT|unix.O_RDWR|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), path)
	info, err := f.Stat()
	if err == nil {
		err = privateFile(path, info)
	}
	if err == nil && !info.Mode().IsRegular() {
		err = errors.New("state_lock")
	}
	if err == nil {
		err = unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
	}
	if err != nil {
		_ = f.Close()
		return nil, errors.New("state_locked_or_permissions")
	}
	return f, nil
}
