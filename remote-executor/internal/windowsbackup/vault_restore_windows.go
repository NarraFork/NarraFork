//go:build windows

package windowsbackup

import (
	"context"
	"fmt"
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
	"unsafe"
)

func verifyVaultLocation(file *os.File, wanted string) error {
	observed, err := openOrdinary(wanted, windows.FILE_READ_ATTRIBUTES)
	if err != nil {
		return err
	}
	defer observed.Close()
	a, err := Identity(file)
	if err != nil {
		return err
	}
	b, err := Identity(observed)
	if err != nil {
		return err
	}
	if a != b {
		return fmt.Errorf("vault original slot/object mismatch")
	}
	return nil
}
func renameVaultHandle(file *os.File, destination string) error {
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
	return windows.SetFileInformationByHandle(windows.Handle(file.Fd()), windows.FileRenameInfo, &buffer[0], uint32(len(buffer)))
}
func restoreVaultOriginal(ctx context.Context, file *os.File, snapshot *Snapshot, target, serviceSID string) error {
	if err := ApplyExact(ctx, file, snapshot); err != nil {
		return err
	}
	if err := renameVaultHandle(file, target); err != nil {
		// The original must not be left unsealed in the private vault after a failed
		// no-overwrite publication. Preserve evidence and attempt only bounded reseal.
		sealErr := Privileged(context.WithoutCancel(ctx), []string{"SeRestorePrivilege"}, func() error {
			sd, e := storeSD(serviceSID)
			if e != nil {
				return e
			}
			dacl, _, e := sd.DACL()
			if e != nil {
				return e
			}
			owner, _, e := sd.Owner()
			if e != nil {
				return e
			}
			h, e := Reopen(windows.Handle(file.Fd()), windows.WRITE_DAC|windows.WRITE_OWNER|windows.READ_CONTROL)
			if e != nil {
				return e
			}
			defer windows.CloseHandle(h)
			return windows.SetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, owner, nil, dacl, nil)
		})
		return fmt.Errorf("original publication unknown; vault retained (reseal=%v): %w", sealErr, err)
	}
	return Matches(ctx, file, snapshot)
}
