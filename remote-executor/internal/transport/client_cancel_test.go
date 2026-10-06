package transport

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/narrafork/remote-executor/internal/config"
	"github.com/narrafork/remote-executor/internal/handlers"
	"github.com/narrafork/remote-executor/internal/rpc"
)

func newCancelTestConnection(t *testing.T) (*connectionState, *websocket.Conn, string) {
	t.Helper()
	accepted := make(chan *websocket.Conn, 1)
	stop := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
		if err != nil {
			return
		}
		accepted <- conn
		<-stop
		conn.CloseNow()
	}))
	t.Cleanup(server.Close)
	t.Cleanup(func() { close(stop) })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	peer, _, err := websocket.Dial(ctx, strings.Replace(server.URL, "http", "ws", 1), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { peer.CloseNow() })
	var conn *websocket.Conn
	select {
	case conn = <-accepted:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	root := t.TempDir()
	h := handlers.New(handlers.NewPathGuard([]string{root}), 1024*1024)
	client := NewClient(&config.Config{}, rpc.NewDispatcher(h), rpc.Platform{}, rpc.Capabilities{})
	state := client.newConnectionState(context.Background(), conn)
	state.authenticated.Store(true)
	t.Cleanup(state.close)
	return state, peer, root
}

func TestRequestCancelImmediatelyFollowingBufferedRPC(t *testing.T) {
	// Deliver the entire batch before serving it. A single P makes the old
	// read-loop/go-handler registration gap reproducible without external load.
	previous := runtime.GOMAXPROCS(1)
	defer runtime.GOMAXPROCS(previous)
	state, peer, _ := newCancelTestConnection(t)
	state.writeMu.Lock() // keep any incorrectly uncancelled workers observable
	t.Cleanup(state.writeMu.Unlock)
	readBarrier := make(chan struct{})
	var barrierOnce sync.Once
	state.cancels["read-barrier"] = &requestCancel{cancel: func() { barrierOnce.Do(func() { close(readBarrier) }) }}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for i := 0; i < 32; i++ {
		id := fmt.Sprintf("immediate-%d", i)
		if err := writeJSON(ctx, peer, rpc.RequestFrame{Type: "rpc", ID: id, Method: "system.ping"}); err != nil {
			t.Fatal(err)
		}
		if err := writeJSON(ctx, peer, rpc.CancelFrame{Type: "rpc_cancel", ID: id}); err != nil {
			t.Fatal(err)
		}
	}
	if err := writeJSON(ctx, peer, rpc.CancelFrame{Type: "rpc_cancel", ID: "read-barrier"}); err != nil {
		t.Fatal(err)
	}
	served := make(chan struct{})
	go func() {
		_ = state.serveAuthenticated()
		close(served)
	}()
	t.Cleanup(func() {
		state.cancel()
		state.conn.CloseNow()
		select {
		case <-served:
		case <-time.After(time.Second):
			t.Error("serve loop leaked after cancellation")
		}
	})
	select {
	case <-readBarrier:
	case <-ctx.Done():
		t.Fatal("serve loop did not consume the queued cancel frames")
	}
	// Give every queued worker a turn. On the buggy implementation they register
	// too late, then remain stuck on writeMu even though their cancel was read.
	time.Sleep(50 * time.Millisecond)
	state.cancelMu.Lock()
	pending := len(state.cancels)
	state.cancelMu.Unlock()
	if pending != 0 {
		t.Errorf("%d RPCs survived their immediately following rpc_cancel", pending)
	}
}

func TestHandleRequestRegistersWithoutWaitingForDispatch(t *testing.T) {
	state, _, _ := newCancelTestConnection(t)
	state.writeMu.Lock()
	t.Cleanup(state.writeMu.Unlock)
	returned := make(chan struct{})
	go func() {
		state.handleRequest(rpc.RequestFrame{Type: "rpc", ID: "blocked-write", Method: "system.ping"})
		close(returned)
	}()
	select {
	case <-returned:
	case <-time.After(250 * time.Millisecond):
		t.Error("registering a request blocked the read loop on dispatch/write")
	}
	state.cancelMu.Lock()
	entry := state.cancels["blocked-write"]
	state.cancelMu.Unlock()
	if entry == nil {
		t.Error("request was not synchronously registered")
	}
	state.cancelRequest("blocked-write")
}

func TestSameIDReplacementKeepsNewCancellation(t *testing.T) {
	state, _, _ := newCancelTestConnection(t)
	state.writeMu.Lock()
	t.Cleanup(state.writeMu.Unlock)
	oldCtx, oldCancel := context.WithCancel(state.ctx)
	defer oldCancel()
	oldEntry := &requestCancel{cancel: oldCancel}
	req := rpc.RequestFrame{Type: "rpc", ID: "reused-id", Method: "system.ping"}
	state.cancels[req.ID] = oldEntry

	state.handleRequest(req)
	if oldCtx.Err() != context.Canceled {
		t.Error("replacing an ID did not cancel its previous worker")
	}
	state.cancelMu.Lock()
	current := state.cancels[req.ID]
	state.cancelMu.Unlock()
	if current == nil || current == oldEntry {
		t.Fatal("replacement was not registered before returning")
	}
	// Complete the old worker only after the new entry exists. Its deferred
	// cleanup must not erase the new worker's cancellation handle.
	state.runRequest(oldCtx, req, oldEntry)
	state.cancelMu.Lock()
	retained := state.cancels[req.ID] == current
	state.cancelMu.Unlock()
	if !retained {
		t.Error("old worker removed the replacement's cancellation handle")
	}
	state.cancelRequest(req.ID)
	state.cancelMu.Lock()
	pending := len(state.cancels)
	state.cancelMu.Unlock()
	if pending != 0 {
		t.Error("replacement could not be cancelled")
	}
}

func TestClosedConnectionDoesNotRegisterRequest(t *testing.T) {
	state, _, _ := newCancelTestConnection(t)
	state.cancel()
	state.handleRequest(rpc.RequestFrame{Type: "rpc", ID: "after-close", Method: "system.ping"})
	if len(state.cancels) != 0 {
		t.Error("closed connection retained a request")
	}
}

func TestWriteJSONCancelWhileWaitingForSendLock(t *testing.T) {
	state, _, _ := newCancelTestConnection(t)
	state.writeMu.Lock()
	ctx, cancel := context.WithCancel(state.ctx)
	defer cancel()
	returned := make(chan error, 1)
	go func() {
		returned <- state.writeJSON(ctx, map[string]string{"type": "pong"})
		close(returned)
	}()
	t.Cleanup(func() {
		state.writeMu.Unlock()
		select {
		case <-returned:
		case <-time.After(time.Second):
			t.Error("cancelled writer did not stop during cleanup")
		}
	})
	cancel()
	select {
	case err := <-returned:
		if err != context.Canceled {
			t.Fatalf("cancelled send lock waiter returned %v", err)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("cancelled stream writer remained blocked behind the send lock")
	}
}

func TestWriteJSONCancelMidFrameKeepsConnectionAlive(t *testing.T) {
	state, peer, _ := newCancelTestConnection(t)
	peer.SetReadLimit(-1)
	// Far larger than the socket buffers, so the write is still in flight while
	// the peer is not reading when the request is cancelled.
	payload := map[string]string{"type": "pong", "pad": strings.Repeat("x", 32<<20)}
	ctx, cancel := context.WithCancel(state.ctx)
	returned := make(chan error, 1)
	go func() { returned <- state.writeJSON(ctx, payload) }()
	// Cancel only once the writer holds the send lock (i.e. the frame write has
	// started); marshalling 32 MiB can outlast any fixed sleep.
	deadline := time.Now().Add(5 * time.Second)
	for {
		state.writeMu.once.Do(func() { state.writeMu.token = make(chan struct{}, 1) })
		if len(state.writeMu.token) == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("writer never acquired the send lock")
		}
		time.Sleep(time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	cancel()
	time.Sleep(100 * time.Millisecond)
	if state.ctx.Err() != nil {
		t.Fatal("connection state was torn down by a per-request cancel")
	}

	// The peer starts reading only now: the in-flight frame must arrive intact
	// and the connection must stay usable for the next frame.
	readCtx, cancelRead := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelRead()
	_, data, err := peer.Read(readCtx)
	if err != nil {
		t.Fatalf("connection closed by mid-frame request cancel: %v", err)
	}
	if len(data) < 32<<20 {
		t.Fatalf("frame truncated: %d bytes", len(data))
	}
	if err := <-returned; err != nil {
		t.Fatalf("in-flight write failed after request cancel: %v", err)
	}
	if err := state.writeJSON(state.ctx, map[string]string{"type": "pong"}); err != nil {
		t.Fatalf("connection unusable after cancel: %v", err)
	}
	if _, _, err := peer.Read(readCtx); err != nil {
		t.Fatalf("follow-up frame not delivered: %v", err)
	}
}

func startExecTestServeLoop(t *testing.T, state *connectionState) {
	t.Helper()
	served := make(chan struct{})
	go func() {
		_ = state.serveAuthenticated()
		close(served)
	}()
	t.Cleanup(func() {
		state.close() // cancels only requests started by this test connection
		select {
		case <-served:
		case <-time.After(2 * time.Second):
			t.Error("test serve loop did not stop")
		}
	})
}

func awaitEmptyExecCancels(t *testing.T, state *connectionState) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		state.cancelMu.Lock()
		pending := len(state.cancels)
		state.cancelMu.Unlock()
		if pending == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("request cancellation registry retained %d entries", pending)
		}
		time.Sleep(time.Millisecond)
	}
}

type execTestWireFrame struct {
	Type     string         `json:"type"`
	ID       string         `json:"id"`
	OK       bool           `json:"ok"`
	Error    string         `json:"error"`
	Result   map[string]any `json:"result"`
	Channel  string         `json:"channel"`
	ChunkB64 string         `json:"chunkB64"`
}

func readExecTestFrame(t *testing.T, ctx context.Context, peer *websocket.Conn, id string) execTestWireFrame {
	t.Helper()
	readCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	_, data, err := peer.Read(readCtx)
	if err != nil {
		t.Fatalf("read %s: %v", id, err)
	}
	var frame execTestWireFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		t.Fatal(err)
	}
	if frame.ID != id {
		t.Fatalf("wanted %s, received stale/unexpected frame: %s", id, data)
	}
	return frame
}

func execTestStreamText(t *testing.T, frame execTestWireFrame) string {
	t.Helper()
	if frame.Type != "rpc_stream" || frame.Channel != "stdout" {
		t.Fatalf("unexpected exec stream frame: %+v", frame)
	}
	chunk, err := base64.StdEncoding.DecodeString(frame.ChunkB64)
	if err != nil {
		t.Fatal(err)
	}
	return string(chunk)
}

func awaitExecTestTerminal(t *testing.T, ctx context.Context, peer *websocket.Conn, id string) (map[string]any, string) {
	t.Helper()
	var output strings.Builder
	for {
		frame := readExecTestFrame(t, ctx, peer, id)
		if frame.Type == "rpc_result" {
			if !frame.OK {
				t.Fatalf("exec %s failed: %s", id, frame.Error)
			}
			return frame.Result, output.String()
		}
		output.WriteString(execTestStreamText(t, frame))
	}
}

func assertExecTestProcessReaped(t *testing.T, output string) {
	t.Helper()
	pid, err := strconv.Atoi(strings.TrimSpace(output))
	if err != nil || pid <= 0 {
		t.Fatalf("fixture did not report its PID: %q", output)
	}
	if runtime.GOOS != "linux" {
		return
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(fmt.Sprintf("/proc/%d", pid)); os.IsNotExist(err) {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("test exec PID %d was not reaped", pid)
}

func TestSequentialShortExecRPCsReleaseCancellationEntries(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses a POSIX shell")
	}
	t.Setenv("SHELL", "/bin/sh")
	state, peer, root := newCancelTestConnection(t)
	startExecTestServeLoop(t, state)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	// One real WebSocket connection, ordinary short commands, no inherited-pipe
	// fixture: every command must receive its terminal frame and release its ID.
	for i := 0; i < 32; i++ {
		id := fmt.Sprintf("short-exec-%02d", i)
		if err := writeJSON(ctx, peer, rpc.RequestFrame{
			Type: "rpc", ID: id, Method: "exec.start",
			Params: map[string]any{"command": "printf '%s' " + id, "cwd": root, "timeoutMs": 2000, "maxBytes": 1024},
		}); err != nil {
			t.Fatal(err)
		}
		result, output := awaitExecTestTerminal(t, ctx, peer, id)
		if output != id || result["exitCode"] != float64(0) || result["timedOut"] != false || result["truncated"] != false {
			t.Fatalf("short command %d: output=%q result=%+v", i, output, result)
		}
		awaitEmptyExecCancels(t, state)
	}
}

func TestRepeatedExecRPCCancelAndTimeoutReleaseCancellationEntries(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses a POSIX shell")
	}
	t.Setenv("SHELL", "/bin/sh")
	for _, mode := range []string{"cancel", "timeout"} {
		t.Run(mode, func(t *testing.T) {
			state, peer, root := newCancelTestConnection(t)
			startExecTestServeLoop(t, state)
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			for i := 0; i < 16; i++ {
				id := fmt.Sprintf("%s-exec-%02d", mode, i)
				timeoutMs := 2000
				if mode == "timeout" {
					timeoutMs = 250
				}
				// The shell is replaced by a finite two-second test process. Closing
				// this test connection also cancels it on any assertion failure.
				if err := writeJSON(ctx, peer, rpc.RequestFrame{
					Type: "rpc", ID: id, Method: "exec.start",
					Params: map[string]any{
						"command": "printf '%s\\n' \"$$\"; exec sleep 2", "cwd": root,
						"timeoutMs": timeoutMs, "maxBytes": 1024,
					},
				}); err != nil {
					t.Fatal(err)
				}
				var output string
				if mode == "cancel" {
					for !strings.Contains(output, "\n") {
						output += execTestStreamText(t, readExecTestFrame(t, ctx, peer, id))
					}
					if err := writeJSON(ctx, peer, rpc.CancelFrame{Type: "rpc_cancel", ID: id}); err != nil {
						t.Fatal(err)
					}
					// Explicit cancellation intentionally suppresses rpc_result. Do
					// not mistake map removal alone for proof of child termination.
				} else {
					var result map[string]any
					result, output = awaitExecTestTerminal(t, ctx, peer, id)
					if result["timedOut"] != true || result["truncated"] != false || result["exitCode"] == float64(0) {
						t.Fatalf("timeout %d: %+v", i, result)
					}
				}
				assertExecTestProcessReaped(t, output)
				awaitEmptyExecCancels(t, state)

				// A subsequent ordinary Bash RPC must still finish after every
				// cancel/timeout; stale results from cancelled RPCs fail this read.
				probe := id + "-next"
				if err := writeJSON(ctx, peer, rpc.RequestFrame{
					Type: "rpc", ID: probe, Method: "exec.start",
					Params: map[string]any{"command": "printf ready", "cwd": root, "timeoutMs": 2000, "maxBytes": 1024},
				}); err != nil {
					t.Fatal(err)
				}
				result, output := awaitExecTestTerminal(t, ctx, peer, probe)
				if output != "ready" || result["exitCode"] != float64(0) || result["timedOut"] != false {
					t.Fatalf("post-%s exec failed: output=%q result=%+v", mode, output, result)
				}
				awaitEmptyExecCancels(t, state)
			}
		})
	}
}

func TestUnknownCancelDoesNotRetainIDs(t *testing.T) {
	state := &connectionState{cancels: make(map[string]*requestCancel)}
	for i := 0; i < 10000; i++ {
		state.cancelRequest(fmt.Sprintf("unknown-%d", i))
	}
	if len(state.cancels) != 0 {
		t.Fatalf("unknown cancel IDs accumulated: %d", len(state.cancels))
	}
}
