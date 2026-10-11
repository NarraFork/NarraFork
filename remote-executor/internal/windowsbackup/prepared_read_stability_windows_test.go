//go:build windows

package windowsbackup

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func preparedReadBasic(t *testing.T, f *os.File) basicInformation {
	t.Helper()
	var b basicInformation
	if err := windows.GetFileInformationByHandleEx(windows.Handle(f.Fd()), windows.FileBasicInfo, (*byte)(unsafe.Pointer(&b)), uint32(unsafe.Sizeof(b))); err != nil {
		t.Fatal(err)
	}
	return b
}

// Countertest for v3: no warm-up capture/read or retrospective timestamp write.
// Baseline is the original metadata before the FIRST Capture or main-stream IO.
// The original full matrix including LastAccess must survive every actual read.
func TestNativeWindowsPreparedReadStability(t *testing.T) {
	requirePreparedScratch(t)
	for _, ads := range []bool{false, true} {
		t.Run(map[bool]string{false: "main", true: "ads"}[ads], func(t *testing.T) {
			ctx := nativeFixtureContext(t)
			path := filepath.Join(t.TempDir(), "unread-original.txt")
			if err := os.WriteFile(path, []byte("first-read-must-not-change-historical-access"), 0600); err != nil {
				t.Fatal(err)
			}
			if ads {
				if err := os.WriteFile(path+":Zone.Identifier", []byte("[ZoneTransfer]\r\nZoneId=3\r\n"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			metadataOnly, err := openOrdinary(path, windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL)
			if err != nil {
				t.Fatal(err)
			}
			defer metadataOnly.Close()
			baseline := preparedReadBasic(t, metadataOnly)
			f, err := OpenMutation(path)
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			if actual := preparedReadBasic(t, f); actual != baseline {
				t.Fatal("stable ordinary open changed pre-read historical basic metadata")
			}
			initial, err := Capture(ctx, f)
			if err != nil {
				t.Fatal(err)
			}
			if initial.Creation != uint64(baseline.Creation) || initial.LastAccess != uint64(baseline.Access) || initial.LastWrite != uint64(baseline.Write) || initial.Attributes != baseline.Attributes {
				t.Fatal("first capture replaced original basic metadata")
			}
			for i := 0; i < 3; i++ {
				if _, err := io.Copy(io.Discard, io.NewSectionReader(f, 0, 4096)); err != nil {
					t.Fatal(err)
				}
				current, err := Capture(ctx, f)
				if err != nil {
					t.Fatal(err)
				}
				beforeHash, err := SnapshotFingerprint(initial)
				if err != nil {
					t.Fatal(err)
				}
				afterHash, err := SnapshotFingerprint(current)
				if err != nil {
					t.Fatal(err)
				}
				after := preparedReadBasic(t, f)
				if baseline != after || beforeHash != afterHash || initial.ReadAccessAfter != uint64(baseline.Access) || current.ReadAccessAfter != uint64(baseline.Access) {
					for _, line := range redactedSnapshotDiagnostic(initial, current) {
						t.Log(line)
					}
					t.Fatalf("read round=%d changed original matrix/basic metadata: access original=%d actual=%d", i, baseline.Access, after.Access)
				}
				t.Logf("stable round=%d LastAccess=%d fullMatrixSHA256=%s originalNativeBasicEqual=true", i, baseline.Access, afterHash)
			}
		})
	}
}

func TestNativeWindowsPreparedReadStabilizationRequiresOrdinaryRights(t *testing.T) {
	requirePreparedScratch(t)
	path := filepath.Join(t.TempDir(), "rights.txt")
	if err := os.WriteFile(path, []byte("must-remain-unread-on-denial"), 0600); err != nil {
		t.Fatal(err)
	}
	readOnly, err := openOrdinary(path, windows.GENERIC_READ|windows.READ_CONTROL)
	if err != nil {
		t.Fatal(err)
	}
	defer readOnly.Close()
	before := preparedReadBasic(t, readOnly)
	processPrivileges := nativeTokenPrivileges(t)
	// Direct access-limited handle must not be silently reopened under a
	// privileged token or fall back to an unstabilized read.
	if err := preserveReadAccess(windows.Handle(readOnly.Fd())); err == nil {
		t.Fatal("read-only handle silently acquired FILE_WRITE_ATTRIBUTES")
	}
	if before != preparedReadBasic(t, readOnly) {
		t.Fatal("denied suppression changed original timestamps")
	}
	if !bytes.Equal(processPrivileges, nativeTokenPrivileges(t)) {
		t.Fatal("suppression changed process privileges")
	}
	// Suppression itself sets only a handle policy, not a timestamp value.
	ordinary, err := openOrdinary(path, windows.GENERIC_READ|windows.FILE_WRITE_ATTRIBUTES)
	if err != nil {
		t.Fatal(err)
	}
	defer ordinary.Close()
	baseline := preparedReadBasic(t, ordinary)
	if err := preserveReadAccess(windows.Handle(ordinary.Fd())); err != nil {
		t.Fatal(err)
	}
	if after := preparedReadBasic(t, ordinary); after != baseline {
		t.Fatal("suppression wrote a real timestamp/basic value")
	}
	if !bytes.Equal(processPrivileges, nativeTokenPrivileges(t)) {
		t.Fatal("ordinary suppression acquired process privileges")
	}
}

func TestNativeWindowsPreparedReadDenyACLDoesNotBorrowHelperAuthority(t *testing.T) {
	requirePreparedScratch(t)
	ctx := nativeFixtureContext(t)
	path := filepath.Join(t.TempDir(), "deny-write-attributes.txt")
	if err := os.WriteFile(path, []byte("private-readable-not-write-attributes"), 0600); err != nil {
		t.Fatal(err)
	}
	setup, err := openOrdinary(path, windows.READ_CONTROL|windows.WRITE_DAC)
	if err != nil {
		t.Fatal(err)
	}
	defer setup.Close()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	// Explicit deny to Everyone includes the test's SYSTEM token. Only the
	// private test object is changed, by an already authorized WRITE_DAC handle.
	sd, err := windows.SecurityDescriptorFromString("D:P(D;;0x100;;;WD)(A;;FA;;;" + user.User.Sid.String() + ")")
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetSecurityInfo(windows.Handle(setup.Fd()), windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		t.Fatal(err)
	}
	readOnly, err := openOrdinary(path, windows.GENERIC_READ|windows.READ_CONTROL)
	if err != nil {
		t.Fatal("fixture must remain ordinarily readable", err)
	}
	defer readOnly.Close()
	var duplicated windows.Handle
	if err := windows.DuplicateHandle(windows.CurrentProcess(), windows.Handle(readOnly.Fd()), windows.CurrentProcess(), &duplicated, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
		t.Fatal(err)
	}
	duplicate := os.NewFile(uintptr(duplicated), path)
	defer duplicate.Close()
	baseline := preparedReadBasic(t, duplicate)
	privileges := nativeTokenPrivileges(t)
	if f, err := OpenObservation(path); err == nil {
		f.Close()
		t.Fatal("ordinary observation ignored FILE_WRITE_ATTRIBUTES deny")
	} else if !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Fatal("unexpected ordinary rights refusal", err)
	}
	if snapshot, err := Capture(ctx, duplicate); err == nil || snapshot != nil || !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Fatal("duplicate readonly handle borrowed helper authority", err)
	}
	if after := preparedReadBasic(t, duplicate); after != baseline {
		t.Fatal("refused capture read or changed original metadata")
	}
	if !bytes.Equal(privileges, nativeTokenPrivileges(t)) {
		t.Fatal("refused capture changed process privileges")
	}
	t.Log("ordinary WriteAttributes denial and DUPLICATE_SAME_ACCESS denial retained; no snapshot issued; original basic metadata and process privileges unchanged")
}
