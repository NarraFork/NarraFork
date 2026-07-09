// Package transport implements the reverse-dial WebSocket client that connects
// the executor to a NarraFork server, performs the hello handshake, and runs
// the RPC serve loop with per-request cancellation and streaming output.
package transport

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/narrafork/remote-executor/internal/config"
	"github.com/narrafork/remote-executor/internal/handlers"
	"github.com/narrafork/remote-executor/internal/rpc"
	"github.com/narrafork/remote-executor/internal/wire"
)

const agentVersion = "0.1.0"

type Client struct {
	cfg        *config.Config
	dispatcher *rpc.Dispatcher
	platform   rpc.Platform
	caps       rpc.Capabilities

	writeMu sync.Mutex
	conn    *websocket.Conn

	// in-flight request cancellations keyed by rpc id
	cancelMu sync.Mutex
	cancels  map[string]context.CancelFunc
}

func NewClient(cfg *config.Config, dispatcher *rpc.Dispatcher, platform rpc.Platform, caps rpc.Capabilities) *Client {
	c := &Client{
		cfg:        cfg,
		dispatcher: dispatcher,
		platform:   platform,
		caps:       caps,
		cancels:    make(map[string]context.CancelFunc),
	}
	// Wire a transfer manager whose binary sender is this client.
	dispatcher.SetTransfers(handlers.NewTransfers(dispatcher.Handlers(), c))
	return c
}

// SendBinary implements handlers.BinarySender: writes a binary WebSocket frame.
func (c *Client) SendBinary(frame []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.conn == nil {
		return fmt.Errorf("no connection")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return c.conn.Write(ctx, websocket.MessageBinary, frame)
}

// BufferedAmount is a best-effort backpressure signal. coder/websocket does not
// expose a send-buffer size, so we return 0 (Write already blocks until the
// frame is handed to the OS, providing natural backpressure).
func (c *Client) BufferedAmount() int { return 0 }

// Run connects and serves until ctx is cancelled, reconnecting with exponential
// backoff on any disconnect.
func (c *Client) Run(ctx context.Context) error {
	backoff := time.Second
	maxBackoff := time.Duration(c.cfg.ReconnectMaxSeconds) * time.Second
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		err := c.connectAndServe(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		log.Printf("connection closed: %v; reconnecting in %s", err, backoff)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

func (c *Client) connectAndServe(ctx context.Context) error {
	dialCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	httpClient := &http.Client{}
	if c.cfg.InsecureSkipVerify {
		httpClient.Transport = &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		}
	}

	conn, _, err := websocket.Dial(dialCtx, c.cfg.ServerURL, &websocket.DialOptions{
		HTTPClient: httpClient,
		// Disable permessage-deflate: the NarraFork server is Bun, whose WS
		// compression negotiation differs and can produce RSV-bit mismatches.
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	// Allow large RPC frames (base64 file payloads).
	conn.SetReadLimit(64 * 1024 * 1024)
	c.conn = conn
	defer conn.CloseNow()

	// Send hello.
	hello := rpc.HelloFrame{
		Type:            "hello",
		ProtocolVersion: rpc.ProtocolVersion,
		DeviceRef:       c.cfg.DeviceRef,
		Token:           c.cfg.Token,
		AgentVersion:    agentVersion,
		Platform:        c.platform,
		DefaultCwd:      c.cfg.DefaultCwd,
		Capabilities:    c.caps,
	}
	if err := c.writeJSON(ctx, hello); err != nil {
		return fmt.Errorf("send hello: %w", err)
	}

	log.Printf("connected to %s as device %q", c.cfg.ServerURL, c.cfg.DeviceRef)
	return c.serve(ctx, conn)
}

func (c *Client) serve(ctx context.Context, conn *websocket.Conn) error {
	for {
		msgType, data, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		// Binary messages are transfer chunk frames (upload direction).
		if msgType == websocket.MessageBinary {
			if header, payload, ok := wire.DecodeChunkFrame(data); ok {
				if tr := c.dispatcher.Transfers(); tr != nil {
					tr.WriteChunk(header.TransferID, header.ChunkIndex, payload)
				}
			}
			continue
		}
		var frame rpc.Frame
		if err := json.Unmarshal(data, &frame); err != nil {
			log.Printf("bad frame: %v", err)
			continue
		}
		switch frame.Type {
		case "hello_ack":
			var ack rpc.HelloAckFrame
			_ = json.Unmarshal(data, &ack)
			if !ack.OK {
				return fmt.Errorf("handshake rejected: %s", ack.Error)
			}
			log.Printf("handshake accepted (session %s)", ack.SessionID)
		case "ping":
			_ = c.writeJSON(ctx, map[string]string{"type": "pong"})
		case "pong":
			// heartbeat ack
		case "rpc":
			var req rpc.RequestFrame
			if err := json.Unmarshal(data, &req); err != nil {
				log.Printf("bad rpc frame: %v", err)
				continue
			}
			go c.handleRequest(ctx, req)
		case "rpc_cancel":
			var cf rpc.CancelFrame
			if err := json.Unmarshal(data, &cf); err == nil {
				c.cancelRequest(cf.ID)
			}
		default:
			// ignore unknown frames
		}
	}
}

func (c *Client) handleRequest(parentCtx context.Context, req rpc.RequestFrame) {
	reqCtx, cancel := context.WithCancel(parentCtx)
	c.cancelMu.Lock()
	c.cancels[req.ID] = cancel
	c.cancelMu.Unlock()
	defer func() {
		c.cancelMu.Lock()
		delete(c.cancels, req.ID)
		c.cancelMu.Unlock()
		cancel()
	}()

	stream := func(channel string, chunk []byte) {
		_ = c.writeJSON(parentCtx, rpc.StreamFrame{
			Type:     "rpc_stream",
			ID:       req.ID,
			Channel:  channel,
			ChunkB64: base64.StdEncoding.EncodeToString(chunk),
		})
	}

	result, err := c.dispatcher.Dispatch(reqCtx, req.Method, req.Params, stream)

	res := rpc.ResultFrame{Type: "rpc_result", ID: req.ID}
	if err != nil {
		res.OK = false
		res.Error = err.Error()
	} else {
		res.OK = true
		res.Result = result
	}
	if writeErr := c.writeJSON(parentCtx, res); writeErr != nil {
		log.Printf("failed to send result for %s: %v", req.ID, writeErr)
	}
}

func (c *Client) cancelRequest(id string) {
	c.cancelMu.Lock()
	cancel := c.cancels[id]
	c.cancelMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (c *Client) writeJSON(ctx context.Context, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.conn == nil {
		return fmt.Errorf("no connection")
	}
	writeCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return c.conn.Write(writeCtx, websocket.MessageText, data)
}

var _ = handlers.StreamFunc(nil)
