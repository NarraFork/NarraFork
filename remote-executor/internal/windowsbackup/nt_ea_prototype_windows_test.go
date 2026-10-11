//go:build windows

package windowsbackup

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"os"
	"runtime"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// TEST ONLY. EA capture is not a full-matrix/restore capability. No production
// capture, BackupRead, privilege scope, snapshot comparison or DTO is changed.
type ntEAPrototypeCounters struct {
	Queries, SizeQueries, Writes, Restarts int
	Statuses                               []uint32
	Log                                    func(string, ...any)
}

func (c *ntEAPrototypeCounters) report(format string, args ...any) {
	if c.Log != nil {
		c.Log(format, args...)
	}
}

type ntEAPrototypeResult struct {
	Raw      []byte
	Entries  []ntEAPrototypeEntry
	Absent   bool
	Terminal uint32
}

func ntEAPrototypeQuery(ctx context.Context, h windows.Handle, size int, restart, single bool, c *ntEAPrototypeCounters) (uint32, []byte, error) {
	if err := ctx.Err(); err != nil {
		return 0, nil, err
	}
	if size < 16 || size > EABytes {
		return 0, nil, fmt.Errorf("EA SDK page budget")
	}
	query := windows.NewLazySystemDLL("ntdll.dll").NewProc("NtQueryEaFile")
	if err := query.Find(); err != nil {
		return 0, nil, fmt.Errorf("NtQueryEaFile unavailable win32=%d", win32Code(err))
	}
	buffer := make([]byte, size)
	var io ntPrototypeIOStatus
	var first, one uintptr
	if restart {
		first = 1
		c.Restarts++
	}
	if single {
		one = 1
	}
	c.Queries++
	status, _, _ := query.Call(uintptr(h), uintptr(unsafe.Pointer(&io)), uintptr(unsafe.Pointer(&buffer[0])), uintptr(size), one, 0, 0, 0, first)
	runtime.KeepAlive(buffer)
	code := uint32(status)
	c.Statuses = append(c.Statuses, code)
	c.report("EA NtQueryEaFile status=0x%08x ioStatus=0x%08x bytes=%d page=%d restart=%t single=%t", code, uint32(io.Status), io.Information, size, restart, single)
	if io.Information > uintptr(size) {
		return code, nil, fmt.Errorf("EA SDK returned length outside buffer")
	}
	if code == 0 && uint32(io.Status) != 0 {
		return code, nil, fmt.Errorf("EA SDK incomplete synchronous reply")
	}
	if err := ctx.Err(); err != nil {
		return code, nil, err
	}
	return code, bytes.Clone(buffer[:int(io.Information)]), nil
}

func ntEAPrototypeSize(ctx context.Context, h windows.Handle, c *ntEAPrototypeCounters) (uint32, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	query := windows.NewLazySystemDLL("ntdll.dll").NewProc("NtQueryInformationFile")
	if err := query.Find(); err != nil {
		return 0, fmt.Errorf("FileEaInformation unavailable win32=%d", win32Code(err))
	}
	var value uint32
	var io ntPrototypeIOStatus
	c.SizeQueries++
	status, _, _ := query.Call(uintptr(h), uintptr(unsafe.Pointer(&io)), uintptr(unsafe.Pointer(&value)), unsafe.Sizeof(value), 7)
	c.report("EA FileEaInformation status=0x%08x bytes=%d EaSize=%d", uint32(status), io.Information, value)
	if uint32(status) != 0 {
		return 0, ntPrototypeStatus("FileEaInformation", status)
	}
	if uint32(io.Status) != 0 || io.Information != unsafe.Sizeof(value) {
		return 0, fmt.Errorf("EA size reply incomplete")
	}
	return value, nil
}

func ntEAPrototypeRequireRead(h windows.Handle, c *ntEAPrototypeCounters) error {
	mask, err := ntPrototypeGrantedAccess(h)
	if err != nil {
		return err
	}
	c.report("EA ordinary GrantedAccess=0x%08x READ_EA_granted=%t", mask, mask&windows.FILE_READ_EA != 0)
	if mask&windows.FILE_READ_EA == 0 {
		return fmt.Errorf("original ordinary handle lacks READ_EA")
	}
	return nil
}

func ntEAPrototypeCapture(ctx context.Context, root, original *os.File, pageSize int, single bool, c *ntEAPrototypeCounters) (ntEAPrototypeResult, error) {
	defer runtime.KeepAlive(root)
	defer runtime.KeepAlive(original)
	var result ntEAPrototypeResult
	if err := ctx.Err(); err != nil {
		return result, err
	}
	h := windows.Handle(original.Fd())
	if err := ntEAPrototypeRequireRead(h, c); err != nil {
		return result, err
	}
	binding, err := newNTPrototypeBinding(windows.Handle(root.Fd()), h)
	if err != nil {
		return result, err
	}
	if pageSize < 16 || pageSize > EABytes {
		return result, fmt.Errorf("EA initial page budget")
	}
	// Retry a too-small page only by explicitly restarting the entire scan with
	// a larger bounded buffer. Do not guess how an error affected its cursor.
	for {
		entries := make([]ntEAPrototypeEntry, 0)
		seen := map[string]bool{}
		encodedSize := 0
		grow := false
		for step := 0; step <= ntEAPrototypeMaxEntries; step++ {
			if err := binding.checkBase(); err != nil {
				return result, err
			}
			status, raw, err := ntEAPrototypeQuery(ctx, h, pageSize, step == 0, single, c)
			if err != nil {
				return result, err
			}
			if err := binding.checkBase(); err != nil {
				return result, err
			}
			outcome, err := ntEAPrototypeReply(status, len(raw), len(entries) > 0)
			if err != nil {
				return result, err
			}
			if outcome == "grow" {
				if pageSize == EABytes {
					return result, fmt.Errorf("one EA cannot fit 64KiB")
				}
				pageSize *= 2
				if pageSize > EABytes {
					pageSize = EABytes
				}
				grow = true
				break
			}
			if outcome == "absent" {
				size, err := ntEAPrototypeSize(ctx, h, c)
				if err != nil {
					return result, err
				}
				if size != 0 {
					return result, fmt.Errorf("EA absence contradicted by native size")
				}
				if err := binding.checkBase(); err != nil {
					return result, err
				}
				return ntEAPrototypeResult{Absent: true, Terminal: status}, nil
			}
			if outcome == "done" {
				// A single full restart query cross-checks page completeness and
				// yields the original NT raw bytes, not a guessed repacked encoding.
				fullStatus, fullRaw, err := ntEAPrototypeQuery(ctx, h, EABytes, true, false, c)
				if err != nil {
					return result, err
				}
				if fullStatus != ntEAStatusSuccess {
					return result, fmt.Errorf("EA full cross-check not complete status=0x%08x", fullStatus)
				}
				full, err := parseNTPrototypeEA(fullRaw)
				if err != nil {
					return result, err
				}
				if !ntEAPrototypeEqual(entries, full) {
					return result, fmt.Errorf("EA paged/full enumeration disagreed")
				}
				if err := binding.checkBase(); err != nil {
					return result, err
				}
				return ntEAPrototypeResult{Raw: fullRaw, Entries: full, Terminal: status}, nil
			}
			page, err := parseNTPrototypeEA(raw)
			if err != nil {
				return result, err
			}
			for _, entry := range page {
				key := ntEAPrototypeNameKey(entry.Name)
				if seen[key] {
					return result, fmt.Errorf("EA duplicate across pages")
				}
				seen[key] = true
				encodedSize = (encodedSize + 3) &^ 3
				encodedSize += 8 + len(entry.Name) + 1 + len(entry.Value)
				if encodedSize > EABytes || len(entries) >= ntEAPrototypeMaxEntries {
					return result, fmt.Errorf("EA aggregate/count budget")
				}
				entries = append(entries, entry)
			}
		}
		if grow {
			continue
		}
		return result, fmt.Errorf("EA enumeration did not prove completion")
	}
}

func ntEAPrototypeFixture(t *testing.T, ads bool, entries []ntEAPrototypeEntry) (*os.File, *os.File, string) {
	t.Helper()
	var root, original *os.File
	var path string
	if ads {
		root, original, path = ntPrototypeFixture(t, []byte("[ZoneTransfer]\r\nZoneId=3\r\n"))
	} else {
		root, original, path = ntPrototypeFixture(t)
	}
	if len(entries) == 0 {
		return root, original, path
	}
	raw := ntEAPrototypeEncode(entries)
	if _, err := parseNTPrototypeEA(raw); err != nil {
		t.Fatal("EA fixture input malformed", err)
	}
	writer, err := openOrdinary(path, windows.FILE_WRITE_EA|windows.FILE_READ_ATTRIBUTES|windows.SYNCHRONIZE)
	if err != nil {
		t.Fatalf("ordinary WRITE_EA fixture open win32=%d", win32Code(err))
	}
	mask, err := ntPrototypeGrantedAccess(windows.Handle(writer.Fd()))
	if err != nil {
		writer.Close()
		t.Fatal(err)
	}
	if mask&windows.FILE_WRITE_EA == 0 {
		writer.Close()
		t.Fatal("fixture writer lacks actual WRITE_EA")
	}
	t.Logf("EA fixture ordinary writer GrantedAccess=0x%08x; no privileged setup", mask)
	set := windows.NewLazySystemDLL("ntdll.dll").NewProc("NtSetEaFile")
	if err := set.Find(); err != nil {
		writer.Close()
		t.Fatal("NtSetEaFile unavailable")
	}
	var io ntPrototypeIOStatus
	status, _, _ := set.Call(uintptr(writer.Fd()), uintptr(unsafe.Pointer(&io)), uintptr(unsafe.Pointer(&raw[0])), uintptr(len(raw)))
	runtime.KeepAlive(raw)
	closeErr := writer.Close()
	t.Logf("EA fixture NtSetEaFile status=0x%08x ioStatus=0x%08x writerClosed=%t rawBytes=%d rawSHA256=%s", uint32(status), uint32(io.Status), closeErr == nil, len(raw), Digest(raw))
	if uint32(status) != 0 || uint32(io.Status) != 0 || closeErr != nil {
		t.Fatal("ordinary EA fixture creation failed; no privilege fallback")
	}
	return root, original, path
}
func ntEAPrototypeValues() []ntEAPrototypeEntry {
	return []ntEAPrototypeEntry{{0, []byte("NF_ALPHA"), []byte{1, 2, 3, 4}}, {0, []byte("NF_BINARY"), []byte{0, 1, 255, 0, 127, 16, 3}}}
}

func TestNativeWindowsEAPrototypeCapture(t *testing.T) {
	requirePreparedScratch(t)
	for _, kind := range []string{"empty", "empty-with-ads", "nonempty", "nonempty-with-ads", "read-ea-without-writeattrs", "large-single-record-growth"} {
		t.Run(kind, func(t *testing.T) {
			var want []ntEAPrototypeEntry
			if kind != "empty" && kind != "empty-with-ads" {
				want = ntEAPrototypeValues()
			}
			if kind == "large-single-record-growth" {
				want = []ntEAPrototypeEntry{{0, []byte("NF_LARGE"), bytes.Repeat([]byte{1, 0, 255, 4}, 1500)}}
			}
			root, original, path := ntEAPrototypeFixture(t, kind == "empty-with-ads" || kind == "nonempty-with-ads", want)
			if kind == "read-ea-without-writeattrs" {
				reader, err := openOrdinary(path, windows.FILE_READ_EA|windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL|windows.SYNCHRONIZE)
				if err != nil {
					t.Fatal("ordinary READ_EA fixture open failed")
				}
				defer reader.Close()
				original = reader
				mask, err := ntPrototypeGrantedAccess(windows.Handle(original.Fd()))
				if err != nil || mask&windows.FILE_WRITE_ATTRIBUTES != 0 {
					t.Fatal("READ_EA-only fixture unexpectedly grants write attributes")
				}
			}
			before, err := inspectStableReadObject(windows.Handle(original.Fd()))
			if err != nil {
				t.Fatal(err)
			}
			privileges := nativeTokenPrivileges(t)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			c := &ntEAPrototypeCounters{Log: t.Logf}
			result, err := ntEAPrototypeCapture(ctx, root, original, 32, true, c)
			sdkBasicEvidence(t, "EA.afterCapture", windows.Handle(original.Fd()), before)
			if err != nil {
				t.Fatal("ordinary EA SDK capture failed (no snapshot/proof)", err)
			}
			if !ntEAPrototypeEqual(result.Entries, want) || result.Absent != (len(want) == 0) {
				t.Fatal("EA raw fields or absence proof differed")
			}
			if len(result.Raw) > EABytes {
				t.Fatal("EA byte budget exceeded")
			}
			after, err := inspectStableReadObject(windows.Handle(original.Fd()))
			if err != nil || after != before {
				t.Fatal("EA query changed original ID/basic/LastAccess")
			}
			if !bytes.Equal(privileges, nativeTokenPrivileges(t)) {
				t.Fatal("EA reader changed process privileges")
			}
			t.Logf("EA ordinary capture verified rawBytes=%d rawSHA256=%s entries=%d explicitAbsent=%t terminal=0x%08x queries=%d restarts=%d originalFullBasicEqual=true", len(result.Raw), Digest(result.Raw), len(result.Entries), result.Absent, result.Terminal, c.Queries, c.Restarts)
		})
	}
}

func TestNativeWindowsEAPrototypeRawBackupFormat(t *testing.T) {
	requirePreparedScratch(t)
	for _, empty := range []bool{false, true} {
		t.Run(map[bool]string{false: "nonempty-unaligned-binary-values", true: "empty"}[empty], func(t *testing.T) {
			var want []ntEAPrototypeEntry
			if !empty {
				want = ntEAPrototypeValues()
			}
			root, original, _ := ntEAPrototypeFixture(t, false, want)
			before, err := inspectStableReadObject(windows.Handle(original.Fd()))
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			c := &ntEAPrototypeCounters{Log: t.Logf}
			result, err := ntEAPrototypeCapture(ctx, root, original, 48, false, c)
			if err != nil {
				t.Fatal(err)
			}
			// No ADS: unchanged readBackup is a legitimate reference for the exact
			// Snapshot.EA bytes subsequently passed to BACKUP_EA_DATA by ApplyExact.
			// Use only ordinary rights on a separate live object; no SeRestore setup.
			expected, err := inspectStableRead(windows.Handle(original.Fd()))
			if err != nil {
				t.Fatal(err)
			}
			h, err := reopenStableRead(windows.Handle(original.Fd()), windows.GENERIC_READ|windows.READ_CONTROL, expected)
			if err != nil {
				t.Fatal("ordinary reference reader open", err)
			}
			defer windows.CloseHandle(h)
			reference := &Snapshot{Streams: []Stream{}}
			readErr := readBackup(ctx, h, reference)
			t.Logf("EA reference BackupRead success=%t NTrawBytes=%d BackupEABytes=%d NTrawSHA256=%s BackupEASHA256=%s exactBytesEqual=%t", readErr == nil, len(result.Raw), len(reference.EA), Digest(result.Raw), Digest(reference.EA), bytes.Equal(result.Raw, reference.EA))
			if readErr != nil {
				t.Fatal("reference BackupRead did not prove supported complete inventory", readErr)
			}
			if len(reference.Streams) != 0 {
				t.Fatal("reference fixture unexpectedly has ADS")
			}
			if !empty {
				decoded, err := parseNTPrototypeEA(reference.EA)
				if err != nil || !ntEAPrototypeEqual(decoded, result.Entries) {
					t.Fatal("BackupRead EA is not the same complete FILE_FULL_EA list", err)
				}
			}
			if !bytes.Equal(result.Raw, reference.EA) {
				t.Fatal("NT EA and Snapshot.EA/BackupWrite input are NOT byte-identical; no guessed normalization")
			}
			after, err := inspectStableReadObject(windows.Handle(original.Fd()))
			if err != nil || after != before {
				t.Fatal("reference read changed original full basic/LastAccess")
			}
		})
	}
}

func TestNativeWindowsEAPrototypeReadAuthorityRefusals(t *testing.T) {
	requirePreparedScratch(t)
	for _, denyACL := range []bool{false, true} {
		t.Run(map[bool]string{false: "granted-handle-without-read-ea", true: "actual-acl-deny-read-ea"}[denyACL], func(t *testing.T) {
			root, _, path := ntEAPrototypeFixture(t, true, ntEAPrototypeValues())
			if denyACL {
				setup, err := openOrdinary(path, windows.READ_CONTROL|windows.WRITE_DAC)
				if err != nil {
					t.Fatal("EA deny setup handle failed")
				}
				defer setup.Close()
				user, err := windows.GetCurrentProcessToken().GetTokenUser()
				if err != nil {
					t.Fatal("EA deny user query failed")
				}
				sd, err := windows.SecurityDescriptorFromString("D:P(D;;0x8;;;WD)(A;;FA;;;" + user.User.Sid.String() + ")")
				if err != nil {
					t.Fatal("EA deny descriptor invalid")
				}
				acl, _, err := sd.DACL()
				if err != nil {
					t.Fatal("EA deny ACL invalid")
				}
				if err := windows.SetSecurityInfo(windows.Handle(setup.Fd()), windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
					t.Fatal("EA deny install failed")
				}
				if f, err := openOrdinary(path, windows.FILE_READ_EA|windows.FILE_READ_ATTRIBUTES); err == nil {
					f.Close()
					t.Fatal("EA deny fixture allowed ordinary READ_EA")
				}
			}
			reader, err := openOrdinary(path, windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL|windows.SYNCHRONIZE)
			if err != nil {
				t.Fatal("EA mask-limited handle unavailable")
			}
			defer reader.Close()
			before, err := inspectStableReadObject(windows.Handle(reader.Fd()))
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			c := &ntEAPrototypeCounters{Log: t.Logf}
			if result, err := ntEAPrototypeCapture(ctx, root, reader, 32, true, c); err == nil || result.Absent || c.Queries != 0 {
				t.Fatal("ordinary missing READ_EA became a query/absence proof")
			}
			// Independently verify the real SDK refusal is not classified as absence.
			actual := &ntEAPrototypeCounters{Log: t.Logf}
			status, raw, err := ntEAPrototypeQuery(ctx, windows.Handle(reader.Fd()), 64, true, false, actual)
			if err != nil {
				t.Fatal(err)
			}
			if status != uint32(windows.STATUS_ACCESS_DENIED) {
				t.Fatalf("expected actual READ_EA refusal, got 0x%08x", status)
			}
			if _, err := ntEAPrototypeReply(status, len(raw), false); err == nil {
				t.Fatal("actual denied query became known absent")
			}
			after, err := inspectStableReadObject(windows.Handle(reader.Fd()))
			if err != nil || after != before {
				t.Fatal("denied EA query changed original basic metadata")
			}
			t.Logf("ordinary refusal queryCount=%d; separate direct SDK refusal status=0x%08x, not knownAbsent", c.Queries, status)
		})
	}
}

// Ensure the fixture encoder remains unaligned at its last record: the raw
// compatibility test must not accidentally hide trailing-padding differences.
func TestNTEAPrototypeFixtureHasUnalignedTail(t *testing.T) {
	raw := ntEAPrototypeEncode(ntEAPrototypeValues())
	if len(raw)%4 == 0 || binary.LittleEndian.Uint32(raw) == 0 {
		t.Fatal("EA format counterfixture lost alignment coverage")
	}
}
