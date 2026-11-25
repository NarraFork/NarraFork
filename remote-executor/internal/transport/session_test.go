//go:build !windows

package transport

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/narrafork/remote-executor/internal/config"
	"github.com/narrafork/remote-executor/internal/handlers"
	"github.com/narrafork/remote-executor/internal/rpc"
	"github.com/narrafork/remote-executor/internal/session"
)

// startExecutorWithSessions is startExecutor plus the process-wide session
// manager that main installs when PTYs are available.
func startExecutorWithSessions(t *testing.T, serverURL, root string) context.CancelFunc {
	t.Helper()
	cfg := &config.Config{
		ServerURL:           strings.Replace(serverURL, "http", "ws", 1),
		DeviceRef:           "test-device",
		Token:               "rdev_test",
		AllowRoots:          []string{root},
		DefaultCwd:          root,
		ReconnectMaxSeconds: 1,
	}
	h := handlers.New(handlers.NewPathGuard(cfg.AllowRoots), 10*1024*1024)
	sessions := session.NewManager(session.DefaultLimits())
	h.SetSessionManager(sessions)
	client := NewClient(cfg, rpc.NewDispatcher(h), rpc.Platform{OS: "linux", Arch: "amd64"}, rpc.Capabilities{})
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = client.Run(ctx) }()
	return func() {
		cancel()
		sessions.Shutdown()
	}
}

type sessionStream struct {
	data     strings.Builder
	gaps     []map[string]int64
	exited   bool
	result   *rpc.ResultFrame
	consumed int64
}

// readSession reads frames for request id until done reports true.
func readSession(
	t *testing.T,
	conn *websocket.Conn,
	id string,
	stream *sessionStream,
	timeout time.Duration,
	done func(*sessionStream) bool,
) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	for !done(stream) {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read %s: %v (have %q)", id, err, stream.data.String())
		}
		var frame rpc.Frame
		if json.Unmarshal(data, &frame) != nil {
			continue
		}
		switch frame.Type {
		case "rpc_stream":
			var sf rpc.StreamFrame
			_ = json.Unmarshal(data, &sf)
			if sf.ID != id {
				continue
			}
			chunk, _ := base64.StdEncoding.DecodeString(sf.ChunkB64)
			switch sf.Channel {
			case session.ChannelData:
				stream.data.Write(chunk)
				stream.consumed += int64(len(chunk))
			case session.ChannelGap:
				var gap map[string]int64
				_ = json.Unmarshal(chunk, &gap)
				stream.gaps = append(stream.gaps, gap)
			case session.ChannelExit:
				stream.exited = true
			}
		case "rpc_result":
			var rf rpc.ResultFrame
			_ = json.Unmarshal(data, &rf)
			if rf.ID == id {
				stream.result = &rf
			}
		}
	}
}

func rpcCall(t *testing.T, conn *websocket.Conn, id, method string, params map[string]any) rpc.ResultFrame {
	t.Helper()
	if err := writeJSON(context.Background(), conn, rpc.RequestFrame{
		Type: "rpc", ID: id, Method: method, Params: params,
	}); err != nil {
		t.Fatalf("send %s: %v", method, err)
	}
	stream := &sessionStream{}
	readSession(t, conn, id, stream, 5*time.Second, func(s *sessionStream) bool { return s.result != nil })
	if !stream.result.OK {
		t.Fatalf("%s failed: %s", method, stream.result.Error)
	}
	return *stream.result
}

var tickPattern = regexp.MustCompile(`TICK_(\d+)`)

func ticks(text string) []int {
	var out []int
	for _, m := range tickPattern.FindAllStringSubmatch(text, -1) {
		n, _ := strconv.Atoi(m[1])
		out = append(out, n)
	}
	return out
}

// TestDurableSessionSurvivesDisconnectAndResumesFromSequence is the property
// the old pty.open could not provide: losing the connection detaches instead of
// killing, and the next connection reads exactly the bytes it has not seen.
func TestDurableSessionSurvivesDisconnectAndResumesFromSequence(t *testing.T) {
	root := t.TempDir()
	server, harness := newReconnectServer(t)
	defer server.Close()
	cancel := startExecutorWithSessions(t, server.URL, root)
	defer cancel()

	pidPath := filepath.Join(root, "session.pid")
	script := fmt.Sprintf(
		"echo $$ > %s; i=0; while true; do echo TICK_$i; i=$((i+1)); sleep 0.02; done",
		shellQuote(pidPath),
	)

	first := harness.nextConnection(t, 5*time.Second)
	rpcCall(t, first, "open", "session.open", map[string]any{
		"sessionId": "durable-1",
		"cmd":       []any{"/bin/sh", "-c", script},
		"cwd":       root,
	})
	pid := awaitPID(t, pidPath, 5*time.Second)
	if err := writeJSON(context.Background(), first, rpc.RequestFrame{
		Type: "rpc", ID: "attach-1", Method: "session.attach",
		Params: map[string]any{"sessionId": "durable-1", "since": float64(0)},
	}); err != nil {
		t.Fatal(err)
	}
	before := &sessionStream{}
	readSession(t, first, "attach-1", before, 5*time.Second, func(s *sessionStream) bool {
		return len(ticks(s.data.String())) >= 3
	})

	// Lose the connection mid-stream.
	first.CloseNow()
	harness.release <- struct{}{}
	time.Sleep(300 * time.Millisecond)
	if err := syscall.Kill(pid, 0); err != nil {
		t.Fatalf("session process died with its connection: %v", err)
	}

	second := harness.nextConnection(t, 5*time.Second)
	defer func() { harness.release <- struct{}{} }()
	if err := writeJSON(context.Background(), second, rpc.RequestFrame{
		Type: "rpc", ID: "attach-2", Method: "session.attach",
		Params: map[string]any{"sessionId": "durable-1", "since": float64(before.consumed)},
	}); err != nil {
		t.Fatal(err)
	}
	after := &sessionStream{}
	readSession(t, second, "attach-2", after, 5*time.Second, func(s *sessionStream) bool {
		return len(ticks(s.data.String())) >= 20
	})
	if len(after.gaps) != 0 {
		t.Fatalf("resume within retention must not report a gap: %v", after.gaps)
	}
	// Exactly the unseen bytes: the joined output counts up with no hole or repeat.
	joined := ticks(before.data.String() + after.data.String())
	for i, n := range joined {
		if n != i {
			t.Fatalf("output not contiguous across reconnect at %d: %v", i, joined)
		}
	}

	info := rpcCall(t, second, "info", "session.info", map[string]any{"sessionId": "durable-1"})
	if raw, _ := json.Marshal(info.Result); !strings.Contains(string(raw), `"state":"running"`) {
		t.Fatalf("info = %s", raw)
	}
	// The attach may end (exit frame and result) before the kill's own reply,
	// so read the attach stream rather than waiting on the kill result first.
	if err := writeJSON(context.Background(), second, rpc.RequestFrame{
		Type: "rpc", ID: "kill", Method: "session.kill",
		Params: map[string]any{"sessionId": "durable-1"},
	}); err != nil {
		t.Fatal(err)
	}
	readSession(t, second, "attach-2", after, 5*time.Second, func(s *sessionStream) bool {
		return s.result != nil
	})
	awaitProcessExit(t, pid, 5*time.Second)
	if !after.exited || !after.result.OK {
		t.Fatalf("attach did not end with the exit: %+v", after.result)
	}
}

func TestDurableSessionRejectsDisabledShellAndUnknownSession(t *testing.T) {
	h := handlers.NewWithOptions(handlers.NewPathGuard([]string{t.TempDir()}), 1024, true)
	h.SetSessionManager(session.NewManager(session.DefaultLimits()))
	if _, err := h.SessionOpen(map[string]any{"sessionId": "x"}); err == nil ||
		!strings.Contains(err.Error(), "disable-shell") {
		t.Fatalf("disabled shell err = %v", err)
	}
	enabled := handlers.New(handlers.NewPathGuard([]string{t.TempDir()}), 1024)
	if _, err := enabled.SessionInfo(map[string]any{"sessionId": "x"}); err == nil {
		t.Fatal("sessions without a manager must be unavailable")
	}
	enabled.SetSessionManager(session.NewManager(session.DefaultLimits()))
	if _, err := enabled.SessionWrite(map[string]any{"sessionId": "missing", "dataB64": ""}); err == nil {
		t.Fatal("unknown session must fail")
	}
}
