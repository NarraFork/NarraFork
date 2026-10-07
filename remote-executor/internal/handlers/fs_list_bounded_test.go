package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestFsListBoundedLimits(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 520; i++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("entry-%03d", i)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	h := New(NewPathGuard([]string{root}), 1024*1024)
	result, err := h.FsListBounded(context.Background(), map[string]any{"path": root, "expectedResolvedPath": root, "maxEntries": float64(3)})
	if err != nil {
		t.Fatal(err)
	}
	m := result.(map[string]any)
	if len(m["entries"].([]map[string]any)) != 3 || m["truncated"] != true || m["reason"] != "entry_limit" {
		t.Fatalf("unexpected result: %#v", m)
	}
	result, err = h.FsListBounded(context.Background(), map[string]any{"path": root, "maxEntries": float64(99999)})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.(map[string]any)["entries"].([]map[string]any)) != 500 {
		t.Fatal("hard entry ceiling not enforced")
	}
	result, err = h.FsListBounded(context.Background(), map[string]any{"path": root, "maxScanned": float64(2)})
	if err != nil {
		t.Fatal(err)
	}
	if result.(map[string]any)["reason"] != "scan_limit" {
		t.Fatal("scan limit not reported")
	}
}

func TestFsListBoundedBytesAndCancellation(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 10; i++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("%d-%s", i, strings.Repeat("x", 100))), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	h := New(NewPathGuard([]string{root}), 1024*1024)
	result, err := h.FsListBounded(context.Background(), map[string]any{"path": root, "maxBytes": float64(512)})
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(result)
	if len(data) > 512 || result.(map[string]any)["reason"] != "byte_limit" {
		t.Fatalf("unbounded response: %s", data)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := h.FsListBounded(ctx, map[string]any{"path": root}); err == nil {
		t.Fatal("cancelled request succeeded")
	}
	if _, err := h.FsListBounded(context.Background(), map[string]any{"path": root, "expectedResolvedPath": filepath.Join(root, "other")}); err == nil {
		t.Fatal("canonical mismatch accepted")
	}
	if _, err := h.FsListBounded(context.Background(), map[string]any{"path": root, "maxBytes": float64(1)}); err == nil {
		t.Fatal("impossible byte budget accepted")
	}
}

func TestFsListBoundedRootGuardAndLinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs elevation")
	}
	base := t.TempDir()
	root, outside := filepath.Join(base, "allowed"), filepath.Join(base, "outside")
	if err := os.MkdirAll(filepath.Join(root, "real"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0700); err != nil {
		t.Fatal(err)
	}
	mustSymlink(t, filepath.Join(root, "real"), filepath.Join(root, "inside-link"))
	mustSymlink(t, outside, filepath.Join(root, "outside-link"))
	h := New(NewPathGuard([]string{root}), 1024*1024)
	result, err := h.FsListBounded(context.Background(), map[string]any{"path": root, "expectedResolvedPath": root})
	if err != nil {
		t.Fatal(err)
	}
	inside := false
	for _, entry := range result.(map[string]any)["entries"].([]map[string]any) {
		if entry["name"] == "outside-link" {
			t.Fatal("out-of-root link exposed")
		}
		if entry["name"] == "inside-link" {
			inside = entry["isDirectory"] == true && entry["isSymlink"] == true
		}
	}
	if !inside {
		t.Fatal("allowed directory link missing")
	}
	if _, err := h.FsListBounded(context.Background(), map[string]any{"path": outside}); err == nil {
		t.Fatal("outside directory allowed")
	}
}
