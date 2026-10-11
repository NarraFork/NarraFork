//go:build windows

package windowsbackup

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

type cancelCaptureBlobs struct {
	base   BlobStore
	cancel context.CancelFunc
	puts   int
}

func (b *cancelCaptureBlobs) Put(ctx context.Context, data []byte) (string, error) {
	b.puts++
	digest, err := b.base.Put(ctx, data)
	b.cancel()
	return digest, err
}
func (b *cancelCaptureBlobs) Get(ctx context.Context, digest string, size int64) ([]byte, error) {
	return b.base.Get(ctx, digest, size)
}

func TestNativeWindowsProductionCaptureCancellation(t *testing.T) {
	requirePreparedScratch(t)
	for _, phase := range []string{"before-admission", "ordinary-CAS"} {
		t.Run(phase, func(t *testing.T) {
			ctx := nativeFixtureContext(t)
			_, original, _ := ntEAPrototypeFixture(t, true, ntEAPrototypeValues())
			before, err := inspectStableReadObject(windows.Handle(original.Fd()))
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(ctx)
			defer cancel()
			store := &cancelCaptureBlobs{base: blobs(ctx), cancel: cancel}
			ctx = WithBlobs(ctx, store)
			if phase == "before-admission" {
				cancel()
			}
			snapshot, err := Capture(ctx, original)
			if snapshot != nil || !errors.Is(err, context.Canceled) {
				t.Fatal("cancel produced snapshot or lost cancellation", err)
			}
			if phase == "before-admission" && store.puts != 0 || phase == "ordinary-CAS" && store.puts != 1 {
				t.Fatal("cancel phase not exercised")
			}
			after, err := inspectStableReadObject(windows.Handle(original.Fd()))
			if err != nil || after != before {
				t.Fatal("cancelled capture changed original basic state")
			}
			if len(captureReadWorkers) != 0 || len(captureReadQueue) != 0 {
				t.Fatal("cancelled capture retained queue/worker admission")
			}
		})
	}
}

type countedCaptureBlobs struct {
	base       BlobStore
	puts, gets int
}

func (b *countedCaptureBlobs) Put(ctx context.Context, data []byte) (string, error) {
	b.puts++
	return b.base.Put(ctx, data)
}
func (b *countedCaptureBlobs) Get(ctx context.Context, digest string, size int64) ([]byte, error) {
	b.gets++
	return b.base.Get(ctx, digest, size)
}

func TestNativeWindowsStableCaptureEAADS(t *testing.T) {
	requirePreparedScratch(t)
	for _, kind := range []string{"ea", "ads", "ea-and-ads"} {
		t.Run(kind, func(t *testing.T) {
			ctx := nativeFixtureContext(t)
			var values []ntEAPrototypeEntry
			if kind != "ads" {
				values = ntEAPrototypeValues()
			}
			_, original, path := ntEAPrototypeFixture(t, kind != "ea", values)
			before, err := inspectStableReadObject(windows.Handle(original.Fd()))
			if err != nil {
				t.Fatal(err)
			}
			privileges := nativeTokenPrivileges(t)
			snapshot, err := Capture(ctx, original)
			if err != nil {
				t.Fatal("production stable Capture", err)
			}
			if len(values) > 0 {
				ea, err := parseNativeEA(snapshot.EA)
				if err != nil || len(ea) != len(values) {
					t.Fatal("production EA capture", err)
				}
				for i := range ea {
					if ea[i].Flags != values[i].Flags || !bytes.Equal(ea[i].Name, values[i].Name) || !bytes.Equal(ea[i].Value, values[i].Value) {
						t.Fatal("production raw EA changed")
					}
				}
			} else if len(snapshot.EA) != 0 {
				t.Fatal("unexpected EA")
			}
			if kind != "ea" {
				if len(snapshot.Streams) != 1 {
					t.Fatal("production ADS omitted")
				}
				data, err := blobs(ctx).Get(ctx, snapshot.Streams[0].Digest, snapshot.Streams[0].Size)
				if err != nil || string(data) != "[ZoneTransfer]\r\nZoneId=3\r\n" {
					t.Fatal("production ADS CAS bytes", err)
				}
			} else if len(snapshot.Streams) != 0 {
				t.Fatal("unexpected ADS")
			}
			after, err := inspectStableReadObject(windows.Handle(original.Fd()))
			if err != nil || after != before {
				t.Fatal("production capture changed original full basic")
			}
			replacement, err := os.CreateTemp(filepath.Dir(path), "production-prepared-")
			if err != nil {
				t.Fatal("prepared fixture create")
			}
			defer replacement.Close()
			if _, err := replacement.Write([]byte("same ordinary bytes")); err != nil {
				t.Fatal("prepared fixture bytes")
			}
			if err := ApplyExact(ctx, replacement, snapshot); err != nil {
				t.Fatal("unchanged original full-matrix writer", err)
			}
			if err := Matches(ctx, replacement, snapshot); err != nil {
				t.Fatal("unchanged strict original matrix comparison", err)
			}
			if !bytes.Equal(privileges, nativeTokenPrivileges(t)) {
				t.Fatal("capture/restore leaked process privileges")
			}
			t.Log("production Capture -> original unchanged ApplyExact -> strict Matches, full EA/ADS/LastAccess matrix retained; not deployment readiness")
		})
	}
}

func TestNativeWindowsPreparedChannelEAADS(t *testing.T) {
	requirePreparedScratch(t)
	h := newPreparedHarness(t)
	root, original, path := ntEAPrototypeFixture(t, true, ntEAPrototypeValues())
	rootDescriptor, err := preparedNativeDescriptor(root)
	if err != nil {
		t.Fatal(err)
	}
	native := &preparedScratchNative{rootFile: root, root: rootDescriptor}
	h.base.Root = rootDescriptor
	h.base.Parent = rootDescriptor
	h.helper.Verifier.Roots = []NativeDescriptor{rootDescriptor}
	h.helper.Native = native
	newPath := filepath.Join(filepath.Dir(path), "prepared-ea-ads.txt")
	if err := os.WriteFile(newPath, []byte("same ordinary bytes"), 0600); err != nil {
		t.Fatal("prepared fixture create failed")
	}
	prepared, err := OpenMutation(newPath)
	if err != nil {
		t.Fatal(err)
	}
	defer prepared.Close()
	old := h.capture(original)
	if err := h.channel.ApplyOriginal(h.ctx, prepared, old); err != nil {
		t.Fatal("production full EA+ADS prepared channel", err)
	}
	if native.restores != 1 {
		t.Fatal("prepared channel restore not exactly once")
	}
	if err := h.channel.MatchesOriginal(h.ctx, prepared, old); err != nil {
		t.Fatal("strict prepared full-matrix verification", err)
	}
	var restore Ticket
	for _, ticket := range h.tickets {
		if ticket.Action == "restore_original" {
			restore = ticket
		}
	}
	restore.Nonce = ""
	if result, err := h.execute(h.attested(restore), prepared, &old.Proof); err != nil || result.State != "completed" || native.restores != 1 {
		t.Fatal("fresh nonce repeated EA+ADS ACL restore", err)
	}
}

func TestNativeWindowsProductionCaptureRejectsObjectID(t *testing.T) {
	requirePreparedScratch(t)
	ctx := nativeFixtureContext(t)
	counter := &countedCaptureBlobs{base: blobs(ctx)}
	ctx = WithBlobs(ctx, counter)
	_, original, path := ntEAPrototypeFixture(t, true, ntEAPrototypeValues())
	setup, err := openOrdinary(path, windows.FILE_READ_DATA|windows.FILE_WRITE_DATA|windows.FILE_READ_ATTRIBUTES|windows.FILE_WRITE_ATTRIBUTES|windows.SYNCHRONIZE)
	if err != nil {
		t.Fatal("ordinary ObjectID setup open")
	}
	var object [64]byte
	var count uint32
	createErr := windows.DeviceIoControl(windows.Handle(setup.Fd()), windows.FSCTL_CREATE_OR_GET_OBJECT_ID, nil, 0, &object[0], uint32(len(object)), &count, nil)
	closeErr := setup.Close()
	if createErr != nil || closeErr != nil || count != 64 {
		t.Fatal("real ObjectID setup failed", createErr, closeErr)
	}
	before, err := inspectStableReadObject(windows.Handle(original.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	captured, err := Capture(ctx, original)
	if err == nil || captured != nil || !strings.Contains(err.Error(), "unsupported backup record type=7") {
		t.Fatal("production inventory omitted ObjectID refusal", err)
	}
	if counter.puts != 0 || counter.gets != 0 {
		t.Fatal("unsupported object reached payload CAS")
	}
	after, queryErr := inspectStableReadObject(windows.Handle(original.Fd()))
	if queryErr != nil || after != before {
		t.Fatal("unsupported capture changed full original basic")
	}
}

func TestNativeWindowsProductionCaptureOrdinaryReadEAGate(t *testing.T) {
	requirePreparedScratch(t)
	ctx := nativeFixtureContext(t)
	counter := &countedCaptureBlobs{base: blobs(ctx)}
	ctx = WithBlobs(ctx, counter)
	_, _, path := ntEAPrototypeFixture(t, true, ntEAPrototypeValues())
	limited, err := openOrdinary(path, windows.FILE_READ_DATA|windows.FILE_READ_ATTRIBUTES|windows.FILE_WRITE_ATTRIBUTES|windows.READ_CONTROL|windows.SYNCHRONIZE)
	if err != nil {
		t.Fatal("limited fixture open")
	}
	defer limited.Close()
	before, err := inspectStableReadObject(windows.Handle(limited.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	if snapshot, err := Capture(ctx, limited); err == nil || snapshot != nil {
		t.Fatal("READ_EA missing ordinary handle borrowed helper access")
	}
	if counter.puts != 0 || counter.gets != 0 {
		t.Fatal("ordinary admission reached payload CAS")
	}
	after, err := inspectStableReadObject(windows.Handle(limited.Fd()))
	if err != nil || after != before {
		t.Fatal("ordinary refusal changed original basic")
	}
}
