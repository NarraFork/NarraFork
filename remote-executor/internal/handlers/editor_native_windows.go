//go:build windows

package handlers

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Same owner/SYSTEM protected namespace policy as native replacement recovery.
func ensureEditorPrivateDirectory(path string) error {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &token); err != nil {
		return err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return err
	}
	sid := user.User.Sid.String()
	acl := "(A;OICI;FA;;;" + sid + ")"
	if sid != "S-1-5-18" {
		acl += "(A;OICI;FA;;;SY)"
	}
	sd, err := windows.SecurityDescriptorFromString("O:" + sid + "D:P" + acl)
	if err != nil {
		return err
	}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	if err = windows.CreateDirectory(p, &sa); err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return err
	}
	f, err := openConditionalWindowsFile(path, windows.READ_CONTROL|windows.FILE_READ_ATTRIBUTES)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("editor state must be a private non-reparse directory")
	}
	var attrs windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(windows.Handle(f.Fd()), &attrs); err != nil {
		return err
	}
	if attrs.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return fmt.Errorf("editor state reparse points unsupported")
	}
	actual, err := windows.GetSecurityInfo(windows.Handle(f.Fd()), windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := actual.Owner()
	if err != nil {
		return err
	}
	control, _, err := actual.Control()
	if err != nil {
		return err
	}
	want, err := descriptorACL(sd, false)
	if err != nil {
		return err
	}
	got, err := descriptorACL(actual, false)
	if err != nil {
		return err
	}
	if !owner.Equals(user.User.Sid) || control&windows.SE_DACL_PROTECTED == 0 || !bytes.Equal(want, got) {
		return fmt.Errorf("editor state directory must have protected owner/SYSTEM-only ACL")
	}
	return nil
}

// Editor-only preflight on the already identity-bound source handle. A known
// read-only target cannot be replaced; reject before applying is journaled.
// Flags changed after the final check remain the ordinary external-writer race,
// and native replacement errors still retain uncertain evidence.
func validateEditorSourceWritable(file *os.File) error {
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(windows.Handle(file.Fd()), &info); err != nil {
		return err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_READONLY != 0 {
		return fmt.Errorf("EDITOR_APPLY_REJECTED: read-only target metadata")
	}
	return nil
}
func validateEditorHostRecordFile(file *os.File) error { return validateWindowsConditionalFile(file) }

// Windows does not offer POSIX directory fsync. Files/journal are flushed; native
// ReplaceFileW and handle no-replace retain their documented NTFS guarantees.
func syncEditorDirectory(_ string) error { return nil }
func lockEditorFile(ctx context.Context, f *os.File) error {
	var overlap windows.Overlapped
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlap)
		if err == nil {
			return nil
		}
		if !errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			return err
		}
		timer := time.NewTimer(10 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}
func unlockEditorFile(f *os.File) {
	var overlap windows.Overlapped
	_ = windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, &overlap)
}
func verifyEditorPreparedMetadata(_ conditionalMetadata, f *os.File) error {
	// apply already re-captures owner/group/mandatory label. DACL is merged by
	// ReplaceFileW and matches is enforced by its existing post-native verifier.
	return validateWindowsConditionalFile(f)
}
func commitEditorReplacement(target, tmp string, original os.FileInfo, metadata conditionalMetadata, digest string, size int64) error {
	f, err := os.Open(tmp)
	if err != nil {
		return err
	}
	defer f.Close()
	next, err := io.ReadAll(io.LimitReader(f, EditorMaxBytes+1))
	if err != nil {
		return err
	}
	if int64(len(next)) != size || editorDigest(next) != digest {
		return fmt.Errorf("editor preparation changed")
	}
	f.Close()
	return commitConditionalReplacementBudget(context.Background(), target, tmp, original, metadata, next, EditorMaxBytes)
}
