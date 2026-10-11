//go:build windows

package windowsbackup

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Causal observations only. A temporal association with sibling fsync is not a
// claim that fsync read the source or caused a deferred/external access update.
// Each case takes ONE initial Capture, then only native basic/ID observations.
type restoreCausalTrace struct {
	mu                                                      sync.Mutex
	t                                                       *testing.T
	target                                                  windows.Handle
	last                                                    *stableReadObjectState
	expected                                                *stableReadObjectState
	firstDrift                                              string
	queryErr                                                error
	started                                                 time.Time
	sdkEvents, readCalls, writeCalls, seekCalls, abortCalls int
	lastWriter                                              windows.Handle
}

func (r *restoreCausalTrace) checkpoint(stage string, force bool) {
	state, err := inspectStableReadObject(r.target)
	r.mu.Lock()
	defer r.mu.Unlock()
	if err != nil {
		if r.queryErr == nil {
			r.queryErr = err
		}
		r.t.Logf("causal stage=%s basicQueryFailed=true win32=%d", stage, win32Code(err))
		return
	}
	changed := r.last != nil && *r.last != state
	if r.expected != nil && *r.expected != state && r.firstDrift == "" {
		r.firstDrift = stage
	}
	if force || changed {
		r.t.Logf("causal stage=%s elapsedMicros=%d observedAtUnixNano=%d changedSincePrior=%t armed=%t IDEqualExpected=%t creation=%d access=%d write=%d change=%d attributes=0x%08x firstDrift=%q", stage, time.Since(r.started).Microseconds(), time.Now().UnixNano(), changed, r.expected != nil, r.expected == nil || r.expected.ID == state.ID, state.Basic.Creation, state.Basic.Access, state.Basic.Write, state.Basic.Change, state.Basic.Attributes, r.firstDrift)
	}
	r.last = &state
}
func (r *restoreCausalTrace) sdk(event backupSDKEvent) {
	r.mu.Lock()
	r.sdkEvents++
	if event.Stage == "after-transfer" {
		if event.Write {
			r.writeCalls++
			r.lastWriter = event.Handle
		} else {
			r.readCalls++
		}
	}
	if event.Stage == "after-seek" {
		r.seekCalls++
	}
	if event.Stage == "after-abort" {
		r.abortCalls++
		if event.Write {
			r.lastWriter = event.Handle
		}
	}
	r.t.Logf("causal SDK stage=%s write=%t security=%t abort=%t requested=%d actual=%d success=%t win32=%d", event.Stage, event.Write, event.Security, event.Abort, event.Requested, event.Actual, event.Success, event.Win32)
	r.mu.Unlock()
	r.checkpoint("SDK/"+event.Stage, false)
}
func (r *restoreCausalTrace) arm(t *testing.T, original *Snapshot) {
	t.Helper()
	state, err := inspectStableReadObject(r.target)
	if err != nil {
		t.Fatal(err)
	}
	if uint64(state.Basic.Creation) != original.Creation || uint64(state.Basic.Access) != original.LastAccess || uint64(state.Basic.Write) != original.LastWrite || state.Basic.Attributes != original.Attributes {
		t.Fatal("writer/no-op returned non-exact historical restorable basic fields; no later baseline replacement allowed")
	}
	r.mu.Lock()
	r.expected = &state
	r.last = &state
	r.mu.Unlock()
	r.checkpoint("armed-original-restorable-fields-exact", true)
}

func TestNativeWindowsRestoreCausalSDK(t *testing.T) {
	requirePreparedScratch(t)
	for _, ads := range []bool{false, true} {
		for _, action := range []string{"no-restore", "same-file-restore", "new-prepared-restore"} {
			label := fmt.Sprintf("%s/%s", map[bool]string{false: "main", true: "ads"}[ads], action)
			t.Run(label, func(t *testing.T) {
				ctx, cancel := context.WithTimeout(nativeFixtureContext(t), 20*time.Second)
				defer cancel()
				var root, source *os.File
				var path string
				if ads {
					root, source, path = ntPrototypeFixture(t, []byte("[ZoneTransfer]\r\nZoneId=3\r\n"))
				} else {
					root, source, path = ntPrototypeFixture(t)
				}
				_ = root // The fixture retains its actual ordinary root for its lifetime.
				target := source
				if action == "new-prepared-restore" {
					newPath := filepath.Join(filepath.Dir(path), "prepared-causal.txt")
					if err := os.WriteFile(newPath, []byte("same ordinary bytes"), 0600); err != nil {
						t.Fatal("private prepared fixture create failed")
					}
					var err error
					target, err = OpenMutation(newPath)
					if err != nil {
						t.Fatal(err)
					}
					defer target.Close()
				}
				beforeSource, err := inspectStableReadObject(windows.Handle(source.Fd()))
				if err != nil {
					t.Fatal(err)
				}
				beforeTarget, err := inspectStableReadObject(windows.Handle(target.Fd()))
				if err != nil {
					t.Fatal(err)
				}
				privileges := nativeTokenPrivileges(t)
				trace := &restoreCausalTrace{t: t, target: windows.Handle(target.Fd()), started: time.Now()}
				oldObserver := backupSDKObserver
				backupSDKObserver = trace.sdk
				defer func() { backupSDKObserver = oldObserver }()
				trace.checkpoint("before-single-initial-Capture", true)
				original, err := Capture(ctx, source)
				if err != nil {
					t.Fatal("single initial raw matrix Capture", err)
				}
				afterCapture, err := inspectStableReadObject(windows.Handle(source.Fd()))
				if err != nil || afterCapture != beforeSource {
					t.Fatal("initial production Capture changed source native basic")
				}
				fingerprint, err := SnapshotFingerprint(original)
				if err != nil {
					t.Fatal(err)
				}
				t.Logf("causal initialMatrix fingerprint=%s securitySHA256=%s eaSHA256=%s streamCount=%d creation=%d access=%d write=%d attributes=0x%08x", fingerprint, Digest(original.Security), Digest(original.EA), len(original.Streams), original.Creation, original.LastAccess, original.LastWrite, original.Attributes)
				trace.checkpoint("after-single-initial-Capture", true)
				if action != "no-restore" {
					trace.checkpoint("before-original-ApplyExact", true)
					if err := ApplyExact(ctx, target, original); err != nil {
						t.Fatal("original unchanged ApplyExact", err)
					}
					trace.checkpoint("after-original-ApplyExact-return", true)
					trace.mu.Lock()
					writer := trace.lastWriter
					trace.mu.Unlock()
					if writer == 0 {
						t.Fatal("writer SDK handle was not observed")
					}
					var flags uint32
					getHandleInformation := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetHandleInformation")
					ok, _, closedErr := getHandleInformation.Call(uintptr(writer), uintptr(unsafe.Pointer(&flags)))
					if ok != 0 {
						closedErr = nil
					}
					t.Logf("causal writerHandleAfterApply closed=%t queryWin32=%d (numeric slot reuse remains possible)", errors.Is(closedErr, windows.ERROR_INVALID_HANDLE), win32Code(closedErr))
					if !errors.Is(closedErr, windows.ERROR_INVALID_HANDLE) {
						t.Fatal("writer handle closure not proven after original ApplyExact")
					}
				}
				afterApply, err := inspectStableReadObject(windows.Handle(target.Fd()))
				if err != nil || afterApply.ID != beforeTarget.ID {
					t.Fatal("Apply/no-op changed physical target ID")
				}
				trace.arm(t, original)
				if !bytes.Equal(privileges, nativeTokenPrivileges(t)) {
					t.Fatal("initial Capture/Apply changed process privileges")
				}
				// Time-matched, bounded metadata-only observation prefix. Waiting is
				// intentional sampling, not another source read or a warming Capture.
				ticker := time.NewTicker(20 * time.Millisecond)
				defer ticker.Stop()
				for i := 0; i < 10; i++ {
					select {
					case <-ticker.C:
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					}
					trace.checkpoint(fmt.Sprintf("basic-only-%02d", i), i == 0 || i == 9)
				}
				// Same fixed sibling IO sequence in all six controls: 64 new files,
				// 2x4KiB writes+fsync each, <=512KiB total. None refers to source/ADS.
				siblingDir := filepath.Join(filepath.Dir(filepath.Dir(path)), "private-causal-io")
				if err := os.Mkdir(siblingDir, 0700); err != nil {
					t.Fatal("private sibling directory create failed")
				}
				payload := bytes.Repeat([]byte{0x4e}, 4096)
				for i := 0; i < 64; i++ {
					select {
					case <-ticker.C:
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					}
					f, err := os.OpenFile(filepath.Join(siblingDir, fmt.Sprintf("record-%02d", i)), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
					if err != nil {
						t.Fatalf("private sibling open win32=%d", win32Code(err))
					}
					for pass := 0; pass < 2; pass++ {
						trace.checkpoint(fmt.Sprintf("sibling-%02d-%d-before-write", i, pass), false)
						if _, err := f.Write(payload); err != nil {
							f.Close()
							t.Fatal("private sibling write failed")
						}
						trace.checkpoint(fmt.Sprintf("sibling-%02d-%d-after-write-before-fsync", i, pass), false)
						if err := f.Sync(); err != nil {
							f.Close()
							t.Fatal("private sibling fsync failed")
						}
						trace.checkpoint(fmt.Sprintf("sibling-%02d-%d-after-fsync", i, pass), false)
					}
					if err := f.Close(); err != nil {
						t.Fatal("private sibling close failed")
					}
					trace.checkpoint(fmt.Sprintf("sibling-%02d-after-close", i), i == 63)
				}
				trace.checkpoint("end-all-original-handles-still-live", true)
				trace.mu.Lock()
				first := trace.firstDrift
				queryErr := trace.queryErr
				reads, writes, seeks, aborts := trace.readCalls, trace.writeCalls, trace.seekCalls, trace.abortCalls
				trace.mu.Unlock()
				t.Logf("causal SUMMARY action=%s ads=%t sourceCaptures=1 postApplySourceDataReads=0 privateWrites=128 privateFsync=128 privateCloses=64 SDKreads=%d SDKwrites=%d SDKseeks=%d SDKaborts=%d firstDrift=%q privilegeUnchanged=%t; temporal boundary is NOT root-cause attribution", action, ads, reads, writes, seeks, aborts, first, bytes.Equal(privileges, nativeTokenPrivileges(t)))
				if queryErr != nil {
					t.Fatal("causal basic observation failed", queryErr)
				}
				if !bytes.Equal(privileges, nativeTokenPrivileges(t)) {
					t.Fatal("causal sequence changed process privileges")
				}
				if first != "" {
					t.Fatalf("original historical metadata drift reproduced at %s; cause not yet attributed, no snapshot/complete proof", first)
				}
			})
		}
	}
}
