//go:build windows

package windowsbackup

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

// Diagnostic-only A/B matrix. It changes no production access policy and does
// not issue a snapshot/proof/restore. Each handle is the same native object
// obtained from the original ordinary handle; no pathname is reopened.
func TestNativeWindowsStableReadReopenRightsABDiagnostics(t *testing.T) {
	requirePreparedScratch(t)
	path := filepath.Join(t.TempDir(), "rights-ab.txt")
	if err := os.WriteFile(path, []byte("rights matrix fixture"), 0600); err != nil {
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
		t.Fatal(err)
	}
	sdkGrantedAccessEvidence(t, "ordinary.reference", original)
	sdkPathEvidence(t, "ordinary.reference", original)
	base := uint32(windows.GENERIC_READ | windows.READ_CONTROL | windows.FILE_WRITE_ATTRIBUTES)
	variants := []struct {
		name   string
		access uint32
	}{
		{"read-control-writeattr", base},
		{"read-control-writeattr-delete", base | windows.DELETE},
		{"read-control-writeattr-systemsecurity", base | windows.ACCESS_SYSTEM_SECURITY},
		{"read-control-writeattr-delete-systemsecurity", base | windows.DELETE | windows.ACCESS_SYSTEM_SECURITY},
	}
	if err := Privileged(context.Background(), []string{"SeSecurityPrivilege", "SeBackupPrivilege"}, func() error {
		for _, variant := range variants {
			h, reopenErr := Reopen(original, variant.access)
			if reopenErr != nil {
				t.Logf("AB.%s reopen success=false win32=%d access=0x%08x", variant.name, win32Code(reopenErr), variant.access)
				continue
			}
			t.Logf("AB.%s reopen success=true access=0x%08x", variant.name, variant.access)
			func() {
				defer windows.CloseHandle(h)
				sdkGrantedAccessEvidence(t, "AB."+variant.name, h)
				state, stateErr := inspectStableReadObject(h)
				t.Logf("AB.%s object success=%t win32=%d idBasicEqual=%t", variant.name, stateErr == nil, win32Code(stateErr), stateErr == nil && state == expected.stableReadObjectState)
				if stateErr != nil {
					return
				}
				if err := preserveReadAccess(h); err != nil {
					t.Logf("AB.%s sentinel success=false win32=%d", variant.name, win32Code(err))
					return
				}
				t.Logf("AB.%s sentinel success=true", variant.name)
				sdkPathEvidence(t, "AB."+variant.name, h)
				finalPathErr := verifyStableReadCompletion(original, h, expected)
				t.Logf("AB.%s strictCanonicalSlotAndIDBasicEqual=%t failure=%v", variant.name, finalPathErr == nil, finalPathErr)
			}()
		}
		return nil
	}); err != nil {
		t.Logf("AB privileged scope returned win32=%d", win32Code(err))
	}
}
