//go:build !windows

package transport

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/narrafork/remote-executor/internal/config"
	"github.com/narrafork/remote-executor/internal/handlers"
	"github.com/narrafork/remote-executor/internal/rpc"
)

type reconnectServer struct {
	connections chan *websocket.Conn
	release     chan struct{}
}

func newReconnectServer(t *testing.T) (*httptest.Server, *reconnectServer) {
	t.Helper()
	harness := &reconnectServer{
		connections: make(chan *websocket.Conn, 4),
		release:     make(chan struct{}, 4),
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			CompressionMode: websocket.CompressionDisabled,
		})
		if err != nil {
			return
		}
		conn.SetReadLimit(64 * 1024 * 1024)
		_, data, err := conn.Read(r.Context())
		if err != nil {
			return
		}
		var hello rpc.HelloFrame
		if err := json.Unmarshal(data, &hello); err != nil || hello.Type != "hello" {
			return
		}
		if err := writeJSON(r.Context(), conn, rpc.HelloAckFrame{
			Type: "hello_ack", OK: true, SessionID: "reconnect-test",
		}); err != nil {
			return
		}
		harness.connections <- conn
		<-harness.release
		conn.CloseNow()
	}))
	return server, harness
}

func (h *reconnectServer) nextConnection(t *testing.T, timeout time.Duration) *websocket.Conn {
	t.Helper()
	select {
	case conn := <-h.connections:
		return conn
	case <-time.After(timeout):
		t.Fatal("timed out waiting for executor connection")
		return nil
	}
}

func TestDisconnectCancelsLongRPCAndIsolatesReconnect(t *testing.T) {
	root := t.TempDir()
	server, harness := newReconnectServer(t)
	defer server.Close()

	cancel := startExecutor(t, server.URL, root)
	defer cancel()

	first := harness.nextConnection(t, 5*time.Second)
	pidPath := filepath.Join(root, "long-rpc.pid")
	command := fmt.Sprintf(
		"echo $$ > %s; while true; do echo OLD_RPC_STREAM; sleep 0.05; done",
		shellQuote(pidPath),
	)
	if err := writeJSON(context.Background(), first, rpc.RequestFrame{
		Type:   "rpc",
		ID:     "old-rpc",
		Method: "exec.start",
		Params: map[string]any{
			"command":   command,
			"cwd":       root,
			"timeoutMs": float64(60000),
			"maxBytes":  float64(1024 * 1024),
		},
	}); err != nil {
		t.Fatalf("start long RPC: %v", err)
	}
	awaitStreamMarker(t, first, "old-rpc", "OLD_RPC_STREAM", 5*time.Second)
	pid := awaitPID(t, pidPath, 5*time.Second)

	first.CloseNow()
	harness.release <- struct{}{}
	awaitProcessExit(t, pid, 5*time.Second)

	second := harness.nextConnection(t, 5*time.Second)
	defer func() { harness.release <- struct{}{} }()
	if err := writeJSON(context.Background(), second, rpc.RequestFrame{
		Type: "rpc", ID: "new-rpc", Method: "system.ping", Params: map[string]any{},
	}); err != nil {
		t.Fatalf("send RPC on reconnected socket: %v", err)
	}
	awaitCleanResult(t, second, "new-rpc", "old-rpc", 5*time.Second)
}

func TestDirectDisconnectCancelsPTYAndIsolatesNextConnection(t *testing.T) {
	const token = "rdev_direct_disconnect"
	root := t.TempDir()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	cfg := &config.Config{
		ListenAddr: addr,
		DeviceRef:  "direct-disconnect-device",
		Token:      token,
		AllowRoots: []string{root},
		DefaultCwd: root,
	}
	dispatcher := rpc.NewDispatcher(handlers.New(handlers.NewPathGuard(cfg.AllowRoots), 10*1024*1024))
	server := NewServer(cfg, dispatcher, rpc.Platform{OS: "linux", Arch: "amd64"}, rpc.Capabilities{})
	serverCtx, stopServer := context.WithCancel(context.Background())
	defer stopServer()
	go func() { _ = server.Run(serverCtx) }()
	if !waitForPort(addr, 3*time.Second) {
		t.Fatal("direct listener did not start")
	}

	first := dialDirect(t, addr, token)
	pidPath := filepath.Join(root, "pty.pid")
	command := fmt.Sprintf(
		"echo $$ > %s; while true; do echo OLD_PTY_STREAM; sleep 0.05; done",
		shellQuote(pidPath),
	)
	if err := writeJSON(context.Background(), first, rpc.RequestFrame{
		Type:   "rpc",
		ID:     "old-pty",
		Method: "pty.open",
		Params: map[string]any{
			"ptyId": "old-terminal",
			"cmd":   []any{"/bin/sh", "-c", command},
			"cwd":   root,
			"cols":  float64(80),
			"rows":  float64(24),
		},
	}); err != nil {
		t.Fatalf("open PTY: %v", err)
	}
	awaitStreamMarker(t, first, "old-pty", "OLD_PTY_STREAM", 5*time.Second)
	pid := awaitPID(t, pidPath, 5*time.Second)
	first.CloseNow()
	awaitProcessExit(t, pid, 5*time.Second)

	second := dialDirect(t, addr, token)
	defer second.CloseNow()
	if err := writeJSON(context.Background(), second, rpc.RequestFrame{
		Type: "rpc", ID: "new-direct", Method: "system.ping", Params: map[string]any{},
	}); err != nil {
		t.Fatalf("send RPC on next direct connection: %v", err)
	}
	awaitCleanResult(t, second, "new-direct", "old-pty", 5*time.Second)
}

func dialDirect(t *testing.T, addr, token string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, fmt.Sprintf("ws://%s/ws/device", addr), &websocket.DialOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		t.Fatalf("dial direct listener: %v", err)
	}
	conn.SetReadLimit(64 * 1024 * 1024)
	performDirectHandshake(t, ctx, conn, token)
	return conn
}

func awaitStreamMarker(t *testing.T, conn *websocket.Conn, id, marker string, timeout time.Duration) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	var output strings.Builder
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read stream %s: %v", id, err)
		}
		var frame rpc.Frame
		_ = json.Unmarshal(data, &frame)
		if frame.Type != "rpc_stream" {
			continue
		}
		var stream rpc.StreamFrame
		_ = json.Unmarshal(data, &stream)
		if stream.ID != id {
			continue
		}
		chunk, _ := base64.StdEncoding.DecodeString(stream.ChunkB64)
		output.Write(chunk)
		if strings.Contains(output.String(), marker) {
			return
		}
	}
}

func awaitCleanResult(t *testing.T, conn *websocket.Conn, wantedID, staleID string, timeout time.Duration) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read result %s: %v", wantedID, err)
		}
		var frame rpc.Frame
		_ = json.Unmarshal(data, &frame)
		switch frame.Type {
		case "rpc_stream":
			var stream rpc.StreamFrame
			_ = json.Unmarshal(data, &stream)
			if stream.ID == staleID {
				t.Fatalf("stale stream %s reached the new connection", staleID)
			}
		case "rpc_result":
			var result rpc.ResultFrame
			_ = json.Unmarshal(data, &result)
			if result.ID == staleID {
				t.Fatalf("stale result %s reached the new connection", staleID)
			}
			if result.ID == wantedID {
				if !result.OK {
					t.Fatalf("RPC %s failed: %s", wantedID, result.Error)
				}
				return
			}
		}
	}
}

func awaitPID(t *testing.T, path string, timeout time.Duration) int {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(path)
		if err == nil {
			pid, parseErr := strconv.Atoi(strings.TrimSpace(string(data)))
			if parseErr == nil && pid > 0 {
				return pid
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("PID file %s was not created", path)
	return 0
}

func awaitProcessExit(t *testing.T, pid int, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		err := syscall.Kill(pid, 0)
		if err == syscall.ESRCH {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("process %d still exists after disconnect", pid)
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
