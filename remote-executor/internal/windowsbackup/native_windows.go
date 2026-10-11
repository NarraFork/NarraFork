//go:build windows

package windowsbackup

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"sort"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	backupRead  = windows.NewLazySystemDLL("kernel32.dll").NewProc("BackupRead")
	backupWrite = windows.NewLazySystemDLL("kernel32.dll").NewProc("BackupWrite")
	backupSeek  = windows.NewLazySystemDLL("kernel32.dll").NewProc("BackupSeek")
)

// Optional package-private TEST observer. It receives only bounded SDK facts,
// never buffers, paths, SD, stream names or context pointers. The original SDK
// calls/arguments remain direct, retaining their uintptr-escape annotations.
type backupSDKEvent struct {
	Stage                           string
	Handle                          windows.Handle
	Write, Security, Abort, Success bool
	Requested, Actual               uint64
	Win32                           uint32
}

var backupSDKObserver func(backupSDKEvent)

func observeBackupSDK(event backupSDKEvent) {
	if backupSDKObserver != nil {
		backupSDKObserver(event)
	}
}

const securityMask = windows.OWNER_SECURITY_INFORMATION | windows.GROUP_SECURITY_INFORMATION | windows.DACL_SECURITY_INFORMATION | windows.SACL_SECURITY_INFORMATION | windows.LABEL_SECURITY_INFORMATION | windows.ATTRIBUTE_SECURITY_INFORMATION | windows.SCOPE_SECURITY_INFORMATION
const ordinaryAttributes = windows.FILE_ATTRIBUTE_READONLY | windows.FILE_ATTRIBUTE_HIDDEN | windows.FILE_ATTRIBUTE_SYSTEM | windows.FILE_ATTRIBUTE_ARCHIVE | windows.FILE_ATTRIBUTE_TEMPORARY | windows.FILE_ATTRIBUTE_NOT_CONTENT_INDEXED | windows.FILE_ATTRIBUTE_NORMAL

type basicInformation struct {
	Creation, Access, Write, Change int64
	Attributes                      uint32
	Padding                         uint32
}
type fileIDInformation struct {
	Volume uint64
	ID     [16]byte
}

// Identity preserves FILE_ID_128; it must not replace legacy v1 hash inputs.
func Identity(file *os.File) (string, error) {
	var id fileIDInformation
	if err := windows.GetFileInformationByHandleEx(windows.Handle(file.Fd()), windows.FileIdInfo, (*byte)(unsafe.Pointer(&id)), uint32(unsafe.Sizeof(id))); err != nil {
		return "", err
	}
	var basic basicInformation
	if err := windows.GetFileInformationByHandleEx(windows.Handle(file.Fd()), windows.FileBasicInfo, (*byte)(unsafe.Pointer(&basic)), uint32(unsafe.Sizeof(basic))); err != nil {
		return "", err
	}
	if id.Volume == 0 || id.ID == [16]byte{} {
		return "", ErrIncomplete
	}
	volume, _, err := VolumeIdentity(file)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("fileid128:%s:%x:%d", volume, id.ID, basic.Creation), nil
}
func validateOrdinary(h windows.Handle) (*basicInformation, error) {
	var basic basicInformation
	if err := windows.GetFileInformationByHandleEx(h, windows.FileBasicInfo, (*byte)(unsafe.Pointer(&basic)), uint32(unsafe.Sizeof(basic))); err != nil {
		return nil, err
	}
	if basic.Attributes & ^uint32(ordinaryAttributes) != 0 {
		return nil, fmt.Errorf("%w: special or unknown attributes 0x%x", ErrIncomplete, basic.Attributes)
	}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		return nil, err
	}
	if info.NumberOfLinks != 1 {
		return nil, fmt.Errorf("%w: single link required", ErrIncomplete)
	}
	var fs [32]uint16
	if err := windows.GetVolumeInformationByHandle(h, nil, 0, nil, nil, nil, &fs[0], uint32(len(fs))); err != nil {
		return nil, err
	}
	switch strings.ToUpper(windows.UTF16ToString(fs[:])) {
	case "NTFS", "REFS":
	default:
		return nil, fmt.Errorf("%w: unverified filesystem", ErrIncomplete)
	}
	return &basic, nil
}
func selfRelativeBytes(sd *windows.SECURITY_DESCRIPTOR) ([]byte, error) {
	control, _, err := sd.Control()
	if err != nil {
		return nil, err
	}
	if control&windows.SE_SELF_RELATIVE == 0 {
		sd, err = sd.ToSelfRelative()
		if err != nil {
			return nil, err
		}
	}
	size := sd.Length()
	if size < 20 || size > MetadataBytes {
		return nil, ErrIncomplete
	}
	return bytes.Clone(unsafe.Slice((*byte)(unsafe.Pointer(sd)), int(size))), nil
}
func descriptor(data []byte) (*windows.SECURITY_DESCRIPTOR, error) {
	if len(data) < 20 || len(data) > MetadataBytes {
		return nil, ErrIncomplete
	}
	sd := (*windows.SECURITY_DESCRIPTOR)(unsafe.Pointer(&data[0]))
	// SECURITY_DESCRIPTOR.Valid() calls the native validator before pointer walks.
	if !sd.IsValid() {
		return nil, ErrIncomplete
	}
	control, _, err := sd.Control()
	if err != nil || control&windows.SE_SELF_RELATIVE == 0 || int(sd.Length()) != len(data) {
		return nil, ErrIncomplete
	}
	return sd, nil
}

// Capture obtains security rights by ReOpenFile on the caller's authorized
// ordinary handle. Unknown SACL/CAP/EA/stream state is always a failure.
func Capture(ctx context.Context, file *os.File) (result *Snapshot, resultErr error) {
	if file == nil {
		return nil, fmt.Errorf("ordinary capture handle required")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	defer runtime.KeepAlive(file)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	release, err := acquireCaptureRead(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	// Admission uses the actual ordinary/DUPLICATE_SAME_ACCESS handle. A
	// privileged helper reopen must never supply ordinary WRITE_ATTRIBUTES.
	original := windows.Handle(file.Fd())
	if err := requireNativeReadRights(original, ctx); err != nil {
		return nil, err
	}
	ordinaryState, err := stabilizeOrdinaryRead(original, ctx)
	if err != nil {
		return nil, err
	}
	// ordinaryState includes the same nonzero FILE_ID_128/creation and native
	// volume-GUID checks as Identity, plus both actual canonical path forms.
	if err := verifyStableOriginal(original, ordinaryState, ctx); err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if info.Size() < 0 {
		return nil, ErrIncomplete
	}
	// Keep the independently opened security object alive through the full
	// endpoint bridge. Every error/panic/cancellation path joins the worker
	// before this close executes; a close-side change also suppresses snapshot.
	var h windows.Handle
	defer func() {
		if h != 0 {
			if closeErr := windows.CloseHandle(h); closeErr != nil {
				resultErr = errors.Join(resultErr, fmt.Errorf("close stable capture handle: %w", closeErr))
			}
			resultErr = errors.Join(resultErr, verifyStableOriginal(original, ordinaryState, ctx), ctx.Err())
			if resultErr != nil {
				result = nil
			}
		}
	}()
	var captured *Snapshot
	var inventory nativeInventory
	err = Privileged(ctx, []string{"SeSecurityPrivilege", "SeBackupPrivilege"}, func() error {
		var reopenErr error
		h, reopenErr = reopenStableRead(original, windows.GENERIC_READ|windows.READ_CONTROL|windows.ACCESS_SYSTEM_SECURITY, ordinaryState, ctx)
		if reopenErr != nil {
			return fmt.Errorf("%w: reopen original security handle: %v", ErrHelperRequired, reopenErr)
		}
		if err := verifyStablePhysical(h, ordinaryState.stableReadObjectState, ctx); err != nil {
			return err
		}
		state, err := inspectStableReadObject(h, ctx)
		if err != nil {
			return err
		}
		basic := &state.Basic
		sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, securityMask)
		if err != nil {
			return fmt.Errorf("%w: full security read: %v", ErrIncomplete, err)
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		sacl, _, err := sd.SACL()
		if err != nil && !errors.Is(err, windows.ERROR_OBJECT_NOT_FOUND) {
			return err
		}
		if sacl != nil {
			raw := unsafe.Slice((*byte)(unsafe.Pointer(sacl)), int(*(*uint16)(unsafe.Add(unsafe.Pointer(sacl), 2))))
			if len(raw) < 8 {
				return ErrIncomplete
			}
			offset := 8
			count := int(binary.LittleEndian.Uint16(raw[4:6]))
			for i := 0; i < count; i++ {
				if offset+4 > len(raw) {
					return ErrIncomplete
				}
				size := int(binary.LittleEndian.Uint16(raw[offset+2 : offset+4]))
				if size < 4 || offset+size > len(raw) {
					return ErrIncomplete
				}
				// RESOURCE_ATTRIBUTE / SCOPED_POLICY / PROCESS_TRUST_LABEL / ACCESS_FILTER
				// are not implemented by the fixed ordinary-file-v2 restoration matrix.
				if raw[offset] >= 0x12 {
					return fmt.Errorf("%w: special security ACE 0x%x", ErrIncomplete, raw[offset])
				}
				offset += size
			}
		}
		security, err := selfRelativeBytes(sd)
		if err != nil {
			return err
		}
		s := &Snapshot{Version: MatrixVersion, Platform: "windows", Matrix: "ordinary-file-v2", Security: security, Attributes: basic.Attributes, Creation: uint64(basic.Creation), LastAccess: uint64(basic.Access), LastWrite: uint64(basic.Write), ChangeTime: uint64(basic.Change), ReadAccessAfter: uint64(basic.Access), Streams: []Stream{}, Manifest: map[string]string{}}
		for _, f := range requiredFields {
			s.Manifest[f] = "captured_exact"
		}
		s.Manifest["specialSecurity"] = "known_absent"
		inventory, err = readNativeInventory(ctx, original, h, ordinaryState.stableReadObjectState, info.Size())
		if err != nil {
			return err
		}
		var afterRead basicInformation
		if err := windows.GetFileInformationByHandleEx(h, windows.FileBasicInfo, (*byte)(unsafe.Pointer(&afterRead)), uint32(unsafe.Sizeof(afterRead))); err != nil {
			return err
		}
		s.ReadAccessAfter = uint64(afterRead.Access)
		if basic.Creation != afterRead.Creation || basic.Write != afterRead.Write || basic.Attributes != afterRead.Attributes {
			return fmt.Errorf("native metadata changed during capture")
		}
		// EA/ADS payloads are read only after this elevated worker has joined.
		// Inside the restricted scope verify ID/volume and every basic field;
		// full normalized slot validation follows after joining this worker.
		currentOrdinary, ordinaryErr := inspectStableReadObject(original, ctx)
		currentSecurity, securityErr := inspectStableReadObject(h, ctx)
		if ordinaryErr != nil || securityErr != nil || currentOrdinary != ordinaryState.stableReadObjectState || currentSecurity != ordinaryState.stableReadObjectState {
			return fmt.Errorf("native identity/basic changed during stable capture")
		}
		captured = s
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	// Ordinary-context payload reads: no SeBackup/SeSecurity worker token and
	// no path/opened-name substitute for the original live canonical binding.
	if err := verifyStableReadCompletion(original, h, ordinaryState, ctx); err != nil {
		return nil, err
	}
	captured.EA, err = readNativeEA(ctx, original, ordinaryState)
	if err != nil {
		return nil, err
	}
	if inventory.EASeen != (len(captured.EA) > 0) || inventory.EASize != uint64(len(captured.EA)) {
		return nil, fmt.Errorf("native EA inventory/raw presence or length mismatch")
	}
	captured.Streams, err = readNativeStreams(ctx, original, ordinaryState, info.Size(), inventory.Streams)
	if err != nil {
		return nil, err
	}
	if len(captured.EA) == 0 {
		captured.Manifest["ea"] = "known_absent"
	}
	if len(captured.Streams) == 0 {
		captured.Manifest["streams"] = "known_absent"
	}
	if err := verifyStableReadCompletion(original, h, ordinaryState, ctx); err != nil {
		return nil, err
	}
	after, err := inspectStableReadObject(original, ctx)
	if err != nil {
		return nil, err
	}
	captured.ReadAccessAfter = uint64(after.Basic.Access)
	if _, err := Encode(captured); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return captured, nil
}

type backupIO struct {
	handle   windows.Handle
	state    uintptr
	write    bool
	security bool
}

func (b *backupIO) close() {
	if b.state == 0 {
		return
	}
	p := backupRead
	if b.write {
		p = backupWrite
	}
	var n uint32
	var processSecurity uintptr
	if b.security {
		processSecurity = 1
	}
	observeBackupSDK(backupSDKEvent{Stage: "before-abort", Handle: b.handle, Write: b.write, Security: b.security, Abort: true})
	ok, _, callErr := p.Call(uintptr(b.handle), 0, 0, uintptr(unsafe.Pointer(&n)), 1, processSecurity, uintptr(unsafe.Pointer(&b.state)))
	observeBackupSDK(backupSDKEvent{Stage: "after-abort", Handle: b.handle, Write: b.write, Security: b.security, Abort: true, Success: ok != 0, Actual: uint64(n), Win32: win32Code(callErr)})
	b.state = 0
}
func (b *backupIO) transfer(data []byte) (int, error) {
	if len(data) == 0 {
		return 0, nil
	}
	var n uint32
	p := backupRead
	if b.write {
		p = backupWrite
	}
	var processSecurity uintptr
	if b.security {
		processSecurity = 1
	}
	observeBackupSDK(backupSDKEvent{Stage: "before-transfer", Handle: b.handle, Write: b.write, Security: b.security, Requested: uint64(len(data))})
	ok, _, err := p.Call(uintptr(b.handle), uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)), uintptr(unsafe.Pointer(&n)), 0, processSecurity, uintptr(unsafe.Pointer(&b.state)))
	observeBackupSDK(backupSDKEvent{Stage: "after-transfer", Handle: b.handle, Write: b.write, Security: b.security, Requested: uint64(len(data)), Actual: uint64(n), Success: ok != 0, Win32: win32Code(err)})
	if ok == 0 {
		return int(n), err
	}
	if n == 0 && !b.write {
		return 0, io.EOF
	}
	if n == 0 {
		return 0, io.ErrShortWrite
	}
	return int(n), nil
}
func (b *backupIO) full(ctx context.Context, data []byte) error {
	for offset := 0; offset < len(data); {
		if err := ctx.Err(); err != nil {
			return err
		}
		end := offset + (64 << 10)
		if end > len(data) {
			end = len(data)
		}
		n, err := b.transfer(data[offset:end])
		offset += n
		if err != nil {
			if err == io.EOF && offset > 0 {
				return io.ErrUnexpectedEOF
			}
			return err
		}
	}
	return nil
}
func (b *backupIO) skip(size uint64) error {
	var lo, hi uint32
	observeBackupSDK(backupSDKEvent{Stage: "before-seek", Handle: b.handle, Requested: size})
	ok, _, err := backupSeek.Call(uintptr(b.handle), uintptr(uint32(size)), uintptr(uint32(size>>32)), uintptr(unsafe.Pointer(&lo)), uintptr(unsafe.Pointer(&hi)), uintptr(unsafe.Pointer(&b.state)))
	observeBackupSDK(backupSDKEvent{Stage: "after-seek", Handle: b.handle, Requested: size, Actual: uint64(hi)<<32 | uint64(lo), Success: ok != 0, Win32: win32Code(err)})
	if ok == 0 {
		return err
	}
	if uint64(hi)<<32|uint64(lo) != size {
		return io.ErrUnexpectedEOF
	}
	return nil
}
func readBackup(ctx context.Context, h windows.Handle, s *Snapshot) error {
	b := backupIO{handle: h}
	defer b.close()
	var total int64
	streams := 0
	eaSeen := false
	// A bounded count also constrains hostile BackupRead streams before allocation.
	for records := 0; records < StreamCount+8; records++ {
		var header [20]byte
		err := b.full(ctx, header[:])
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		id := binary.LittleEndian.Uint32(header[:4])
		flags := binary.LittleEndian.Uint32(header[4:8])
		size := binary.LittleEndian.Uint64(header[8:16])
		nameSize := binary.LittleEndian.Uint32(header[16:20])
		if nameSize > 65536 || nameSize%2 != 0 || size > 1<<63-1 {
			return ErrIncomplete
		}
		name := make([]byte, nameSize)
		if err := b.full(ctx, name); err != nil {
			return err
		}
		switch id {
		case 1: // main data was separately captured by history with its own budget.
			if nameSize != 0 || flags != 0 {
				return ErrIncomplete
			}
			if err := b.skip(size); err != nil {
				return err
			}
		case 2: // BACKUP_EA_DATA
			if eaSeen || nameSize != 0 || size > EABytes {
				return fmt.Errorf("%w: EA budget/type", ErrIncomplete)
			}
			eaSeen = true
			s.EA = make([]byte, int(size))
			if err := b.full(ctx, s.EA); err != nil {
				return err
			}
		case 4: // BACKUP_ALTERNATE_DATA
			streams++
			total += int64(size)
			if streams > StreamCount || total > StreamBytes || flags != 0 {
				return fmt.Errorf("%w: ADS budget/type", ErrIncomplete)
			}
			wide := make([]uint16, len(name)/2)
			for i := range wide {
				wide[i] = binary.LittleEndian.Uint16(name[i*2:])
			}
			streamName := windows.UTF16ToString(wide)
			if !validStreamName(streamName) {
				return ErrIncomplete
			}
			data := make([]byte, int(size))
			if err := b.full(ctx, data); err != nil {
				return err
			}
			store := blobs(ctx)
			if store == nil {
				return fmt.Errorf("%w: stream CAS is not configured", ErrIncomplete)
			}
			digest, err := store.Put(ctx, data)
			if err != nil {
				return err
			}
			if digest != Digest(data) {
				return ErrIncomplete
			}
			s.Streams = append(s.Streams, Stream{Name: streamName, Size: int64(size), Digest: digest})
		case 3: // not requested: bProcessSecurity=FALSE, reject surprising security stream
			return fmt.Errorf("%w: unexpected backup security stream", ErrIncomplete)
		default:
			return fmt.Errorf("%w: unsupported backup stream %d", ErrIncomplete, id)
		}
	}
	return fmt.Errorf("%w: backup record budget", ErrIncomplete)
}

// ApplyExact is a low-level primitive for a legitimately authorized token, not
// an RPC endpoint. The helper calls it ONLY with its own verified stored record.
func ApplyExact(ctx context.Context, file *os.File, s *Snapshot) error {
	if err := s.Validate(); err != nil {
		return err
	}
	_, err := descriptor(s.Security)
	if err != nil {
		return err
	}
	// Resolve every immutable stream before any mutation.
	data := make([][]byte, len(s.Streams))
	for i, stream := range s.Streams {
		store := blobs(ctx)
		if store == nil {
			return ErrIncomplete
		}
		data[i], err = store.Get(ctx, stream.Digest, stream.Size)
		if err != nil {
			return err
		}
		if int64(len(data[i])) != stream.Size || Digest(data[i]) != stream.Digest {
			return ErrIncomplete
		}
	}
	return Privileged(ctx, []string{"SeSecurityPrivilege", "SeBackupPrivilege", "SeRestorePrivilege"}, func() error {
		h, err := Reopen(windows.Handle(file.Fd()), windows.GENERIC_READ|windows.GENERIC_WRITE|windows.READ_CONTROL|windows.WRITE_DAC|windows.WRITE_OWNER|windows.ACCESS_SYSTEM_SECURITY)
		if err != nil {
			return fmt.Errorf("%w: exact restore rights: %v", ErrHelperRequired, err)
		}
		defer windows.CloseHandle(h)
		current, err := validateOrdinary(h)
		if err != nil {
			return err
		}
		// This primitive restores a prepared object. Foreign streams/EA are not
		// silently merged. A nonempty existing set must match the stored set exactly.
		observed := &Snapshot{Streams: []Stream{}}
		if err := readBackup(ctx, h, observed); err != nil {
			return err
		}
		if len(observed.Streams) > 0 || len(observed.EA) > 0 {
			if !bytes.Equal(observed.EA, s.EA) || len(observed.Streams) != len(s.Streams) {
				return fmt.Errorf("%w: prepared object has foreign EA/streams", ErrIncomplete)
			}
			sort.Slice(observed.Streams, func(i, j int) bool { return observed.Streams[i].Name < observed.Streams[j].Name })
			for i := range observed.Streams {
				if observed.Streams[i] != s.Streams[i] {
					return ErrIncomplete
				}
			}
		} else {
			b := backupIO{handle: h, write: true}
			defer b.close()
			writeRecord := func(id uint32, name string, content []byte) error {
				var names []uint16
				if name != "" {
					names, err = windows.UTF16FromString(name)
					if err != nil {
						return err
					}
					names = names[:len(names)-1]
				}
				header := make([]byte, 20+len(names)*2)
				binary.LittleEndian.PutUint32(header, id)
				binary.LittleEndian.PutUint64(header[8:], uint64(len(content)))
				binary.LittleEndian.PutUint32(header[16:], uint32(len(names)*2))
				for i, n := range names {
					binary.LittleEndian.PutUint16(header[20+i*2:], n)
				}
				if err := b.full(ctx, header); err != nil {
					return err
				}
				return b.full(ctx, content)
			}
			if len(s.EA) > 0 {
				if err := writeRecord(2, "", s.EA); err != nil {
					return err
				}
			}
			for i, stream := range s.Streams {
				if err := writeRecord(4, stream.Name, data[i]); err != nil {
					return err
				}
			}
			// Finish BackupWrite before restoring times/attributes: closing its
			// stream context after SetFileBasicInfo can otherwise change them again.
			b.close()
		}
		// Use the helper-owned self-relative security backup record rather than
		// selectively installing ACLs. Strict Matches still proves all control
		// bits and absent/present-null SACL state after this operation.
		securityWriter := backupIO{handle: h, write: true, security: true}
		defer securityWriter.close()
		securityHeader := make([]byte, 20)
		binary.LittleEndian.PutUint32(securityHeader, 3)     // BACKUP_SECURITY_DATA
		binary.LittleEndian.PutUint32(securityHeader[4:], 2) // STREAM_CONTAINS_SECURITY
		binary.LittleEndian.PutUint64(securityHeader[8:], uint64(len(s.Security)))
		if err := securityWriter.full(ctx, securityHeader); err != nil {
			return fmt.Errorf("write original security record header: %w", err)
		}
		if err := securityWriter.full(ctx, s.Security); err != nil {
			return fmt.Errorf("write original security record: %w", err)
		}
		securityWriter.close()
		current.Creation = int64(s.Creation)
		current.Access = int64(s.LastAccess)
		current.Write = int64(s.LastWrite)
		current.Change = 0
		current.Attributes = s.Attributes
		if err := windows.SetFileInformationByHandle(h, windows.FileBasicInfo, (*byte)(unsafe.Pointer(current)), uint32(unsafe.Sizeof(*current))); err != nil {
			return err
		}
		return nil
	})
}
func Matches(ctx context.Context, file *os.File, s *Snapshot) error {
	current, err := Capture(ctx, file)
	if err != nil {
		return err
	}
	a, err := SnapshotFingerprint(s)
	if err != nil {
		return err
	}
	b, err := SnapshotFingerprint(current)
	if err != nil {
		return err
	}
	if a != b {
		return fmt.Errorf("native_metadata_changed")
	}
	return nil
}
