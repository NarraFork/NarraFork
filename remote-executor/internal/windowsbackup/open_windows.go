//go:build windows

package windowsbackup

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// OpenObservation explicitly shares DELETE. Go's ordinary os.Open does not
// promise it and can conflict with the executor's own later DELETE handle.
func OpenObservation(path string) (*os.File, error) {
	return openStableOrdinary(path, windows.GENERIC_READ|windows.READ_CONTROL)
}

// OpenMutation fixes the ordinary authorized target once with required rights;
// later quarantine uses this handle, never a second name lookup.
func OpenMutation(path string) (*os.File, error) {
	return openStableOrdinary(path, windows.GENERIC_READ|windows.READ_CONTROL|windows.DELETE)
}

// Stabilizing history reads needs ordinary FILE_WRITE_ATTRIBUTES, in addition to
// ordinary read/delete authorization. Permission denial stays denial; this is
// never retried with a privileged helper token.
func openStableOrdinary(path string, rights uint32) (*os.File, error) {
	file, err := openOrdinary(path, rights|windows.FILE_WRITE_ATTRIBUTES)
	if err != nil {
		return nil, err
	}
	if _, err := stabilizeOrdinaryRead(windows.Handle(file.Fd())); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}

// preserveReadAccess changes only the read handle's automatic access-time
// update policy. The all-ones sentinel is NOT a historical timestamp write.
// Windows requires FILE_WRITE_ATTRIBUTES on this exact handle. No privileged
// retry, path reopen, timestamp repair or unstabilized fallback is permitted.
func stableReadContext(contexts []context.Context) context.Context {
	if len(contexts) == 1 {
		return contexts[0]
	}
	return context.Background()
}

func preserveReadAccess(handle windows.Handle, contexts ...context.Context) error {
	ctx := stableReadContext(contexts)
	if err := ctx.Err(); err != nil {
		return err
	}
	noAccessUpdate := windows.Filetime{LowDateTime: ^uint32(0), HighDateTime: ^uint32(0)}
	if err := windows.SetFileTime(handle, nil, &noAccessUpdate, nil); err != nil {
		return fmt.Errorf("ordinary read access-time stabilization required: %w", err)
	}
	return ctx.Err()
}

// stableReadState keeps every native basic observation, FILE_ID_128 and native
// path slot unchanged around the handle-policy change. It is not a replacement
// descriptor or historical snapshot and never updates a proof's original tuple.
type stableReadObjectState struct {
	ID    fileIDInformation
	Basic basicInformation
}

type stableReadState struct {
	stableReadObjectState
	Slot    string
	DOSSlot string
}

func win32Code(err error) uint32 {
	var code windows.Errno
	if errors.As(err, &code) {
		return uint32(code)
	}
	return 0
}

func inspectStableReadObject(handle windows.Handle, contexts ...context.Context) (stableReadObjectState, error) {
	var state stableReadObjectState
	ctx := stableReadContext(contexts)
	if err := ctx.Err(); err != nil {
		return state, err
	}
	if err := windows.GetFileInformationByHandleEx(handle, windows.FileIdInfo, (*byte)(unsafe.Pointer(&state.ID)), uint32(unsafe.Sizeof(state.ID))); err != nil {
		return state, fmt.Errorf("stable read FileIdInfo win32=%d: %w", win32Code(err), err)
	}
	if err := ctx.Err(); err != nil {
		return state, err
	}
	if err := windows.GetFileInformationByHandleEx(handle, windows.FileBasicInfo, (*byte)(unsafe.Pointer(&state.Basic)), uint32(unsafe.Sizeof(state.Basic))); err != nil {
		return state, fmt.Errorf("stable read FileBasicInfo win32=%d: %w", win32Code(err), err)
	}
	if err := ctx.Err(); err != nil {
		return state, err
	}
	if state.ID.Volume == 0 || state.ID.ID == [16]byte{} {
		return state, fmt.Errorf("stable read native identity unavailable volumeZero=%t fileIDZero=%t", state.ID.Volume == 0, state.ID.ID == [16]byte{})
	}
	return state, nil
}

func inspectStableRead(handle windows.Handle, contexts ...context.Context) (stableReadState, error) {
	ctx := stableReadContext(contexts)
	object, err := inspectStableReadObject(handle, ctx)
	state := stableReadState{stableReadObjectState: object}
	if err != nil {
		return state, err
	}
	var name [32768]uint16
	n, err := windows.GetFinalPathNameByHandle(handle, &name[0], uint32(len(name)), 1)
	if err != nil {
		return state, fmt.Errorf("stable read final path win32=%d length=%d volumeZero=%t fileIDZero=%t: %w", win32Code(err), n, state.ID.Volume == 0, state.ID.ID == [16]byte{}, err)
	}
	if n == 0 || n >= uint32(len(name)) || state.ID.Volume == 0 || state.ID.ID == [16]byte{} {
		return state, fmt.Errorf("stable read native identity unavailable finalPathErr=0 length=%d volumeZero=%t fileIDZero=%t", n, state.ID.Volume == 0, state.ID.ID == [16]byte{})
	}
	state.Slot = windows.UTF16ToString(name[:n])
	if !strings.HasPrefix(state.Slot, `\\?\Volume{`) || !strings.Contains(state.Slot, `}\`) {
		return state, fmt.Errorf("stable read native volume GUID unavailable")
	}
	if err := ctx.Err(); err != nil {
		return state, err
	}
	n, err = windows.GetFinalPathNameByHandle(handle, &name[0], uint32(len(name)), 0)
	if err != nil || n == 0 || n >= uint32(len(name)) {
		return state, fmt.Errorf("stable read DOS canonical path unavailable win32=%d length=%d", win32Code(err), n)
	}
	state.DOSSlot = windows.UTF16ToString(name[:n])
	return state, ctx.Err()
}

// Called on the actual ordinary / DUPLICATE_SAME_ACCESS handle before entering
// any privilege scope. Successfully setting the policy on a newly elevated
// ReOpenFile would NOT prove this ordinary authority.
func stabilizeOrdinaryRead(handle windows.Handle, contexts ...context.Context) (stableReadState, error) {
	ctx := stableReadContext(contexts)
	before, err := inspectStableRead(handle, ctx)
	if err != nil {
		return before, err
	}
	if err := preserveReadAccess(handle, ctx); err != nil {
		return before, err
	}
	after, err := inspectStableRead(handle, ctx)
	if err != nil || before != after {
		return before, fmt.Errorf("ordinary identity/basic state changed during read stabilization")
	}
	return before, nil
}

// Reopen is used only after the original ordinary handle passed the check above.
// Each independent security/BackupRead file object needs its own sentinel; a
// sentinel on the main-stream handle is not transferred by ReOpenFile.
func reopenStableRead(original windows.Handle, access uint32, expected stableReadState, contexts ...context.Context) (windows.Handle, error) {
	ctx := stableReadContext(contexts)
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	h, err := Reopen(original, access|windows.FILE_WRITE_ATTRIBUTES)
	if err != nil {
		return 0, err
	}
	// A ReOpenFile-derived handle may not support normalized-name queries even
	// after the scope ends. Do not broaden rights or use opened/client names.
	// Its same-physical-object binding MUST be checked against the still-live
	// original, whose actual normalized DOS/GUID slots remain authoritative.
	before, err := inspectStableReadObject(h, ctx)
	if err == nil && before != expected.stableReadObjectState {
		err = fmt.Errorf("reopened stable read native identity/basic state changed")
	}
	if err == nil {
		err = preserveReadAccess(h, ctx)
	}
	if err == nil {
		after, inspectErr := inspectStableReadObject(h, ctx)
		err = inspectErr
		if err == nil && after != expected.stableReadObjectState {
			err = fmt.Errorf("reopened read stabilization changed native identity/basic state")
		}
	}
	if err != nil {
		closeErr := windows.CloseHandle(h)
		return 0, errors.Join(err, closeErr)
	}
	return h, nil
}

func verifyStablePhysical(handle windows.Handle, expected stableReadObjectState, contexts ...context.Context) error {
	ctx := stableReadContext(contexts)
	actual, err := inspectStableReadObject(handle, ctx)
	if err != nil {
		return err
	}
	if actual != expected {
		return fmt.Errorf("stable read physical identity/full basic changed")
	}
	if actual.Basic.Attributes & ^uint32(ordinaryAttributes) != 0 {
		return fmt.Errorf("stable read special attributes rejected")
	}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if info.NumberOfLinks != 1 {
		return fmt.Errorf("stable read single link required")
	}
	var fs [32]uint16
	if err := windows.GetVolumeInformationByHandle(handle, nil, 0, nil, nil, nil, &fs[0], uint32(len(fs))); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	switch strings.ToUpper(windows.UTF16ToString(fs[:])) {
	case "NTFS", "REFS":
	default:
		return fmt.Errorf("stable read unverified filesystem")
	}
	var tags struct{ Attributes, ReparseTag uint32 }
	if err := windows.GetFileInformationByHandleEx(handle, windows.FileAttributeTagInfo, (*byte)(unsafe.Pointer(&tags)), uint32(unsafe.Sizeof(tags))); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if tags.Attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || tags.ReparseTag != 0 {
		return fmt.Errorf("stable read reparse object rejected")
	}
	return nil
}

func verifyStableOriginal(original windows.Handle, expected stableReadState, contexts ...context.Context) error {
	ctx := stableReadContext(contexts)
	if err := verifyStablePhysical(original, expected.stableReadObjectState, ctx); err != nil {
		return err
	}
	actual, err := inspectStableRead(original, ctx)
	if err != nil {
		return err
	}
	if actual != expected {
		return fmt.Errorf("native original identity/basic/canonical slot changed")
	}
	return nil
}

// Endpoint bridge for handles obtained ONLY from this original via ReOpenFile
// or a checked relative stream open. The actual live original supplies BOTH
// normalized DOS/GUID slots; opened/client names never become authorization.
// Helper Native.Observe still must verify the signed root/parent/containment.
// This is NOT an atomic namespace/metadata-ABA proof or a readiness assertion.
func verifyStableReadCompletion(original, derived windows.Handle, expected stableReadState, contexts ...context.Context) error {
	ctx := stableReadContext(contexts)
	if err := verifyStableOriginal(original, expected, ctx); err != nil {
		return err
	}
	if err := verifyStablePhysical(derived, expected.stableReadObjectState, ctx); err != nil {
		return err
	}
	return verifyStableOriginal(original, expected, ctx)
}

func openOrdinary(path string, rights uint32) (*os.File, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(name, rights, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(h), path), nil
}
