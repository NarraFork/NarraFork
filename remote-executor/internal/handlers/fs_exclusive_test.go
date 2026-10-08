package handlers

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestFsMkdirExclusiveCollisionAndCanonicalGuard(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h := New(NewPathGuard([]string{root}), 1024*1024)
	path := filepath.Join(root, "ui")
	params := map[string]any{"path": path, "expectedResolvedPath": path}
	var wg sync.WaitGroup
	results := make(chan bool, 8)
	errors := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := h.FsMkdirExclusive(context.Background(), params)
			if err != nil {
				errors <- err
				return
			}
			results <- result.(map[string]any)["created"].(bool)
		}()
	}
	wg.Wait()
	close(results)
	close(errors)
	for err := range errors {
		t.Fatal(err)
	}
	created := 0
	for result := range results {
		if result {
			created++
		}
	}
	if created != 1 {
		t.Fatalf("exclusive mkdir created %d times", created)
	}
	if _, err := h.FsMkdirExclusive(context.Background(), map[string]any{"path": filepath.Join(root, "mismatch"), "expectedResolvedPath": path}); err == nil {
		t.Fatal("canonical mismatch accepted")
	}
	if _, err := h.FsMkdirExclusive(context.Background(), map[string]any{"path": filepath.Join(filepath.Dir(root), "outside"), "expectedResolvedPath": path}); err == nil {
		t.Fatal("out-of-guard path accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	cancelledPath := filepath.Join(root, "cancelled")
	if _, err := h.FsMkdirExclusive(ctx, map[string]any{"path": cancelledPath, "expectedResolvedPath": cancelledPath}); err == nil {
		t.Fatal("cancelled creation accepted")
	}
	if _, err := os.Stat(cancelledPath); !os.IsNotExist(err) {
		t.Fatal("cancelled operation created a directory")
	}
}

func TestFsWriteExclusiveNeverOverwrites(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h := New(NewPathGuard([]string{root}), 1024*1024)
	path := filepath.Join(root, "App.tsx")
	params := map[string]any{"path": path, "expectedResolvedPath": path, "exclusive": true, "dataB64": base64.StdEncoding.EncodeToString([]byte("original"))}
	if _, err := h.FsWriteContext(context.Background(), params); err != nil {
		t.Fatal(err)
	}
	params["dataB64"] = base64.StdEncoding.EncodeToString([]byte("replacement"))
	if _, err := h.FsWriteContext(context.Background(), params); err == nil {
		t.Fatal("exclusive write overwrote the existing file")
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "original" {
		t.Fatalf("existing content changed: %q", content)
	}
}
