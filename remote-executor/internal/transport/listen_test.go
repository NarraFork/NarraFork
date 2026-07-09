package transport

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/narrafork/remote-executor/internal/config"
	"github.com/narrafork/remote-executor/internal/handlers"
	"github.com/narrafork/remote-executor/internal/rpc"
)

// TestDirectModeEndToEnd starts the executor in listen (direct) mode, connects
// to it like the NarraFork server would, and drives a few RPCs.
func TestDirectModeEndToEnd(t *testing.T) {
	root := t.TempDir()

	// Pick a free port.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	cfg := &config.Config{
		ListenAddr: addr,
		DeviceRef:  "direct-device",
		AllowRoots: []string{root},
		DefaultCwd: root,
	}
	guard := handlers.NewPathGuard(cfg.AllowRoots)
	h := handlers.New(guard, 10*1024*1024)
	dispatcher := rpc.NewDispatcher(h)
	server := NewServer(cfg, dispatcher, rpc.Platform{OS: "linux", Arch: "amd64"}, rpc.Capabilities{})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = server.Run(ctx) }()

	// Wait for the listener to come up.
	if !waitForPort(addr, 3*time.Second) {
		t.Fatal("executor listener did not start")
	}

	dialCtx, dialCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer dialCancel()
	conn, _, err := websocket.Dial(dialCtx, fmt.Sprintf("ws://%s/ws/device", addr), &websocket.DialOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		t.Fatalf("dial executor: %v", err)
	}
	conn.SetReadLimit(64 * 1024 * 1024)
	defer conn.CloseNow()

	ctx2, cancel2 := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel2()

	// The executor sends hello first in direct mode.
	_, data, err := conn.Read(ctx2)
	if err != nil {
		t.Fatalf("read hello: %v", err)
	}
	var hello rpc.HelloFrame
	if err := json.Unmarshal(data, &hello); err != nil || hello.Type != "hello" {
		t.Fatalf("expected hello, got %s (err=%v)", string(data), err)
	}
	// Server acks.
	_ = writeJSON(ctx2, conn, rpc.HelloAckFrame{Type: "hello_ack", OK: true, SessionID: "test"})

	// Drive an fs.write RPC.
	req := rpc.RequestFrame{
		Type:   "rpc",
		ID:     "d1",
		Method: "fs.write",
		Params: map[string]any{
			"path":    root + "/direct.txt",
			"dataB64": base64.StdEncoding.EncodeToString([]byte("direct-mode")),
		},
	}
	if err := writeJSON(ctx2, conn, req); err != nil {
		t.Fatalf("send rpc: %v", err)
	}

	res := readResult(t, ctx2, conn, "d1")
	if !res.OK {
		t.Fatalf("fs.write failed: %s", res.Error)
	}

	// Read it back.
	req2 := rpc.RequestFrame{Type: "rpc", ID: "d2", Method: "fs.read", Params: map[string]any{"path": root + "/direct.txt"}}
	_ = writeJSON(ctx2, conn, req2)
	res2 := readResult(t, ctx2, conn, "d2")
	if !res2.OK {
		t.Fatalf("fs.read failed: %s", res2.Error)
	}
	m := res2.Result.(map[string]any)
	got, _ := base64.StdEncoding.DecodeString(m["dataB64"].(string))
	if string(got) != "direct-mode" {
		t.Fatalf("read mismatch: %q", got)
	}
}

func readResult(t *testing.T, ctx context.Context, conn *websocket.Conn, id string) rpc.ResultFrame {
	t.Helper()
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read result: %v", err)
		}
		var frame rpc.Frame
		_ = json.Unmarshal(data, &frame)
		if frame.Type == "rpc_result" {
			var rf rpc.ResultFrame
			_ = json.Unmarshal(data, &rf)
			if rf.ID == id {
				return rf
			}
		}
	}
}

func waitForPort(addr string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		c, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
		if err == nil {
			_ = c.Close()
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false
}
