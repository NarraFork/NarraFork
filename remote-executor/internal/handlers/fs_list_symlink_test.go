package handlers

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// fs.list feeds the interactive remote directory picker, which only shows entries
// reporting isDirectory == true. os.ReadDir returns lstat-derived types, so a
// symlink pointing at a directory answers IsDir() == false and used to disappear
// from the picker entirely. These tests pin the resolution and the cases where a
// link must still be dropped.

func listEntries(t *testing.T, h *Handlers, path string) map[string]map[string]any {
	t.Helper()
	res, err := h.FsList(map[string]any{"path": path})
	if err != nil {
		t.Fatalf("FsList(%q): %v", path, err)
	}
	raw, ok := res.(map[string]any)["entries"].([]map[string]any)
	if !ok {
		t.Fatalf("unexpected FsList result shape: %#v", res)
	}
	byName := make(map[string]map[string]any, len(raw))
	for _, entry := range raw {
		name, _ := entry["name"].(string)
		byName[name] = entry
	}
	return byName
}

func TestFsListResolvesSymlinkedDirectories(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires elevation on Windows")
	}
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "real-dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "real-file"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustSymlink(t, filepath.Join(root, "real-dir"), filepath.Join(root, "link-to-dir"))
	mustSymlink(t, filepath.Join(root, "real-file"), filepath.Join(root, "link-to-file"))

	entries := listEntries(t, New(NewPathGuard([]string{root}), 1024*1024), root)

	link, ok := entries["link-to-dir"]
	if !ok {
		t.Fatal("symlink to a directory is missing from fs.list; the picker cannot show it")
	}
	if link["isDirectory"] != true {
		t.Errorf("symlinked directory reported isDirectory=%v, want true", link["isDirectory"])
	}
	if link["isSymlink"] != true {
		t.Errorf("symlinked directory reported isSymlink=%v, want true", link["isSymlink"])
	}

	// A link to a file is still listed (fs.list is not directory-only), but must not
	// claim to be a directory.
	fileLink, ok := entries["link-to-file"]
	if !ok {
		t.Fatal("symlink to a file is missing from fs.list")
	}
	if fileLink["isDirectory"] != false {
		t.Errorf("symlink to file reported isDirectory=%v, want false", fileLink["isDirectory"])
	}
	if fileLink["isSymlink"] != true {
		t.Errorf("symlink to file reported isSymlink=%v, want true", fileLink["isSymlink"])
	}

	if real, ok := entries["real-dir"]; !ok {
		t.Fatal("real directory missing from fs.list")
	} else if real["isSymlink"] != false {
		t.Errorf("real directory reported isSymlink=%v, want false", real["isSymlink"])
	}
}

func TestFsListDropsUnusableAndOutOfRootSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires elevation on Windows")
	}
	base := t.TempDir()
	root := filepath.Join(base, "root")
	outside := filepath.Join(base, "outside")
	for _, dir := range []string{root, outside} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(root, "stays"), 0o755); err != nil {
		t.Fatal(err)
	}
	mustSymlink(t, outside, filepath.Join(root, "escape-link"))
	mustSymlink(t, filepath.Join(root, "nope"), filepath.Join(root, "dangling-link"))
	mustSymlink(t, filepath.Join(root, "cyclic-link"), filepath.Join(root, "cyclic-link"))

	entries := listEntries(t, New(NewPathGuard([]string{root}), 1024*1024), root)

	// A link out of allowRoots would be refused the moment the user descended into
	// it, so offering it in the picker only defers the failure.
	if _, ok := entries["escape-link"]; ok {
		t.Error("symlink resolving outside allowRoots must not be listed")
	}
	if _, ok := entries["dangling-link"]; ok {
		t.Error("dangling symlink must not be listed")
	}
	if _, ok := entries["cyclic-link"]; ok {
		t.Error("cyclic symlink must not be listed")
	}
	// The regression this guards: one unusable link must not empty the listing.
	if _, ok := entries["stays"]; !ok {
		t.Error("real directory dropped alongside the unusable symlinks")
	}
}

func mustSymlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("symlink %q -> %q: %v", link, target, err)
	}
}
