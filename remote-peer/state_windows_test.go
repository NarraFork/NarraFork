//go:build windows

package remotepeer

import (
	"golang.org/x/sys/windows"
	"path/filepath"
	"testing"
)

func TestWindowsStateRejectsBroadDACLOnSameFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private", "state.json")
	store, err := OpenRuntimeStore(path, true)
	if err != nil {
		t.Fatal(err)
	}
	identity := PublicHex(&store.key.PublicKey)
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = OpenRuntimeStore(path, true)
	if err != nil {
		t.Fatal("same protected file reopen", err)
	}
	if PublicHex(&store.key.PublicKey) != identity {
		t.Fatal("identity replaced")
	}
	_ = store.Close()
	broad, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := broad.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err = windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
		t.Fatal(err)
	}
	if again, err := OpenRuntimeStore(path, true); err == nil {
		_ = again.Close()
		t.Fatal("Everyone DACL accepted")
	}
}
