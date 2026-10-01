//go:build windows || darwin

package handlers

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestConditionalWriteRejectsUnverifiablePlatformMetadata(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "file")
	if err := os.WriteFile(path, []byte("before"), 0600); err != nil {
		t.Fatal(err)
	}
	original, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	h := New(NewPathGuard([]string{root}), 4000000)
	if _, err := h.FsWriteConditional(context.Background(), conditionalParams(path, "before", "after")); err == nil {
		t.Fatal("unverifiable replacement accepted")
	}
	current, err := os.Stat(path)
	if err != nil || !os.SameFile(original, current) {
		t.Fatal("original inode replaced")
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "before" {
		t.Fatal("original content altered")
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 1 {
		t.Fatal("temporary artifact leaked")
	}
}
