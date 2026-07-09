//go:build !windows

package transport

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/narrafork/remote-executor/internal/config"
	"github.com/narrafork/remote-executor/internal/handlers"
	"github.com/narrafork/remote-executor/internal/rpc"
)

// ptyTestServer is a minimal single-reader server harness. A single goroutine
// owns all reads on the connection (coder/websocket forbids concurrent reads);
// the test interacts through channels. Writes are guarded by a mutex.
type ptyTestServer struct {
	conn      *websocket.Conn
	writeMu   sync.Mutex
	ready     chan struct{}
	readyOnce sync.Once
	streams   chan rpc.StreamFrame
	results   chan rpc.ResultFrame
	binaries  chan []byte
}

func newPtyTestServer(t *testing.T) (*httptest.Server, *ptyTestServer) {
	pts := &ptyTestServer{
		ready:    make(chan struct{}),
		streams:  make(chan rpc.StreamFrame, 256),
		results:  make(chan rpc.ResultFrame, 16),
		binaries: make(chan []byte, 512),
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			CompressionMode: websocket.CompressionDisabled,
		})
		if err != nil {
			return
		}
		conn.SetReadLimit(64 * 1024 * 1024)
		pts.conn = conn

		// Single reader loop.
		for {
			msgType, data, err := conn.Read(r.Context())
			if err != nil {
				return
			}
			if msgType == websocket.MessageBinary {
				cp := make([]byte, len(data))
				copy(cp, data)
				select {
				case pts.binaries <- cp:
				default:
				}
				continue
			}
			var frame rpc.Frame
			if json.Unmarshal(data, &frame) != nil {
				continue
			}
			switch frame.Type {
			case "hello":
				pts.writeFrame(r.Context(), rpc.HelloAckFrame{Type: "hello_ack", OK: true, SessionID: "test"})
				pts.readyOnce.Do(func() { close(pts.ready) })
			case "rpc_stream":
				var sf rpc.StreamFrame
				_ = json.Unmarshal(data, &sf)
				select {
				case pts.streams <- sf:
				default:
				}
			case "rpc_result":
				var rf rpc.ResultFrame
				_ = json.Unmarshal(data, &rf)
				select {
				case pts.results <- rf:
				default:
				}
			}
		}
	}))
	return srv, pts
}

func (p *ptyTestServer) writeFrame(ctx context.Context, v any) {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	if p.conn == nil {
		return
	}
	data, _ := json.Marshal(v)
	writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_ = p.conn.Write(writeCtx, websocket.MessageText, data)
}

func TestPtyEndToEnd(t *testing.T) {
	root := t.TempDir()
	srv, pts := newPtyTestServer(t)
	defer srv.Close()

	cancel := startExecutor(t, srv.URL, root)
	defer cancel()

	select {
	case <-pts.ready:
	case <-time.After(5 * time.Second):
		t.Fatal("handshake timeout")
	}

	ctx := context.Background()

	// Open a PTY (long-lived RPC id "p1").
	pts.writeFrame(ctx, rpc.RequestFrame{
		Type:   "rpc",
		ID:     "p1",
		Method: "pty.open",
		Params: map[string]any{
			"ptyId": "term-1",
			"cmd":   []any{"/bin/sh"},
			"cwd":   root,
			"cols":  float64(80),
			"rows":  float64(24),
		},
	})

	// Give the shell a moment to start, then write a command with a marker.
	time.Sleep(300 * time.Millisecond)
	pts.writePty(ctx, "term-1", "echo PTY_MARKER_123\n")

	if !pts.awaitStream(t, "p1", "PTY_MARKER_123", 10*time.Second) {
		t.Fatal("did not observe PTY marker in output")
	}

	// Exit ends the session; pty.open result should arrive.
	pts.writePty(ctx, "term-1", "exit\n")
	if !pts.awaitResult("p1", 10*time.Second) {
		t.Fatal("pty.open did not resolve after exit")
	}
}

func (p *ptyTestServer) writePty(ctx context.Context, ptyID, data string) {
	p.writeFrame(ctx, rpc.RequestFrame{
		Type:   "rpc",
		ID:     "w_" + ptyID,
		Method: "pty.write",
		Params: map[string]any{
			"ptyId":   ptyID,
			"dataB64": base64.StdEncoding.EncodeToString([]byte(data)),
		},
	})
}

func (p *ptyTestServer) awaitStream(t *testing.T, id, marker string, timeout time.Duration) bool {
	t.Helper()
	var acc strings.Builder
	deadline := time.After(timeout)
	for {
		select {
		case sf := <-p.streams:
			if sf.ID == id {
				chunk, _ := base64.StdEncoding.DecodeString(sf.ChunkB64)
				acc.Write(chunk)
				if strings.Contains(acc.String(), marker) {
					return true
				}
			}
		case <-deadline:
			return false
		}
	}
}

func (p *ptyTestServer) awaitResult(id string, timeout time.Duration) bool {
	deadline := time.After(timeout)
	for {
		select {
		case rf := <-p.results:
			if rf.ID == id {
				return rf.OK
			}
		case <-deadline:
			return false
		}
	}
}

var _ = config.Config{}
var _ = handlers.New
