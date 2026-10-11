//go:build windows

package handlers

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"unsafe"

	"github.com/narrafork/remote-executor/internal/windowsbackup"
	"golang.org/x/sys/windows"
)

type firstCaptureJoinedPathKey struct{}

func withFirstCaptureJoinedPaths(ctx context.Context) context.Context {
	return context.WithValue(ctx, firstCaptureJoinedPathKey{}, true)
}

func (h *Handlers) describeFirstCaptureOrdinary(ctx context.Context, rootKey windowsbackup.NativeDescriptor, file *os.File) (windowsbackup.NativeObservation, *NativePathDescriptorV2, error) {
	var observation windowsbackup.NativeObservation
	ctx = withFirstCaptureJoinedPaths(ctx)
	if _, err := windowsbackup.InspectFirstCaptureOrdinaryHandle(ctx, file); err != nil {
		return observation, nil, err
	}
	target, name, err := h.ResolveNativeOpenedFileV2(ctx, file)
	if err != nil {
		return observation, nil, err
	}
	if len(target.Ancestors) == 0 || len(target.Ancestors) > 64 {
		return observation, nil, windowsbackup.ErrFirstCaptureNotReady
	}
	var rootPath string
	for _, ancestor := range target.Ancestors {
		if ancestor.Object.VolumeID == rootKey.VolumeID && ancestor.Object.FileID == rootKey.FileID && ancestor.Object.CreationTime == rootKey.CreationTime {
			rootPath = ancestor.CanonicalPath
			break
		}
	}
	if rootPath == "" {
		return observation, nil, windowsbackup.ErrFirstCaptureNotReady
	}
	root, err := resolveNativePathV2(ctx, rootPath, "existing")
	if err != nil {
		return observation, nil, err
	}
	actualRoot, err := nativeBackupDescriptor(root.NativeDescriptor)
	if err != nil || actualRoot != rootKey || !nativeDescriptorContains(root.NativeDescriptor, target) {
		return observation, nil, windowsbackup.ErrFirstCaptureNotReady
	}
	parent, err := resolveNativePathV2(ctx, target.Parent.CanonicalPath, "existing")
	if err != nil {
		return observation, nil, err
	}
	observation.Root = actualRoot
	observation.Parent, err = nativeBackupDescriptor(parent.NativeDescriptor)
	if err != nil {
		return observation, nil, err
	}
	observation.Target, err = nativeBackupDescriptor(target)
	if err != nil {
		return observation, nil, err
	}
	observation.RootPath = root.CanonicalPath
	observation.ParentPath = parent.CanonicalPath
	observation.TargetPath = name
	return observation, target, nil
}
func (h *Handlers) DescribeFirstCaptureOrdinary(ctx context.Context, rootKey windowsbackup.NativeDescriptor, file *os.File) (windowsbackup.NativeObservation, error) {
	o, _, err := h.describeFirstCaptureOrdinary(ctx, rootKey, file)
	return o, err
}
func (h *Handlers) InspectFirstCaptureOrdinary(ctx context.Context, root windowsbackup.NativeDescriptor, file *os.File) (windowsbackup.FirstCapturePinnedOrdinary, error) {
	result := windowsbackup.FirstCapturePinnedOrdinary{Terminal: true}
	var err error
	result.GrantedAccess, err = windowsbackup.InspectFirstCaptureOrdinaryHandle(ctx, file)
	if err != nil {
		return result, err
	}
	result.Observation, _, err = h.describeFirstCaptureOrdinary(ctx, root, file)
	return result, err
}

func pinFirstCaptureAncestor(ctx context.Context, ancestor NativePathAncestorV2) (file *os.File, resultErr error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	pointer, err := windows.UTF16PtrFromString(ancestor.CanonicalPath)
	if err != nil {
		return nil, err
	}
	// Lifetime namespace pin: no DELETE sharing, metadata-only rights. Never
	// inherits into a worker shell and never augments target's granted access.
	h, err := windows.CreateFile(pointer, windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	file = os.NewFile(uintptr(h), "first-capture-ancestor-pin")
	defer func() {
		if resultErr != nil {
			closeErr := file.Close()
			if closeErr == nil {
				file = nil
			} else {
				resultErr = errors.Join(resultErr, closeErr)
			}
		}
	}()
	var id pathFileIDInformation
	if err := windows.GetFileInformationByHandleEx(h, pathFileIDInfo, (*byte)(unsafe.Pointer(&id)), uint32(unsafe.Sizeof(id))); err != nil {
		return file, err
	}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		return file, err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return file, windowsbackup.ErrFirstCaptureNotReady
	}
	volume, err := nativeHandleVolumeID(h, id.VolumeSerial, ancestor.CanonicalPath)
	if err != nil {
		return file, err
	}
	object := NativePathObjectV2{volume, hex.EncodeToString(id.FileID[:]), strconv.FormatUint(uint64(info.CreationTime.HighDateTime)<<32|uint64(info.CreationTime.LowDateTime), 10)}
	if object != ancestor.Object {
		return file, windowsbackup.ErrFirstCaptureNotReady
	}
	var flags uint32
	if err := windows.GetFileInformationByHandleEx(h, pathFileCaseSensitiveInfo, (*byte)(unsafe.Pointer(&flags)), 4); err != nil {
		return file, err
	}
	if (flags&1 != 0) != ancestor.CaseSensitive {
		return file, windowsbackup.ErrFirstCaptureNotReady
	}
	return file, ctx.Err()
}
func (h *Handlers) PinFirstCaptureOrdinary(ctx context.Context, root windowsbackup.NativeDescriptor, file *os.File) (windowsbackup.FirstCapturePinnedOrdinary, error) {
	ctx = withFirstCaptureJoinedPaths(ctx)
	result, err := h.InspectFirstCaptureOrdinary(ctx, root, file)
	if err != nil {
		return result, err
	}
	_, target, err := h.describeFirstCaptureOrdinary(ctx, root, file)
	if err != nil {
		return result, err
	}
	for _, ancestor := range target.Ancestors {
		pin, err := pinFirstCaptureAncestor(ctx, ancestor)
		if pin != nil {
			result.Pins = append(result.Pins, pin)
		}
		if err != nil {
			return result, err
		}
	}
	if len(result.Pins) == 0 || len(result.Pins) > 64 {
		return result, windowsbackup.ErrFirstCaptureNotReady
	}
	after, _, err := h.describeFirstCaptureOrdinary(ctx, root, file)
	if err != nil || after != result.Observation {
		return result, errors.Join(err, fmt.Errorf("ordinary pinned description changed"))
	}
	return result, nil
}

// This adapter preserves the original Helper Execute/Observe/Capture predicates.
// Only first-capture path-resolution lifetime joins are extended to prevent a
// timed-out resolver from outliving references while caller advertises terminal.
type WindowsFirstCaptureNativeOperations struct{ *WindowsBackupNativeOperations }

func (o *WindowsFirstCaptureNativeOperations) Observe(ctx context.Context, t windowsbackup.Ticket, file *os.File) (windowsbackup.NativeObservation, error) {
	return o.WindowsBackupNativeOperations.Observe(withFirstCaptureJoinedPaths(ctx), t, file)
}
func (o *WindowsFirstCaptureNativeOperations) PinOrdinary(ctx context.Context, root windowsbackup.NativeDescriptor, file *os.File) (windowsbackup.FirstCapturePinnedOrdinary, error) {
	if _, ok := o.roots[root]; !ok {
		return windowsbackup.FirstCapturePinnedOrdinary{Terminal: true}, windowsbackup.ErrFirstCaptureNotReady
	}
	return o.handlers.PinFirstCaptureOrdinary(ctx, root, file)
}
func (o *WindowsFirstCaptureNativeOperations) InspectFirstCaptureOrdinary(ctx context.Context, root windowsbackup.NativeDescriptor, file *os.File) (windowsbackup.FirstCapturePinnedOrdinary, error) {
	if _, ok := o.roots[root]; !ok {
		return windowsbackup.FirstCapturePinnedOrdinary{Terminal: true}, windowsbackup.ErrFirstCaptureNotReady
	}
	return o.handlers.InspectFirstCaptureOrdinary(withFirstCaptureJoinedPaths(ctx), root, file)
}
func (o *WindowsFirstCaptureNativeOperations) DescribeOrdinary(ctx context.Context, root windowsbackup.NativeDescriptor, file *os.File) (windowsbackup.NativeObservation, error) {
	return o.WindowsBackupNativeOperations.DescribeOrdinary(withFirstCaptureJoinedPaths(ctx), root, file)
}

var _ io.Closer = (*os.File)(nil)
