//go:build !windows

package handlers

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/narrafork/remote-executor/internal/session"
)

func newSessionHandlers(t *testing.T) (*Handlers, string) {
	t.Helper()
	root := t.TempDir()
	h := New(NewPathGuard([]string{root}), 1<<20)
	m := session.NewManager(session.DefaultLimits())
	h.SetSessionManager(m)
	t.Cleanup(m.Shutdown)
	return h, root
}

func waitUntil(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not reached")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func readPID(t *testing.T, path string) int {
	t.Helper()
	var pid int
	waitUntil(t, func() bool {
		raw, err := os.ReadFile(path)
		if err != nil {
			return false
		}
		pid, err = strconv.Atoi(strings.TrimSpace(string(raw)))
		return err == nil && pid > 0
	})
	return pid
}

func TestSessionPtyInputDedupeAndExit(t *testing.T) {
	h, root := newSessionHandlers(t)
	if _, err := h.SessionOpen(map[string]any{
		"sessionId": "pty-1",
		"cmd":       []any{"/bin/sh", "-c", "read line; echo GOT:$line; read again; echo GOT:$again; exit 7"},
		"cwd":       root,
	}); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var out strings.Builder
	result := make(chan any, 1)
	go func() {
		r, _ := h.SessionAttach(context.Background(), map[string]any{"sessionId": "pty-1"}, func(ch string, b []byte) {
			if ch == session.ChannelData {
				mu.Lock()
				out.Write(b)
				mu.Unlock()
			}
		})
		result <- r
	}()
	write := func(text, id string) bool {
		res, err := h.SessionWrite(map[string]any{
			"sessionId": "pty-1",
			"dataB64":   base64.StdEncoding.EncodeToString([]byte(text)),
			"writeId":   id,
		})
		if err != nil {
			t.Fatal(err)
		}
		return res.(map[string]any)["duplicate"].(bool)
	}
	if write("first\n", "w1") {
		t.Fatal("first write reported duplicate")
	}
	// A retried write (lost acknowledgement) must not be typed into the shell again.
	if !write("first\n", "w1") {
		t.Fatal("retry was not deduplicated")
	}
	if write("second\n", "w2") {
		t.Fatal("second write reported duplicate")
	}
	select {
	case r := <-result:
		if r.(session.AttachResult).ExitCode != 7 {
			t.Fatalf("exit = %+v", r)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("session did not exit")
	}
	mu.Lock()
	text := out.String()
	mu.Unlock()
	if !strings.Contains(text, "GOT:first") || !strings.Contains(text, "GOT:second") {
		t.Fatalf("output = %q", text)
	}
}

func TestSessionKillStopsBackgroundChildren(t *testing.T) {
	h, root := newSessionHandlers(t)
	childPath := filepath.Join(root, "child.pid")
	if _, err := h.SessionOpen(map[string]any{
		"sessionId": "pty-2",
		"cmd":       []any{"/bin/sh", "-c", "sleep 300 & echo $! > " + childPath + "; wait"},
		"cwd":       root,
	}); err != nil {
		t.Fatal(err)
	}
	child := readPID(t, childPath)
	if _, err := h.SessionKill(map[string]any{"sessionId": "pty-2"}); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, func() bool { return syscall.Kill(child, 0) != nil })
	waitUntil(t, func() bool {
		info, err := h.SessionInfo(map[string]any{"sessionId": "pty-2"})
		return err == nil && info.(session.Info).State == "exited"
	})
}

func TestSessionOpenGuardsCwdAndKind(t *testing.T) {
	h, root := newSessionHandlers(t)
	if _, err := h.SessionOpen(map[string]any{"sessionId": "x", "cwd": "/"}); err == nil {
		t.Fatal("cwd outside allowed roots must be rejected")
	}
	if _, err := h.SessionOpen(map[string]any{"sessionId": "x", "cwd": root, "kind": "exec"}); err == nil {
		t.Fatal("unsupported kinds must be rejected")
	}
	if _, err := h.SessionOpen(map[string]any{"cwd": root}); err == nil {
		t.Fatal("missing sessionId must be rejected")
	}
}

// An interactive shell with job control gives every `cmd &` job its own process
// group; stopping the terminal must stop those jobs too, not only the shell's group.
func TestSessionKillStopsJobControlGroups(t *testing.T) {
	if _, err := os.Stat("/bin/bash"); err != nil {
		t.Skip("bash not installed")
	}
	h, root := newSessionHandlers(t)
	childPath := filepath.Join(root, "job.pid")
	if _, err := h.SessionOpen(map[string]any{
		"sessionId": "pty-jobs",
		"cmd":       []any{"/bin/bash", "--norc", "--noprofile", "-i"},
		"cwd":       root,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.SessionWrite(map[string]any{
		"sessionId": "pty-jobs",
		"dataB64":   base64.StdEncoding.EncodeToString([]byte("sleep 300 & echo $! > " + childPath + "\n")),
	}); err != nil {
		t.Fatal(err)
	}
	child := readPID(t, childPath)
	shellInfo, err := h.SessionInfo(map[string]any{"sessionId": "pty-jobs"})
	if err != nil || shellInfo.(session.Info).State != "running" {
		t.Fatalf("session not running: %v", err)
	}
	// The job really is in a different process group than the shell.
	if pgid, err := syscall.Getpgid(child); err != nil || pgid != child {
		t.Fatalf("job is not its own process group leader: pgid=%d err=%v", pgid, err)
	}
	if _, err := h.SessionKill(map[string]any{"sessionId": "pty-jobs", "release": true}); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, func() bool { return syscall.Kill(child, 0) != nil })
	waitUntil(t, func() bool {
		_, err := h.SessionInfo(map[string]any{"sessionId": "pty-jobs"})
		return err != nil
	})
}
