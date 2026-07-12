package handlers

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestDisableShellBlocksExecStart verifies that ExecStart returns an error
// when the executor is configured with --disable-shell.
func TestDisableShellBlocksExecStart(t *testing.T) {
	root := t.TempDir()
	guard := NewPathGuard([]string{root})
	h := NewWithOptions(guard, 1024*1024, true /* disableShell */)

	_, err := h.ExecStart(context.Background(), map[string]any{
		"command": "echo hello",
		"cwd":     root,
	}, func(string, []byte) {})
	if err == nil {
		t.Fatal("ExecStart should be rejected when shell is disabled")
	}
}

// TestDisableShellBlocksPtyOpen verifies that PtyOpen returns an error when
// the executor is configured with --disable-shell (non-Windows platforms).
func TestDisableShellBlocksPtyOpen(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PTY test skipped on Windows")
	}
	root := t.TempDir()
	guard := NewPathGuard([]string{root})
	h := NewWithOptions(guard, 1024*1024, true /* disableShell */)

	_, err := h.PtyOpen(context.Background(), map[string]any{
		"ptyId": "test-pty",
		"cwd":   root,
	}, func(string, []byte) {})
	if err == nil {
		t.Fatal("PtyOpen should be rejected when shell is disabled")
	}
}

// TestShellEnabledAllowsExecStart verifies that ExecStart works normally when
// shell is NOT disabled (a basic sanity check).
func TestShellEnabledAllowsExecStart(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("exec test skipped on Windows")
	}
	root := t.TempDir()
	outFile := filepath.Join(root, "out.txt")
	guard := NewPathGuard([]string{root})
	h := NewWithOptions(guard, 1024*1024, false /* disableShell */)

	var captured []byte
	_, err := h.ExecStart(context.Background(), map[string]any{
		"command": "echo hello > " + outFile,
		"cwd":     root,
	}, func(ch string, chunk []byte) {
		if ch == "stdout" {
			captured = append(captured, chunk...)
		}
	})
	if err != nil {
		t.Fatalf("ExecStart with shell enabled failed: %v", err)
	}
	// Command ran to completion; the output file should exist.
	if _, statErr := os.Stat(outFile); statErr != nil {
		t.Fatalf("output file not created: %v", statErr)
	}
}

// TestAllowRootDoesNotSandboxShellCommands locks in the documented trust
// boundary: allow-root validates the initial cwd, not paths referenced by an
// opaque shell command. Hard confinement requires --disable-shell plus OS-level
// isolation.
func TestAllowRootDoesNotSandboxShellCommands(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell boundary test uses POSIX shell syntax")
	}
	base := t.TempDir()
	root := filepath.Join(base, "allowed")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(base, "outside.txt")
	h := NewWithOptions(NewPathGuard([]string{root}), 1024*1024, false)

	_, err := h.ExecStart(context.Background(), map[string]any{
		"command":  `printf boundary > "$NF_BOUNDARY_TARGET"`,
		"cwd":      root,
		"freshEnv": true,
		"env":      map[string]any{"NF_BOUNDARY_TARGET": outside},
	}, func(string, []byte) {})
	if err != nil {
		t.Fatalf("shell command failed: %v", err)
	}
	data, err := os.ReadFile(outside)
	if err != nil || string(data) != "boundary" {
		t.Fatalf("expected command to access path outside allow-root: data=%q err=%v", data, err)
	}
}

// TestDisableShellDoesNotBlockGit verifies that git operations are unaffected
// by --disable-shell.
func TestDisableShellDoesNotBlockGit(t *testing.T) {
	// GitStatus requires a real git repo; if git is not installed we skip.
	root := t.TempDir()
	guard := NewPathGuard([]string{root})
	h := NewWithOptions(guard, 1024*1024, true /* disableShell */)

	// GitStatus should return an error because the directory is not a git repo,
	// NOT because the shell is disabled.
	_, err := h.GitStatus(map[string]any{"cwd": root})
	if err != nil && err.Error() == "shell execution is disabled on this executor (--disable-shell)" {
		t.Fatal("GitStatus incorrectly blocked by disable-shell")
	}
	// Any other error (not a git repo, git not found) is acceptable here.
}
