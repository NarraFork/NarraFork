//go:build windows

package windowsbackup

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

func storeSD(serviceSID string) (*windows.SECURITY_DESCRIPTOR, error) {
	if !strings.HasPrefix(serviceSID, "S-1-5-80-") {
		return nil, fmt.Errorf("dedicated helper service SID required")
	}
	if _, err := windows.StringToSid(serviceSID); err != nil {
		return nil, err
	}
	return windows.SecurityDescriptorFromString("O:SYG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;" + serviceSID + ")")
}
func prepareProtectedDirectory(path, serviceSID string) error {
	sd, err := storeSD(serviceSID)
	if err != nil {
		return err
	}
	// Configuration is explicitly provisioned. Do not create arbitrary roots or
	// trust client first use. All ancestors must already exist without reparse.
	for parent := filepath.Dir(path); ; parent = filepath.Dir(parent) {
		p, err := windows.UTF16PtrFromString(parent)
		if err != nil {
			return err
		}
		attr, err := windows.GetFileAttributes(p)
		if err != nil {
			return err
		}
		if attr&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return fmt.Errorf("protected store reparse ancestor")
		}
		if filepath.Dir(parent) == parent {
			break
		}
	}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	if err := windows.CreateDirectory(p, &sa); err != nil && err != windows.ERROR_ALREADY_EXISTS {
		return err
	}
	f, err := openOrdinary(path, windows.READ_CONTROL|windows.FILE_READ_ATTRIBUTES)
	if err != nil {
		return err
	}
	defer f.Close()
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(windows.Handle(f.Fd()), &info); err != nil {
		return err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
		return fmt.Errorf("invalid protected directory")
	}
	got, err := windows.GetSecurityInfo(windows.Handle(f.Fd()), windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	wantDACL, _, err := sd.DACL()
	if err != nil {
		return err
	}
	gotDACL, _, err := got.DACL()
	if err != nil {
		return err
	}
	bytesOf := func(a *windows.ACL) []byte {
		if a == nil {
			return nil
		}
		return unsafe.Slice((*byte)(unsafe.Pointer(a)), int(*(*uint16)(unsafe.Add(unsafe.Pointer(a), 2))))
	}
	control, _, err := got.Control()
	if err != nil {
		return err
	}
	owner, _, err := got.Owner()
	if err != nil {
		return err
	}
	if owner.String() != "S-1-5-18" || control&windows.SE_DACL_PROTECTED == 0 || !bytes.Equal(bytesOf(wantDACL), bytesOf(gotDACL)) {
		return fmt.Errorf("helper store ACL not administrator-provisioned")
	}
	return nil
}
func protectStoreObject(file *os.File, serviceSID string) error {
	sd, err := storeSD(serviceSID)
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	// os.CreateTemp has WRITE_DAC only through owner implicit access. ReOpenFile
	// binds the exact newly created object; no security path lookup is used.
	h, err := Reopen(windows.Handle(file.Fd()), windows.WRITE_DAC|windows.READ_CONTROL)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	return windows.SetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}
func protectedIdentity(path string) (string, error) {
	f, err := openOrdinary(path, windows.FILE_READ_ATTRIBUTES)
	if err != nil {
		return "", err
	}
	defer f.Close()
	return Identity(f)
}
func renameProtected(from, to string) error {
	a, err := windows.UTF16PtrFromString(from)
	if err != nil {
		return err
	}
	b, err := windows.UTF16PtrFromString(to)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(a, b, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}
func syncProtectedDirectory(path string) error {
	// Windows does not expose Unix fsync-directory semantics. MoveFileEx with
	// WRITE_THROUGH above durably publishes the rename after file FlushFileBuffers.
	return nil
}
