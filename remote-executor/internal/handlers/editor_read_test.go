package handlers

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEditorRootIdentityStableAndObjectBound(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "workspace")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	h := New(NewPathGuard([]string{parent}), 1024)
	result, err := h.FsStat(map[string]any{"path": root, "editorIdentity": true})
	if err != nil {
		t.Fatal(err)
	}
	a := result.(map[string]any)
	if a["canonicalRoot"] != a["resolvedPath"] || a["runtimeEpoch"] != EditorRuntimeEpoch() {
		t.Fatal("invalid identity metadata", a)
	}
	if err := os.WriteFile(filepath.Join(root, "new"), []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	_, same, err := h.EditorRootIdentity(root)
	if err != nil || same != a["rootIdentity"] {
		t.Fatal("directory content changed root identity", err)
	}
	if err := os.Rename(root, root+".old"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	_, changed, err := h.EditorRootIdentity(root)
	if err != nil || changed == same {
		t.Fatal("root replacement did not change identity", err)
	}
	legacy, err := h.FsStat(map[string]any{"path": root})
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"rootIdentity", "canonicalRoot", "runtimeEpoch"} {
		if _, exists := legacy.(map[string]any)[key]; exists {
			t.Fatal("legacy response changed", key)
		}
	}
}

func TestEditorReadGuardAndNonregular(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	path := filepath.Join(outside, "file")
	if err := os.WriteFile(path, []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	h := New(NewPathGuard([]string{root}), 1024)
	if _, _, _, err := h.OpenEditorReadFile(path); err == nil {
		t.Fatal("read outside guard")
	}
	if _, _, err := h.EditorRootIdentity(outside); err == nil {
		t.Fatal("root outside guard")
	}
	if _, _, _, err := h.OpenEditorReadFile(root); err == nil {
		t.Fatal("directory read accepted")
	}
	link := filepath.Join(root, "symlink")
	if err := os.Symlink(path, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if _, _, _, err := h.OpenEditorReadFile(link); err == nil {
		t.Fatal("symlink accepted")
	}
}
