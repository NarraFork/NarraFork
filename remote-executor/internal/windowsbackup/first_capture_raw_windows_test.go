//go:build windows

package windowsbackup

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestNativeWindowsFirstCaptureRawOpenNoEffects(t *testing.T) {
	requirePreparedScratch(t)
	path := filepath.Join(t.TempDir(), "raw-preauthorization.txt")
	if err := os.WriteFile(path, []byte("unread main"), 0600); err != nil {
		t.Fatal("raw fixture main create")
	}
	if err := os.WriteFile(path+":Zone.Identifier", []byte("unread named stream"), 0600); err != nil {
		t.Fatal("raw fixture ADS create")
	}
	metadata, err := openOrdinary(path, windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL|windows.SYNCHRONIZE)
	if err != nil {
		t.Fatal(err)
	}
	defer metadata.Close()
	before, err := inspectStableReadObject(windows.Handle(metadata.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	privileges := nativeTokenPrivileges(t)
	backupCalls := 0
	oldObserver := backupSDKObserver
	backupSDKObserver = func(backupSDKEvent) { backupCalls++ }
	defer func() { backupSDKObserver = oldObserver }()
	raw, err := openFirstCaptureRaw(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if raw == nil || raw.file == nil || raw.granted&0x120189 != 0x120189 {
		t.Fatal("raw ordinary handle rights not complete")
	}
	if raw.ordinary.stableReadObjectState != before {
		t.Fatal("raw open changed first ordinary native/basic observation")
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}
	after, err := inspectStableReadObject(windows.Handle(metadata.Fd()))
	if err != nil || after != before {
		t.Fatal("raw preauthorization close changed original metadata")
	}
	if backupCalls != 0 || !bytes.Equal(privileges, nativeTokenPrivileges(t)) {
		t.Fatal("raw open entered backup or changed process privileges")
	}
	t.Log("raw ordinary open actualGranted verified; no sentinel/payload/SD/Capture/backup/privilege scope; original first native basic equal")
}
func TestNativeWindowsFirstCaptureRawOpenRightsDenied(t *testing.T) {
	requirePreparedScratch(t)
	path := filepath.Join(t.TempDir(), "deny-raw-writeattrs.txt")
	if err := os.WriteFile(path, []byte("unread"), 0600); err != nil {
		t.Fatal("raw deny fixture create")
	}
	setup, err := openOrdinary(path, windows.WRITE_DAC|windows.READ_CONTROL|windows.FILE_READ_ATTRIBUTES)
	if err != nil {
		t.Fatal(err)
	}
	defer setup.Close()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(D;;0x100;;;WD)(A;;FA;;;" + user.User.Sid.String() + ")")
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetSecurityInfo(windows.Handle(setup.Fd()), windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
		t.Fatal(err)
	}
	before, err := inspectStableReadObject(windows.Handle(setup.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := openFirstCaptureRaw(context.Background(), path)
	if raw != nil {
		raw.Close()
		t.Fatal("denied ordinary raw open retained an unexpectedly authorized handle")
	}
	if !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Fatal("raw write-attributes denial not enforced", err)
	}
	after, err := inspectStableReadObject(windows.Handle(setup.Fd()))
	if err != nil || after != before {
		t.Fatal("denied raw open changed original metadata")
	}
}
