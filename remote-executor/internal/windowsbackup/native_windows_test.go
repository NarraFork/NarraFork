//go:build windows

package windowsbackup

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func nativeFixtureContext(t *testing.T) context.Context {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	// Unit fixture key is not any production key/config and does not establish
	// ordinary-token helper service readiness.
	store, err := NewProtectedStore(StoreConfig{Directory: filepath.Join(t.TempDir(), "private-store"), HelperInstanceID: "native-test", ServiceSID: "S-1-5-80-1-2-3-4-5", SigningKey: key})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Error(err)
		}
	})
	return WithBlobs(context.Background(), store)
}
func nativeTokenPrivileges(t *testing.T) []byte {
	t.Helper()
	token := windows.GetCurrentProcessToken()
	var data [8192]byte
	var used uint32
	if err := windows.GetTokenInformation(token, windows.TokenPrivileges, &data[0], uint32(len(data)), &used); err != nil {
		t.Fatal(err)
	}
	return bytes.Clone(data[:used])
}
func TestNativeWindowsFullMetadataExactRestore(t *testing.T) {
	for _, sacl := range []string{"S:", "S:NO_ACCESS_CONTROL", "S:P(AU;SAFA;FW;;;WD)(ML;;NW;;;ME)"} {
		t.Run(sacl, func(t *testing.T) {
			ctx := nativeFixtureContext(t)
			root := t.TempDir()
			sourcePath := filepath.Join(root, "original.txt")
			if err := os.WriteFile(sourcePath, []byte("old content"), 0600); err != nil {
				t.Fatal(err)
			}
			original, err := OpenMutation(sourcePath)
			if err != nil {
				t.Fatal(err)
			}
			defer original.Close()
			user, err := windows.GetCurrentProcessToken().GetTokenUser()
			if err != nil {
				t.Fatal(err)
			}
			sd, err := windows.SecurityDescriptorFromString("O:" + user.User.Sid.String() + "G:SYD:P(A;;FA;;;" + user.User.Sid.String() + ")(A;;FR;;;WD)" + sacl)
			if err != nil {
				t.Fatal(err)
			}
			if err := Privileged(ctx, []string{"SeSecurityPrivilege", "SeRestorePrivilege"}, func() error {
				h, err := Reopen(windows.Handle(original.Fd()), windows.WRITE_DAC|windows.WRITE_OWNER|windows.ACCESS_SYSTEM_SECURITY)
				if err != nil {
					return err
				}
				defer windows.CloseHandle(h)
				return windows.SetKernelObjectSecurity(h, windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.SACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION|windows.PROTECTED_SACL_SECURITY_INFORMATION, sd)
			}); err != nil {
				t.Fatal(err)
			}
			captured, err := Capture(ctx, original)
			if err != nil {
				t.Fatal("default NTFS full metadata must capture with legitimate privileges", err)
			}
			replacement, err := os.CreateTemp(root, "prepared-")
			if err != nil {
				t.Fatal(err)
			}
			defer replacement.Close()
			if _, err := replacement.Write([]byte("new content")); err != nil {
				t.Fatal(err)
			}
			if err := ApplyExact(ctx, replacement, captured); err != nil {
				t.Fatal("exact restore", err)
			}
			if err := Matches(ctx, replacement, captured); err != nil {
				t.Fatal("owner/group/SD control/DACL/SACL/label/times/attributes not exact", err)
			}
			a, err := Identity(original)
			if err != nil {
				t.Fatal(err)
			}
			b, err := Identity(replacement)
			if err != nil {
				t.Fatal(err)
			}
			if a == b {
				t.Fatal("new inode falsely equated to historical inode")
			}
		})
	}
}
func TestNativeWindowsPrivilegeScopeDoesNotLeak(t *testing.T) {
	before := nativeTokenPrivileges(t)
	for _, kind := range []string{"success", "error", "panic", "cancel"} {
		ctx, cancel := context.WithCancel(context.Background())
		if kind == "cancel" {
			cancel()
		}
		_ = Privileged(ctx, []string{"SeSecurityPrivilege", "SeBackupPrivilege", "SeRestorePrivilege"}, func() error {
			var token windows.Token
			if err := windows.OpenThreadToken(windows.CurrentThread(), windows.TOKEN_QUERY, true, &token); err != nil {
				return err
			}
			defer token.Close()
			if kind == "panic" {
				panic("fixture")
			}
			if kind == "error" {
				return fmt.Errorf("fixture")
			}
			return nil
		})
		cancel()
		if !bytes.Equal(before, nativeTokenPrivileges(t)) {
			t.Fatalf("process privileges leaked after %s", kind)
		}
	}
}
func TestNativeWindowsShareDeleteAndIdentityBoundRename(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "source.txt")
	if err := os.WriteFile(path, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	observation, err := OpenObservation(path)
	if err != nil {
		t.Fatalf("SHARE_DELETE_NATIVE_FAILURE stage=OpenObservation win32=%d error=%v", win32Code(err), err)
	}
	defer observation.Close()
	mutation, err := OpenMutation(path)
	if err != nil {
		t.Fatalf("SHARE_DELETE_NATIVE_FAILURE stage=OpenMutation win32=%d observer caused own FILE_SHARE_DELETE conflict: %v", win32Code(err), err)
	}
	defer mutation.Close()
	before, err := Identity(mutation)
	if err != nil {
		t.Fatalf("SHARE_DELETE_NATIVE_FAILURE stage=IdentityBeforeRename win32=%d error=%v", win32Code(err), err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("SHARE_DELETE_NATIVE_FAILURE stage=StatBeforeRename win32=%d", win32Code(err))
	}
	// Exercise the same original DELETE handle, not a pathname reopen.
	destination := filepath.Join(root, "moved.txt")
	wide, err := windows.UTF16FromString(destination)
	if err != nil {
		t.Fatal(err)
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
	if err := windows.SetFileInformationByHandle(windows.Handle(mutation.Fd()), windows.FileRenameInfo, &buffer[0], uint32(len(buffer))); err != nil {
		t.Fatalf("SHARE_DELETE_NATIVE_FAILURE stage=SetFileInformationByHandle(FileRenameInfo) win32=%d error=%v", win32Code(err), err)
	}
	after, err := Identity(mutation)
	if err != nil || before != after {
		t.Fatalf("SHARE_DELETE_NATIVE_FAILURE stage=IdentityAfterRename win32=%d identityEqual=%t same-volume rename lost FILE_ID_128: %v", win32Code(err), before == after, err)
	}
}
func TestNativeWindowsADSExactCaptureRestore(t *testing.T) {
	ctx := nativeFixtureContext(t)
	root := t.TempDir()
	path := filepath.Join(root, "original.txt")
	if err := os.WriteFile(path, []byte("main"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path+":Zone.Identifier", []byte("[ZoneTransfer]\r\nZoneId=3\r\n"), 0600); err != nil {
		t.Fatal(err)
	}
	source, err := OpenObservation(path)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	snapshot, err := Capture(ctx, source)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Streams) != 1 {
		t.Fatalf("ADS omitted: streamCount=%d", len(snapshot.Streams))
	}
	prepared, err := os.CreateTemp(root, "prepared-")
	if err != nil {
		t.Fatal(err)
	}
	defer prepared.Close()
	if _, err := prepared.Write([]byte("next")); err != nil {
		t.Fatal(err)
	}
	if err := ApplyExact(ctx, prepared, snapshot); err != nil {
		t.Fatal(err)
	}
	if err := Matches(ctx, prepared, snapshot); err != nil {
		current, captureErr := Capture(ctx, prepared)
		if captureErr != nil {
			t.Logf("ADS diagnostic recapture failed: %v", captureErr)
		} else {
			for _, line := range redactedSnapshotDiagnostic(snapshot, current) {
				t.Log(line)
			}
			for _, line := range redactedSecurityDiagnostic(snapshot, current) {
				t.Log(line)
			}
		}
		// Preserve the original strict failure; diagnostics never turn it into success.
		t.Fatal(err)
	}
	actual, err := os.ReadFile(prepared.Name() + ":Zone.Identifier")
	if err != nil || string(actual) != "[ZoneTransfer]\r\nZoneId=3\r\n" {
		t.Fatal("ADS bytes lost", err)
	}
}
func TestNativeWindowsRejectsHardlinkAndSpecialAttributes(t *testing.T) {
	ctx := nativeFixtureContext(t)
	for _, kind := range []string{"hardlink", "compressed", "sparse", "offline", "reparse"} {
		t.Run(kind, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "source.txt")
			if err := os.WriteFile(path, []byte("bytes"), 0600); err != nil {
				t.Fatal(err)
			}
			if kind == "hardlink" {
				if err := os.Link(path, path+".link"); err != nil {
					t.Fatal(err)
				}
			} else {
				attr := map[string]uint32{"compressed": windows.FILE_ATTRIBUTE_COMPRESSED, "sparse": windows.FILE_ATTRIBUTE_SPARSE_FILE, "offline": windows.FILE_ATTRIBUTE_OFFLINE, "reparse": windows.FILE_ATTRIBUTE_REPARSE_POINT}[kind]
				// Direct attribute tests validate the exact fixed matrix without pretending
				// SetFileAttributes can create sparse/compressed/reparse native structures.
				if attr&^uint32(ordinaryAttributes) == 0 {
					t.Fatal("special attribute admitted by matrix")
				}
				if kind != "offline" {
					return
				}
				p, _ := windows.UTF16PtrFromString(path)
				if err := windows.SetFileAttributes(p, attr); err != nil {
					t.Fatal(err)
				}
			}
			file, err := OpenObservation(path)
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			if _, err := Capture(ctx, file); err == nil {
				t.Fatal("special final object accepted")
			}
		})
	}
}
