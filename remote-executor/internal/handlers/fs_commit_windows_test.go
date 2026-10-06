//go:build windows

package handlers

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func windowsReplacementFixture(t *testing.T) (string, string, os.FileInfo, conditionalMetadata) {
	t.Helper()
	target := filepath.Join(t.TempDir(), "target.txt")
	if err := os.WriteFile(target, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	return windowsPreparedReplacement(t, target)
}

func windowsPreparedReplacement(t *testing.T, target string) (string, string, os.FileInfo, conditionalMetadata) {
	t.Helper()
	f, err := os.Open(target)
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := captureConditionalMetadata(f)
	if err != nil {
		f.Close()
		t.Fatal(err)
	}
	info, err := f.Stat()
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(target), ".nf-test-*")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tmp.Write([]byte("next")); err != nil {
		t.Fatal(err)
	}
	if err := metadata.apply(tmp); err != nil {
		tmp.Close()
		t.Fatal(err)
	}
	name := tmp.Name()
	tmpInfo, err := tmp.Stat()
	if err != nil {
		tmp.Close()
		t.Fatal(err)
	}
	if err := tmp.Close(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = removeConditionalTemporary(name, tmpInfo) }) // Mirrors the shared defer.
	return target, name, info, metadata
}

func testSetWindowsDACL(t *testing.T, path, sddl string, protected bool) {
	t.Helper()
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		t.Fatal(err)
	}
	acl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	f, err := openConditionalWindowsFile(path, windows.WRITE_DAC|windows.READ_CONTROL)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	mask := windows.SECURITY_INFORMATION(windows.DACL_SECURITY_INFORMATION | windows.UNPROTECTED_DACL_SECURITY_INFORMATION)
	if protected {
		mask = windows.DACL_SECURITY_INFORMATION | windows.PROTECTED_DACL_SECURITY_INFORMATION
	}
	if err := windows.SetSecurityInfo(windows.Handle(f.Fd()), windows.SE_FILE_OBJECT, mask, nil, nil, acl, nil); err != nil {
		t.Fatal(err)
	}
}

func testWindowsUserSID(t *testing.T) string {
	t.Helper()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	return user.User.Sid.String()
}

func TestWindowsConditionalNativeReplacement(t *testing.T) {
	for _, kind := range []string{"ordinary", "custom", "protected", "inherited", "label"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			sid := testWindowsUserSID(t)
			if kind == "inherited" {
				testSetWindowsDACL(t, dir, "D:P(A;OICI;FA;;;"+sid+")(A;OICI;FR;;;WD)", true)
			}
			target := filepath.Join(dir, "target.txt")
			if err := os.WriteFile(target, []byte("original"), 0600); err != nil {
				t.Fatal(err)
			}
			if kind == "custom" || kind == "protected" {
				testSetWindowsDACL(t, target, "D:(A;;FA;;;"+sid+")(A;;FR;;;WD)", kind == "protected")
			}
			if kind == "label" {
				sd, err := windows.SecurityDescriptorFromString("S:(ML;;NW;;;LW)")
				if err != nil {
					t.Fatal(err)
				}
				acl, _, err := sd.SACL()
				if err != nil {
					t.Fatal(err)
				}
				f, err := openConditionalWindowsFile(target, windows.WRITE_OWNER)
				if err != nil {
					t.Fatal(err)
				}
				err = windows.SetSecurityInfo(windows.Handle(f.Fd()), windows.SE_FILE_OBJECT, windows.LABEL_SECURITY_INFORMATION, nil, nil, nil, acl)
				f.Close()
				if err != nil {
					t.Fatal(err)
				}
			}
			target, tmp, originalInfo, metadata := windowsPreparedReplacement(t, target)
			if err := commitConditionalReplacement(context.Background(), target, tmp, originalInfo, metadata, []byte("next")); err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(target)
			if err != nil || string(got) != "next" {
				t.Fatalf("content %q, %v", got, err)
			}
			f, err := os.Open(target)
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			if err := metadata.matches(f); err != nil {
				t.Fatal(err)
			}
			info, err := f.Stat()
			if err != nil || os.SameFile(originalInfo, info) {
				t.Fatalf("replacement must have new identity: %v", err)
			}
			backups, err := filepath.Glob(filepath.Join(dir, ".nf-transaction-*"))
			if err != nil || len(backups) != 0 {
				t.Fatalf("backup leak: %v, %v", backups, err)
			}
		})
	}
}

func TestWindowsConditionalMetadataConflict(t *testing.T) {
	target, tmp, info, metadata := windowsReplacementFixture(t)
	testSetWindowsDACL(t, target, "D:P(A;;FA;;;"+testWindowsUserSID(t)+")", true)
	err := commitConditionalReplacement(context.Background(), target, tmp, info, metadata, []byte("next"))
	if !errors.Is(err, errConditionalMetadataChanged) {
		t.Fatalf("expected metadata conflict, got %v", err)
	}
	got, _ := os.ReadFile(target)
	if string(got) != "original" {
		t.Fatal("conflict changed original")
	}
}

func TestWindowsConditionalPartialNativeFailure(t *testing.T) {
	for _, code := range []windows.Errno{1175, 1176, 1177} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			target, tmp, info, metadata := windowsReplacementFixture(t)
			native := conditionalReplaceFile
			conditionalReplaceFile = func(target, replacement, backup string) error {
				if code == 1177 {
					if err := windows.MoveFileEx(mustWindowsPath(t, target), mustWindowsPath(t, backup), 0); err != nil {
						t.Fatal(err)
					}
				}
				return code
			}
			t.Cleanup(func() { conditionalReplaceFile = native })
			err := commitConditionalReplacement(context.Background(), target, tmp, info, metadata, []byte("next"))
			if err == nil {
				t.Fatal("partial native error silently succeeded")
			}
			got, e := os.ReadFile(target)
			if e != nil || string(got) != "original" {
				t.Fatalf("original not restored: %q, %v (%v)", got, e, err)
			}
			if !conditionalFileIdentity(target, info) {
				t.Fatal("original identity lost")
			}
		})
	}
}

func mustWindowsPath(t *testing.T, path string) *uint16 {
	t.Helper()
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestWindowsConditionalVerificationRollbackAndCancellation(t *testing.T) {
	target, tmp, info, metadata := windowsReplacementFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	native := conditionalReplaceFile
	conditionalReplaceFile = func(target, replacement, backup string) error {
		if err := native(target, replacement, backup); err != nil {
			return err
		}
		cancel() // Cancellation after native mutation must not skip compensation.
		return os.WriteFile(target, []byte("corrupt"), 0600)
	}
	t.Cleanup(func() { conditionalReplaceFile = native })
	err := commitConditionalReplacement(ctx, target, tmp, info, metadata, []byte("next"))
	if err == nil || !strings.Contains(err.Error(), "restored") {
		t.Fatalf("expected rollback: %v", err)
	}
	got, e := os.ReadFile(target)
	if e != nil || string(got) != "original" {
		t.Fatalf("original lost: %q %v", got, e)
	}
	recovered, _ := filepath.Glob(filepath.Join(filepath.Dir(target), ".nf-transaction-*", "replacement"))
	if len(recovered) != 1 {
		t.Fatalf("corrupt replacement recovery not retained: %v", recovered)
	}
}

func TestWindowsConditionalRecoveryFailureRetainsBackup(t *testing.T) {
	target, tmp, info, metadata := windowsReplacementFixture(t)
	native, rename := conditionalReplaceFile, conditionalRenameHandle
	var backup string
	conditionalReplaceFile = func(target, replacement, originalBackup string) error {
		backup = originalBackup
		if err := native(target, replacement, originalBackup); err != nil {
			return err
		}
		return os.WriteFile(target, []byte("corrupt"), 0600)
	}
	conditionalRenameHandle = func(*os.File, string) error { return windows.ERROR_ACCESS_DENIED }
	t.Cleanup(func() { conditionalReplaceFile, conditionalRenameHandle = native, rename })
	err := commitConditionalReplacement(context.Background(), target, tmp, info, metadata, []byte("next"))
	if err == nil || !strings.Contains(err.Error(), backup) {
		t.Fatalf("recovery error must identify backup: %v", err)
	}
	got, e := os.ReadFile(backup)
	if e != nil || string(got) != "original" {
		t.Fatalf("backup lost: %q %v", got, e)
	}
	if !conditionalFileIdentity(backup, info) {
		t.Fatal("backup is not original object")
	}
}

func TestWindowsConditionalUnknownExternalTargetNotOverwritten(t *testing.T) {
	target, tmp, info, metadata := windowsReplacementFixture(t)
	native := conditionalReplaceFile
	var backup string
	conditionalReplaceFile = func(target, replacement, originalBackup string) error {
		backup = originalBackup
		if err := windows.MoveFileEx(mustWindowsPath(t, target), mustWindowsPath(t, backup), 0); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, []byte("external"), 0600); err != nil {
			t.Fatal(err)
		}
		return windows.Errno(1177)
	}
	t.Cleanup(func() { conditionalReplaceFile = native })
	err := commitConditionalReplacement(context.Background(), target, tmp, info, metadata, []byte("next"))
	if err == nil || !strings.Contains(err.Error(), "external") {
		t.Fatalf("expected uncertain external state: %v", err)
	}
	got, _ := os.ReadFile(target)
	if string(got) != "external" {
		t.Fatal("external target overwritten")
	}
	got, _ = os.ReadFile(backup)
	if string(got) != "original" {
		t.Fatal("original backup lost")
	}
}

func TestWindowsConditionalRestrictedTokenCustomDACL(t *testing.T) {
	// GitHub's Windows runners are elevated. Remove admin grants and every
	// privilege except traverse, then execute all file operations while locked
	// to the impersonating OS thread. This must not become an admin-only test.
	dir := t.TempDir()
	sid := testWindowsUserSID(t)
	testSetWindowsDACL(t, dir, "D:P(A;OICI;FA;;;"+sid+")", true)
	runtime.LockOSThread()
	var previous windows.Token
	err := windows.OpenThreadToken(windows.CurrentThread(), windows.TOKEN_QUERY|windows.TOKEN_IMPERSONATE, true, &previous)
	if err != nil && !errors.Is(err, windows.ERROR_NO_TOKEN) {
		runtime.UnlockOSThread()
		t.Fatal(err)
	}
	defer func() {
		var restoreErr error
		if previous != 0 {
			restoreErr = windows.SetThreadToken(nil, previous)
			previous.Close()
		} else {
			restoreErr = windows.RevertToSelf()
		}
		if restoreErr != nil {
			t.Errorf("cannot restore original thread token: %v", restoreErr)
			// Do not return an impersonating thread to the runtime pool. A
			// goroutine exiting while locked causes the OS thread to be retired.
			return
		}
		runtime.UnlockOSThread()
	}()
	var process windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_DUPLICATE|windows.TOKEN_QUERY, &process); err != nil {
		t.Fatal(err)
	}
	defer process.Close()
	admin, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		t.Fatal(err)
	}
	disable := windows.SIDAndAttributes{Sid: admin}
	var restricted windows.Token
	proc := windows.NewLazySystemDLL("advapi32.dll").NewProc("CreateRestrictedToken")
	ok, _, callErr := proc.Call(uintptr(process), 1 /* DISABLE_MAX_PRIVILEGE */, 1, uintptr(unsafe.Pointer(&disable)), 0, 0, 0, 0, uintptr(unsafe.Pointer(&restricted)))
	if ok == 0 {
		t.Fatalf("CreateRestrictedToken: %v", callErr)
	}
	defer restricted.Close()
	var impersonation windows.Token
	if err := windows.DuplicateTokenEx(restricted, windows.TOKEN_QUERY|windows.TOKEN_IMPERSONATE, nil, windows.SecurityImpersonation, windows.TokenImpersonation, &impersonation); err != nil {
		t.Fatal(err)
	}
	defer impersonation.Close()
	groups, err := impersonation.GetTokenGroups()
	if err != nil {
		t.Fatal(err)
	}
	for _, group := range groups.AllGroups() {
		if group.Sid.Equals(admin) && group.Attributes&windows.SE_GROUP_ENABLED != 0 {
			t.Fatal("administrator SID still enabled")
		}
	}
	var privileges [4096]byte
	var returned uint32
	if err := windows.GetTokenInformation(impersonation, windows.TokenPrivileges, &privileges[0], uint32(len(privileges)), &returned); err != nil {
		t.Fatal(err)
	}
	var traverse windows.LUID
	name, err := windows.UTF16PtrFromString("SeChangeNotifyPrivilege")
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.LookupPrivilegeValue(nil, name, &traverse); err != nil {
		t.Fatal(err)
	}
	for _, privilege := range (*windows.Tokenprivileges)(unsafe.Pointer(&privileges[0])).AllPrivileges() {
		if privilege.Attributes&windows.SE_PRIVILEGE_ENABLED != 0 && privilege.Luid != traverse {
			t.Fatal("restricted token retained an enabled privilege")
		}
	}
	if err := windows.SetThreadToken(nil, impersonation); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(dir, "ordinary.txt")
	if err := os.WriteFile(target, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	testSetWindowsDACL(t, target, "D:P(A;;FA;;;"+sid+")(A;;FR;;;WD)", true)
	target, tmp, info, metadata := windowsPreparedReplacement(t, target)
	if err := commitConditionalReplacement(context.Background(), target, tmp, info, metadata, []byte("next")); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(target)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := metadata.matches(f); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(target)
	if err != nil || string(got) != "next" {
		t.Fatalf("restricted token content: %q, %v", got, err)
	}
}

func TestWindowsConditionalRecoveryNamespaceIsProtectedAndPinned(t *testing.T) {
	target := filepath.Join(t.TempDir(), "target")
	name, dir, err := newWindowsRecoveryDirectory(target)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	sd, err := windows.GetSecurityInfo(windows.Handle(dir.Fd()), windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	control, _, err := sd.Control()
	if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
		t.Fatalf("unprotected namespace: %v", err)
	}
	if err := windows.MoveFileEx(mustWindowsPath(t, name), mustWindowsPath(t, name+".external"), 0); err == nil {
		t.Fatal("pinned recovery namespace could be renamed externally")
	}
	if err := disposeConditionalHandle(dir); err != nil {
		t.Fatal(err)
	}
	if err := dir.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(name); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("empty recovery namespace not removed: %v", err)
	}
}

func TestWindowsConditionalRecoveryNamespaceAccessBoundary(t *testing.T) {
	target := filepath.Join(t.TempDir(), "target")
	name, dir, err := newWindowsRecoveryDirectory(target)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	backup := filepath.Join(name, "original")
	// This is explicitly NOT same-user isolation. The owner's ordinary token
	// can preoccupy the backup name. Do not claim a protected DACL prevents it.
	if err := os.WriteFile(backup, []byte("owner can create"), 0600); err != nil {
		t.Fatal(err)
	}
	info := conditionalHandleInfo(t, backup)
	if err := removeConditionalTemporary(backup, info); err != nil {
		t.Fatal(err)
	}
	func() {
		runtime.LockOSThread()
		var previous windows.Token
		err := windows.OpenThreadToken(windows.CurrentThread(), windows.TOKEN_QUERY|windows.TOKEN_IMPERSONATE, true, &previous)
		if err != nil && !errors.Is(err, windows.ERROR_NO_TOKEN) {
			runtime.UnlockOSThread()
			t.Fatal(err)
		}
		defer func() {
			var restoreErr error
			if previous != 0 {
				restoreErr = windows.SetThreadToken(nil, previous)
				previous.Close()
			} else {
				restoreErr = windows.RevertToSelf()
			}
			if restoreErr != nil {
				// Exit while locked: retire the thread rather than reuse an
				// impersonating OS thread or continue the outer test under it.
				t.Fatalf("cannot restore original thread token: %v", restoreErr)
			}
			runtime.UnlockOSThread()
		}()
		var process windows.Token
		if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_DUPLICATE|windows.TOKEN_QUERY, &process); err != nil {
			t.Fatal(err)
		}
		defer process.Close()
		user, err := process.GetTokenUser()
		if err != nil {
			t.Fatal(err)
		}
		admin, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
		if err != nil {
			t.Fatal(err)
		}
		// Microsoft permits disabling the user SID itself. Without the owner
		// allow grant or admin privileges, real NTFS access checks must deny a
		// new backup creation. This is not a mocked metadata comparison.
		disable := [2]windows.SIDAndAttributes{{Sid: user.User.Sid}, {Sid: admin}}
		var restricted windows.Token
		proc := windows.NewLazySystemDLL("advapi32.dll").NewProc("CreateRestrictedToken")
		ok, _, callErr := proc.Call(uintptr(process), 1 /* DISABLE_MAX_PRIVILEGE */, 2, uintptr(unsafe.Pointer(&disable[0])), 0, 0, 0, 0, uintptr(unsafe.Pointer(&restricted)))
		if ok == 0 {
			t.Fatalf("CreateRestrictedToken: %v", callErr)
		}
		defer restricted.Close()
		var impersonation windows.Token
		if err := windows.DuplicateTokenEx(restricted, windows.TOKEN_QUERY|windows.TOKEN_IMPERSONATE, nil, windows.SecurityImpersonation, windows.TokenImpersonation, &impersonation); err != nil {
			t.Fatal(err)
		}
		defer impersonation.Close()
		if err := windows.SetThreadToken(nil, impersonation); err != nil {
			t.Fatal(err)
		}
		h, err := windows.CreateFile(mustWindowsPath(t, backup), windows.GENERIC_WRITE, 0, nil, windows.CREATE_NEW, windows.FILE_ATTRIBUTE_NORMAL, 0)
		if err == nil {
			windows.CloseHandle(h)
			t.Fatal("token without owner/admin grants could preoccupy backup")
		}
		if !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			t.Fatalf("expected actual ACL access denial, got %v", err)
		}
	}()
	if err := disposeConditionalHandle(dir); err != nil {
		t.Fatal(err)
	}
}

func TestWindowsConditionalTemporaryCleanupUsesIdentity(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tmp")
	if err := os.WriteFile(path, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	info := conditionalHandleInfo(t, path)
	if err := os.Rename(path, path+".moved"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("external"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := removeConditionalTemporary(path, info); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != "external" {
		t.Fatalf("cleanup removed external object: %q %v", got, err)
	}
	if err := removeConditionalTemporary(path+".moved", info); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path + ".moved"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("known temporary not removed: %v", err)
	}
}

func TestWindowsConditionalNewFileNoOverwrite(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "new.txt")
	tmp := filepath.Join(dir, "tmp.txt")
	if err := os.WriteFile(tmp, []byte("next"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("external"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := commitConditionalReplacement(context.Background(), target, tmp, nil, nil, []byte("next")); !errors.Is(err, errConditionalMetadataChanged) {
		t.Fatalf("new-file conflict: %v", err)
	}
	os.Remove(target)
	if err := commitConditionalReplacement(context.Background(), target, tmp, nil, nil, []byte("next")); err != nil {
		t.Fatal(err)
	}
}
