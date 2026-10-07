//go:build windows

package handlers

import (
	"fmt"
	"golang.org/x/sys/windows"
	"os"
)

func quarantineHistoryOriginal(file *os.File, destination string) error {
	opened, err := openConditionalWindowsFile(file.Name(), windows.DELETE|windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL)
	if err != nil {
		return err
	}
	defer opened.Close()
	original, err := file.Stat()
	if err != nil {
		return err
	}
	current, err := opened.Stat()
	if err != nil {
		return err
	}
	if !os.SameFile(original, current) {
		return errConditionalMetadataChanged
	}
	return renameConditionalHandle(opened, destination)
}
func publishHistoryNoReplace(source, destination string) error {
	// Move by an identity-bound DELETE handle; FileRenameInfo.ReplaceIfExists stays
	// false, so another actor's newly created entry is never overwritten.
	file, err := openConditionalWindowsFile(source, windows.DELETE|windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("native publication requires regular file")
	}
	return renameConditionalHandle(file, destination)
}
func syncHistoryDirectory(path string) error { return nil }

func historyFilesystemIdentity(path string) (string, error) {
	ptr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return "", err
	}
	handle, err := windows.CreateFile(ptr, windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(handle)
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return "", err
	}
	return fmt.Sprintf("%d", info.VolumeSerialNumber), nil
}
