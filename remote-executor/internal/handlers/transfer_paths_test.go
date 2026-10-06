package handlers

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type transferPathNopSender struct{}

func (transferPathNopSender) SendBinary([]byte) error { return nil }
func (transferPathNopSender) BufferedAmount() int     { return 0 }

func TestValidateTransferRelPath(t *testing.T) {
	safe, err := validateTransferRelPath(filepath.Join("nested", "file.txt"))
	if err != nil {
		t.Fatalf("safe relPath rejected: %v", err)
	}
	if safe != "nested/file.txt" {
		t.Fatalf("safe relPath was not slash-normalized: %q", safe)
	}

	for _, relPath := range []string{
		t.TempDir(),
		"../outside.txt",
		"nested/../file.txt",
		"nested\\..\\file.txt",
		"nested/../../outside.txt",
	} {
		if _, err := validateTransferRelPath(relPath); err == nil {
			t.Fatalf("unsafe relPath accepted: %q", relPath)
		}
	}
}

func TestTransferHandlersRequireAbsoluteRemotePaths(t *testing.T) {
	root := t.TempDir()
	h := New(NewPathGuard([]string{root}), 1024*1024)
	if _, err := h.TransferStat(map[string]any{"path": "relative/file.txt"}); err == nil {
		t.Fatal("transfer.stat accepted a relative remote path")
	} else if !strings.Contains(err.Error(), "must be absolute") {
		t.Fatalf("transfer.stat returned an unclear path error: %v", err)
	}

	transfers := NewTransfers(h, transferPathNopSender{})
	if _, err := transfers.Begin(context.Background(), map[string]any{
		"transferId": "relative-upload",
		"direction":  "upload",
		"remotePath": "relative/file.txt",
	}); err == nil {
		t.Fatal("transfer.begin accepted a relative remote path")
	} else if !strings.Contains(err.Error(), "must be absolute") {
		t.Fatalf("transfer.begin returned an unclear path error: %v", err)
	}
}

func TestTransferStatEmitsSafeSlashNormalizedManifestPaths(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "nested")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nested, "file.txt"), []byte("data"), 0o644); err != nil {
		t.Fatal(err)
	}

	h := New(NewPathGuard([]string{root}), 1024*1024)
	result, err := h.TransferStat(map[string]any{
		"path":      root,
		"recursive": true,
	})
	if err != nil {
		t.Fatalf("transfer.stat failed: %v", err)
	}
	entries := result.(map[string]any)["entries"].([]map[string]any)
	if len(entries) != 1 || entries[0]["relPath"] != "nested/file.txt" {
		t.Fatalf("unexpected transfer manifest entries: %#v", entries)
	}
}

func TestRequiredAbsoluteTransferPathUsesExecutorPlatformSemantics(t *testing.T) {
	paths := []string{"/srv/data/file.txt"}
	if runtime.GOOS == "windows" {
		paths = []string{`C:\\data\\file.txt`, `\\server\share\file.txt`}
	}
	for _, path := range paths {
		got, err := requiredAbsoluteTransferPath(map[string]any{"path": path}, "path")
		if err != nil {
			t.Fatalf("platform absolute path %q rejected: %v", path, err)
		}
		if got != path {
			t.Fatalf("absolute path changed: got %q want %q", got, path)
		}
	}
}
