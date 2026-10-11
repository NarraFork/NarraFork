//go:build !windows

package windowsbackup

import "os"

func pinProtectedDirectory(path string) (*os.File, error)   { return os.Open(path) }
func pinnedProtectedIdentity(file *os.File) (string, error) { return protectedIdentity(file.Name()) }
