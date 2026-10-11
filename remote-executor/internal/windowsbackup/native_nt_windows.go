//go:build windows

package windowsbackup

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

const nativeStreamReadAccess = windows.FILE_READ_DATA | windows.FILE_READ_ATTRIBUTES | windows.FILE_READ_EA | windows.FILE_WRITE_ATTRIBUTES | windows.SYNCHRONIZE

var (
	nativeNTDLL        = windows.NewLazySystemDLL("ntdll.dll")
	nativeQueryObject  = nativeNTDLL.NewProc("NtQueryObject")
	nativeQueryFile    = nativeNTDLL.NewProc("NtQueryInformationFile")
	nativeQueryEA      = nativeNTDLL.NewProc("NtQueryEaFile")
	nativeCreateFile   = nativeNTDLL.NewProc("NtCreateFile")
	captureReadQueue   = make(chan struct{}, QueueSize)
	captureReadWorkers = make(chan struct{}, Workers)
)

type nativeIOStatus struct{ Status, Information uintptr }
type nativeObjectBasic struct {
	Attributes, GrantedAccess, HandleCount, PointerCount uint32
	Reserved                                             [10]uint32
}
type nativeUnicodeString struct {
	Length, MaximumLength uint16
	Buffer                *uint16
}
type nativeObjectAttributes struct {
	Length                                       uint32
	RootDirectory                                windows.Handle
	ObjectName                                   *nativeUnicodeString
	Attributes                                   uint32
	SecurityDescriptor, SecurityQualityOfService uintptr
}

func nativeStatusError(stage string, status uintptr) error {
	return fmt.Errorf("%s NTSTATUS=0x%08x", stage, uint32(status))
}
func acquireCaptureRead(ctx context.Context) (func(), error) {
	select {
	case captureReadQueue <- struct{}{}:
	default:
		return nil, fmt.Errorf("native capture queue full")
	}
	select {
	case captureReadWorkers <- struct{}{}:
		if err := ctx.Err(); err != nil {
			<-captureReadWorkers
			<-captureReadQueue
			return nil, err
		}
		return func() { <-captureReadWorkers; <-captureReadQueue }, nil
	case <-ctx.Done():
		<-captureReadQueue
		return nil, ctx.Err()
	}
}
func nativeGrantedAccess(handle windows.Handle, contexts ...context.Context) (uint32, error) {
	ctx := stableReadContext(contexts)
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if err := nativeQueryObject.Find(); err != nil {
		return 0, fmt.Errorf("native granted-access API unavailable: %w", err)
	}
	var info nativeObjectBasic
	var length uint32
	status, _, _ := nativeQueryObject.Call(uintptr(handle), 0, uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info), uintptr(unsafe.Pointer(&length)))
	if uint32(status) != 0 {
		return 0, nativeStatusError("native granted access", status)
	}
	if length < uint32(unsafe.Sizeof(info)) {
		return 0, fmt.Errorf("native granted-access reply incomplete")
	}
	return info.GrantedAccess, ctx.Err()
}
func requireNativeReadRights(handle windows.Handle, contexts ...context.Context) error {
	ctx := stableReadContext(contexts)
	granted, err := nativeGrantedAccess(handle, ctx)
	if err != nil {
		return err
	}
	if granted&nativeStreamReadAccess != nativeStreamReadAccess {
		return fmt.Errorf("ordinary granted handle lacks complete stable-read rights: %w", windows.ERROR_ACCESS_DENIED)
	}
	return nil
}
func readNativeStreamInfo(ctx context.Context, original windows.Handle, mainSize int64) ([]nativeStreamRecord, error) {
	if err := nativeQueryFile.Find(); err != nil {
		return nil, err
	}
	for size := 4096; size <= MetadataBytes; size *= 2 {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		buffer := make([]byte, size)
		var io nativeIOStatus
		status, _, _ := nativeQueryFile.Call(uintptr(original), uintptr(unsafe.Pointer(&io)), uintptr(unsafe.Pointer(&buffer[0])), uintptr(size), 22)
		runtime.KeepAlive(buffer)
		if uint32(status) == nativeStatusOverflow || uint32(status) == nativeStatusTooSmall || uint32(status) == 0xc0000004 {
			continue
		}
		if uint32(status) != 0 {
			return nil, nativeStatusError("native FileStreamInformation", status)
		}
		if uint32(io.Status) != 0 || io.Information == 0 || io.Information > uintptr(size) {
			return nil, fmt.Errorf("native stream enumeration completion/length")
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return parseNativeStreams(buffer[:int(io.Information)], mainSize)
	}
	return nil, fmt.Errorf("native stream enumeration metadata budget")
}
func openNativeStream(ctx context.Context, original windows.Handle, name string) (windows.Handle, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if !nativeStreamName(name) {
		return 0, fmt.Errorf("native relative stream name rejected")
	}
	if err := requireNativeReadRights(original, ctx); err != nil {
		return 0, err
	}
	if err := nativeCreateFile.Find(); err != nil {
		return 0, err
	}
	wide, err := windows.UTF16FromString(name)
	if err != nil {
		return 0, fmt.Errorf("native stream Unicode rejected")
	}
	u := nativeUnicodeString{Length: uint16((len(wide) - 1) * 2), MaximumLength: uint16((len(wide) - 1) * 2), Buffer: &wide[0]}
	attributes := nativeObjectAttributes{RootDirectory: original, ObjectName: &u}
	attributes.Length = uint32(unsafe.Sizeof(attributes))
	var h windows.Handle
	var io nativeIOStatus
	// Same live ordinary file as RootDirectory; existing named stream only.
	// No pathname fallback, MAXIMUM_ALLOWED or FILE_OPEN_FOR_BACKUP_INTENT.
	status, _, _ := nativeCreateFile.Call(uintptr(unsafe.Pointer(&h)), uintptr(nativeStreamReadAccess), uintptr(unsafe.Pointer(&attributes)), uintptr(unsafe.Pointer(&io)), 0, 0, uintptr(windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE), 1, 0x20|0x40|0x00200000, 0, 0)
	runtime.KeepAlive(wide)
	runtime.KeepAlive(u)
	runtime.KeepAlive(attributes)
	var openErr error
	if uint32(status) != 0 {
		openErr = nativeStatusError("native relative stream open", status)
	} else if uint32(io.Status) != 0 || io.Information != 1 {
		openErr = fmt.Errorf("native stream open completion/disposition")
	}
	if openErr == nil {
		openErr = ctx.Err()
	}
	if openErr != nil {
		if h != 0 && h != windows.InvalidHandle {
			openErr = errors.Join(openErr, windows.CloseHandle(h))
		}
		return 0, openErr
	}
	if h == 0 || h == windows.InvalidHandle {
		return 0, fmt.Errorf("native stream handle unavailable")
	}
	return h, nil
}
