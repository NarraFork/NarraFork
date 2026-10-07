package handlers

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

type checkingContext struct {
	context.Context
	checks int
	check  func(int) error
}

func (c *checkingContext) Err() error { c.checks++; return c.check(c.checks) }

func TestGlobBoundedFiltersAndDirectoryNavigation(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "中文 dir"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"中文 dir/file.ts", "other.ts", ".hidden.ts"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("do not read contents"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	h := New(NewPathGuard([]string{root}), 4096)
	result, err := h.GlobContext(context.Background(), map[string]any{"cwd": root, "pattern": "**/*", "query": "中文", "includeDirectories": true, "timeoutMs": 2000})
	if err != nil {
		t.Fatal(err)
	}
	payload := result.(map[string]any)
	matches := payload["matches"].([]string)
	if len(matches) != 2 || payload["truncated"] != false {
		t.Fatalf("unexpected result %#v", payload)
	}
	for _, match := range matches {
		if match != "中文 dir" && match != "中文 dir/file.ts" {
			t.Fatalf("unexpected match %q", match)
		}
	}
}

func TestGlobStopsOnCountBytesAndCancellationWithoutMatches(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 300; i++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("file-%03d.ts", i)), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	h := New(NewPathGuard([]string{root}), 4096)
	counting := &checkingContext{Context: context.Background(), check: func(n int) error {
		if n > 30 {
			return context.Canceled
		}
		return nil
	}}
	result, err := h.GlobContext(counting, map[string]any{"cwd": root, "pattern": "**/*", "maxResults": 3, "maxBytes": 4096})
	if err != nil {
		t.Fatalf("scan did not stop at result cap: %v", err)
	}
	payload := result.(map[string]any)
	if len(payload["matches"].([]string)) != 3 || payload["truncated"] != true {
		t.Fatalf("unexpected count result %#v", payload)
	}
	result, err = h.GlobContext(context.Background(), map[string]any{"cwd": root, "pattern": "**/*", "maxBytes": 5})
	if err != nil {
		t.Fatal(err)
	}
	payload = result.(map[string]any)
	if len(payload["matches"].([]string)) != 0 || payload["truncated"] != true {
		t.Fatalf("unexpected byte result %#v", payload)
	}
	unmatched := &checkingContext{Context: context.Background(), check: func(n int) error {
		if n >= 8 {
			return context.Canceled
		}
		return nil
	}}
	_, err = h.GlobContext(unmatched, map[string]any{"cwd": root, "pattern": "**/*.not-present", "query": "absent"})
	if !errors.Is(err, context.Canceled) || unmatched.checks < 8 {
		t.Fatalf("unmatched scan ignored cancellation: checks=%d err=%v", unmatched.checks, err)
	}
}

func TestGlobDeadlineAndGuardPruneCandidates(t *testing.T) {
	root := t.TempDir()
	denied := filepath.Join(root, "denied")
	if err := os.Mkdir(denied, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(denied, "secret.ts"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	h := New(NewPathGuardWithRules([]PathRule{{Action: RuleAllow, Path: root}, {Action: RuleDeny, Path: denied}}), 4096)
	result, err := h.GlobContext(context.Background(), map[string]any{"cwd": root, "pattern": "**/*", "includeDirectories": true})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.(map[string]any)["matches"].([]string)) != 0 {
		t.Fatalf("denied directory became an anchor: %#v", result)
	}
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	if _, err := h.GlobContext(ctx, map[string]any{"cwd": root, "pattern": "**/*"}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline ignored: %v", err)
	}
}

type cancelAfterRead struct {
	cancel context.CancelFunc
	calls  int
}

func (r *cancelAfterRead) Read(buffer []byte) (int, error) {
	r.calls++
	for i := range buffer {
		buffer[i] = 'x'
	}
	r.cancel()
	return len(buffer), nil
}

func TestBoundedReadCancelsBetweenChunksAndDetectsProbeByte(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	reader := &cancelAfterRead{cancel: cancel}
	_, _, err := readFileChunks(ctx, reader, 1024*1024, ctx.Err)
	if !errors.Is(err, context.Canceled) || reader.calls != 1 {
		t.Fatalf("read did not stop between chunks: calls=%d err=%v", reader.calls, err)
	}
	data, truncated, err := readFileChunks(context.Background(), bytes.NewReader(bytes.Repeat([]byte{'x'}, 100)), 20, func() error { return nil })
	if err != nil || !truncated || len(data) != 20 {
		t.Fatalf("missing overflow probe: n=%d truncated=%v err=%v", len(data), truncated, err)
	}
}

func TestProtectedReadRechecksCanonicalIdentityAfterReading(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows may deny renaming an open file")
	}
	root := t.TempDir()
	path := filepath.Join(root, "file.txt")
	if err := os.WriteFile(path, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	h := New(NewPathGuard([]string{root}), 4096)
	changed := false
	ctx := &checkingContext{Context: context.Background(), check: func(n int) error {
		if n == 4 {
			if err := os.Rename(path, path+".old"); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte("replacement"), 0600); err != nil {
				t.Fatal(err)
			}
			changed = true
		}
		return nil
	}}
	_, err := h.FsReadContext(ctx, map[string]any{"path": path, "expectedResolvedPath": path, "maxBytes": 128, "timeoutMs": 2000})
	if !changed || err == nil {
		t.Fatalf("read released content after path replacement: changed=%v checks=%d err=%v", changed, ctx.checks, err)
	}
}

func TestBoundedOffsetRead(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "range.txt")
	if err := os.WriteFile(path, []byte("0123456789"), 0600); err != nil {
		t.Fatal(err)
	}
	h := New(NewPathGuard([]string{root}), 4096)
	for _, tc := range []struct {
		offset    float64
		expected  string
		truncated bool
	}{{3, "3456", true}, {8, "89", false}, {10, "", false}} {
		result, err := h.FsReadContext(context.Background(), map[string]any{"path": path, "expectedResolvedPath": path, "maxBytes": float64(4), "offset": tc.offset})
		if err != nil {
			t.Fatal(err)
		}
		payload := result.(map[string]any)
		if payload["dataB64"] != base64.StdEncoding.EncodeToString([]byte(tc.expected)) || payload["truncated"] != tc.truncated || payload["totalSize"] != int64(10) {
			t.Fatalf("incorrect page: %#v", payload)
		}
	}
	for _, invalid := range []float64{-1, 1.5} {
		if _, err := h.FsReadContext(context.Background(), map[string]any{"path": path, "offset": invalid}); err == nil {
			t.Fatal("invalid offset accepted")
		}
	}
}

func TestProtectedReadPreservesResultShapeAndHonorsDeadline(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "file.txt")
	if err := os.WriteFile(path, []byte("saved"), 0600); err != nil {
		t.Fatal(err)
	}
	h := New(NewPathGuard([]string{root}), 4096)
	result, err := h.FsReadContext(context.Background(), map[string]any{"path": path, "expectedResolvedPath": path, "maxBytes": 100, "timeoutMs": 2000})
	if err != nil {
		t.Fatal(err)
	}
	payload := result.(map[string]any)
	if payload["dataB64"] != base64.StdEncoding.EncodeToString([]byte("saved")) || payload["truncated"] != false || payload["resolvedPath"] != path {
		t.Fatalf("read shape changed: %#v", payload)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := h.FsReadContext(ctx, map[string]any{"path": path}); !errors.Is(err, context.Canceled) {
		t.Fatalf("read ignored cancellation: %v", err)
	}
}
