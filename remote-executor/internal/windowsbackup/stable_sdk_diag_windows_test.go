//go:build windows

package windowsbackup

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// TEST ONLY: public SDK ObjectBasicInformation layout, not an inferred access
// mask. https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntqueryobject
// Bounded fixed buffer. No enumeration, token modification, data read or ACL IO.
type sdkObjectBasicInformation struct {
	Attributes    uint32
	GrantedAccess uint32
	HandleCount   uint32
	PointerCount  uint32
	Reserved      [10]uint32
}

func sdkGrantedAccessEvidence(t *testing.T, phase string, handle windows.Handle) {
	t.Helper()
	query := windows.NewLazySystemDLL("ntdll.dll").NewProc("NtQueryObject")
	convert := windows.NewLazySystemDLL("ntdll.dll").NewProc("RtlNtStatusToDosError")
	if err := query.Find(); err != nil {
		t.Logf("SDK.%s.GrantedAccess queryAvailable=false win32=%d", phase, win32Code(err))
		return
	}
	if err := convert.Find(); err != nil {
		t.Logf("SDK.%s.GrantedAccess statusConverterAvailable=false win32=%d", phase, win32Code(err))
		return
	}
	var info sdkObjectBasicInformation
	var length uint32
	status, _, _ := query.Call(uintptr(handle), 0, uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info), uintptr(unsafe.Pointer(&length)))
	errno, _, _ := convert.Call(status)
	if uint32(status) != 0 {
		t.Logf("SDK.%s.GrantedAccess success=false ntstatus=0x%08x win32=%d returnedLength=%d", phase, uint32(status), uint32(errno), length)
		return
	}
	t.Logf("SDK.%s.GrantedAccess success=true ntstatus=0x%08x win32=%d returnedLength=%d mask=0x%08x", phase, uint32(status), uint32(errno), length, info.GrantedAccess)
}

func sdkPathEvidence(t *testing.T, phase string, handle windows.Handle) {
	t.Helper()
	digests := map[uint32]string{}
	for _, flags := range []uint32{0, 1, 8, 9} {
		n, digest, err := finalPathEvidence(handle, flags)
		t.Logf("SDK.%s.finalPath flags=%d success=%t win32=%d length=%d nameSHA256=%s", phase, flags, err == nil && n > 0, win32Code(err), n, digest)
		if err == nil && n > 0 && digest != "unavailable" {
			digests[flags] = digest
		}
	}
	t.Logf("SDK.%s.normalizedVsOpened normalizedDOSAvailable=%t normalizedGUIDAvailable=%t DOSHashesEqual=%t GUIDHashesEqual=%t", phase, digests[0] != "", digests[1] != "", digests[0] != "" && digests[0] == digests[8], digests[1] != "" && digests[1] == digests[9])
}

func sdkBasicEvidence(t *testing.T, phase string, handle windows.Handle, initial stableReadObjectState) (stableReadObjectState, error) {
	t.Helper()
	state, err := inspectStableReadObject(handle)
	if err != nil {
		t.Logf("SDK.%s.object success=false win32=%d", phase, win32Code(err))
		return state, err
	}
	a, b := initial.Basic, state.Basic
	t.Logf("SDK.%s.object success=true volumeEqual=%t volume=%016x fileID128Equal=%t fileID128=%x allBasicEqual=%t", phase, initial.ID.Volume == state.ID.Volume, state.ID.Volume, initial.ID.ID == state.ID.ID, state.ID.ID, a == b)
	t.Logf("SDK.%s.Creation equal=%t initial=%d actual=%d", phase, a.Creation == b.Creation, a.Creation, b.Creation)
	t.Logf("SDK.%s.LastAccess equal=%t initial=%d actual=%d", phase, a.Access == b.Access, a.Access, b.Access)
	t.Logf("SDK.%s.LastWrite equal=%t initial=%d actual=%d", phase, a.Write == b.Write, a.Write, b.Write)
	t.Logf("SDK.%s.ChangeTime equal=%t initial=%d actual=%d", phase, a.Change == b.Change, a.Change, b.Change)
	t.Logf("SDK.%s.Attributes equal=%t initial=0x%08x actual=0x%08x", phase, a.Attributes == b.Attributes, a.Attributes, b.Attributes)
	return state, nil
}

// Diagnostic exit success means evidence was collected, NOT canonical-read,
// restore or helper readiness. All queries use the SAME two live native handles.
func TestNativeWindowsStableReadGrantedAccessAndRenameDiagnostics(t *testing.T) {
	requirePreparedScratch(t)
	t.Log("DIAGNOSTIC_ONLY: no snapshot/proof/restore is issued")
	path := filepath.Join(t.TempDir(), "sdk-access-name.txt")
	if err := os.WriteFile(path, []byte("unread scratch fixture"), 0600); err != nil {
		t.Fatalf("fixture create failed win32=%d", win32Code(err))
	}
	originalFile, err := OpenMutation(path)
	if err != nil {
		t.Fatalf("fixture ordinary open failed win32=%d", win32Code(err))
	}
	defer originalFile.Close()
	original := windows.Handle(originalFile.Fd())
	expected, err := inspectStableRead(original)
	if err != nil {
		t.Fatalf("ordinary initial native state failed win32=%d", win32Code(err))
	}
	sdkGrantedAccessEvidence(t, "ordinary.beforeScope", original)
	sdkPathEvidence(t, "ordinary.beforeScope", original)
	var h windows.Handle
	defer func() {
		if h != 0 {
			if err := windows.CloseHandle(h); err != nil {
				t.Errorf("diagnostic close failed win32=%d", win32Code(err))
			}
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err = Privileged(ctx, []string{"SeSecurityPrivilege", "SeBackupPrivilege"}, func() error {
		var err error
		h, err = reopenStableRead(original, windows.GENERIC_READ|windows.READ_CONTROL|windows.ACCESS_SYSTEM_SECURITY, expected)
		if err != nil {
			return err
		}
		sdkGrantedAccessEvidence(t, "ordinary.inScope", original)
		sdkGrantedAccessEvidence(t, "security.inScope", h)
		sdkPathEvidence(t, "ordinary.inScope", original)
		sdkPathEvidence(t, "security.inScope", h)
		return nil
	})
	if err != nil {
		t.Logf("SDK.scope failed=true win32=%d", win32Code(err))
		return
	}
	for _, item := range []struct {
		label  string
		handle windows.Handle
	}{{"ordinary.beforeRename", original}, {"security.beforeRename", h}} {
		sdkGrantedAccessEvidence(t, item.label, item.handle)
		sdkPathEvidence(t, item.label, item.handle)
	}
	if err := os.Rename(path, filepath.Join(filepath.Dir(path), "renamed-sdk-access-name.txt")); err != nil {
		t.Fatalf("fixture rename failed win32=%d", win32Code(err))
	}
	for _, item := range []struct {
		label  string
		handle windows.Handle
	}{{"ordinary.afterRename", original}, {"security.afterRename", h}} {
		sdkGrantedAccessEvidence(t, item.label, item.handle)
		sdkPathEvidence(t, item.label, item.handle)
		if _, err := sdkBasicEvidence(t, item.label, item.handle, expected.stableReadObjectState); err != nil {
			t.Fatalf("post-rename native object query failed win32=%d", win32Code(err))
		}
	}
}

// One actual SDK pass on each fresh, never-read main/ADS fixture, following the
// native Capture's current helpers and unchanged readBackup. This records exact
// stage boundaries without instrumenting, relaxing, retrying or replacing the
// production Capture. No historical timestamp is written or refreshed.
func TestNativeWindowsStableReadBackupStageDiagnostics(t *testing.T) {
	requirePreparedScratch(t)
	for _, ads := range []bool{false, true} {
		t.Run(map[bool]string{false: "main", true: "ads"}[ads], func(t *testing.T) {
			t.Log("DIAGNOSTIC_ONLY: first SDK capture pass; no snapshot/proof/restore is issued")
			ctx, cancel := context.WithTimeout(nativeFixtureContext(t), 10*time.Second)
			defer cancel()
			path := filepath.Join(t.TempDir(), "sdk-first-backup.txt")
			if err := os.WriteFile(path, []byte("unread ordinary main stream"), 0600); err != nil {
				t.Fatalf("fixture create failed win32=%d", win32Code(err))
			}
			if ads {
				if err := os.WriteFile(path+":Zone.Identifier", []byte("[ZoneTransfer]\r\nZoneId=3\r\n"), 0600); err != nil {
					t.Fatalf("fixture ADS creation failed win32=%d", win32Code(err))
				}
			}
			file, err := openOrdinary(path, windows.GENERIC_READ|windows.READ_CONTROL|windows.DELETE|windows.FILE_WRITE_ATTRIBUTES)
			if err != nil {
				t.Fatalf("ordinary raw open failed win32=%d", win32Code(err))
			}
			defer file.Close()
			original := windows.Handle(file.Fd())
			initial, err := inspectStableReadObject(original)
			if err != nil {
				t.Fatalf("initial ordinary object failed win32=%d", win32Code(err))
			}
			sdkBasicEvidence(t, "ordinary.beforeFirstSentinel", original, initial)
			sdkGrantedAccessEvidence(t, "ordinary.beforeFirstSentinel", original)
			err = preserveReadAccess(original)
			t.Logf("SDK.ordinary.openSentinel success=%t win32=%d", err == nil, win32Code(err))
			if err != nil {
				return
			}
			sdkBasicEvidence(t, "ordinary.afterFirstSentinel", original, initial)
			ordinaryState, err := stabilizeOrdinaryRead(original)
			t.Logf("SDK.ordinary.capturePreflightSentinel success=%t win32=%d", err == nil, win32Code(err))
			if err != nil {
				return
			}
			sdkBasicEvidence(t, "ordinary.captureInitialState", original, initial)
			t.Logf("SDK.ordinary.captureInitialState.equalsInitialObject=%t", ordinaryState.stableReadObjectState == initial)
			var h windows.Handle
			defer func() {
				if h != 0 {
					if err := windows.CloseHandle(h); err != nil {
						t.Errorf("diagnostic security close failed win32=%d", win32Code(err))
					}
				}
			}()
			err = Privileged(ctx, []string{"SeSecurityPrivilege", "SeBackupPrivilege"}, func() error {
				sdkBasicEvidence(t, "ordinary.beforeSecurityReopen", original, initial)
				var err error
				h, err = Reopen(original, windows.GENERIC_READ|windows.READ_CONTROL|windows.ACCESS_SYSTEM_SECURITY|windows.FILE_WRITE_ATTRIBUTES)
				t.Logf("SDK.security.reopen success=%t win32=%d", err == nil, win32Code(err))
				if err != nil {
					return err
				}
				sdkGrantedAccessEvidence(t, "security.afterReopen", h)
				before, err := sdkBasicEvidence(t, "security.beforeSentinel", h, initial)
				if err != nil {
					return err
				}
				if before != initial {
					return fmt.Errorf("SDK identity/basic already changed before security sentinel")
				}
				err = preserveReadAccess(h)
				t.Logf("SDK.security.readSentinel success=%t win32=%d", err == nil, win32Code(err))
				if err != nil {
					return err
				}
				sdkBasicEvidence(t, "security.afterSentinel", h, initial)
				sdkBasicEvidence(t, "ordinary.afterSecuritySentinel", original, initial)
				if _, err := validateOrdinary(h); err != nil {
					return err
				}
				_, err = windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, securityMask)
				t.Logf("SDK.security.fullSecurityRead success=%t win32=%d", err == nil, win32Code(err))
				if err != nil {
					return err
				}
				sdkBasicEvidence(t, "ordinary.beforeBackupRead", original, initial)
				sdkBasicEvidence(t, "security.beforeBackupRead", h, initial)
				snapshot := &Snapshot{Streams: []Stream{}}
				readErr := readBackup(ctx, h, snapshot)
				t.Logf("SDK.BackupRead success=%t win32=%d", readErr == nil, win32Code(readErr))
				sdkBasicEvidence(t, "ordinary.afterBackupRead", original, initial)
				sdkBasicEvidence(t, "security.afterBackupRead", h, initial)
				streamManifest, _ := json.Marshal(snapshot.Streams)
				t.Logf("SDK.BackupRead.result EABytes=%d EASHA256=%s ADSCount=%d streamManifestSHA256=%s", len(snapshot.EA), Digest(snapshot.EA), len(snapshot.Streams), Digest(streamManifest))
				return readErr
			})
			t.Logf("SDK.captureScope completed=%t win32=%d", err == nil, win32Code(err))
			sdkBasicEvidence(t, "ordinary.postScope", original, initial)
			sdkPathEvidence(t, "ordinary.postScope", original)
			if h != 0 {
				sdkBasicEvidence(t, "security.postScope", h, initial)
				sdkPathEvidence(t, "security.postScope", h)
			}
		})
	}
}
