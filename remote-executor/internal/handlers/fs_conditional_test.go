package handlers

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
)

func conditionalParams(path string, before any, after string) map[string]any {
	var expected any
	if text, ok := before.(string); ok {
		expected = base64.StdEncoding.EncodeToString([]byte(text))
	}
	return map[string]any{"path": path, "expectedResolvedPath": path, "expectedDataB64": expected, "dataB64": base64.StdEncoding.EncodeToString([]byte(after))}
}

func TestConditionalWriteConflictAndCreate(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "file.txt")
	h := New(NewPathGuard([]string{root}), 4000000)
	p := conditionalParams(path, nil, "first")
	result, err := h.FsWriteConditional(context.Background(), p)
	if err != nil || result.(map[string]any)["applied"] != true {
		t.Fatalf("create: %v %v", result, err)
	}
	result, err = h.FsWriteConditional(context.Background(), p)
	if err != nil || result.(map[string]any)["conflict"] != true {
		t.Fatalf("create conflict: %v %v", result, err)
	}
	if err := os.WriteFile(path, []byte("external"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err = h.FsWriteConditional(context.Background(), conditionalParams(path, "first", "next"))
	if err != nil || result.(map[string]any)["conflict"] != true {
		t.Fatalf("stale: %v %v", result, err)
	}
	data, _ := os.ReadFile(path)
	if string(data) != "external" {
		t.Fatal("clobbered external content")
	}
}

func TestConditionalWriteConcurrentOnlyOneApplies(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("existing-file replacement is fail-closed; covered by platform rejection test")
	}
	root := t.TempDir()
	path := filepath.Join(root, "file.txt")
	if err := os.WriteFile(path, []byte("before"), 0600); err != nil {
		t.Fatal(err)
	}
	h := New(NewPathGuard([]string{root}), 4000000)
	var wg sync.WaitGroup
	results := make(chan bool, 2)
	for _, text := range []string{"one", "two"} {
		wg.Add(1)
		go func(next string) {
			defer wg.Done()
			result, err := h.FsWriteConditional(context.Background(), conditionalParams(path, "before", next))
			if err != nil {
				t.Error(err)
				results <- false
				return
			}
			results <- result.(map[string]any)["applied"] == true
		}(text)
	}
	wg.Wait()
	close(results)
	count := 0
	for applied := range results {
		if applied {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("applied %d, want one", count)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0600 {
		t.Fatal("permissions not preserved")
	}
}

func TestConditionalWriteCancellationAndIdentity(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "file.txt")
	h := New(NewPathGuard([]string{root}), 4000000)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := h.FsWriteConditional(ctx, conditionalParams(path, nil, "next")); err == nil {
		t.Fatal("cancelled write accepted")
	}
	p := conditionalParams(path, nil, "next")
	p["expectedResolvedPath"] = filepath.Join(root, "other")
	result, err := h.FsWriteConditional(context.Background(), p)
	if err != nil || result.(map[string]any)["conflict"] != true {
		t.Fatalf("identity: %v %v", result, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("file created on rejection")
	}
}

func TestConditionalWriteBoundedAndNoTemporaryLeak(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "file.txt")
	h := New(NewPathGuard([]string{root}), 4000000)
	p := conditionalParams(path, nil, string(make([]byte, 2000001)))
	if _, err := h.FsWriteConditional(context.Background(), p); err == nil {
		t.Fatal("oversized write accepted")
	}
	p = conditionalParams(path, nil, "next")
	delete(p, "expectedDataB64")
	if _, err := h.FsWriteConditional(context.Background(), p); err == nil {
		t.Fatal("missing expectation accepted")
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 0 {
		t.Fatal("rejected write left artifacts")
	}
}
