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

func TestConditionalWritePreservesLinuxMetadata(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "file")
	if err := os.WriteFile(path, []byte("before"), 0640); err != nil {
		t.Fatal(err)
	}
	// POSIX ACL xattr format: version 2, then tag/permission/id records.
	acl := make([]byte, 4+5*8)
	binary.LittleEndian.PutUint32(acl, 2)
	entries := []struct {
		tag, perm uint16
		id        uint32
	}{
		{1, 6, ^uint32(0)}, {2, 4, uint32(os.Getuid()) + 1},
		{4, 0, ^uint32(0)}, {16, 4, ^uint32(0)}, {32, 0, ^uint32(0)},
	}
	for i, entry := range entries {
		p := acl[4+i*8:]
		binary.LittleEndian.PutUint16(p, entry.tag)
		binary.LittleEndian.PutUint16(p[2:], entry.perm)
		binary.LittleEndian.PutUint32(p[4:], entry.id)
	}
	if err := unix.Setxattr(path, "system.posix_acl_access", acl, 0); err != nil {
		t.Fatalf("ACL fixture unavailable: %v", err)
	}
	for name, value := range map[string]string{"user.narrafork.first": "first-value", "user.narrafork.second": "second-value"} {
		if err := unix.Setxattr(path, name, []byte(value), 0); err != nil {
			t.Fatal(err)
		}
	}
	before, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := captureConditionalMetadata(before)
	before.Close()
	if err != nil {
		t.Fatal(err)
	}
	h := New(NewPathGuard([]string{root}), 4000000)
	result, err := h.FsWriteConditional(context.Background(), conditionalParams(path, "before", "after"))
	if err != nil || result.(map[string]any)["applied"] != true {
		t.Fatalf("%v %v", result, err)
	}
	after, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer after.Close()
	if err := metadata.matches(after); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 1024)
	n, err := unix.Fgetxattr(int(after.Fd()), "system.posix_acl_access", buf)
	if err != nil || !bytes.Equal(buf[:n], acl) {
		t.Fatalf("ACL lost: %x %v", buf[:n], err)
	}
}

func TestConditionalWriteRejectsUnsafeMetadata(t *testing.T) {
	for _, kind := range []string{"hardlink", "special-mode", "inode-flags"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "file")
			if err := os.WriteFile(path, []byte("before"), 0600); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "hardlink":
				if err := os.Link(path, filepath.Join(root, "linked")); err != nil {
					t.Fatal(err)
				}
			case "special-mode":
				if err := os.Chmod(path, 0600|os.ModeSetuid); err != nil {
					t.Fatal(err)
				}
			case "inode-flags":
				f, err := os.Open(path)
				if err != nil {
					t.Fatal(err)
				}
				defer f.Close()
				flags, err := unix.IoctlGetInt(int(f.Fd()), unix.FS_IOC_GETFLAGS)
				if err != nil {
					t.Fatal(err)
				}
				// NODUMP is safe to set as the owner but must not be lost on rename.
				if err := unix.IoctlSetPointerInt(int(f.Fd()), unix.FS_IOC_SETFLAGS, flags|0x40); err != nil {
					t.Fatal(err)
				}
			}
			h := New(NewPathGuard([]string{root}), 4000000)
			if _, err := h.FsWriteConditional(context.Background(), conditionalParams(path, "before", "after")); err == nil {
				t.Fatal("unsafe metadata accepted")
			}
			data, err := os.ReadFile(path)
			if err != nil || string(data) != "before" {
				t.Fatalf("original altered: %q %v", data, err)
			}
			files, err := filepath.Glob(filepath.Join(root, ".nf-conditional-*"))
			if err != nil || len(files) != 0 {
				t.Fatal("temporary file leaked")
			}
		})
	}
}

func TestConditionalMetadataDetectsConcurrentChange(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(path, []byte("before"), 0600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	metadata, err := captureConditionalMetadata(f)
	if err != nil {
		t.Fatal(err)
	}
	if err := unix.Fsetxattr(int(f.Fd()), "user.narrafork", []byte("new"), 0); err != nil {
		t.Fatal(err)
	}
	if err := metadata.matches(f); err == nil {
		t.Fatal("concurrent metadata change accepted")
	}
}

func TestConditionalWriteDoesNotGainInheritedACL(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "file")
	if err := os.WriteFile(path, []byte("before"), 0600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := captureConditionalMetadata(f)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	acl := make([]byte, 44)
	binary.LittleEndian.PutUint32(acl, 2)
	for i, tag := range []uint16{1, 2, 4, 16, 32} {
		p := acl[4+i*8:]
		binary.LittleEndian.PutUint16(p, tag)
		binary.LittleEndian.PutUint16(p[2:], 7)
		id := ^uint32(0)
		if tag == 2 {
			id = uint32(os.Getuid()) + 1
		}
		binary.LittleEndian.PutUint32(p[4:], id)
	}
	if err := unix.Setxattr(root, "system.posix_acl_default", acl, 0); err != nil {
		t.Fatal(err)
	}
	h := New(NewPathGuard([]string{root}), 4000000)
	result, err := h.FsWriteConditional(context.Background(), conditionalParams(path, "before", "after"))
	if err != nil || result.(map[string]any)["applied"] != true {
		t.Fatalf("%v %v", result, err)
	}
	f, err = os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := metadata.matches(f); err != nil {
		t.Fatalf("replacement gained inherited metadata: %v", err)
	}
}

func TestConditionalMetadataOwnerFailureIsClosed(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("requires unprivileged executor")
	}
	root := t.TempDir()
	path := filepath.Join(root, "file")
	if err := os.WriteFile(path, []byte("before"), 0600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := captureConditionalMetadata(f)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	m := metadata.(*linuxConditionalMetadata)
	m.UID++
	tmp, err := os.CreateTemp(root, ".nf-test-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	if err := m.apply(tmp); err == nil {
		t.Fatal("unpreservable owner accepted")
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "before" {
		t.Fatal("original altered on metadata failure")
	}
}
