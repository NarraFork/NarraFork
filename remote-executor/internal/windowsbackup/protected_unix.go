//go:build !windows

package windowsbackup

import (
	"fmt"
	"os"
	"reflect"
)

// Unix backing primitives exist for deterministic library/fault tests only;
// Windows helper service readiness is never produced by these implementations.
func prepareProtectedDirectory(path, serviceSID string) error   { return os.MkdirAll(path, 0700) }
func protectStoreObject(file *os.File, serviceSID string) error { return file.Chmod(0600) }
func protectedIdentity(path string) (string, error) {
	s, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	v := reflect.ValueOf(s.Sys()).Elem()
	return fmt.Sprintf("%v:%v", v.FieldByName("Dev"), v.FieldByName("Ino")), nil
}
func renameProtected(from, to string) error { return os.Rename(from, to) }
func syncProtectedDirectory(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}
