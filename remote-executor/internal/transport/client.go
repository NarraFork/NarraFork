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
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/narrafork/remote-executor/internal/buildinfo"
	"github.com/narrafork/remote-executor/internal/config"
	"github.com/narrafork/remote-executor/internal/handlers"
	"github.com/narrafork/remote-executor/internal/rpc"
	"github.com/narrafork/remote-executor/internal/wire"
)

const handshakeTimeout = 10 * time.Second

type Client struct {
	cfg        *config.Config
	dispatcher *rpc.Dispatcher
	platform   rpc.Platform
	caps       rpc.Capabilities
}

// connectionState owns every mutable resource associated with exactly one
// WebSocket. Writers and transfer senders retain this object, so work from an
// old connection can never target a replacement socket after reconnect.
type connectionState struct {
	conn          *websocket.Conn
	ctx           context.Context
	cancel        context.CancelFunc
	dispatcher    *rpc.Dispatcher
	transfers     *handlers.Transfers
	authenticated atomic.Bool

	writeMu   sync.Mutex
	cancelMu  sync.Mutex
	cancels   map[string]*requestCancel
	closeOnce sync.Once
}

type requestCancel struct {
	cancel context.CancelFunc
}

func NewClient(cfg *config.Config, dispatcher *rpc.Dispatcher, platform rpc.Platform, caps rpc.Capabilities) *Client {
	return &Client{
		cfg:        cfg,
		dispatcher: dispatcher,
		platform:   platform,
		caps:       caps,
	}
}

func (c *Client) newConnectionState(parent context.Context, conn *websocket.Conn) *connectionState {
	ctx, cancel := context.WithCancel(parent)
	h := c.dispatcher.Handlers().ConnectionScoped()
	dispatcher := rpc.NewDispatcher(h)
	state := &connectionState{
		conn:       conn,
		ctx:        ctx,
		cancel:     cancel,
		dispatcher: dispatcher,
		cancels:    make(map[string]*requestCancel),
	}
	state.transfers = handlers.NewTransfersWithContext(ctx, h, state)
	dispatcher.SetTransfers(state.transfers)
	return state
}

// SendBinary implements handlers.BinarySender for one connection.
func (s *connectionState) SendBinary(frame []byte) error {
	if !s.authenticated.Load() {
		return fmt.Errorf("connection is not authenticated")
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := s.ctx.Err(); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(s.ctx, 30*time.Second)
	defer cancel()
	return s.conn.Write(ctx, websocket.MessageBinary, frame)
}

// BufferedAmount is a best-effort backpressure signal. coder/websocket does not
// expose a send-buffer size, so Write itself provides natural backpressure.
func (s *connectionState) BufferedAmount() int { return 0 }

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
	conn.SetReadLimit(64 * 1024 * 1024)
	state := c.newConnectionState(ctx, conn)
	defer state.close()

	handshakeCtx, handshakeCancel := context.WithTimeout(state.ctx, handshakeTimeout)
	hello := c.hello(true)
	if err := state.writeJSON(handshakeCtx, hello); err != nil {
		handshakeCancel()
		return fmt.Errorf("send hello: %w", err)
	}
	ack, err := c.awaitHelloAck(handshakeCtx, state)
	handshakeCancel()
	if err != nil {
		return err
	}
	state.authenticated.Store(true)
	log.Printf("connected to %s as device %q (session %s)", c.cfg.ServerURL, c.cfg.DeviceRef, ack.SessionID)
	return state.serveAuthenticated()
}

func (c *Client) hello(includeToken bool) rpc.HelloFrame {
	effective := c.cfg.EffectivePathRules()
	rules := make([]rpc.PathRuleFrame, 0, len(effective))
	for _, rule := range effective {
		rules = append(rules, rpc.PathRuleFrame{Action: rule.Action, Path: rule.Path})
	}
	hello := rpc.HelloFrame{
		Type:            "hello",
		ProtocolVersion: rpc.ProtocolVersion,
		DeviceRef:       c.cfg.DeviceRef,
		AgentVersion:    buildinfo.Version,
		Platform:        c.platform,
		DefaultCwd:      c.cfg.DefaultCwd,
		Capabilities:    c.caps,
		PathRules:       rules,
		// Reported explicitly: an empty rule list and "this build does not report
		// rules" must not look identical to the server, or the UI would show a
		// misleading "not applied" badge against an older executor.
		PathRulesUnrestricted: len(rules) == 0,
	}
	if includeToken {
		hello.Token = c.cfg.Token
	}
	return hello
}

// authenticateDirect performs authVersion=1 mutual nonce/HMAC authentication.
// The caller must not enter serveAuthenticated until the final hello_ack succeeds.
func (c *Client) authenticateDirect(state *connectionState) (rpc.HelloAckFrame, error) {
	handshakeCtx, cancel := context.WithTimeout(state.ctx, handshakeTimeout)
	defer cancel()

	executorNonce, err := rpc.GenerateAuthNonce()
	if err != nil {
		return rpc.HelloAckFrame{}, err
	}
	init := rpc.AuthInitFrame{
		Type:          "auth_init",
		AuthVersion:   rpc.AuthVersion,
		DeviceRef:     c.cfg.DeviceRef,
		ExecutorNonce: executorNonce,
	}
	if err := state.writeJSON(handshakeCtx, init); err != nil {
		return rpc.HelloAckFrame{}, fmt.Errorf("send auth init: %w", err)
	}

	var challenge rpc.AuthChallengeFrame
	for {
		data, frame, err := readHandshakeFrame(handshakeCtx, state.conn)
		if err != nil {
			return rpc.HelloAckFrame{}, err
		}
		switch frame.Type {
		case "auth_challenge":
			if err := json.Unmarshal(data, &challenge); err != nil {
				return rpc.HelloAckFrame{}, fmt.Errorf("decode auth challenge: %w", err)
			}
			goto challengeReceived
		case "ping":
			if err := state.writeJSON(handshakeCtx, map[string]string{"type": "pong"}); err != nil {
				return rpc.HelloAckFrame{}, err
			}
		case "pong":
			// heartbeat acknowledgement is allowed during the handshake
		case "rpc", "rpc_cancel":
			return rpc.HelloAckFrame{}, fmt.Errorf("received %s before authentication", frame.Type)
		default:
			return rpc.HelloAckFrame{}, fmt.Errorf("unexpected %s during direct authentication", frame.Type)
		}
	}

challengeReceived:
	if challenge.AuthVersion != rpc.AuthVersion || challenge.DeviceRef != c.cfg.DeviceRef ||
		challenge.ExecutorNonce != executorNonce || !rpc.ValidAuthNonce(challenge.ServerNonce) {
		return rpc.HelloAckFrame{}, fmt.Errorf("invalid auth challenge")
	}
	key := rpc.DeriveAuthKey(c.cfg.Token)
	serverTranscript := rpc.AuthTranscriptInput{
		AuthVersion:   rpc.AuthVersion,
		DeviceRef:     c.cfg.DeviceRef,
		ExecutorNonce: executorNonce,
		ServerNonce:   challenge.ServerNonce,
		Role:          rpc.AuthRoleServer,
	}
	if !rpc.VerifyAuthProof(key[:], serverTranscript, challenge.Proof) {
		return rpc.HelloAckFrame{}, fmt.Errorf("server authentication failed")
	}

	executorTranscript := serverTranscript
	executorTranscript.Role = rpc.AuthRoleExecutor
	proof, err := rpc.CreateAuthProof(key[:], executorTranscript)
	if err != nil {
		return rpc.HelloAckFrame{}, err
	}
	if err := state.writeJSON(handshakeCtx, rpc.AuthProofFrame{
		Type:          "auth_proof",
		AuthVersion:   rpc.AuthVersion,
		DeviceRef:     c.cfg.DeviceRef,
		ExecutorNonce: executorNonce,
		ServerNonce:   challenge.ServerNonce,
		Proof:         proof,
	}); err != nil {
		return rpc.HelloAckFrame{}, fmt.Errorf("send auth proof: %w", err)
	}
	if err := state.writeJSON(handshakeCtx, c.hello(false)); err != nil {
		return rpc.HelloAckFrame{}, fmt.Errorf("send hello: %w", err)
	}
	return c.awaitHelloAck(handshakeCtx, state)
}

func readHandshakeFrame(ctx context.Context, conn *websocket.Conn) ([]byte, rpc.Frame, error) {
	msgType, data, err := conn.Read(ctx)
	if err != nil {
		return nil, rpc.Frame{}, fmt.Errorf("handshake read: %w", err)
	}
	if msgType == websocket.MessageBinary {
		return nil, rpc.Frame{}, fmt.Errorf("received binary frame before authentication")
	}
	var frame rpc.Frame
	if err := json.Unmarshal(data, &frame); err != nil || frame.Type == "" {
		return nil, rpc.Frame{}, fmt.Errorf("invalid handshake frame")
	}
	return data, frame, nil
}

func (c *Client) awaitHelloAck(ctx context.Context, state *connectionState) (rpc.HelloAckFrame, error) {
	for {
		data, frame, err := readHandshakeFrame(ctx, state.conn)
		if err != nil {
			return rpc.HelloAckFrame{}, err
		}
		switch frame.Type {
		case "hello_ack":
			var ack rpc.HelloAckFrame
			if err := json.Unmarshal(data, &ack); err != nil {
				return rpc.HelloAckFrame{}, fmt.Errorf("decode hello ack: %w", err)
			}
			if !ack.OK {
				return rpc.HelloAckFrame{}, fmt.Errorf("handshake rejected: %s", ack.Error)
			}
			return ack, nil
		case "ping":
			if err := state.writeJSON(ctx, map[string]string{"type": "pong"}); err != nil {
				return rpc.HelloAckFrame{}, err
			}
		case "pong":
			// heartbeat acknowledgement is allowed during the handshake
		case "rpc", "rpc_cancel":
			return rpc.HelloAckFrame{}, fmt.Errorf("received %s before hello_ack", frame.Type)
		default:
			return rpc.HelloAckFrame{}, fmt.Errorf("unexpected %s while awaiting hello_ack", frame.Type)
		}
	}
}

func (s *connectionState) serveAuthenticated() error {
	if !s.authenticated.Load() {
		return fmt.Errorf("serve loop started before authentication")
	}
	for {
		msgType, data, err := s.conn.Read(s.ctx)
		if err != nil {
			return err
		}
		if msgType == websocket.MessageBinary {
			if header, payload, ok := wire.DecodeChunkFrame(data); ok {
				s.transfers.WriteChunk(header.TransferID, header.ChunkIndex, payload)
			}
			continue
		}
		var frame rpc.Frame
		if err := json.Unmarshal(data, &frame); err != nil {
			log.Printf("bad frame: %v", err)
			continue
		}
		switch frame.Type {
		case "ping":
			_ = s.writeJSON(s.ctx, map[string]string{"type": "pong"})
		case "pong":
			// heartbeat ack
		case "rpc":
			var req rpc.RequestFrame
			if err := json.Unmarshal(data, &req); err != nil {
				log.Printf("bad rpc frame: %v", err)
				continue
			}
			go s.handleRequest(req)
		case "rpc_cancel":
			var cf rpc.CancelFrame
			if err := json.Unmarshal(data, &cf); err == nil {
				s.cancelRequest(cf.ID)
			}
		default:
			// ignore unknown post-authentication frames for forward compatibility
		}
	}
}

func (s *connectionState) handleRequest(req rpc.RequestFrame) {
	reqCtx, cancel := context.WithCancel(s.ctx)
	entry := &requestCancel{cancel: cancel}
	s.cancelMu.Lock()
	if s.ctx.Err() != nil {
		s.cancelMu.Unlock()
		cancel()
		return
	}
	if previous := s.cancels[req.ID]; previous != nil {
		previous.cancel()
	}
	s.cancels[req.ID] = entry
	s.cancelMu.Unlock()
	defer func() {
		s.cancelMu.Lock()
		if s.cancels[req.ID] == entry {
			delete(s.cancels, req.ID)
		}
		s.cancelMu.Unlock()
		cancel()
	}()

	stream := func(channel string, chunk []byte) {
		if reqCtx.Err() != nil {
			return
		}
		_ = s.writeJSON(reqCtx, rpc.StreamFrame{
			Type:     "rpc_stream",
			ID:       req.ID,
			Channel:  channel,
			ChunkB64: base64.StdEncoding.EncodeToString(chunk),
		})
	}

	result, err := s.dispatcher.Dispatch(reqCtx, req.Method, req.Params, stream)
	if reqCtx.Err() != nil {
		return
	}

	res := rpc.ResultFrame{Type: "rpc_result", ID: req.ID}
	if err != nil {
		res.OK = false
		res.Error = err.Error()
	} else {
		res.OK = true
		res.Result = result
	}
	if writeErr := s.writeJSON(reqCtx, res); writeErr != nil && s.ctx.Err() == nil {
		log.Printf("failed to send result for %s: %v", req.ID, writeErr)
	}
}

func (s *connectionState) cancelRequest(id string) {
	s.cancelMu.Lock()
	entry := s.cancels[id]
	if entry != nil {
		delete(s.cancels, id)
	}
	s.cancelMu.Unlock()
	if entry != nil {
		entry.cancel()
	}
}

func (s *connectionState) cancelAllRequests() {
	s.cancelMu.Lock()
	cancels := make([]context.CancelFunc, 0, len(s.cancels))
	for id, entry := range s.cancels {
		cancels = append(cancels, entry.cancel)
		delete(s.cancels, id)
	}
	s.cancelMu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
}

func (s *connectionState) close() {
	s.closeOnce.Do(func() {
		s.authenticated.Store(false)
		s.cancel()
		s.cancelAllRequests()
		s.transfers.Close()
		s.conn.CloseNow()
	})
}

func (s *connectionState) writeJSON(ctx context.Context, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := s.ctx.Err(); err != nil {
		return err
	}
	writeCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return s.conn.Write(writeCtx, websocket.MessageText, data)
}
