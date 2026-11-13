//go:build windows

package remotepeer

import (
	"errors"
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
	"unsafe"
)

func privateSecurity() (*windows.SECURITY_DESCRIPTOR, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	return windows.SecurityDescriptorFromString("O:" + user.User.Sid.String() + "D:P(A;;FA;;;" + user.User.Sid.String() + ")(A;;FA;;;SY)")
}
func privateFile(path string, info os.FileInfo) error {
	ptr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	attrs, err := windows.GetFileAttributes(ptr)
	if err != nil {
		return err
	}
	if attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return errors.New("state_reparse")
	}
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return err
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	if owner == nil || !owner.Equals(user.User.Sid) {
		return errors.New("state_owner")
	}
	control, _, err := sd.Control()
	if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
		return errors.New("state_acl")
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil || acl.AceCount == 0 || acl.AceCount > 8 {
		return errors.New("state_acl")
	}
	userAllowed := false
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if windows.GetAce(acl, i, &ace) != nil || ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return errors.New("state_acl")
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if sid.Equals(user.User.Sid) {
			if uint32(ace.Mask)&0x1f01ff /* FILE_ALL_ACCESS */ == 0x1f01ff /* FILE_ALL_ACCESS */ {
				userAllowed = true
			}
		} else if sid.String() != "S-1-5-18" {
			return errors.New("state_acl")
		}
	}
	if !userAllowed {
		return errors.New("state_acl")
	}
	return nil
}
func privateParent(path string) error {
	for part := path; part != filepath.Dir(part); part = filepath.Dir(part) {
		ptr, err := windows.UTF16PtrFromString(part)
		if err != nil {
			return err
		}
		attrs, err := windows.GetFileAttributes(ptr)
		if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
			continue
		}
		if err != nil {
			return err
		}
		if attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || attrs&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
			return errors.New("state_parent")
		}
	}
	if _, err := os.Lstat(path); os.IsNotExist(err) {
		// Only the state directory is created; the NF-owned data parent must already exist.
		sd, err := privateSecurity()
		if err != nil {
			return err
		}
		ptr, err := windows.UTF16PtrFromString(path)
		if err != nil {
			return err
		}
		sa := &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
		if err = windows.CreateDirectory(ptr, sa); err != nil {
			return err
		}
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	return privateFile(path, info)
}
func createPrivate(path string, creation uint32, share uint32) (*os.File, error) {
	sd, err := privateSecurity()
	if err != nil {
		return nil, err
	}
	ptr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	sa := &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	handle, err := windows.CreateFile(ptr, windows.GENERIC_READ|windows.GENERIC_WRITE, share, sa, creation, windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(handle), path)
	info, err := f.Stat()
	if err == nil {
		err = privateFile(path, info)
	}
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	return f, nil
}
func privateTemp(parent string) (*os.File, error) {
	return createPrivate(filepath.Join(parent, ".remote-state-"+randomHex(16)), windows.CREATE_NEW, 0)
}
func lockState(path string) (*os.File, error) { return createPrivate(path, windows.OPEN_ALWAYS, 0) }
