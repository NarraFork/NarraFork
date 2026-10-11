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
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// TEST ONLY. Counts describe bytes delivered by BackupRead, not hidden kernel
// IO. Full basic/LastAccess checks decide whether header/seek traversal is safe.
type backupHeaderAuditCounters struct {
	Types                                                          []uint32
	ReadCalls, SeekCalls, AbortCalls, AbortSuccess, HandleCloses   int
	HeaderBytes, NameBytes, DeliveredBytes, PayloadRead, SeekBytes uint64
	Complete                                                       bool
	FirstChangedStage                                              string
	Log                                                            func(string, ...any)
}

func (c *backupHeaderAuditCounters) report(format string, args ...any) {
	if c.Log != nil {
		c.Log(format, args...)
	}
}

type backupHeaderAuditIO struct {
	handle  windows.Handle
	state   uintptr
	c       *backupHeaderAuditCounters
	binding *ntPrototypeBinding
}

func (a *backupHeaderAuditIO) readMetadata(ctx context.Context, data []byte, header bool) error {
	for offset := 0; offset < len(data); {
		if err := ctx.Err(); err != nil {
			return err
		}
		var n uint32
		a.c.ReadCalls++
		ok, _, callErr := backupRead.Call(uintptr(a.handle), uintptr(unsafe.Pointer(&data[offset])), uintptr(len(data)-offset), uintptr(unsafe.Pointer(&n)), 0, 0, uintptr(unsafe.Pointer(&a.state)))
		if n > uint32(len(data)-offset) {
			return fmt.Errorf("audit metadata read overflow")
		}
		a.c.DeliveredBytes += uint64(n)
		if header {
			a.c.HeaderBytes += uint64(n)
		} else {
			a.c.NameBytes += uint64(n)
		}
		offset += int(n)
		if ok == 0 {
			return fmt.Errorf("audit BackupRead metadata win32=%d", win32Code(callErr))
		}
		if n == 0 {
			if offset == 0 {
				return io.EOF
			}
			return io.ErrUnexpectedEOF
		}
	}
	return nil
}
func (a *backupHeaderAuditIO) observe(stage string) error {
	if err := a.binding.checkSameObject(a.handle); err == nil {
		return nil
	}
	if a.c.FirstChangedStage == "" {
		a.c.FirstChangedStage = stage
	}
	for _, item := range []struct {
		name   string
		handle windows.Handle
	}{{"original", a.binding.original}, {"audit", a.handle}} {
		actual, err := inspectStableReadObject(item.handle)
		if err != nil {
			a.c.report("audit stability stage=%s handle=%s queryFailed=true win32=%d", stage, item.name, win32Code(err))
			continue
		}
		before := a.binding.originalState
		a.c.report("audit stability stage=%s handle=%s IDEqual=%t creationEqual=%t accessEqual=%t writeEqual=%t changeEqual=%t attributesEqual=%t initialAccess=%d actualAccess=%d", stage, item.name, actual.ID == before.ID, actual.Basic.Creation == before.Basic.Creation, actual.Basic.Access == before.Basic.Access, actual.Basic.Write == before.Basic.Write, actual.Basic.Change == before.Basic.Change, actual.Basic.Attributes == before.Basic.Attributes, before.Basic.Access, actual.Basic.Access)
	}
	return fmt.Errorf("audit original identity/full basic/canonical changed stage=%s", stage)
}
func (a *backupHeaderAuditIO) skip(ctx context.Context, size uint64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if size == 0 {
		return nil
	}
	var low, high uint32
	a.c.SeekCalls++
	ok, _, callErr := backupSeek.Call(uintptr(a.handle), uintptr(uint32(size)), uintptr(uint32(size>>32)), uintptr(unsafe.Pointer(&low)), uintptr(unsafe.Pointer(&high)), uintptr(unsafe.Pointer(&a.state)))
	actual := uint64(high)<<32 | uint64(low)
	a.c.SeekBytes += actual
	if ok == 0 {
		return fmt.Errorf("audit BackupSeek win32=%d", win32Code(callErr))
	}
	if actual != size {
		return fmt.Errorf("audit BackupSeek partial payload skip")
	}
	return ctx.Err()
}
func (a *backupHeaderAuditIO) abort() error {
	if a.state == 0 {
		return nil
	}
	var n uint32
	a.c.AbortCalls++
	ok, _, callErr := backupRead.Call(uintptr(a.handle), 0, 0, uintptr(unsafe.Pointer(&n)), 1, 0, uintptr(unsafe.Pointer(&a.state)))
	if ok == 0 {
		return fmt.Errorf("audit abort win32=%d", win32Code(callErr))
	}
	a.state = 0
	a.c.AbortSuccess++
	if n != 0 {
		return fmt.Errorf("audit abort unexpectedly delivered bytes")
	}
	return nil
}

func runBackupHeaderAudit(ctx context.Context, root, original *os.File, c *backupHeaderAuditCounters) (resultErr error) {
	defer runtime.KeepAlive(root)
	defer runtime.KeepAlive(original)
	if err := ctx.Err(); err != nil {
		return err
	}
	granted, err := ntPrototypeGrantedAccess(windows.Handle(original.Fd()))
	if err != nil {
		return err
	}
	if granted&ntPrototypeStreamAccess != ntPrototypeStreamAccess {
		return fmt.Errorf("audit original lacks ordinary data/EA/attributes rights")
	}
	binding, err := newNTPrototypeBinding(windows.Handle(root.Fd()), windows.Handle(original.Fd()))
	if err != nil {
		return err
	}
	expected, err := stabilizeOrdinaryRead(binding.original)
	if err != nil {
		return err
	}
	info, err := original.Stat()
	if err != nil {
		return fmt.Errorf("audit main stat win32=%d", win32Code(err))
	}
	if info.Size() < 0 || info.Size() > StreamBytes {
		return fmt.Errorf("audit prototype main budget")
	}
	// No privilege scope or backup/security right is borrowed. The fixed native
	// file object is retained through context abort, close and final base check.
	h, err := reopenStableRead(binding.original, windows.GENERIC_READ|windows.READ_CONTROL, expected)
	if err != nil {
		return err
	}
	a := backupHeaderAuditIO{handle: h, c: c, binding: binding}
	reachedEOF := false
	defer func() {
		resultErr = errors.Join(resultErr, a.abort())
		resultErr = errors.Join(resultErr, a.observe("after-abort"))
		c.HandleCloses++
		if err := windows.CloseHandle(h); err != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("audit handle close win32=%d", win32Code(err)))
		}
		if err := binding.checkBase(); err != nil {
			if c.FirstChangedStage == "" {
				c.FirstChangedStage = "after-handle-close"
			}
			resultErr = errors.Join(resultErr, err)
		}
		if c.DeliveredBytes != c.HeaderBytes+c.NameBytes {
			c.PayloadRead = c.DeliveredBytes - c.HeaderBytes - c.NameBytes
			resultErr = errors.Join(resultErr, fmt.Errorf("audit delivered payload bytes"))
		}
		resultErr = errors.Join(resultErr, ctx.Err())
		c.Complete = resultErr == nil && reachedEOF
	}()
	if err := a.observe("before-header"); err != nil {
		return err
	}
	mainSeen, eaSeen := false, false
	adsCount := 0
	var adsBytes uint64
	for recordIndex := 0; recordIndex < StreamCount+8; recordIndex++ {
		var raw [20]byte
		err := a.readMetadata(ctx, raw[:], true)
		if err == io.EOF {
			if info.Size() > 0 && !mainSeen {
				return fmt.Errorf("audit missed nonempty main stream header")
			}
			reachedEOF = true
			return nil
		}
		if err != nil {
			return err
		}
		r, decodeErr := decodeBackupHeaderAudit(raw[:])
		c.Types = append(c.Types, binary.LittleEndian.Uint32(raw[:]))
		// Record type is numeric only, even when it is unsupported.
		c.report("audit header type=%d flags=%d payloadSize=%d nameBytes=%d", r.ID, r.Flags, r.Size, r.NameBytes)
		stableErr := a.observe("after-header")
		if decodeErr != nil || stableErr != nil {
			return errors.Join(decodeErr, stableErr)
		}
		if c.HeaderBytes+c.NameBytes+uint64(r.NameBytes) > MetadataBytes+20*(StreamCount+8) {
			return fmt.Errorf("audit total header/name budget")
		}
		name := make([]byte, r.NameBytes)
		if len(name) > 0 {
			if err := a.readMetadata(ctx, name, false); err != nil {
				return err
			}
			if err := a.observe("after-name"); err != nil {
				return err
			}
		}
		switch r.ID {
		case 1:
			if mainSeen || r.Size != uint64(info.Size()) {
				return fmt.Errorf("audit main stream identity/size mismatch")
			}
			mainSeen = true
		case 2:
			if eaSeen {
				return fmt.Errorf("audit duplicate EA record")
			}
			eaSeen = true
		case 4:
			adsCount++
			adsBytes += r.Size
			if adsCount > StreamCount || adsBytes > StreamBytes {
				return fmt.Errorf("audit ADS count/total budget")
			}
			if _, err := decodeBackupHeaderAuditName(name); err != nil {
				return err
			}
		}
		if err := a.skip(ctx, r.Size); err != nil {
			return err
		}
		if err := a.observe("after-seek"); err != nil {
			return err
		}
	}
	return fmt.Errorf("audit backup record count budget")
}

func TestNativeWindowsBackupHeaderAuditPrototypeStability(t *testing.T) {
	requirePreparedScratch(t)
	for _, kind := range []string{"main", "ea", "ads", "ea-and-ads"} {
		t.Run(kind, func(t *testing.T) {
			var values []ntEAPrototypeEntry
			if kind == "ea" || kind == "ea-and-ads" {
				values = ntEAPrototypeValues()
			}
			root, original, _ := ntEAPrototypeFixture(t, kind == "ads" || kind == "ea-and-ads", values)
			before, err := inspectStableReadObject(windows.Handle(original.Fd()))
			if err != nil {
				t.Fatal(err)
			}
			privileges := nativeTokenPrivileges(t)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			c := &backupHeaderAuditCounters{Log: t.Logf}
			err = runBackupHeaderAudit(ctx, root, original, c)
			sdkBasicEvidence(t, "headerAudit.returned", windows.Handle(original.Fd()), before)
			t.Logf("audit counters types=%v headerBytes=%d nameBytes=%d delivered=%d payloadRead=%d seeks=%d seekBytes=%d abort=%d abortSuccess=%d handleCloses=%d complete=%t firstChangedStage=%q", c.Types, c.HeaderBytes, c.NameBytes, c.DeliveredBytes, c.PayloadRead, c.SeekCalls, c.SeekBytes, c.AbortCalls, c.AbortSuccess, c.HandleCloses, c.Complete, c.FirstChangedStage)
			if err != nil {
				t.Fatal("header-only audit failed: STOP this scheme, no read-after time refresh or fallback", err)
			}
			if !c.Complete || c.PayloadRead != 0 || c.AbortCalls != 1 || c.AbortSuccess != 1 || c.HandleCloses != 1 {
				t.Fatal("audit completion/zero-payload/lifecycle evidence missing")
			}
			expectedTypes := []uint32{1}
			if len(values) > 0 {
				expectedTypes = append(expectedTypes, 2)
			}
			if kind == "ads" || kind == "ea-and-ads" {
				expectedTypes = append(expectedTypes, 4)
			}
			if len(c.Types) != len(expectedTypes) {
				t.Fatal("audit omitted or added records")
			}
			for _, wanted := range expectedTypes {
				found := false
				for _, got := range c.Types {
					if got == wanted {
						found = true
					}
				}
				if !found {
					t.Fatalf("audit failed to observe type=%d", wanted)
				}
			}
			after, err := inspectStableReadObject(windows.Handle(original.Fd()))
			if err != nil || after != before {
				t.Fatal("audit changed original full ID/basic/LastAccess")
			}
			if !bytes.Equal(privileges, nativeTokenPrivileges(t)) {
				t.Fatal("audit changed process privileges")
			}
			t.Log("SDK header inventory only; no payload/snapshot/proof/restore or production readiness")
		})
	}
}

func TestNativeWindowsBackupHeaderAuditPrototypeRejectsObjectID(t *testing.T) {
	requirePreparedScratch(t)
	root, original, path := ntPrototypeFixture(t)
	privileges := nativeTokenPrivileges(t)
	// CREATE_OR_GET on a fresh private test file only: do not alter/delete an
	// existing object ID, and never change production/user files or use privilege.
	setup, err := openOrdinary(path, windows.FILE_READ_DATA|windows.FILE_WRITE_DATA|windows.FILE_READ_ATTRIBUTES|windows.FILE_WRITE_ATTRIBUTES|windows.SYNCHRONIZE)
	if err != nil {
		t.Fatalf("ordinary ObjectID fixture open win32=%d", win32Code(err))
	}
	mask, maskErr := ntPrototypeGrantedAccess(windows.Handle(setup.Fd()))
	if maskErr != nil {
		setup.Close()
		t.Fatal(maskErr)
	}
	t.Logf("ObjectID fixture ordinary GrantedAccess=0x%08x no privilege scope", mask)
	var object [64]byte
	var returned uint32
	createErr := windows.DeviceIoControl(windows.Handle(setup.Fd()), windows.FSCTL_CREATE_OR_GET_OBJECT_ID, nil, 0, &object[0], uint32(len(object)), &returned, nil)
	closeErr := setup.Close()
	t.Logf("ObjectID fixture create/get success=%t win32=%d returned=%d setupClosed=%t", createErr == nil, win32Code(createErr), returned, closeErr == nil)
	if createErr != nil || closeErr != nil || returned != 64 || bytes.Equal(object[:16], make([]byte, 16)) {
		t.Fatal("real ObjectID fixture not established; unsupported-type refusal NOT tested")
	}
	var verified [64]byte
	returned = 0
	if err := windows.DeviceIoControl(windows.Handle(original.Fd()), windows.FSCTL_GET_OBJECT_ID, nil, 0, &verified[0], uint32(len(verified)), &returned, nil); err != nil || returned != 64 || verified != object {
		t.Fatalf("actual ObjectID presence verification failed win32=%d", win32Code(err))
	}
	before, err := inspectStableReadObject(windows.Handle(original.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c := &backupHeaderAuditCounters{Log: t.Logf}
	auditErr := runBackupHeaderAudit(ctx, root, original, c)
	var unsupported *backupHeaderAuditUnsupported
	t.Logf("ObjectID audit types=%v payloadRead=%d seeks=%d abort=%d abortSuccess=%d closes=%d complete=%t", c.Types, c.PayloadRead, c.SeekCalls, c.AbortCalls, c.AbortSuccess, c.HandleCloses, c.Complete)
	if !errors.As(auditErr, &unsupported) || unsupported.ID != 7 || c.Complete {
		t.Fatal("real old-unsupported ObjectID was not explicitly rejected as type=7", auditErr)
	}
	if c.PayloadRead != 0 || c.AbortCalls != 1 || c.AbortSuccess != 1 || c.HandleCloses != 1 {
		t.Fatal("unsupported audit consumed payload or failed cleanup")
	}
	after, err := inspectStableReadObject(windows.Handle(original.Fd()))
	if err != nil || after != before {
		t.Fatal("unsupported header audit changed original basic/LastAccess")
	}
	if !bytes.Equal(privileges, nativeTokenPrivileges(t)) {
		t.Fatal("ObjectID fixture/audit changed process privileges")
	}
}
