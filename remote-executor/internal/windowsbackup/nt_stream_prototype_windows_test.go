//go:build windows

package windowsbackup

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"runtime"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// TEST ONLY. NtCreateFile's documented RootDirectory is a directory: using the
// ordinary FILE handle for a :stream name is an experiment, NOT assumed support.
// There is no pathname/privileged/BackupRead fallback and no snapshot or proof.
const ntPrototypeStreamAccess = windows.FILE_READ_DATA | windows.FILE_READ_ATTRIBUTES | windows.FILE_READ_EA | windows.FILE_WRITE_ATTRIBUTES | windows.SYNCHRONIZE

type ntPrototypeIOStatus struct{ Status, Information uintptr }
type ntPrototypeUnicodeString struct {
	Length, MaximumLength uint16
	Buffer                *uint16
}
type ntPrototypeObjectAttributes struct {
	Length                   uint32
	RootDirectory            windows.Handle
	ObjectName               *ntPrototypeUnicodeString
	Attributes               uint32
	SecurityDescriptor       uintptr
	SecurityQualityOfService uintptr
}
type ntPrototypeCounters struct {
	Queries, RelativeOpens, Reads, Closes int
	Bytes                                 int64
	beforeRead                            func()
	log                                   func(string, ...any)
}

func (c *ntPrototypeCounters) report(format string, args ...any) {
	if c.log != nil {
		c.log(format, args...)
	}
}
func ntPrototypeStatus(stage string, status uintptr) error {
	return fmt.Errorf("prototype %s NTSTATUS=0x%08x", stage, uint32(status))
}
func ntPrototypeGrantedAccess(handle windows.Handle) (uint32, error) {
	query := windows.NewLazySystemDLL("ntdll.dll").NewProc("NtQueryObject")
	if err := query.Find(); err != nil {
		return 0, fmt.Errorf("prototype NtQueryObject unavailable win32=%d", win32Code(err))
	}
	var info sdkObjectBasicInformation
	var length uint32
	status, _, _ := query.Call(uintptr(handle), 0, uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info), uintptr(unsafe.Pointer(&length)))
	if uint32(status) != 0 {
		return 0, ntPrototypeStatus("ObjectBasicInformation", status)
	}
	if length < uint32(unsafe.Sizeof(info)) {
		return 0, fmt.Errorf("prototype granted access structure incomplete")
	}
	return info.GrantedAccess, nil
}
func ntPrototypeRequireOriginalRights(original windows.Handle, c *ntPrototypeCounters) error {
	mask, err := ntPrototypeGrantedAccess(original)
	if err != nil {
		return err
	}
	c.report("prototype ordinary GrantedAccess=0x%08x required=0x%08x", mask, uint32(ntPrototypeStreamAccess))
	if mask&ntPrototypeStreamAccess != ntPrototypeStreamAccess {
		return fmt.Errorf("prototype original granted handle lacks requested ordinary stream rights")
	}
	return nil
}

func ntPrototypeEnumerate(ctx context.Context, original windows.Handle, mainSize int64, c *ntPrototypeCounters) ([]ntPrototypeStream, error) {
	query := windows.NewLazySystemDLL("ntdll.dll").NewProc("NtQueryInformationFile")
	if err := query.Find(); err != nil {
		return nil, fmt.Errorf("prototype FileStreamInformation API unavailable win32=%d", win32Code(err))
	}
	for size := 4096; size <= MetadataBytes; size *= 2 {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		buffer := make([]byte, size)
		var io ntPrototypeIOStatus
		c.Queries++
		status, _, _ := query.Call(uintptr(original), uintptr(unsafe.Pointer(&io)), uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), 22)
		runtime.KeepAlive(buffer)
		if uint32(status) == 0x80000005 || uint32(status) == 0xc0000023 || uint32(status) == 0xc0000004 {
			continue
		}
		if uint32(status) != 0 {
			return nil, ntPrototypeStatus("FileStreamInformation", status)
		}
		if uint32(io.Status) != 0 || io.Information == 0 || io.Information > uintptr(len(buffer)) {
			return nil, fmt.Errorf("prototype stream enumeration completion/length")
		}
		return parseNTPrototypeStreams(buffer[:int(io.Information)], mainSize)
	}
	return nil, fmt.Errorf("prototype stream enumeration exceeds metadata budget")
}

func ntPrototypeOpenRelative(original windows.Handle, name string, c *ntPrototypeCounters) (windows.Handle, error) {
	if !ntPrototypeStreamName(name) {
		return 0, fmt.Errorf("prototype invalid named stream")
	}
	if err := ntPrototypeRequireOriginalRights(original, c); err != nil {
		return 0, err
	}
	create := windows.NewLazySystemDLL("ntdll.dll").NewProc("NtCreateFile")
	if err := create.Find(); err != nil {
		return 0, fmt.Errorf("prototype NtCreateFile unavailable win32=%d", win32Code(err))
	}
	wide, err := windows.UTF16FromString(name)
	if err != nil {
		return 0, fmt.Errorf("prototype stream UTF16 rejected")
	}
	unicode := ntPrototypeUnicodeString{Length: uint16((len(wide) - 1) * 2), MaximumLength: uint16((len(wide) - 1) * 2), Buffer: &wide[0]}
	attributes := ntPrototypeObjectAttributes{RootDirectory: original, ObjectName: &unicode}
	attributes.Length = uint32(unsafe.Sizeof(attributes))
	var handle windows.Handle
	var io ntPrototypeIOStatus
	c.RelativeOpens++
	// FILE_OPEN only, no MAXIMUM_ALLOWED, no BACKUP_INTENT, no path fallback.
	// SYNCHRONOUS_IO_NONALERT | NON_DIRECTORY_FILE | OPEN_REPARSE_POINT.
	status, _, _ := create.Call(uintptr(unsafe.Pointer(&handle)), uintptr(ntPrototypeStreamAccess), uintptr(unsafe.Pointer(&attributes)), uintptr(unsafe.Pointer(&io)), 0, 0, uintptr(windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE), 1, 0x20|0x40|0x00200000, 0, 0)
	runtime.KeepAlive(wide)
	runtime.KeepAlive(unicode)
	runtime.KeepAlive(attributes)
	c.report("prototype relative NtCreateFile NTSTATUS=0x%08x ioStatus=0x%08x ioInformation=%d nameSHA256=%s", uint32(status), uint32(io.Status), io.Information, Digest([]byte(name)))
	if uint32(status) != 0 || uint32(io.Status) != 0 || io.Information != 1 {
		if handle != 0 && handle != windows.InvalidHandle {
			c.Closes++
			_ = windows.CloseHandle(handle)
		}
		return 0, ntPrototypeStatus("relative file-root stream open", status)
	}
	if handle == 0 || handle == windows.InvalidHandle {
		return 0, fmt.Errorf("prototype invalid stream handle")
	}
	return handle, nil
}

func ntPrototypeReadOne(ctx context.Context, binding *ntPrototypeBinding, stream ntPrototypeStream, c *ntPrototypeCounters) (result Stream, resultErr error) {
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if err := binding.checkBase(); err != nil {
		return result, err
	}
	h, err := ntPrototypeOpenRelative(binding.original, stream.Name, c)
	if err != nil {
		return result, err
	}
	defer func() {
		c.Closes++
		if err := windows.CloseHandle(h); err != nil {
			result = Stream{}
			resultErr = errors.Join(resultErr, fmt.Errorf("prototype stream close win32=%d", win32Code(err)))
		}
	}()
	granted, err := ntPrototypeGrantedAccess(h)
	if err != nil {
		return result, err
	}
	c.report("prototype stream GrantedAccess=0x%08x", granted)
	if granted&ntPrototypeStreamAccess != ntPrototypeStreamAccess {
		return result, fmt.Errorf("prototype stream missing exact requested rights")
	}
	before, err := inspectStableReadObject(h)
	if err != nil {
		return result, err
	}
	c.report("prototype stream before sentinel fileIDEqual=%t allBasicEqual=%t creation=%d access=%d write=%d change=%d attributes=0x%08x", before.ID == binding.originalState.ID, before.Basic == binding.originalState.Basic, before.Basic.Creation, before.Basic.Access, before.Basic.Write, before.Basic.Change, before.Basic.Attributes)
	if err := binding.checkSameObject(h); err != nil {
		return result, err
	}
	if err := preserveReadAccess(h); err != nil {
		return result, err
	}
	c.report("prototype named-stream sentinel success=true")
	if err := binding.checkSameObject(h); err != nil {
		return result, err
	}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		return result, fmt.Errorf("prototype stream size query win32=%d", win32Code(err))
	}
	if int64(uint64(info.FileSizeHigh)<<32|uint64(info.FileSizeLow)) != stream.Size {
		return result, fmt.Errorf("prototype enumerated stream size changed")
	}
	if c.beforeRead != nil {
		c.beforeRead()
	}
	hash := sha256.New()
	var consumed int64
	buffer := make([]byte, 64<<10)
	for {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		remaining := stream.Size - consumed + 1
		if remaining <= 0 {
			return result, fmt.Errorf("prototype stream grew")
		}
		want := len(buffer)
		if remaining < int64(want) {
			want = int(remaining)
		}
		var count uint32
		c.Reads++
		err := windows.ReadFile(h, buffer[:want], &count, nil)
		if count > uint32(want) {
			return result, fmt.Errorf("prototype stream read length")
		}
		if err != nil && !errors.Is(err, windows.ERROR_HANDLE_EOF) {
			return result, fmt.Errorf("prototype ReadFile win32=%d", win32Code(err))
		}
		if count == 0 {
			break
		}
		consumed += int64(count)
		c.Bytes += int64(count)
		if consumed > stream.Size || c.Bytes > StreamBytes {
			return result, fmt.Errorf("prototype actual stream byte budget")
		}
		_, _ = hash.Write(buffer[:count])
		if err != nil {
			break
		}
	}
	if consumed != stream.Size {
		return result, fmt.Errorf("prototype truncated stream")
	}
	if err := binding.checkSameObject(h); err != nil {
		return result, err
	}
	return Stream{Name: stream.Name, Size: stream.Size, Digest: hex.EncodeToString(hash.Sum(nil))}, nil
}

func ntPrototypeReadStreams(ctx context.Context, root, original *os.File, c *ntPrototypeCounters) ([]Stream, error) {
	defer runtime.KeepAlive(root)
	defer runtime.KeepAlive(original)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := ntPrototypeRequireOriginalRights(windows.Handle(original.Fd()), c); err != nil {
		return nil, err
	}
	binding, err := newNTPrototypeBinding(windows.Handle(root.Fd()), windows.Handle(original.Fd()))
	if err != nil {
		return nil, err
	}
	if _, err := stabilizeOrdinaryRead(binding.original); err != nil {
		return nil, err
	}
	info, err := original.Stat()
	if err != nil {
		return nil, fmt.Errorf("prototype main stat win32=%d", win32Code(err))
	}
	entries, err := ntPrototypeEnumerate(ctx, binding.original, info.Size(), c)
	if err != nil {
		return nil, err
	}
	if err := binding.checkBase(); err != nil {
		return nil, err
	}
	results := make([]Stream, 0, len(entries))
	for _, entry := range entries {
		stream, err := ntPrototypeReadOne(ctx, binding, entry, c)
		if err != nil {
			return nil, err
		}
		results = append(results, stream)
	}
	after, err := ntPrototypeEnumerate(ctx, binding.original, info.Size(), c)
	if err != nil {
		return nil, err
	}
	if len(entries) != len(after) {
		return nil, fmt.Errorf("prototype stream enumeration changed")
	}
	for i := range entries {
		if entries[i] != after[i] {
			return nil, fmt.Errorf("prototype stream manifest changed")
		}
	}
	if err := binding.checkBase(); err != nil {
		return nil, err
	}
	return results, nil
}

func TestNativeWindowsRelativeADSPrototype(t *testing.T) {
	requirePreparedScratch(t)
	data := []byte("[ZoneTransfer]\r\nZoneId=3\r\n")
	root, file, _ := ntPrototypeFixture(t, data)
	before, err := inspectStableReadObject(windows.Handle(file.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	privileges := nativeTokenPrivileges(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c := &ntPrototypeCounters{log: t.Logf}
	sdkBasicEvidence(t, "relativePrototype.initial", windows.Handle(file.Fd()), before)
	result, err := ntPrototypeReadStreams(ctx, root, file, c)
	sdkBasicEvidence(t, "relativePrototype.returned", windows.Handle(file.Fd()), before)
	t.Logf("prototype counters query=%d relativeOpen=%d ReadFile=%d bytes=%d closes=%d", c.Queries, c.RelativeOpens, c.Reads, c.Bytes, c.Closes)
	if err != nil {
		t.Fatal("relative ADS prototype failed (NO fallback, no snapshot/proof)", err)
	}
	if len(result) != 1 || result[0].Name != ":Zone.Identifier:$DATA" || result[0].Size != int64(len(data)) || result[0].Digest != Digest(data) {
		t.Fatal("relative stream selector/content mismatch")
	}
	after, err := inspectStableReadObject(windows.Handle(file.Fd()))
	if err != nil || after != before {
		t.Fatal("relative stream read changed original ID/basic/LastAccess")
	}
	if c.RelativeOpens != 1 || c.Closes != 1 || c.Reads == 0 || !bytes.Equal(privileges, nativeTokenPrivileges(t)) {
		t.Fatal("prototype close/read/privilege counters")
	}
	t.Log("prototype stream bytes and original LastAccess/full basic exact; not an EA/full-metadata implementation and NOT productionReady")
}

func TestNativeWindowsRelativeADSPrototypeRefusals(t *testing.T) {
	requirePreparedScratch(t)
	for _, kind := range []string{"readonly-duplicate", "acl-deny-writeattrs", "bad-name", "cancel-before", "cancel-before-read"} {
		t.Run(kind, func(t *testing.T) {
			root, file, path := ntPrototypeFixture(t, []byte("unread ADS"))
			if kind == "acl-deny-writeattrs" {
				setup, err := openOrdinary(path, windows.READ_CONTROL|windows.WRITE_DAC)
				if err != nil {
					t.Fatal("ACL setup handle failed")
				}
				defer setup.Close()
				user, err := windows.GetCurrentProcessToken().GetTokenUser()
				if err != nil {
					t.Fatal("ACL user query failed")
				}
				sd, err := windows.SecurityDescriptorFromString("D:P(D;;0x100;;;WD)(A;;FA;;;" + user.User.Sid.String() + ")")
				if err != nil {
					t.Fatal("ACL fixture descriptor failed")
				}
				acl, _, err := sd.DACL()
				if err != nil {
					t.Fatal("ACL fixture failed")
				}
				if err := windows.SetSecurityInfo(windows.Handle(setup.Fd()), windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
					t.Fatal("ACL fixture installation failed")
				}
				if granted, err := OpenObservation(path); err == nil {
					granted.Close()
					t.Fatal("ordinary deny fixture did not deny write attributes")
				}
			}
			original := file
			if kind == "readonly-duplicate" || kind == "acl-deny-writeattrs" {
				readOnly, err := openOrdinary(path, windows.GENERIC_READ|windows.READ_CONTROL)
				if err != nil {
					t.Fatal("ordinary readable fixture failed")
				}
				defer readOnly.Close()
				var duplicate windows.Handle
				if err := windows.DuplicateHandle(windows.CurrentProcess(), windows.Handle(readOnly.Fd()), windows.CurrentProcess(), &duplicate, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
					t.Fatal("same-access duplicate failed")
				}
				original = os.NewFile(uintptr(duplicate), "prototype-duplicate")
				defer original.Close()
			}
			before, err := inspectStableReadObject(windows.Handle(original.Fd()))
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			c := &ntPrototypeCounters{log: t.Logf}
			cancelReached := false
			if kind == "cancel-before" {
				cancel()
			}
			if kind == "cancel-before-read" {
				c.beforeRead = func() { cancelReached = true; cancel() }
			}
			if kind == "bad-name" {
				for _, name := range []string{"::$DATA", ":../outside:$DATA", ":x:$INDEX_ALLOCATION", ":x\x00:$DATA", ":bad\xff:$DATA"} {
					if h, err := ntPrototypeOpenRelative(windows.Handle(original.Fd()), name, c); err == nil {
						windows.CloseHandle(h)
						t.Fatal("invalid stream name reached NT open")
					}
				}
			} else {
				_, readErr := ntPrototypeReadStreams(ctx, root, original, c)
				if readErr == nil {
					t.Fatal("refused prototype operation succeeded")
				}
				if kind == "cancel-before-read" && (!cancelReached || !errors.Is(readErr, context.Canceled) || c.Closes == 0) {
					t.Fatal("relative open/sentinel did not reach cancellation point: cancellation-after-open has NOT been tested", readErr)
				}
			}
			if c.Reads != 0 || c.Bytes != 0 {
				t.Fatal("refusal performed actual stream data read")
			}
			if kind != "cancel-before-read" && c.RelativeOpens != 0 {
				t.Fatal("ordinary admission/name/cancel failure reached NtCreateFile")
			}
			if c.Closes != c.RelativeOpens {
				t.Fatal("prototype failed to close opened stream handle")
			}
			after, err := inspectStableReadObject(windows.Handle(original.Fd()))
			if err != nil || after != before {
				t.Fatal("refusal changed original native/basic state")
			}
			t.Logf("refusal counters relativeOpen=%d ReadFile=%d closes=%d; no privileged restore exists in prototype", c.RelativeOpens, c.Reads, c.Closes)
		})
	}
}
