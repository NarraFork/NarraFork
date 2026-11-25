//go:build !windows

package handlers

import (
	"context"
	"encoding/base64"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/narrafork/remote-executor/internal/session"
)

// attachAll collects a session's output until it ends.
func attachAll(t *testing.T, h *Handlers, id string, since int64) (string, session.AttachResult) {
	t.Helper()
	var mu sync.Mutex
	var out strings.Builder
	type attached struct {
		result any
		err    error
	}
	done := make(chan attached, 1)
	go func() {
		r, err := h.SessionAttach(context.Background(), map[string]any{"sessionId": id, "since": float64(since)}, func(ch string, b []byte) {
			if ch == session.ChannelData {
				mu.Lock()
				out.Write(b)
				mu.Unlock()
			}
		})
		done <- attached{r, err}
	}()
	select {
	case a := <-done:
		if a.err != nil {
			t.Fatalf("attach %s: %v", id, a.err)
		}
		mu.Lock()
		defer mu.Unlock()
		return out.String(), a.result.(session.AttachResult)
	case <-time.After(10 * time.Second):
		t.Fatalf("session %s did not end", id)
	}
	return "", session.AttachResult{}
}

func TestExecSessionCapturesBothStreamsAndExitCode(t *testing.T) {
	h, root := newSessionHandlers(t)
	if _, err := h.SessionOpen(map[string]any{
		"sessionId": "exec-1",
		"kind":      "exec",
		"command":   "echo OUT:$NF_TEST; echo ERR >&2; pwd; exit 3",
		"cwd":       root,
		"env":       map[string]any{"NF_TEST": "value"},
	}); err != nil {
		t.Fatal(err)
	}
	out, result := attachAll(t, h, "exec-1", 0)
	if result.ExitCode != 3 || result.TimedOut {
		t.Fatalf("exit = %+v", result)
	}
	resolved, _ := filepath.EvalSymlinks(root)
	for _, want := range []string{"OUT:value", "ERR", resolved} {
		if !strings.Contains(out, want) {
			t.Fatalf("output %q lacks %q", out, want)
		}
	}
	if result.EndSeq != int64(len(out)) {
		t.Fatalf("endSeq %d for %d bytes", result.EndSeq, len(out))
	}
	// The exit and the output stay readable by a later attach (a restarted NarraFork).
	again, second := attachAll(t, h, "exec-1", 0)
	if again != out || second.ExitCode != 3 {
		t.Fatalf("replay = %q %+v", again, second)
	}
	info, err := h.SessionInfo(map[string]any{"sessionId": "exec-1"})
	if err != nil || info.(session.Info).Kind != "exec" {
		t.Fatalf("info = %+v, %v", info, err)
	}
}

func TestExecSessionTakesNoInput(t *testing.T) {
	h, root := newSessionHandlers(t)
	if _, err := h.SessionOpen(map[string]any{
		"sessionId": "exec-2", "kind": "exec", "command": "read line; echo read=$?", "cwd": root,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.SessionWrite(map[string]any{
		"sessionId": "exec-2", "dataB64": base64.StdEncoding.EncodeToString([]byte("x\n")),
	}); err == nil {
		t.Fatal("writing to an exec session must fail")
	}
	// stdin is /dev/null: read sees end of input instead of waiting forever.
	out, result := attachAll(t, h, "exec-2", 0)
	if result.ExitCode != 0 || !strings.Contains(out, "read=1") {
		t.Fatalf("output %q, %+v", out, result)
	}
}

// The deadline is enforced by the executor, so it holds while no one is attached.
func TestExecSessionDeadlineStopsTheCommandAndItsChildren(t *testing.T) {
	h, root := newSessionHandlers(t)
	childPath := filepath.Join(root, "child.pid")
	if _, err := h.SessionOpen(map[string]any{
		"sessionId": "exec-3",
		"kind":      "exec",
		"command":   "sleep 300 & echo $! > " + childPath + "; wait",
		"cwd":       root,
		"timeoutMs": float64(300),
	}); err != nil {
		t.Fatal(err)
	}
	child := readPID(t, childPath)
	waitUntil(t, func() bool { return syscall.Kill(child, 0) != nil })
	_, result := attachAll(t, h, "exec-3", 0)
	if result.ExitCode == 0 || !result.TimedOut {
		t.Fatalf("a command stopped at its deadline must report the timeout: %+v", result)
	}
}

// Descendants that start their own process group are still part of the command's
// session, so killing the session stops them as well.
func TestExecSessionKillReachesOtherProcessGroups(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("only Linux can enumerate a session's processes; elsewhere the command's group is stopped")
	}
	h, root := newSessionHandlers(t)
	childPath := filepath.Join(root, "child.pid")
	script := "set -m; sleep 300 & echo $! > " + childPath + "; wait"
	if _, err := h.SessionOpen(map[string]any{
		"sessionId": "exec-4", "kind": "exec", "command": script, "cwd": root,
	}); err != nil {
		t.Fatal(err)
	}
	child := readPID(t, childPath)
	if pgid, err := syscall.Getpgid(child); err != nil || pgid != child {
		t.Fatalf("job is not its own process group: pgid=%d err=%v", pgid, err)
	}
	if _, err := h.SessionKill(map[string]any{"sessionId": "exec-4", "release": true}); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, func() bool { return syscall.Kill(child, 0) != nil })
	waitUntil(t, func() bool {
		_, err := h.SessionInfo(map[string]any{"sessionId": "exec-4"})
		return err != nil
	})
}
