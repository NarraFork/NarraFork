//go:build linux

package handlers

import (
	"bytes"
	"context"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestEditorPreservesLinuxOwnerModeXattrsAndACL(t *testing.T) {
	f := newEditorFixture(t, []byte("before"))
	acl := make([]byte, 44)
	binary.LittleEndian.PutUint32(acl, 2)
	for i, tag := range []uint16{1, 2, 4, 16, 32} {
		entry := acl[4+i*8:]
		binary.LittleEndian.PutUint16(entry, tag)
		perm := uint16(4)
		if tag == 1 {
			perm = 6
		}
		if tag == 32 {
			perm = 0
		}
		binary.LittleEndian.PutUint16(entry[2:], perm)
		id := ^uint32(0)
		if tag == 2 {
			id = uint32(os.Getuid()) + 1
		}
		binary.LittleEndian.PutUint32(entry[4:], id)
	}
	if err := unix.Setxattr(f.path, "system.posix_acl_access", acl, 0); err != nil {
		t.Fatal("ACL fixture unavailable", err)
	}
	if err := unix.Setxattr(f.path, "user.editor-fixture", []byte("kept"), 0); err != nil {
		t.Fatal(err)
	}
	before, err := os.Open(f.path)
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := captureConditionalMetadata(before)
	before.Close()
	if err != nil {
		t.Fatal(err)
	}
	req := f.request(t, "metadata", []byte("before"), bytes.Repeat([]byte("after"), 700000))
	if result := f.call(t, "editor.apply", req).(EditorApplyResult); result.Outcome != "committed" {
		t.Fatalf("%+v", result)
	}
	after, err := os.Open(f.path)
	if err != nil {
		t.Fatal(err)
	}
	defer after.Close()
	if err = metadata.matches(after); err != nil {
		t.Fatal("metadata changed", err)
	}
	buf := make([]byte, 1024)
	n, err := unix.Fgetxattr(int(after.Fd()), "system.posix_acl_access", buf)
	if err != nil || !bytes.Equal(buf[:n], acl) {
		t.Fatal("ACL changed", err)
	}
}
func TestEditorLinuxRejectsUnsafeMetadataBeforeReplacement(t *testing.T) {
	for _, kind := range []string{"hardlink", "special-mode", "inode-flags", "read-permission", "directory-permission"} {
		t.Run(kind, func(t *testing.T) {
			f := newEditorFixture(t, []byte("before"))
			req := f.request(t, "unsafe", []byte("before"), []byte("after"))
			switch kind {
			case "hardlink":
				if err := os.Link(f.path, filepath.Join(f.root, "other")); err != nil {
					t.Fatal(err)
				}
			case "special-mode":
				if err := os.Chmod(f.path, 0600|os.ModeSetuid); err != nil {
					t.Fatal(err)
				}
			case "inode-flags":
				file, err := os.Open(f.path)
				if err != nil {
					t.Fatal(err)
				}
				defer file.Close()
				flags, err := unix.IoctlGetInt(int(file.Fd()), unix.FS_IOC_GETFLAGS)
				if err != nil {
					t.Fatal(err)
				}
				if err = unix.IoctlSetPointerInt(int(file.Fd()), unix.FS_IOC_SETFLAGS, flags|0x40); err != nil {
					t.Fatal(err)
				}
			case "read-permission":
				if err := os.Chmod(f.path, 0000); err != nil {
					t.Fatal(err)
				}
				defer os.Chmod(f.path, 0600)
			case "directory-permission":
				if err := os.Chmod(f.root, 0500); err != nil {
					t.Fatal(err)
				}
				defer os.Chmod(f.root, 0700)
			}
			if (kind == "read-permission" || kind == "directory-permission") && os.Geteuid() == 0 { // root has the actual authority; exercise the original metadata rejection instead.
				if err := os.Chmod(f.path, 0600|os.ModeSetuid); err != nil {
					t.Fatal(err)
				}
			}
			r := f.call(t, "editor.apply", req).(EditorApplyResult)
			if r.Outcome != "rejected" {
				t.Fatalf("unsafe %s: %+v", kind, r)
			}
			os.Chmod(f.path, 0600)
			got, err := os.ReadFile(f.path)
			if err != nil || string(got) != "before" {
				t.Fatal("original changed", err)
			}
		})
	}
}
func TestEditorKernelLockContentionIsBounded(t *testing.T) {
	f := newEditorFixture(t, nil)
	lock, err := os.OpenFile(filepath.Join(f.state, "engine.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err = unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	defer unix.Flock(int(lock.Fd()), unix.LOCK_UN)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = f.h.EditorDispatch(ctx, "editor.stage.open", editorParams(t, EditorStageOpen{Namespace: "owner", ResourceKey: "resource", MaxBytes: 1, IdleTimeoutMs: 1000})); err == nil {
		t.Fatal("cancelled lock acquisition succeeded")
	}
}
