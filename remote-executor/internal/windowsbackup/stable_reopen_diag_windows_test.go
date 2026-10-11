//go:build windows

package windowsbackup

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func finalPathEvidence(handle windows.Handle, flags uint32) (uint32, string, error) {
	var name [32768]uint16
	n, err := windows.GetFinalPathNameByHandle(handle, &name[0], uint32(len(name)), flags)
	digest := "unavailable"
	if err == nil && n > 0 && n < uint32(len(name)) {
		digest = Digest([]byte(windows.UTF16ToString(name[:n])))
	}
	return n, digest, err
}

// This is a bounded diagnostic for the isolated privileged ReOpen failure. It
// emits Win32 codes, lengths, zero-state and hashes only; never the path, SD,
// proof, nonce, key or stream contents. It makes no read, timestamp, ACL or
// privilege-policy change beyond the already-approved per-handle sentinel.
func TestNativeWindowsStableReadReopenDiagnostics(t *testing.T) {
	requirePreparedScratch(t)
	path := filepath.Join(t.TempDir(), "stable-reopen-diagnostic.txt")
	if err := os.WriteFile(path, []byte("stable reopen diagnostic"), 0600); err != nil {
		t.Fatal(err)
	}
	file, err := OpenMutation(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	original := windows.Handle(file.Fd())
	expected, err := inspectStableRead(original)
	if err != nil {
		t.Fatal("ordinary inspect failed", err)
	}
	t.Logf("ordinary: volume=%016x fileIDZero=%t creation=%d slotSHA256=%s", expected.ID.Volume, expected.ID.ID == [16]byte{}, expected.Basic.Creation, Digest([]byte(expected.Slot)))
	for _, flags := range []uint32{0, 1, 8, 9} {
		n, digest, pathErr := finalPathEvidence(original, flags)
		t.Logf("ordinary.finalPath flags=%d length=%d slotSHA256=%s win32=%d failed=%t", flags, n, digest, win32Code(pathErr), pathErr != nil)
	}
	var h windows.Handle
	defer func() {
		if h != 0 {
			if err := windows.CloseHandle(h); err != nil {
				t.Error(err)
			}
		}
	}()
	err = Privileged(context.Background(), []string{"SeSecurityPrivilege", "SeBackupPrivilege"}, func() error {
		var reopenErr error
		h, reopenErr = Reopen(original, windows.GENERIC_READ|windows.READ_CONTROL|windows.ACCESS_SYSTEM_SECURITY|windows.FILE_WRITE_ATTRIBUTES)
		if reopenErr != nil {
			t.Logf("isolated.ReOpen win32=%d failed=true", win32Code(reopenErr))
			return reopenErr
		}
		t.Log("isolated.ReOpen succeeded=true retainedUntilCallerSlotCheck=true")
		for _, flags := range []uint32{0, 1, 8, 9} {
			n, digest, pathErr := finalPathEvidence(h, flags)
			t.Logf("isolated.finalPath flags=%d length=%d slotSHA256=%s win32=%d failed=%t", flags, n, digest, win32Code(pathErr), pathErr != nil)
		}
		state, inspectErr := inspectStableRead(h)
		if inspectErr != nil {
			t.Logf("isolated.inspect failed=true detail=%v", inspectErr)
			var id fileIDInformation
			idErr := windows.GetFileInformationByHandleEx(h, windows.FileIdInfo, (*byte)(unsafe.Pointer(&id)), uint32(unsafe.Sizeof(id)))
			var basic basicInformation
			basicErr := windows.GetFileInformationByHandleEx(h, windows.FileBasicInfo, (*byte)(unsafe.Pointer(&basic)), uint32(unsafe.Sizeof(basic)))
			t.Logf("isolated.raw FileIdInfo win32=%d failed=%t volumeZero=%t fileIDZero=%t; FileBasicInfo win32=%d failed=%t creation=%d", win32Code(idErr), idErr != nil, id.Volume == 0, id.ID == [16]byte{}, win32Code(basicErr), basicErr != nil, basic.Creation)
			return nil
		}
		t.Logf("isolated: volume=%016x fileIDZero=%t creation=%d slotSHA256=%s equalOriginal=%t", state.ID.Volume, state.ID.ID == [16]byte{}, state.Basic.Creation, Digest([]byte(state.Slot)), state == expected)
		if state != expected {
			return fmt.Errorf("isolated stable identity differs")
		}
		return nil
	})
	if err != nil {
		t.Logf("isolated privileged diagnostic returned win32=%d failed=true", win32Code(err))
	}
	if h != 0 {
		for _, flags := range []uint32{0, 1, 8, 9} {
			n, digest, pathErr := finalPathEvidence(h, flags)
			t.Logf("postScope.sameHandle.finalPath flags=%d length=%d slotSHA256=%s win32=%d failed=%t", flags, n, digest, win32Code(pathErr), pathErr != nil)
		}
		finalErr := verifyStableReadCompletion(original, h, expected)
		t.Logf("postScope.sameHandle.strictOriginalTupleAndCanonicalSlotEqual=%t", finalErr == nil)
		if finalErr != nil {
			t.Logf("postScope.failure: %v", finalErr)
		}
	}
}

func TestNativeWindowsStableReadPostScopeBinding(t *testing.T) {
	requirePreparedScratch(t)
	for _, moved := range []bool{false, true} {
		t.Run(map[bool]string{false: "unchanged", true: "renamed-same-file-id"}[moved], func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "post-scope.txt")
			if err := os.WriteFile(path, []byte("same-object"), 0600); err != nil {
				t.Fatal(err)
			}
			file, err := OpenMutation(path)
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			original := windows.Handle(file.Fd())
			expected, err := stabilizeOrdinaryRead(original)
			if err != nil {
				t.Fatal(err)
			}
			var h windows.Handle
			defer func() {
				if h != 0 {
					if err := windows.CloseHandle(h); err != nil {
						t.Error(err)
					}
				}
			}()
			if err := Privileged(context.Background(), []string{"SeSecurityPrivilege", "SeBackupPrivilege"}, func() error {
				var err error
				h, err = reopenStableRead(original, windows.GENERIC_READ|windows.READ_CONTROL|windows.ACCESS_SYSTEM_SECURITY, expected)
				return err
			}); err != nil {
				t.Fatal(err)
			}
			if moved {
				if err := os.Rename(path, filepath.Join(filepath.Dir(path), "moved.txt")); err != nil {
					t.Fatal(err)
				}
			}
			finalErr := verifyStableReadCompletion(original, h, expected)
			if moved {
				current, err := inspectStableRead(original)
				if err != nil {
					t.Fatal("ordinary current canonical unavailable", err)
				}
				derived, err := inspectStableReadObject(h)
				if err != nil {
					t.Fatal("derived physical tuple unavailable", err)
				}
				if current.ID != expected.ID || current.Basic.Creation != expected.Basic.Creation || current.Slot == expected.Slot || current.DOSSlot == expected.DOSSlot || derived != current.stableReadObjectState {
					t.Fatal("fixture did not retain both same physical handles while changing actual ordinary canonical slots")
				}
				if finalErr == nil {
					t.Fatal("same FILE_ID_128 at changed canonical slot accepted")
				}
			} else if finalErr != nil {
				t.Fatal("same retained security handle failed complete post-scope verification", finalErr)
			}
		})
	}
}
