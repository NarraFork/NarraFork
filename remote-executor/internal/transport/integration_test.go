package transport

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/narrafork/remote-executor/internal/config"
	"github.com/narrafork/remote-executor/internal/handlers"
	"github.com/narrafork/remote-executor/internal/rpc"
)

// testServer stands in for the NarraFork server: it accepts the executor's WS
// connection, validates the hello, and lets the test drive RPCs.
type testServer struct {
	conn      *websocket.Conn
	ready     chan struct{}
	done      chan struct{}
	hello     rpc.HelloFrame
	readyOnce sync.Once
}

func newTestServer(t *testing.T) (*httptest.Server, *testServer) {
	ts := &testServer{ready: make(chan struct{}), done: make(chan struct{})}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			CompressionMode: websocket.CompressionDisabled,
		})
		if err != nil {
			t.Errorf("accept: %v", err)
			return
		}
		conn.SetReadLimit(64 * 1024 * 1024)
		ts.conn = conn

		// Read hello.
		_, data, err := conn.Read(r.Context())
		if err != nil {
			return
		}
		_ = json.Unmarshal(data, &ts.hello)
		_ = writeJSON(r.Context(), conn, rpc.HelloAckFrame{Type: "hello_ack", OK: true, SessionID: "test"})
		ts.readyOnce.Do(func() { close(ts.ready) })

		// Hand the connection over to the test body (ts.call reads/writes it).
		// The handler must NOT read concurrently, or WS framing gets corrupted.
		<-ts.done
	}))
	return srv, ts
}

func writeJSON(ctx context.Context, conn *websocket.Conn, v any) error {
	data, _ := json.Marshal(v)
	return conn.Write(ctx, websocket.MessageText, data)
}

// call sends an RPC and waits for its result, collecting any stream chunks.
func (ts *testServer) call(ctx context.Context, id, method string, params map[string]any) (rpc.ResultFrame, []byte, error) {
	req := rpc.RequestFrame{Type: "rpc", ID: id, Method: method, Params: params}
	if err := writeJSON(ctx, ts.conn, req); err != nil {
		return rpc.ResultFrame{}, nil, err
	}
	var streamed []byte
	for {
		_, data, err := ts.conn.Read(ctx)
		if err != nil {
			return rpc.ResultFrame{}, nil, err
		}
		var frame rpc.Frame
		_ = json.Unmarshal(data, &frame)
		switch frame.Type {
		case "rpc_stream":
			var sf rpc.StreamFrame
			_ = json.Unmarshal(data, &sf)
			chunk, _ := base64.StdEncoding.DecodeString(sf.ChunkB64)
			streamed = append(streamed, chunk...)
		case "rpc_result":
			var rf rpc.ResultFrame
			_ = json.Unmarshal(data, &rf)
			if rf.ID == id {
				return rf, streamed, nil
			}
		}
	}
}

func startExecutor(t *testing.T, serverURL, root string) context.CancelFunc {
	cfg := &config.Config{
		ServerURL:           strings.Replace(serverURL, "http", "ws", 1),
		DeviceRef:           "test-device",
		Token:               "rdev_test",
		AllowRoots:          []string{root},
		DefaultCwd:          root,
		ReconnectMaxSeconds: 1,
	}
	guard := handlers.NewPathGuard(cfg.AllowRoots)
	h := handlers.New(guard, 10*1024*1024)
	dispatcher := rpc.NewDispatcher(h)
	client := NewClient(cfg, dispatcher, rpc.Platform{OS: "linux", Arch: "amd64"}, rpc.Capabilities{})

	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = client.Run(ctx) }()
	return cancel
}

func TestExecutorEndToEnd(t *testing.T) {
	root := t.TempDir()
	srv, ts := newTestServer(t)
	defer srv.Close()

	cancel := startExecutor(t, srv.URL, root)
	defer cancel()
	defer close(ts.done)

	select {
	case <-ts.ready:
	case <-time.After(5 * time.Second):
		t.Fatal("executor did not complete handshake")
	}
	if ts.hello.DeviceRef != "test-device" || ts.hello.Token != "rdev_test" {
		t.Fatalf("unexpected hello: %+v", ts.hello)
	}

	ctx, cancelCtx := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancelCtx()

	// fs.write → fs.read round-trip.
	target := filepath.Join(root, "sub", "hello.txt")
	content := "line one\nline two\n"
	res, _, err := ts.call(ctx, "1", "fs.write", map[string]any{
		"path":    target,
		"dataB64": base64.StdEncoding.EncodeToString([]byte(content)),
	})
	if err != nil || !res.OK {
		t.Fatalf("fs.write failed: err=%v res=%+v", err, res)
	}

	res, _, err = ts.call(ctx, "2", "fs.read", map[string]any{"path": target})
	if err != nil || !res.OK {
		t.Fatalf("fs.read failed: err=%v res=%+v", err, res)
	}
	readMap := res.Result.(map[string]any)
	gotBytes, _ := base64.StdEncoding.DecodeString(readMap["dataB64"].(string))
	if string(gotBytes) != content {
		t.Fatalf("read mismatch: got %q want %q", gotBytes, content)
	}

	// fs.stat.
	res, _, err = ts.call(ctx, "3", "fs.stat", map[string]any{"path": target})
	if err != nil || !res.OK {
		t.Fatalf("fs.stat failed: %+v", res)
	}
	statMap := res.Result.(map[string]any)
	if statMap["isFile"] != true {
		t.Fatalf("stat isFile expected true: %+v", statMap)
	}

	// glob.
	res, _, err = ts.call(ctx, "4", "glob", map[string]any{"pattern": "**/*.txt", "cwd": root})
	if err != nil || !res.OK {
		t.Fatalf("glob failed: %+v", res)
	}
	globMap := res.Result.(map[string]any)
	matches := globMap["matches"].([]any)
	if len(matches) != 1 || matches[0].(string) != "sub/hello.txt" {
		t.Fatalf("glob mismatch: %+v", matches)
	}

	// exec.start with streaming output.
	res, streamed, err := ts.call(ctx, "5", "exec.start", map[string]any{
		"command":   "printf 'hello-exec'",
		"cwd":       root,
		"timeoutMs": float64(10000),
		"maxBytes":  float64(1024 * 1024),
	})
	if err != nil || !res.OK {
		t.Fatalf("exec.start failed: err=%v res=%+v", err, res)
	}
	if !strings.Contains(string(streamed), "hello-exec") {
		t.Fatalf("exec output mismatch: %q", streamed)
	}
	execMap := res.Result.(map[string]any)
	if execMap["exitCode"].(float64) != 0 {
		t.Fatalf("exec exit code expected 0: %+v", execMap)
	}

	// Path guard: reading outside the allowed root must fail.
	res, _, err = ts.call(ctx, "6", "fs.read", map[string]any{"path": "/etc/passwd"})
	if err != nil {
		t.Fatalf("call transport error: %v", err)
	}
	if res.OK {
		t.Fatal("expected path guard to reject /etc/passwd")
	}

	_ = os.Remove(target)
}
