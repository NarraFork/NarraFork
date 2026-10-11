//go:build windows

package windowsbackup

import (
	"fmt"
	"golang.org/x/sys/windows"
	"os"
	"strings"
	"unsafe"
)

// VolumeIdentity uses exactly the path-v2 local Windows format: actual native
// volume GUID including trailing slash followed by 16-digit native serial.
func VolumeIdentity(file *os.File) (string, string, error) {
	var id fileIDInformation
	if err := windows.GetFileInformationByHandleEx(windows.Handle(file.Fd()), windows.FileIdInfo, (*byte)(unsafe.Pointer(&id)), uint32(unsafe.Sizeof(id))); err != nil {
		return "", "", err
	}
	var buffer [32768]uint16
	n, err := windows.GetFinalPathNameByHandle(windows.Handle(file.Fd()), &buffer[0], uint32(len(buffer)), 1)
	if err != nil || n == 0 || n >= uint32(len(buffer)) {
		return "", "", fmt.Errorf("reliable volume GUID unavailable: %v", err)
	}
	name := windows.UTF16ToString(buffer[:n])
	end := strings.Index(name, `}\`)
	if !strings.HasPrefix(name, `\\?\Volume{`) || end < 0 {
		return "", "", fmt.Errorf("full metadata requires an independently verified native volume GUID")
	}
	guid := name[:end+2]
	return guid + fmt.Sprintf("%016x", id.Volume), guid, nil
}
