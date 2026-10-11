//go:build windows

package windowsbackup

import (
	"context"
	"encoding/binary"
	"fmt"
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
	"strings"
	"unsafe"
)

func nativeObjectIdentity(file *os.File) (string, error) { return Identity(file) }
func validateVaultVolume(path, volumeID, guid string) error {
	f, err := openOrdinary(path, windows.FILE_READ_ATTRIBUTES)
	if err != nil {
		return err
	}
	defer f.Close()
	var id fileIDInformation
	if err := windows.GetFileInformationByHandleEx(windows.Handle(f.Fd()), windows.FileIdInfo, (*byte)(unsafe.Pointer(&id)), uint32(unsafe.Sizeof(id))); err != nil {
		return err
	}
	var name [32768]uint16
	n, err := windows.GetFinalPathNameByHandle(windows.Handle(f.Fd()), &name[0], uint32(len(name)), 1)
	if err != nil || n == 0 || n >= uint32(len(name)) {
		return fmt.Errorf("vault volume GUID unavailable: %v", err)
	}
	native := windows.UTF16ToString(name[:n])
	end := strings.Index(native, `}\`)
	if end < 0 || native[:end+2]+fmt.Sprintf("%016x", id.Volume) != volumeID || !strings.EqualFold(native[:end+2], guid) {
		return fmt.Errorf("vault volume GUID/identity mismatch")
	}
	return nil
}
func allocatedBytes(file *os.File) (int64, error) {
	h := windows.Handle(file.Fd())
	type standardInfo struct {
		Allocation, EOF          int64
		Links                    uint32
		DeletePending, Directory byte
		Padding                  [2]byte
	}
	var standard standardInfo
	if err := windows.GetFileInformationByHandleEx(h, windows.FileStandardInfo, (*byte)(unsafe.Pointer(&standard)), uint32(unsafe.Sizeof(standard))); err != nil {
		return 0, err
	}
	if standard.Links != 1 || standard.Directory != 0 || standard.Allocation < 0 {
		return 0, ErrIncomplete
	}
	var buffer [65536]byte
	if err := windows.GetFileInformationByHandleEx(h, windows.FileStreamInfo, &buffer[0], uint32(len(buffer))); err != nil {
		return 0, err
	}
	total := int64(0)
	offset := 0
	for count := 0; count < StreamCount+1; count++ {
		if offset+24 > len(buffer) {
			return 0, ErrIncomplete
		}
		next := int(binary.LittleEndian.Uint32(buffer[offset:]))
		n := int(binary.LittleEndian.Uint32(buffer[offset+4:]))
		allocated := int64(binary.LittleEndian.Uint64(buffer[offset+16:]))
		if n < 0 || n%2 != 0 || offset+24+n > len(buffer) || allocated < 0 || allocated > StoreQuota-total {
			return 0, ErrIncomplete
		}
		total += allocated
		if next == 0 {
			return total, nil
		}
		if next < 24+n || offset+next <= offset {
			return 0, ErrIncomplete
		}
		offset += next
	}
	return 0, ErrIncomplete
}
func vaultAvailable(path string, required int64) error {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	var available uint64
	if err := windows.GetDiskFreeSpaceEx(p, &available, nil, nil); err != nil {
		return err
	}
	if required < 0 || uint64(required) > available {
		return fmt.Errorf("vault space preflight")
	}
	return nil
}
func moveVaultOriginal(ctx context.Context, file *os.File, destination, serviceSID string) error {
	return Privileged(ctx, []string{"SeSecurityPrivilege", "SeBackupPrivilege", "SeRestorePrivilege"}, func() error {
		// Original ordinary DELETE handle is fixed; privilege does not reclaim a path.
		h := windows.Handle(file.Fd())
		security, err := Reopen(h, windows.GENERIC_WRITE|windows.WRITE_DAC|windows.WRITE_OWNER|windows.READ_CONTROL)
		if err != nil {
			return err
		}
		defer windows.CloseHandle(security)
		destination, err := filepath.Abs(destination)
		if err != nil {
			return err
		}
		wide, err := windows.UTF16FromString(destination)
		if err != nil {
			return err
		}
		wide = wide[:len(wide)-1]
		type renameInfo struct {
			Replace uint32
			Root    windows.Handle
			Length  uint32
			Name    uint16
		}
		offset := int(unsafe.Offsetof(renameInfo{}.Name))
		buffer := make([]byte, offset+len(wide)*2)
		info := (*renameInfo)(unsafe.Pointer(&buffer[0]))
		info.Length = uint32(len(wide) * 2)
		copy(unsafe.Slice((*uint16)(unsafe.Pointer(&buffer[offset])), len(wide)), wide)
		if err := windows.SetFileInformationByHandle(h, windows.FileRenameInfo, &buffer[0], uint32(len(buffer))); err != nil {
			return err
		}
		sd, err := storeSD(serviceSID)
		if err != nil {
			return err
		}
		dacl, _, err := sd.DACL()
		if err != nil {
			return err
		}
		// Protect EACH original object, not just parent. This removes the old user's
		// bypass-traverse/direct fileID read grants while historical SD remains stored.
		owner, _, err := sd.Owner()
		if err != nil {
			return err
		}
		if err := windows.SetSecurityInfo(security, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, owner, nil, dacl, nil); err != nil {
			return err
		}
		actual, err := windows.GetSecurityInfo(security, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
		if err != nil {
			return err
		}
		expected, err := selfRelativeBytes(sd)
		if err != nil {
			return err
		}
		_ = expected
		control, _, err := actual.Control()
		if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
			return fmt.Errorf("vault object sealing failed")
		}
		return windows.FlushFileBuffers(h)
	})
}
func captureVaultFingerprint(ctx context.Context, file *os.File) (string, error) {
	s, err := Capture(ctx, file)
	if err != nil {
		return "", err
	}
	raw, err := Encode(s)
	if err != nil {
		return "", err
	}
	return Digest(raw), nil
}
