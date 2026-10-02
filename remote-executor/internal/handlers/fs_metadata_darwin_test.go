//go:build darwin

package handlers

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"unsafe"

	"github.com/ebitengine/purego"
	"golang.org/x/sys/unix"
)

func darwinTestFile(t *testing.T, root, name string) *os.File {
	t.Helper()
	f, err := os.OpenFile(filepath.Join(root, name), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0640)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.Close() })
	if _, err := f.WriteString("before"); err != nil {
		t.Fatal(err)
	}
	return f
}

// Fixtures use libc's documented text parser, not subprocesses or assumptions
// about private structs. Production captures only the lossless binary form.
func darwinTestSetACL(t *testing.T, f *os.File, entries string) {
	t.Helper()
	api, err := loadDarwinACL()
	if err != nil {
		t.Fatal(err)
	}
	h, err := purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_NOW|purego.RTLD_LOCAL)
	if err != nil {
		t.Fatal(err)
	}
	defer purego.Dlclose(h)
	var parse func(string) uintptr
	purego.RegisterLibFunc(&parse, h, "acl_from_text")
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	errno := api.errno()
	*errno = 0
	acl := parse("!#acl 1\n" + entries)
	if acl == 0 {
		t.Fatal(darwinNativeError("fixture acl_from_text", errno))
	}
	defer api.free(acl)
	*errno = 0
	if api.setFD(int32(f.Fd()), acl) != 0 {
		t.Fatal(darwinNativeError("fixture acl_set_fd", errno))
	}
}

func darwinTestACLEntries(inherit bool) string {
	flags := ""
	if inherit {
		flags = ",file_inherit,only_inherit"
	}
	// Explicit deny followed by allow exercises order, tags, permissions and
	// UUID mapping. Execute denial does not prevent the test's file reads.
	return fmt.Sprintf("user:::%d:deny%s:execute\nuser:::%d:allow%s:read,write,readattr,writeattr,readextattr,writeextattr,readsecurity,writesecurity\n", os.Getuid(), flags, os.Getuid(), flags)
}

func TestDarwinConditionalWritePreservesNativeMetadata(t *testing.T) {
	for _, inherited := range []bool{false, true} {
		t.Run(fmt.Sprintf("inherited=%v", inherited), func(t *testing.T) {
			root := t.TempDir()
			if inherited {
				dir, err := os.Open(root)
				if err != nil {
					t.Fatal(err)
				}
				darwinTestSetACL(t, dir, darwinTestACLEntries(true))
				_ = dir.Close()
			}
			f := darwinTestFile(t, root, "file")
			if !inherited {
				darwinTestSetACL(t, f, darwinTestACLEntries(false))
			}
			if err := f.Chmod(0640); err != nil {
				t.Fatal(err)
			}
			for name, value := range map[string][]byte{"org.narrafork.first": {0, 1, 255}, "org.narrafork.empty": {}} {
				if err := unix.Fsetxattr(int(f.Fd()), name, value, 0); err != nil {
					t.Fatal(err)
				}
			}
			m, err := captureConditionalMetadata(f)
			if err != nil {
				t.Fatal(err)
			}
			if len(m.(*darwinConditionalMetadata).snapshot.ACL) == 0 {
				t.Fatal("real allow/deny ACL fixture missing")
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
			if err := m.matches(after); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestDarwinConditionalWriteClearsInheritedACL(t *testing.T) {
	root := t.TempDir()
	f := darwinTestFile(t, root, "file")
	api, err := loadDarwinACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := api.write(int(f.Fd()), nil); err != nil {
		t.Fatal(err)
	}
	m, err := captureConditionalMetadata(f)
	if err != nil {
		t.Fatal(err)
	}
	if m.(*darwinConditionalMetadata).snapshot.ACL != nil {
		t.Fatal("source ACL was not removed")
	}
	dir, err := os.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	darwinTestSetACL(t, dir, darwinTestACLEntries(true))
	_ = dir.Close()
	// Prove the parent really grants an inherited ACL before testing clearing.
	probe := darwinTestFile(t, root, "probe")
	acl, err := api.read(int(probe.Fd()))
	if err != nil || acl == nil {
		t.Fatalf("fixture did not inherit ACL: %x %v", acl, err)
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
	if err := m.matches(after); err != nil {
		t.Fatal(err)
	}
}

func TestDarwinConditionalMetadataChangesAndErrors(t *testing.T) {
	for _, kind := range []string{"xattr", "acl", "mode", "mtime", "same-inode-apply", "cancel"} {
		t.Run(kind, func(t *testing.T) {
			f := darwinTestFile(t, t.TempDir(), "file")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			m, err := captureConditionalMetadata(f, ctx)
			if err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "xattr":
				err = unix.Fsetxattr(int(f.Fd()), "org.narrafork.changed", []byte("new"), 0)
			case "acl":
				darwinTestSetACL(t, f, darwinTestACLEntries(false))
			case "mode":
				err = f.Chmod(0600)
			case "mtime":
				var stat unix.Stat_t
				if err = unix.Fstat(int(f.Fd()), &stat); err == nil {
					times := []unix.Timeval{unix.NsecToTimeval(stat.Atim.Nano()), unix.NsecToTimeval(stat.Mtim.Nano() + 1000000000)}
					err = unix.Futimes(int(f.Fd()), times)
				}
			case "same-inode-apply":
				if m.apply(f) == nil {
					t.Fatal("apply accepted original inode")
				}
				return
			case "cancel":
				cancel()
			}
			if err != nil {
				t.Fatal(err)
			}
			if m.matches(f) == nil {
				t.Fatal("metadata change accepted")
			}
		})
	}
}

func TestDarwinConditionalWriteRejectsUnsafeMetadata(t *testing.T) {
	for _, kind := range []string{"hardlink", "special-mode", "flags", "resource-fork", "decmpfs", "too-many-attrs", "too-large-attr", "total-budget"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			f := darwinTestFile(t, root, "file")
			original, err := f.Stat()
			if err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "hardlink":
				err = os.Link(f.Name(), filepath.Join(root, "link"))
			case "special-mode":
				err = f.Chmod(0640 | os.ModeSetuid)
			case "flags":
				err = unix.Fchflags(int(f.Fd()), unix.UF_NODUMP)
			case "resource-fork":
				err = unix.Fsetxattr(int(f.Fd()), "com.apple.ResourceFork", []byte("fork"), 0)
			case "decmpfs":
				err = unix.Fsetxattr(int(f.Fd()), "com.apple.decmpfs", []byte("compressed"), 0)
			case "too-many-attrs":
				for i := 0; i < 257 && err == nil; i++ {
					err = unix.Fsetxattr(int(f.Fd()), fmt.Sprintf("org.narrafork.%d", i), []byte("x"), 0)
				}
			case "too-large-attr":
				err = unix.Fsetxattr(int(f.Fd()), "org.narrafork.large", make([]byte, 65537), 0)
			case "total-budget":
				for i := 0; i < 5 && err == nil; i++ {
					err = unix.Fsetxattr(int(f.Fd()), fmt.Sprintf("org.narrafork.large.%d", i), make([]byte, 65536), 0)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			h := New(NewPathGuard([]string{root}), 4000000)
			if _, err := h.FsWriteConditional(context.Background(), conditionalParams(f.Name(), "before", "after")); err == nil {
				t.Fatal("unsafe metadata accepted")
			}
			now, err := os.Stat(f.Name())
			if err != nil || !os.SameFile(original, now) {
				t.Fatal("original inode replaced")
			}
			data, err := os.ReadFile(f.Name())
			if err != nil || string(data) != "before" {
				t.Fatalf("original altered: %q %v", data, err)
			}
			files, err := filepath.Glob(filepath.Join(root, ".nf-conditional-*"))
			if err != nil || len(files) != 0 {
				t.Fatal("temporary artifact leaked")
			}
		})
	}
}

func TestDarwinACLNativeAllocationAndErrno(t *testing.T) {
	for _, stage := range []string{"absent", "get-error", "size-error", "oversize", "copy-error", "short-copy", "success", "free-error"} {
		t.Run(stage, func(t *testing.T) {
			var errno int32
			freed := 0
			api := &darwinACLNative{
				errno: func() *int32 { return &errno },
				getFD: func(int32) uintptr {
					if errno != 0 {
						t.Fatal("stale errno not cleared")
					}
					if stage == "absent" {
						errno = int32(unix.ENOENT)
						return 0
					}
					if stage == "get-error" {
						errno = int32(unix.EACCES)
						return 0
					}
					return 2
				},
				size: func(uintptr) int64 {
					if stage == "size-error" {
						errno = int32(unix.EINVAL)
						return -1
					}
					if stage == "oversize" {
						return darwinMaxACLBytes + 1
					}
					return 4
				},
				copyExt: func(p unsafe.Pointer, _ uintptr, _ int64) int64 {
					if stage == "copy-error" {
						errno = int32(unix.ERANGE)
						return -1
					}
					if stage == "short-copy" {
						return 3
					}
					copy(unsafe.Slice((*byte)(p), 4), []byte("test"))
					return 4
				},
				free: func(uintptr) int32 {
					freed++
					// Deliberately clobber errno: primary errors must have been
					// materialized before cleanup (and before thread unlock).
					errno = int32(unix.EIO)
					if stage == "free-error" {
						return -1
					}
					return 0
				},
			}
			errno = int32(unix.EPERM)
			data, err := api.read(10)
			wantFree := 1
			if stage == "absent" || stage == "get-error" {
				wantFree = 0
			}
			if freed != wantFree {
				t.Fatalf("freed %d, want %d", freed, wantFree)
			}
			switch stage {
			case "absent":
				if err != nil || data != nil {
					t.Fatalf("%x %v", data, err)
				}
			case "success":
				if err != nil || !bytes.Equal(data, []byte("test")) {
					t.Fatalf("%x %v", data, err)
				}
			case "get-error":
				if !errors.Is(err, unix.EACCES) {
					t.Fatal(err)
				}
			case "size-error":
				if !errors.Is(err, unix.EINVAL) {
					t.Fatal(err)
				}
			case "copy-error":
				if !errors.Is(err, unix.ERANGE) {
					t.Fatal(err)
				}
			default:
				if err == nil {
					t.Fatal("native failure accepted")
				}
			}
		})
	}
}

func TestDarwinACLNativeWriteCleanup(t *testing.T) {
	for _, stage := range []string{"import-error", "set-error", "set-success", "filesec-error", "property-error", "chmod-error", "remove-success"} {
		t.Run(stage, func(t *testing.T) {
			var errno int32
			freed, secFreed := 0, 0
			api := &darwinACLNative{
				errno: func() *int32 { return &errno },
				copyInt: func(unsafe.Pointer) uintptr {
					if stage == "import-error" {
						errno = int32(unix.EINVAL)
						return 0
					}
					return 2
				},
				setFD: func(int32, uintptr) int32 {
					if stage == "set-error" {
						errno = int32(unix.EPERM)
						return -1
					}
					return 0
				},
				free: func(uintptr) int32 { freed++; errno = int32(unix.EIO); return 0 },
				filesecInit: func() uintptr {
					if stage == "filesec-error" {
						errno = int32(unix.ENOMEM)
						return 0
					}
					return 3
				},
				filesecSet: func(sec uintptr, property int32, value uintptr) int32 {
					if sec != 3 || property != 5 || value != 1 {
						t.Fatal("incorrect ACL remove sentinel")
					}
					if stage == "property-error" {
						errno = int32(unix.EINVAL)
						return -1
					}
					return 0
				},
				filesecFree: func(uintptr) { secFreed++; errno = int32(unix.EIO) },
				chmodx: func(int32, uintptr) int32 {
					if stage == "chmod-error" {
						errno = int32(unix.EACCES)
						return -1
					}
					return 0
				},
			}
			var data []byte
			if stage == "import-error" || stage == "set-error" || stage == "set-success" {
				data = []byte("test")
			}
			err := api.write(10, data)
			if stage == "set-success" || stage == "remove-success" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil {
				t.Fatal("native failure accepted")
			}
			if data != nil {
				want := 1
				if stage == "import-error" {
					want = 0
				}
				if freed != want || secFreed != 0 {
					t.Fatalf("release counts: ACL=%d filesec=%d", freed, secFreed)
				}
			} else {
				want := 1
				if stage == "filesec-error" {
					want = 0
				}
				if freed != 0 || secFreed != want {
					t.Fatalf("release counts: ACL=%d filesec=%d", freed, secFreed)
				}
			}
			if stage == "set-error" && !errors.Is(err, unix.EPERM) {
				t.Fatal(err)
			}
			if stage == "chmod-error" && !errors.Is(err, unix.EACCES) {
				t.Fatal(err)
			}
		})
	}
}

func TestDarwinNativeErrnoThreadBinding(t *testing.T) {
	api, err := loadDarwinACL()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 100; i++ {
		if _, err := api.read(-1); !errors.Is(err, unix.EBADF) {
			t.Fatalf("wrong thread errno: %v", err)
		}
		runtime.Gosched()
	}
}
