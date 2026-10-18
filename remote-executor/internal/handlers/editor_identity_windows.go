//go:build windows

package handlers

import (
	"fmt"
	"golang.org/x/sys/windows"
	"os"
)

func editorObjectIdentity(path string, _ os.FileInfo) (string, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return "", err
	}
	handle, err := windows.CreateFile(name, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(handle)
	return editorHandleIdentity(handle)
}

func editorFileIdentity(f *os.File, _ os.FileInfo) (string, error) {
	return editorHandleIdentity(windows.Handle(f.Fd()))
}

func editorHandleIdentity(handle windows.Handle) (string, error) {
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x:%x:%x", info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow), nil
}
