//go:build windows

package windowsbackup

import (
	"fmt"
	"golang.org/x/sys/windows"
	"os"
)

// Hold the administrator-provisioned private root without DELETE sharing. Unlike
// observation handles, this is a lifetime pin: its namespace cannot be renamed
// or replaced by a client while a privileged metadata worker uses the store.
func pinProtectedDirectory(path string) (*os.File, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateFile(name, windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(handle), path), nil
}
func pinnedProtectedIdentity(file *os.File) (string, error) {
	identity, err := Identity(file)
	if err != nil {
		return "", err
	}
	var name [32768]uint16
	n, err := windows.GetFinalPathNameByHandle(windows.Handle(file.Fd()), &name[0], uint32(len(name)), 1)
	if err != nil || n == 0 || n >= uint32(len(name)) {
		return "", fmt.Errorf("pinned store native path unavailable: %v", err)
	}
	return identity + ":" + windows.UTF16ToString(name[:n]), nil
}
