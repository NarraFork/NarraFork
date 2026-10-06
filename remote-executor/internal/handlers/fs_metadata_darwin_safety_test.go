//go:build darwin

package handlers

import (
	"context"
	"errors"
	"os"
	"runtime"
	"testing"
	"unsafe"

	"github.com/ebitengine/purego"
	"golang.org/x/sys/unix"
)

func TestDarwinCaptureRejectsChangeDuringSnapshot(t *testing.T) {
	f := darwinTestFile(t, t.TempDir(), "file")
	var errno int32
	api := &darwinACLNative{
		errno: func() *int32 { return &errno },
		getFD: func(int32) uintptr {
			if err := unix.Fsetxattr(int(f.Fd()), "org.narrafork.mid-snapshot", []byte("changed"), 0); err != nil {
				t.Fatal(err)
			}
			errno = int32(unix.ENOENT)
			return 0
		},
	}
	if _, _, err := darwinCaptureOnce(context.Background(), f, api); !errors.Is(err, errConditionalMetadataChanged) {
		t.Fatalf("unstable snapshot accepted: %v", err)
	}
}

func TestDarwinSourceChangeCannotBeHiddenByRestoredMode(t *testing.T) {
	f := darwinTestFile(t, t.TempDir(), "file")
	metadata, err := captureConditionalMetadata(f)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Chmod(0600); err != nil {
		t.Fatal(err)
	}
	if err := f.Chmod(0640); err != nil {
		t.Fatal(err)
	}
	if err := metadata.matches(f); !errors.Is(err, errConditionalMetadataChanged) {
		t.Fatalf("source ctime change accepted: %v", err)
	}
}

func TestDarwinOwnerFailureKeepsOriginal(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("requires unprivileged executor")
	}
	root := t.TempDir()
	f := darwinTestFile(t, root, "source")
	metadata, err := captureConditionalMetadata(f)
	if err != nil {
		t.Fatal(err)
	}
	m := metadata.(*darwinConditionalMetadata)
	m.snapshot.UID++
	target := darwinTestFile(t, root, "target")
	if err := m.apply(target); err == nil {
		t.Fatal("unpreservable owner accepted")
	}
	data, err := os.ReadFile(f.Name())
	if err != nil || string(data) != "before" {
		t.Fatalf("original changed: %q %v", data, err)
	}
}

func TestDarwinCanceledMetadataDoesNotMutateTarget(t *testing.T) {
	root := t.TempDir()
	f := darwinTestFile(t, root, "source")
	ctx, cancel := context.WithCancel(context.Background())
	m, err := captureConditionalMetadata(f, ctx)
	if err != nil {
		t.Fatal(err)
	}
	target := darwinTestFile(t, root, "target")
	if err := target.Chmod(0600); err != nil {
		t.Fatal(err)
	}
	cancel()
	if err := m.apply(target); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	info, err := target.Stat()
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("canceled metadata application mutated target")
	}
	if _, err := captureConditionalMetadata(f, ctx); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

// This mock checks representation branches only; the real empty-ACL kernel
// round trip is exercised by TestDarwinConditionalWritePreservesEmptyNativeACL.
func TestDarwinNativeAbsentAndEmptyBranches(t *testing.T) {
	var errno int32
	present, freed := false, 0
	api := &darwinACLNative{
		errno: func() *int32 { return &errno },
		getFD: func(int32) uintptr {
			if !present {
				errno = int32(unix.ENOENT)
				return 0
			}
			return 2
		},
		// A present, zero-entry ACL still has a nonzero external header.
		size: func(uintptr) int64 { return 4 },
		copyExt: func(p unsafe.Pointer, _ uintptr, _ int64) int64 {
			clear(unsafe.Slice((*byte)(p), 4))
			return 4
		},
		free: func(uintptr) int32 { freed++; return 0 },
	}
	absent, err := api.read(10)
	if err != nil || absent != nil {
		t.Fatalf("absent ACL: %x %v", absent, err)
	}
	present = true
	empty, err := api.read(10)
	if err != nil || empty == nil || len(empty) != 4 || freed != 1 {
		t.Fatalf("empty ACL: %x %v; frees=%d", empty, err, freed)
	}
	api.getFD = func(int32) uintptr { errno = int32(unix.ENOTSUP); return 0 }
	if _, err := api.read(10); !errors.Is(err, unix.ENOTSUP) {
		t.Fatalf("unsupported ACL was mistaken for absent: %v", err)
	}
}

// Count via documented libc APIs, not an assumed external-header layout.
func darwinTestNativeACECount(t *testing.T, api *darwinACLNative, data []byte) int {
	t.Helper()
	if data == nil {
		return 0
	}
	if len(data) == 0 {
		t.Fatal("present ACL has no external representation")
	}
	h, err := purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_NOW|purego.RTLD_LOCAL)
	if err != nil {
		t.Fatal(err)
	}
	defer purego.Dlclose(h)
	var getEntry func(uintptr, int32, *uintptr) int32
	purego.RegisterLibFunc(&getEntry, h, "acl_get_entry")
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	errno := api.errno()
	*errno = 0
	acl := api.copyInt(unsafe.Pointer(&data[0]))
	runtime.KeepAlive(data)
	if acl == 0 {
		t.Fatal(darwinNativeError("fixture acl_copy_int", errno))
	}
	defer func() {
		*errno = 0
		if api.free(acl) != 0 {
			t.Error(darwinNativeError("fixture acl_free", errno))
		}
	}()
	// Apple <sys/acl.h>: ACL_FIRST_ENTRY=0 and ACL_NEXT_ENTRY=-1.
	entryID := int32(0)
	for count := 0; count <= 256; count++ {
		var entry uintptr
		*errno = 0
		if getEntry(acl, entryID, &entry) != 0 {
			// Apple acl_get_entry reports the end of a valid ACL as EINVAL.
			if unix.Errno(*errno) != unix.EINVAL {
				t.Fatal(darwinNativeError("fixture acl_get_entry", errno))
			}
			return count
		}
		if entry == 0 {
			t.Fatal("acl_get_entry succeeded without an entry")
		}
		entryID = -1
	}
	t.Fatal("fixture ACL exceeded bounded entry enumeration")
	return 0
}

func TestDarwinConditionalWritePreservesEmptyNativeACL(t *testing.T) {
	root := t.TempDir()
	f := darwinTestFile(t, root, "file")
	api, err := loadDarwinACL()
	if err != nil {
		t.Fatal(err)
	}
	// The real libc parser produces a valid, zero-entry acl_t. Setting it
	// exercises acl_set_fd, not the filesec remove-ACL sentinel.
	darwinTestSetACL(t, f, "")
	metadata, err := captureConditionalMetadata(f)
	if err != nil {
		t.Fatal(err)
	}
	originalACL := metadata.(*darwinConditionalMetadata).snapshot.ACL
	if got := darwinTestNativeACECount(t, api, originalACL); got != 0 {
		t.Fatalf("empty ACL fixture has %d ACEs", got)
	}
	if originalACL == nil {
		t.Log("kernel normalized zero-entry ACL to absent; preserve its actual absent semantics")
	} else {
		t.Log("kernel preserved a present zero-entry ACL; preserve its exact binary representation")
	}
	// Make temporary replacement inodes inherit actual non-empty permissions.
	dir, err := os.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	darwinTestSetACL(t, dir, darwinTestACLEntries(true))
	_ = dir.Close()
	probe := darwinTestFile(t, root, "probe")
	inherited, err := api.read(int(probe.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	if got := darwinTestNativeACECount(t, api, inherited); got == 0 {
		t.Fatal("parent ACL fixture did not grant inherited ACEs")
	}
	h := New(NewPathGuard([]string{root}), 4000000)
	result, err := h.FsWriteConditional(context.Background(), conditionalParams(f.Name(), "before", "after"))
	if err != nil || result.(map[string]any)["applied"] != true {
		t.Fatalf("%v %v", result, err)
	}
	after, err := os.Open(f.Name())
	if err != nil {
		t.Fatal(err)
	}
	defer after.Close()
	actualACL, err := api.read(int(after.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	if got := darwinTestNativeACECount(t, api, actualACL); got != 0 {
		t.Fatalf("empty-ACL replacement gained %d inherited ACEs", got)
	}
	// matches compares ACL bytes and nil/non-nil identity, in addition to the
	// complete metadata snapshot. No assumption about kernel normalization.
	if err := metadata.matches(after); err != nil {
		t.Fatal(err)
	}
}
