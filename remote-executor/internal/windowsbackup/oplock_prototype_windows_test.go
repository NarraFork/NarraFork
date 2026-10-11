//go:build windows

package windowsbackup

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// TEST ONLY. Microsoft SDK winioctl.h:
// FSCTL_REQUEST_OPLOCK = CTL_CODE(FILE_DEVICE_FILE_SYSTEM,144,METHOD_BUFFERED,FILE_ANY_ACCESS).
// No production guard/reader/permission/readiness decision uses this experiment.
const (
	prototypeRequestOplock uint32 = (9 << 16) | (144 << 2)
	prototypeRWH           uint32 = 7
	prototypeOplockRequest uint32 = 1
)

type prototypeOplockInput struct {
	Version, Length uint16
	Level, Flags    uint32
}
type prototypeOplockOutput struct {
	Version, Length                            uint16
	OriginalLevel, NewLevel, Flags, AccessMode uint32
	ShareMode                                  uint16
	Reserved                                   uint16 // native alignment padding, not an invented protocol field
}
type prototypeOplockLease struct {
	mu                                             sync.Mutex
	h, event                                       windows.Handle
	input                                          *prototypeOplockInput
	output                                         *prototypeOplockOutput
	ov                                             *windows.Overlapped
	pin                                            runtime.Pinner
	submitted, pending, terminal, closed, unpinned bool
	terminalErr                                    error
	doneBytes                                      uint32
}

// The registry owns all kernel-visible memory and native handles if cancellation
// cannot prove terminal completion. Unknown is a leak/evidence state, not success.
var prototypeOplockRetained = struct {
	sync.Mutex
	leases   map[*prototypeOplockLease]bool
	triggers map[*prototypeOplockTrigger]bool
}{leases: map[*prototypeOplockLease]bool{}, triggers: map[*prototypeOplockTrigger]bool{}}

func prototypeRetainLease(l *prototypeOplockLease) {
	prototypeOplockRetained.Lock()
	prototypeOplockRetained.leases[l] = true
	prototypeOplockRetained.Unlock()
}
func prototypeForgetLease(l *prototypeOplockLease) {
	prototypeOplockRetained.Lock()
	delete(prototypeOplockRetained.leases, l)
	prototypeOplockRetained.Unlock()
}

func prototypeRemaining(ctx context.Context, max time.Duration) uint32 {
	if deadline, ok := ctx.Deadline(); ok {
		left := time.Until(deadline)
		if left < max {
			max = left
		}
	}
	if max <= 0 {
		return 0
	}
	return uint32((max + time.Millisecond - 1) / time.Millisecond)
}
func prototypeQueryTerminal(l *prototypeOplockLease) (bool, error) {
	var done uint32
	err := windows.GetOverlappedResult(l.h, l.ov, &done, false)
	if errors.Is(err, windows.ERROR_IO_INCOMPLETE) || errors.Is(err, windows.ERROR_IO_PENDING) {
		return false, err
	}
	// ERROR_INVALID_HANDLE/other SDK failure does not prove the IRP is gone.
	if err != nil && !errors.Is(err, windows.ERROR_OPERATION_ABORTED) {
		return false, err
	}
	l.terminal = true
	l.pending = false
	l.terminalErr = err
	l.doneBytes = done
	return true, err
}
func prototypeDrainLease(ctx context.Context, l *prototypeOplockLease, t *testing.T) error {
	if l.terminal || !l.pending {
		return nil
	}
	cancelErr := windows.CancelIoEx(l.h, l.ov)
	t.Logf("oplock cancelRequested win32=%d (ERROR_NOT_FOUND does not prove drain)", win32Code(cancelErr))
	wait, err := windows.WaitForSingleObject(l.event, prototypeRemaining(ctx, 2*time.Second))
	if err != nil || wait != windows.WAIT_OBJECT_0 {
		return fmt.Errorf("OPLOCK_DRAIN_UNKNOWN wait=%d win32=%d retainedPinned=true", wait, win32Code(err))
	}
	terminal, err := prototypeQueryTerminal(l)
	if !terminal {
		return fmt.Errorf("OPLOCK_DRAIN_UNKNOWN terminalQueryWin32=%d retainedPinned=true", win32Code(err))
	}
	t.Logf("oplock drained terminalNTSTATUS=0x%08x terminalWin32=%d bytes=%d", uint32(l.ov.Internal), win32Code(err), l.doneBytes)
	return nil
}
func prototypeCloseLease(ctx context.Context, l *prototypeOplockLease, t *testing.T) error {
	if l.closed {
		return nil
	}
	if err := prototypeDrainLease(ctx, l, t); err != nil {
		return err
	}
	// Closing the entire granted lease replaces ACK in this first prototype.
	// This happens BEFORE joining the second open/write/rename operation.
	if l.h != 0 {
		if err := windows.CloseHandle(l.h); err != nil {
			return fmt.Errorf("OPLOCK_CLOSE_UNKNOWN win32=%d retainedPinned=true", win32Code(err))
		}
		l.h = 0
	}
	if l.event != 0 {
		if err := windows.CloseHandle(l.event); err != nil {
			return fmt.Errorf("OPLOCK_EVENT_CLOSE_UNKNOWN win32=%d retainedPinned=true", win32Code(err))
		}
		l.event = 0
	}
	l.closed = true
	l.pin.Unpin()
	l.unpinned = true
	prototypeForgetLease(l)
	t.Log("oplock leaseClosed=true eventClosed=true memoryUnpinnedOnlyAfterTerminal=true")
	return nil
}
func prototypeRequestLease(t *testing.T, path string, async bool) (*prototypeOplockLease, error) {
	t.Helper()
	if unsafe.Sizeof(prototypeOplockInput{}) != 12 || unsafe.Sizeof(prototypeOplockOutput{}) != 24 {
		t.Fatal("official oplock input/output ABI mismatch")
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	flags := uint32(windows.FILE_FLAG_OPEN_REPARSE_POINT | windows.FILE_FLAG_BACKUP_SEMANTICS)
	if async {
		flags |= windows.FILE_FLAG_OVERLAPPED
	}
	requested := uint32(windows.FILE_READ_ATTRIBUTES | windows.READ_CONTROL | windows.FILE_WRITE_ATTRIBUTES | windows.SYNCHRONIZE)
	h, err := windows.CreateFile(name, requested, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, flags, 0)
	if err != nil {
		return nil, fmt.Errorf("oplock ordinary open win32=%d", win32Code(err))
	}
	mask, err := nativeGrantedAccess(h)
	if err != nil {
		windows.CloseHandle(h)
		return nil, err
	}
	t.Logf("oplock ordinary requested=0x%08x actualGranted=0x%08x overlap=%t", requested, mask, async)
	if mask&requested != requested || mask&(windows.FILE_READ_DATA|windows.FILE_READ_EA|windows.DELETE) != 0 {
		windows.CloseHandle(h)
		return nil, fmt.Errorf("oplock original granted mask changed")
	}
	event, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		windows.CloseHandle(h)
		return nil, err
	}
	l := &prototypeOplockLease{h: h, event: event, input: &prototypeOplockInput{1, 12, prototypeRWH, prototypeOplockRequest}, output: &prototypeOplockOutput{}, ov: &windows.Overlapped{HEvent: event}}
	l.pin.Pin(l.input)
	l.pin.Pin(l.output)
	l.pin.Pin(l.ov)
	prototypeRetainLease(l)
	// Cleanup never releases Go memory still reachable by a pending kernel IRP.
	t.Cleanup(func() {
		if l.closed {
			return
		}
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := prototypeCloseLease(cleanupCtx, l, t); err != nil {
			t.Errorf("oplock cleanup UNKNOWN, registry retains native handles/pinned buffers: %v", err)
		}
	})
	l.submitted = true
	err = windows.DeviceIoControl(h, prototypeRequestOplock, (*byte)(unsafe.Pointer(l.input)), 12, (*byte)(unsafe.Pointer(l.output)), 24, nil, l.ov)
	runtime.KeepAlive(l)
	if errors.Is(err, windows.ERROR_IO_PENDING) {
		l.pending = true
		t.Log("OPLOCK_GRANTED pending=true input=RWH REQUEST=true")
		return l, nil
	}
	// A completed non-pending request is not a grant. Even unexpected BOOL TRUE
	// is rejected; memory may be released because DeviceIoControl was synchronous.
	l.terminal = true
	return l, fmt.Errorf("OPLOCK_NOT_GRANTED win32=%d synchronousSuccess=%t", win32Code(err), err == nil)
}

type prototypeOplockTriggerResult struct {
	err                     error
	op                      string
	before, after           stableReadObjectState
	beforeNames, afterNames ntPrototypeCanonical
	readBytes, writeBytes   uint32
	actualGranted           uint32
	requestedAccessTime     int64
	executed, closed        bool
}
type prototypeOplockTrigger struct {
	ready     chan error
	result    chan prototypeOplockTriggerResult
	release   chan struct{}
	exited    chan struct{}
	thread    windows.Handle
	joined    bool // controller-owned only
	released  bool
	collected *prototypeOplockTriggerResult // retained if thread-handle close fails
}

func prototypeStartTrigger(path, op string, initial stableReadObjectState) *prototypeOplockTrigger {
	trigger := &prototypeOplockTrigger{ready: make(chan error, 1), result: make(chan prototypeOplockTriggerResult, 1), release: make(chan struct{}), exited: make(chan struct{})}
	prototypeOplockRetained.Lock()
	prototypeOplockRetained.triggers[trigger] = true
	prototypeOplockRetained.Unlock()
	go func() {
		runtime.LockOSThread()
		defer func() { runtime.UnlockOSThread(); close(trigger.exited) }()
		// THREAD_TERMINATE is the documented CancelSynchronousIo handle right,
		// on THIS test worker only. Never cancel another process or executor.
		thread, err := windows.OpenThread(1, false, windows.GetCurrentThreadId())
		trigger.thread = thread
		trigger.ready <- err
		if err != nil {
			trigger.result <- prototypeOplockTriggerResult{op: op, err: err}
			<-trigger.release
			return
		}
		result := prototypeOplockTriggerResult{op: op}
		// Keep this OS thread locked until controller collected the result and
		// closed its cancellation handle; it cannot target a reused Go thread.
		defer func() { trigger.result <- result; <-trigger.release }()
		access := uint32(windows.FILE_READ_ATTRIBUTES | windows.READ_CONTROL | windows.SYNCHRONIZE)
		switch op {
		case "read":
			access |= windows.FILE_READ_DATA
		case "metadata":
			access |= windows.FILE_WRITE_ATTRIBUTES
		case "write":
			access |= windows.FILE_WRITE_DATA
		case "rename":
			access |= windows.DELETE
		}
		name, err := windows.UTF16PtrFromString(path)
		if err != nil {
			result.err = err
			return
		}
		h, err := windows.CreateFile(name, access, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
		if err != nil {
			result.err = err
			return
		}
		defer func() {
			closeErr := windows.CloseHandle(h)
			result.closed = closeErr == nil
			result.err = errors.Join(result.err, closeErr)
		}()
		result.actualGranted, err = nativeGrantedAccess(h)
		if err != nil || result.actualGranted&access != access {
			result.err = fmt.Errorf("trigger actual granted rights not proven: %w", err)
			return
		}
		result.before, err = inspectStableReadObject(h)
		if err != nil {
			result.err = err
			return
		}
		result.beforeNames, err = ntPrototypeCanonicalNames(h)
		if err != nil {
			result.err = err
			return
		}
		if result.before.ID != initial.ID || result.before.Basic.Creation != initial.Basic.Creation {
			result.err = fmt.Errorf("trigger object replaced before operation")
			return
		}
		switch op {
		case "read":
			var data [1]byte
			err = windows.ReadFile(h, data[:], &result.readBytes, nil)
			result.executed = err == nil && result.readBytes == 1
		case "write":
			err = windows.WriteFile(h, []byte("x"), &result.writeBytes, nil)
			result.executed = err == nil && result.writeBytes == 1
		case "metadata":
			ft := windows.NsecToFiletime(time.Now().UnixNano())
			result.requestedAccessTime = int64(uint64(ft.HighDateTime)<<32 | uint64(ft.LowDateTime))
			err = windows.SetFileTime(h, nil, &ft, nil)
			result.executed = err == nil
		case "rename":
			err = ntPrototypeRenameFixtureHandle(h, filepath.Join(filepath.Dir(path), "renamed-oplock.txt"))
			result.executed = err == nil
		}
		if err != nil {
			result.err = err
			return
		}
		result.after, err = inspectStableReadObject(h)
		if err != nil {
			result.err = err
			return
		}
		result.afterNames, err = ntPrototypeCanonicalNames(h)
		result.err = err
	}()
	return trigger
}
func prototypeJoinTrigger(ctx context.Context, trigger *prototypeOplockTrigger, t *testing.T) (prototypeOplockTriggerResult, error) {
	var result prototypeOplockTriggerResult
	if trigger.joined {
		return *trigger.collected, nil
	}
	if trigger.collected != nil {
		result = *trigger.collected
	} else {
		select {
		case result = <-trigger.result:
		case <-time.After(time.Duration(prototypeRemaining(ctx, 1500*time.Millisecond)) * time.Millisecond):
			cancel := windows.NewLazySystemDLL("kernel32.dll").NewProc("CancelSynchronousIo")
			ok, _, err := cancel.Call(uintptr(trigger.thread))
			t.Logf("trigger CancelSynchronousIo success=%t win32=%d", ok != 0, win32Code(err))
			select {
			case result = <-trigger.result:
			case <-time.After(time.Duration(prototypeRemaining(ctx, 500*time.Millisecond)) * time.Millisecond):
				return result, fmt.Errorf("TRIGGER_UNKNOWN not joined, thread/native operation retained")
			}
		}
		trigger.collected = &result
	}
	if trigger.thread != 0 {
		if err := windows.CloseHandle(trigger.thread); err != nil {
			return result, err
		}
		trigger.thread = 0
	}
	if !trigger.released {
		close(trigger.release)
		trigger.released = true
	}
	select {
	case <-trigger.exited:
	case <-time.After(time.Duration(prototypeRemaining(ctx, 100*time.Millisecond)) * time.Millisecond):
		return result, fmt.Errorf("TRIGGER_UNKNOWN exit not observed; resources retained")
	}
	trigger.joined = true
	prototypeOplockRetained.Lock()
	delete(prototypeOplockRetained.triggers, trigger)
	prototypeOplockRetained.Unlock()
	return result, nil
}
func prototypeOplockFixture(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "private-oplock.txt")
	if err := os.WriteFile(path, []byte("private-oplock-fixture"), 0600); err != nil {
		t.Fatalf("oplock fixture create win32=%d", win32Code(err))
	}
	return path
}
func prototypeValidateTerminalBreak(l *prototypeOplockLease, t *testing.T) error {
	terminal, err := prototypeQueryTerminal(l)
	if !terminal || err != nil {
		return fmt.Errorf("BREAK_NOT_TERMINAL win32=%d pinnedMemoryRetained=%t", win32Code(err), !terminal)
	}
	t.Logf("oplock break GetOverlappedResultSuccess=true bytes=%d ntstatus=0x%08x version=%d length=%d original=0x%08x new=0x%08x flags=0x%08x access=0x%08x share=0x%04x", l.doneBytes, uint32(l.ov.Internal), l.output.Version, l.output.Length, l.output.OriginalLevel, l.output.NewLevel, l.output.Flags, l.output.AccessMode, l.output.ShareMode)
	if uint32(l.ov.Internal) != 0 || l.doneBytes != 24 || l.output.Version != 1 || l.output.Length != 24 || l.output.OriginalLevel != prototypeRWH || l.output.NewLevel&^prototypeRWH != 0 || l.output.NewLevel == prototypeRWH || l.output.Flags&^uint32(3) != 0 {
		return fmt.Errorf("BREAK_OUTPUT_INVALID_OR_UNATTRIBUTED")
	}
	return nil
}

func TestNativeWindowsOplockPrototype(t *testing.T) {
	requirePreparedScratch(t)
	for _, op := range []string{"read", "metadata", "write", "rename"} {
		t.Run(op, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			path := prototypeOplockFixture(t)
			// Pin a real parent identity/canonical proof, not a client path claim.
			parent, err := openOrdinary(filepath.Dir(path), windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL)
			if err != nil {
				t.Fatal(err)
			}
			defer parent.Close()
			parentState, err := inspectStableRead(windows.Handle(parent.Fd()))
			if err != nil {
				t.Fatal(err)
			}
			lease, err := prototypeRequestLease(t, path, true)
			if err != nil {
				t.Fatal(err)
			}
			initial, err := inspectStableRead(lease.h)
			if err != nil {
				t.Fatal(err)
			}
			if err := verifyStableOriginal(lease.h, initial, ctx); err != nil {
				t.Fatal(err)
			}
			if filepath.Dir(initial.Slot) != parentState.Slot || filepath.Dir(initial.DOSSlot) != parentState.DOSSlot {
				t.Fatal("oplock actual canonical parent mismatch")
			}
			if wait, err := windows.WaitForSingleObject(lease.event, 0); err != nil || wait != uint32(windows.WAIT_TIMEOUT) {
				t.Fatalf("oplock already broke before controlled trigger wait=%d win32=%d", wait, win32Code(err))
			}
			trigger := prototypeStartTrigger(path, op, initial.stableReadObjectState)
			select {
			case err := <-trigger.ready:
				t.Cleanup(func() {
					if trigger.joined {
						return
					}
					cleanupCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
					defer cancel()
					closeErr := prototypeCloseLease(cleanupCtx, lease, t)
					_, joinErr := prototypeJoinTrigger(cleanupCtx, trigger, t)
					if err := errors.Join(closeErr, joinErr); err != nil {
						t.Errorf("trigger cleanup UNKNOWN retained resources: %v", err)
					}
				})
				if err != nil {
					t.Fatal("trigger thread registration", err)
				}
			case <-ctx.Done():
				t.Fatal("trigger registration timeout")
			}
			wait, waitErr := windows.WaitForSingleObject(lease.event, prototypeRemaining(ctx, 5*time.Second))
			breakErr := error(nil)
			if waitErr != nil || wait != windows.WAIT_OBJECT_0 {
				breakErr = fmt.Errorf("BREAK_TIMEOUT_OR_NOT_COVERED operation=%s wait=%d win32=%d; NOT a guard proof", op, wait, win32Code(waitErr))
			} else {
				breakErr = prototypeValidateTerminalBreak(lease, t)
			}
			// Record the actual original handle while still live, even when a break
			// permits an operation before acknowledgment. Changes are evidence, not
			// a promise that every RWH transition is an atomic write barrier.
			atBreak, tupleErr := inspectStableRead(lease.h)
			if tupleErr == nil {
				t.Logf("oplock originalAtBreak samePhysical=%t fullBasicEqual=%t canonicalSlotsEqual=%t slotSHA256=%s", atBreak.ID == initial.ID, atBreak.Basic == initial.Basic, atBreak.Slot == initial.Slot && atBreak.DOSSlot == initial.DOSSlot, Digest([]byte(atBreak.Slot)))
			} else {
				t.Logf("oplock originalAtBreak queryWin32=%d", win32Code(tupleErr))
			}
			if tupleErr != nil || atBreak.ID != initial.ID || atBreak.Basic.Creation != initial.Basic.Creation {
				breakErr = errors.Join(breakErr, fmt.Errorf("original live identity at break not proven"))
			}
			closeErr := prototypeCloseLease(ctx, lease, t)
			// Controller released the entire lease BEFORE joining a potentially
			// blocked second CreateFile/write/rename. No ACK or OVERLAPPED reuse.
			result, joinErr := prototypeJoinTrigger(ctx, trigger, t)
			t.Logf("oplock controlled operation=%s actualExecuted=%t actualGranted=0x%08x secondHandleClosed=%t ReadFileBytes=%d WriteFileBytes=%d operationWin32=%d joined=%t beforeAccess=%d afterAccess=%d beforeWrite=%d afterWrite=%d beforeChange=%d afterChange=%d beforeSlotSHA256=%s afterSlotSHA256=%s", op, result.executed, result.actualGranted, result.closed, result.readBytes, result.writeBytes, win32Code(result.err), joinErr == nil, result.before.Basic.Access, result.after.Basic.Access, result.before.Basic.Write, result.after.Basic.Write, result.before.Basic.Change, result.after.Basic.Change, Digest([]byte(result.beforeNames.GUID)), Digest([]byte(result.afterNames.GUID)))
			if err := errors.Join(breakErr, closeErr, joinErr, result.err); err != nil {
				t.Fatal(err)
			}
			if !result.executed || !result.closed || result.after.ID != initial.ID || result.after.Basic.Creation != initial.Basic.Creation {
				t.Fatal("controlled second operation/native identity not proven")
			}
			if op == "metadata" && result.after.Basic.Access != result.requestedAccessTime {
				t.Fatal("actual controlled SetFileTime result not exact")
			}
			if result.beforeNames.GUID != initial.Slot || result.beforeNames.DOS != initial.DOSSlot {
				t.Fatal("controlled operation started at a changed actual canonical slot")
			}
			if op == "rename" {
				if result.afterNames == result.beforeNames || filepath.Dir(result.afterNames.GUID) != parentState.Slot || filepath.Dir(result.afterNames.DOS) != parentState.DOSSlot {
					t.Fatal("actual controlled same-parent rename not proven")
				}
			} else if result.afterNames != result.beforeNames {
				t.Fatal("non-rename trigger changed canonical slot")
			}
			finalParent, err := inspectStableRead(windows.Handle(parent.Fd()))
			if err != nil || finalParent.ID != parentState.ID || finalParent.Basic.Creation != parentState.Basic.Creation || finalParent.Slot != parentState.Slot || finalParent.DOSSlot != parentState.DOSSlot {
				t.Fatal("controlled root/parent identity or canonical changed")
			}
			if err := ctx.Err(); err != nil {
				t.Fatal("oplock case total budget expired", err)
			}
			t.Log("GRANTED_BREAK_DRAINED_AND_CONTROLLED_OPERATION_JOINED; endpoint experiment only, no namespace/meta ABA, filter-read or productionReady proof")
		})
	}
}
func TestNativeWindowsOplockPendingCancel(t *testing.T) {
	requirePreparedScratch(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	path := prototypeOplockFixture(t)
	lease, err := prototypeRequestLease(t, path, true)
	if err != nil {
		t.Fatal(err)
	}
	initial, err := inspectStableRead(lease.h)
	if err != nil {
		t.Fatal(err)
	}
	if wait, err := windows.WaitForSingleObject(lease.event, 0); err != nil || wait != uint32(windows.WAIT_TIMEOUT) {
		t.Fatal("pending-cancel fixture broke before cancellation")
	}
	if err := prototypeDrainLease(ctx, lease, t); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(lease.terminalErr, windows.ERROR_OPERATION_ABORTED) {
		t.Fatal("cancellation did not prove aborted terminal; possible external break is not pending-cancel evidence")
	}
	if err := verifyStableOriginal(lease.h, initial, ctx); err != nil {
		t.Fatal(err)
	}
	if err := prototypeCloseLease(ctx, lease, t); err != nil {
		t.Fatal(err)
	}
	t.Log("PENDING_CANCEL_TERMINAL_ABORT_DRAINED pinnedMemoryReleasedAfterResult=true")
}
func TestNativeWindowsOplockRejectsSynchronousHandle(t *testing.T) {
	requirePreparedScratch(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	path := prototypeOplockFixture(t)
	lease, requestErr := prototypeRequestLease(t, path, false)
	if lease == nil {
		t.Fatal("synchronous fixture did not reach FSCTL request", requestErr)
	}
	if requestErr == nil {
		closeErr := prototypeCloseLease(ctx, lease, t)
		t.Fatalf("synchronous handle unexpectedly returned ERROR_IO_PENDING grant cleanup=%v", closeErr)
	}
	if lease.pending || !lease.terminal {
		t.Fatal("synchronous refusal not an immediate terminal result")
	}
	if err := prototypeCloseLease(ctx, lease, t); err != nil {
		t.Fatal(err)
	}
	t.Logf("SYNCHRONOUS_OPLOCK_REFUSED actualRequest=%v (not a grant or guard)", requestErr)
}
