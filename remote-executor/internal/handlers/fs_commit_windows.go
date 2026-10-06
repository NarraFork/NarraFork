//go:build windows

package handlers

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

var replaceFileW = windows.NewLazySystemDLL("kernel32.dll").NewProc("ReplaceFileW")

// Injectable native boundary; tests must not run overrides in parallel.
var conditionalReplaceFile = nativeConditionalReplaceFile
var conditionalRenameHandle = renameConditionalHandle

func nativeConditionalReplaceFile(target, replacement, backup string) error {
	t, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	r, err := windows.UTF16PtrFromString(replacement)
	if err != nil {
		return err
	}
	b, err := windows.UTF16PtrFromString(backup)
	if err != nil {
		return err
	}
	ok, _, callErr := replaceFileW.Call(uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(r)), uintptr(unsafe.Pointer(b)), 0, 0, 0)
	if ok == 0 {
		if callErr == windows.ERROR_SUCCESS {
			return windows.ERROR_GEN_FAILURE
		}
		return callErr
	}
	return nil
}

func openConditionalWindowsFile(path string, access uint32) (*os.File, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(p, access, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(h), path), nil
}

// Handle-bound rename, no overwrite. A path check followed by MoveFileEx could
// move somebody else's file during compensation; this operates on the object.
func renameConditionalHandle(f *os.File, destination string) error {
	destination, err := filepath.Abs(destination)
	if err != nil {
		return err
	}
	name, err := windows.UTF16FromString(destination)
	if err != nil {
		return err
	}
	name = name[:len(name)-1]
	type renameInfo struct {
		Replace uint32
		Root    windows.Handle
		Length  uint32
		Name    uint16
	}
	offset := int(unsafe.Offsetof(renameInfo{}.Name))
	buf := make([]byte, offset+len(name)*2)
	info := (*renameInfo)(unsafe.Pointer(&buf[0]))
	info.Length = uint32(len(name) * 2)
	copy(unsafe.Slice((*uint16)(unsafe.Pointer(&buf[offset])), len(name)), name)
	return windows.SetFileInformationByHandle(windows.Handle(f.Fd()), windows.FileRenameInfo, &buf[0], uint32(len(buf)))
}

// The backup name must not be published in a writable directory: ReplaceFileW
// can overwrite an existing backup. Create a protected namespace atomically,
// then pin its directory identity with a handle that denies delete sharing.
// This protects against other unprivileged principals, not malicious same-SID
// processes or administrators: they can still populate this owner's namespace.
// Native replacement is not an OS CAS or a hostile-same-user isolation boundary.
func newWindowsRecoveryDirectory(target string) (string, *os.File, error) {
	var token windows.Token
	if err := windows.OpenThreadToken(windows.CurrentThread(), windows.TOKEN_QUERY, true, &token); err != nil {
		if !errors.Is(err, windows.ERROR_NO_TOKEN) {
			return "", nil, err
		}
		if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &token); err != nil {
			return "", nil, err
		}
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return "", nil, err
	}
	sid := user.User.Sid.String()
	sd, err := windows.SecurityDescriptorFromString("O:" + sid + "D:P(A;OICI;FA;;;" + sid + ")(A;OICI;FA;;;SY)")
	if err != nil {
		return "", nil, err
	}
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	for attempt := 0; attempt < 8; attempt++ {
		var entropy [16]byte
		if _, err := rand.Read(entropy[:]); err != nil {
			return "", nil, err
		}
		name := filepath.Join(filepath.Dir(target), ".nf-transaction-"+hex.EncodeToString(entropy[:]))
		p, err := windows.UTF16PtrFromString(name)
		if err != nil {
			return "", nil, err
		}
		if err := windows.CreateDirectory(p, &sa); err != nil {
			if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
				continue
			}
			return "", nil, err
		}
		h, err := windows.CreateFile(p, windows.DELETE|windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err != nil {
			return "", nil, fmt.Errorf("recovery directory created at %q but cannot pin it: %w", name, err)
		}
		dir := os.NewFile(uintptr(h), name)
		// Verify the security attached at creation before using this namespace.
		actual, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
		if err != nil {
			dir.Close()
			return "", nil, fmt.Errorf("retain unused recovery directory %q: %w", name, err)
		}
		owner, _, err := actual.Owner()
		if err != nil {
			dir.Close()
			return "", nil, err
		}
		control, _, err := actual.Control()
		if err != nil {
			dir.Close()
			return "", nil, err
		}
		wantACL, err := descriptorACL(sd, false)
		if err != nil {
			dir.Close()
			return "", nil, err
		}
		gotACL, err := descriptorACL(actual, false)
		if err != nil {
			dir.Close()
			return "", nil, err
		}
		if !owner.Equals(user.User.Sid) || control&windows.SE_DACL_PROTECTED == 0 || !bytes.Equal(wantACL, gotACL) {
			dir.Close()
			return "", nil, fmt.Errorf("recovery directory security was changed at %q", name)
		}
		return name, dir, nil
	}
	return "", nil, fmt.Errorf("unable to reserve a private recovery namespace")
}

func disposeConditionalHandle(f *os.File) error {
	disposition := byte(1)
	return windows.SetFileInformationByHandle(windows.Handle(f.Fd()), windows.FileDispositionInfo, &disposition, 1)
}

func removeConditionalTemporary(path string, expectedInfo os.FileInfo) error {
	if expectedInfo == nil {
		return fmt.Errorf("temporary cleanup requires recorded identity")
	}
	f, err := openConditionalWindowsFile(path, windows.FILE_READ_ATTRIBUTES|windows.DELETE)
	if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) || errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if !os.SameFile(info, expectedInfo) {
		return nil
	}
	return disposeConditionalHandle(f)
}

func conditionalFileIdentity(path string, info os.FileInfo) bool {
	f, err := openConditionalWindowsFile(path, windows.FILE_READ_ATTRIBUTES)
	if err != nil {
		return false
	}
	defer f.Close()
	got, err := f.Stat()
	return err == nil && os.SameFile(got, info)
}

func verifyWindowsCommitted(f *os.File, replacementInfo os.FileInfo, metadata conditionalMetadata, next []byte) error {
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if !os.SameFile(info, replacementInfo) || info.Size() != int64(len(next)) {
		return fmt.Errorf("replacement identity/size changed")
	}
	observed, err := io.ReadAll(io.LimitReader(f, int64(len(next))+1))
	if err != nil {
		return err
	}
	if !bytes.Equal(observed, next) {
		return fmt.Errorf("replacement content changed")
	}
	if metadata != nil {
		return metadata.matches(f)
	}
	return validateWindowsConditionalFile(f)
}

// Once the native call begins, cancellation cannot interrupt state inspection
// or compensation. Errors carrying backup/recovery paths are not retry-safe.
func commitConditionalReplacement(ctx context.Context, target, tmpPath string, originalInfo os.FileInfo, metadata conditionalMetadata, next []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	replacement, err := openConditionalWindowsFile(tmpPath, windows.GENERIC_READ|windows.READ_CONTROL|windows.DELETE)
	if err != nil {
		return fmt.Errorf("open replacement for safe recovery: %w", err)
	}
	defer replacement.Close()
	replacementInfo, err := replacement.Stat()
	if err != nil {
		return err
	}
	if err := validateWindowsConditionalFile(replacement); err != nil {
		return err
	}
	if originalInfo == nil {
		if err := ctx.Err(); err != nil {
			return err
		}
		// No-replace handle rename is an atomic missing-target check.
		if err := conditionalRenameHandle(replacement, target); err != nil {
			if errors.Is(err, windows.ERROR_ALREADY_EXISTS) || errors.Is(err, windows.ERROR_FILE_EXISTS) {
				return errConditionalMetadataChanged
			}
			return err
		}
		if err := verifyWindowsCommitted(replacement, replacementInfo, nil, next); err != nil {
			return fmt.Errorf("created file verification failed; retained at %q: %w", target, err)
		}
		if !conditionalFileIdentity(target, replacementInfo) {
			return fmt.Errorf("created file path changed; original replacement handle was verified, state uncertain")
		}
		return nil
	}
	original, err := openConditionalWindowsFile(target, windows.GENERIC_READ|windows.READ_CONTROL)
	if err != nil {
		return err
	}
	defer original.Close()
	info, err := original.Stat()
	if err != nil {
		return err
	}
	if !os.SameFile(info, originalInfo) {
		return errConditionalMetadataChanged
	}
	if err := metadata.matches(original); err != nil {
		return err
	}
	oldContent, err := io.ReadAll(io.LimitReader(original, 2000001))
	if err != nil {
		return err
	}
	if len(oldContent) > 2000000 {
		return fmt.Errorf("original exceeds conditional replacement budget")
	}
	recoveryDirectory, recoveryDirHandle, err := newWindowsRecoveryDirectory(target)
	if err != nil {
		return err
	}
	defer recoveryDirHandle.Close()
	backup := filepath.Join(recoveryDirectory, "original")
	// Pre-native failures leave only an empty private directory. Once native
	// begins, retain it on every failure because it may contain the sole original.
	nativeStarted := false
	defer func() {
		if !nativeStarted {
			_ = disposeConditionalHandle(recoveryDirHandle)
		}
	}()
	// ReplaceFileW opens the replacement with no sharing. Even a handle opened
	// with FILE_SHARE_DELETE would block that exclusive native open.
	if err := replacement.Close(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	nativeStarted = true
	nativeErr := conditionalReplaceFile(target, tmpPath, backup)
	// Reopen after native completion and bind compensation to the recorded ID.
	// Never act on an unknown pathname occupant.
	var committedReplacement *os.File
	candidate, candidateErr := openConditionalWindowsFile(target, windows.GENERIC_READ|windows.READ_CONTROL|windows.DELETE)
	if candidateErr == nil {
		ci, e := candidate.Stat()
		if e == nil && os.SameFile(ci, replacementInfo) {
			committedReplacement = candidate
			defer committedReplacement.Close()
		} else {
			candidate.Close()
			candidateErr = fmt.Errorf("target is not the recorded replacement")
		}
	}
	// Check the backup even on success: it may be a raced-in external object.
	backupFile, backupErr := openConditionalWindowsFile(backup, windows.GENERIC_READ|windows.READ_CONTROL|windows.DELETE)
	backupValid := false
	if backupErr == nil {
		defer backupFile.Close()
		bi, e := backupFile.Stat()
		if e == nil && os.SameFile(bi, originalInfo) {
			observed, e := io.ReadAll(io.LimitReader(backupFile, int64(len(oldContent))+1))
			backupValid = e == nil && bytes.Equal(observed, oldContent) && metadata.matches(backupFile) == nil
		}
	}
	var verifyErr error
	if nativeErr == nil {
		if committedReplacement == nil {
			verifyErr = candidateErr
		} else {
			verifyErr = verifyWindowsCommitted(committedReplacement, replacementInfo, metadata, next)
		}
		if verifyErr == nil && !backupValid {
			verifyErr = fmt.Errorf("original backup identity/content/metadata not verified")
		}
		if verifyErr == nil && !conditionalFileIdentity(target, replacementInfo) {
			verifyErr = fmt.Errorf("target path changed after verification")
		}
		if verifyErr == nil {
			// Delete by handle, not by potentially raced backup pathname.
			if e := disposeConditionalHandle(backupFile); e != nil {
				return fmt.Errorf("replacement verified but original backup cleanup failed at %q: %w", backup, e)
			}
			// The source handle also refers to the backed-up object; close both
			// before deleting the now-empty directory by its pinned handle.
			backupFile.Close()
			original.Close()
			if e := disposeConditionalHandle(recoveryDirHandle); e != nil {
				return fmt.Errorf("replacement verified; backup removed but private recovery directory retained at %q: %w", recoveryDirectory, e)
			}
			return nil
		}
	}
	cause := nativeErr
	if cause == nil {
		cause = verifyErr
	}
	// Only pre-native metadata conflicts are safe to classify as conflicts.
	// A post-native error may carry recovery state and must not be swallowed.
	if errors.Is(cause, errConditionalMetadataChanged) {
		cause = fmt.Errorf("post-native metadata verification: %v", cause)
	}
	// 1175/1176 normally leave the original in place. 1177 may already have
	// moved it to backup. Inspect identity, never infer disk state from errno.
	if conditionalFileIdentity(target, originalInfo) {
		// Any backup is retained on errors; do not remove unknown external files.
		return fmt.Errorf("native replacement failed; original remains at %q; backup (if present) %q: %w", target, backup, cause)
	}
	if !backupValid {
		return fmt.Errorf("replacement state uncertain; original backup not verified; retain %q and inspect %q: %w", backup, target, cause)
	}
	recovery := filepath.Join(recoveryDirectory, "replacement")
	if conditionalFileIdentity(target, replacementInfo) {
		if committedReplacement == nil {
			return fmt.Errorf("retain original backup %q; cannot open replacement for recovery: %v; cause: %w", backup, candidateErr, cause)
		}
		if e := conditionalRenameHandle(committedReplacement, recovery); e != nil {
			return fmt.Errorf("retain original backup %q; cannot move replacement to %q: %v; cause: %w", backup, recovery, e, cause)
		}
	} else if _, e := os.Lstat(target); !errors.Is(e, os.ErrNotExist) {
		return fmt.Errorf("unknown external target not overwritten; original backup %q retained: %w", backup, cause)
	}
	// No overwrite: an external creation in this interval wins, backup survives.
	if e := conditionalRenameHandle(backupFile, target); e != nil {
		return fmt.Errorf("restore failed; original backup %q and replacement recovery %q retained: %v; cause: %w", backup, recovery, e, cause)
	}
	if !conditionalFileIdentity(target, originalInfo) {
		return fmt.Errorf("restore path changed; inspect %q and recovery %q: %w", target, recovery, cause)
	}
	return fmt.Errorf("replacement failed; original restored to %q; replacement recovery (if present) %q: %w", target, recovery, cause)
}
