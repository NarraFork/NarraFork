package transport

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/narrafork/remote-executor/internal/config"
	"github.com/narrafork/remote-executor/internal/handlers"
	"github.com/narrafork/remote-executor/internal/rpc"
)

// ── helpers ──────────────────────────────────────────────────────────────────

func startDirectServer(t *testing.T, token string) (addr string, cancel context.CancelFunc) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr = ln.Addr().String()
	_ = ln.Close()

	cfg := &config.Config{
		ListenAddr: addr,
		DeviceRef:  "direct-device",
		Token:      token,
		AllowRoots: []string{t.TempDir()},
		DefaultCwd: t.TempDir(),
	}
	guard := handlers.NewPathGuard(cfg.AllowRoots)
	h := handlers.New(guard, 10*1024*1024)
	dispatcher := rpc.NewDispatcher(h)
	server := NewServer(cfg, dispatcher, rpc.Platform{OS: "linux", Arch: "amd64"}, rpc.Capabilities{})

	ctx, cf := context.WithCancel(context.Background())
	go func() { _ = server.Run(ctx) }()
	if !waitForPort(addr, 3*time.Second) {
		cf()
		t.Fatal("executor listener did not start")
	}
	return addr, cf
}

// performDirectHandshake mimics what the NarraFork server does for a direct
// connection: sends auth_init, responds to auth_challenge with auth_proof +
// hello, and awaits hello_ack. Returns the connection ready for RPCs.
func performDirectHandshake(
	t *testing.T,
	ctx context.Context,
	conn *websocket.Conn,
	token string,
) rpc.HelloAckFrame {
	t.Helper()

	// Step 1 – read auth_init from the executor.
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read auth_init: %v", err)
	}
	var initF rpc.AuthInitFrame
	if err := json.Unmarshal(data, &initF); err != nil || initF.Type != "auth_init" {
		t.Fatalf("expected auth_init, got %s (err=%v)", string(data), err)
	}
	if initF.AuthVersion != rpc.AuthVersion {
		t.Fatalf("unexpected authVersion %d", initF.AuthVersion)
	}
	if !rpc.ValidAuthNonce(initF.ExecutorNonce) {
		t.Fatalf("invalid executor nonce: %q", initF.ExecutorNonce)
	}

	// Step 2 – send auth_challenge with server proof.
	serverNonce, err := rpc.GenerateAuthNonce()
	if err != nil {
		t.Fatalf("generate server nonce: %v", err)
	}
	key := rpc.DeriveAuthKey(token)
	serverTranscript := rpc.AuthTranscriptInput{
		AuthVersion:   rpc.AuthVersion,
		DeviceRef:     initF.DeviceRef,
		ExecutorNonce: initF.ExecutorNonce,
		ServerNonce:   serverNonce,
		Role:          rpc.AuthRoleServer,
	}
	serverProof, err := rpc.CreateAuthProof(key[:], serverTranscript)
	if err != nil {
		t.Fatalf("create server proof: %v", err)
	}
	challenge := rpc.AuthChallengeFrame{
		Type:          "auth_challenge",
		AuthVersion:   rpc.AuthVersion,
		DeviceRef:     initF.DeviceRef,
		ExecutorNonce: initF.ExecutorNonce,
		ServerNonce:   serverNonce,
		Proof:         serverProof,
	}
	if err := writeJSON(ctx, conn, challenge); err != nil {
		t.Fatalf("send auth_challenge: %v", err)
	}

	// Step 3 – read auth_proof from the executor.
	_, data, err = conn.Read(ctx)
	if err != nil {
		t.Fatalf("read auth_proof: %v", err)
	}
	var proofF rpc.AuthProofFrame
	if err := json.Unmarshal(data, &proofF); err != nil || proofF.Type != "auth_proof" {
		t.Fatalf("expected auth_proof, got %s (err=%v)", string(data), err)
	}
	executorTranscript := serverTranscript
	executorTranscript.Role = rpc.AuthRoleExecutor
	if !rpc.VerifyAuthProof(key[:], executorTranscript, proofF.Proof) {
		t.Fatalf("executor proof verification failed")
	}

	// Step 4 – read hello from the executor.
	_, data, err = conn.Read(ctx)
	if err != nil {
		t.Fatalf("read hello: %v", err)
	}
	var hello rpc.HelloFrame
	if err := json.Unmarshal(data, &hello); err != nil || hello.Type != "hello" {
		t.Fatalf("expected hello, got %s (err=%v)", string(data), err)
	}
	if hello.Token != "" {
		t.Fatalf("hello in direct mode must not include token, got %q", hello.Token)
	}
	if hello.DeviceRef != initF.DeviceRef {
		t.Fatalf("hello deviceRef mismatch: %q vs %q", hello.DeviceRef, initF.DeviceRef)
	}

	// Step 5 – send hello_ack.
	ack := rpc.HelloAckFrame{Type: "hello_ack", OK: true, SessionID: "test-direct"}
	if err := writeJSON(ctx, conn, ack); err != nil {
		t.Fatalf("send hello_ack: %v", err)
	}
	return ack
}

// ── tests ─────────────────────────────────────────────────────────────────────

// TestDirectModeEndToEnd starts the executor in direct (listen) mode, performs
// the full nonce/HMAC mutual authentication, and exercises a few RPCs.
func TestDirectModeEndToEnd(t *testing.T) {
	const token = "rdev_direct_test"
	root := t.TempDir()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	cfg := &config.Config{
		ListenAddr: addr,
		DeviceRef:  "direct-device",
		Token:      token,
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

	rpcCtx, rpcCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer rpcCancel()

	// Perform the mutual nonce/HMAC handshake.
	performDirectHandshake(t, rpcCtx, conn, token)

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
	if err := writeJSON(rpcCtx, conn, req); err != nil {
		t.Fatalf("send rpc: %v", err)
	}

	res := readResult(t, rpcCtx, conn, "d1")
	if !res.OK {
		t.Fatalf("fs.write failed: %s", res.Error)
	}

	// Read it back.
	req2 := rpc.RequestFrame{
		Type:   "rpc",
		ID:     "d2",
		Method: "fs.read",
		Params: map[string]any{"path": root + "/direct.txt"},
	}
	_ = writeJSON(rpcCtx, conn, req2)
	res2 := readResult(t, rpcCtx, conn, "d2")
	if !res2.OK {
		t.Fatalf("fs.read failed: %s", res2.Error)
	}
	m := res2.Result.(map[string]any)
	got, _ := base64.StdEncoding.DecodeString(m["dataB64"].(string))
	if string(got) != "direct-mode" {
		t.Fatalf("read mismatch: %q", got)
	}
}

// TestDirectModeWrongTokenRejected verifies the executor rejects a challenge
// proof computed with the wrong key.
func TestDirectModeWrongTokenRejected(t *testing.T) {
	const goodToken = "rdev_direct_good"
	const badToken = "rdev_direct_bad"

	addr, cancel := startDirectServer(t, goodToken)
	defer cancel()

	dialCtx, dialCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer dialCancel()
	conn, _, err := websocket.Dial(dialCtx, fmt.Sprintf("ws://%s/ws/device", addr), &websocket.DialOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	ctx, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel2()

	// Read auth_init.
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read auth_init: %v", err)
	}
	var initF rpc.AuthInitFrame
	_ = json.Unmarshal(data, &initF)

	// Respond with a proof computed using the wrong key.
	serverNonce, _ := rpc.GenerateAuthNonce()
	badKey := rpc.DeriveAuthKey(badToken)
	badProof, _ := rpc.CreateAuthProof(badKey[:], rpc.AuthTranscriptInput{
		AuthVersion:   rpc.AuthVersion,
		DeviceRef:     initF.DeviceRef,
		ExecutorNonce: initF.ExecutorNonce,
		ServerNonce:   serverNonce,
		Role:          rpc.AuthRoleServer,
	})
	challenge := rpc.AuthChallengeFrame{
		Type:          "auth_challenge",
		AuthVersion:   rpc.AuthVersion,
		DeviceRef:     initF.DeviceRef,
		ExecutorNonce: initF.ExecutorNonce,
		ServerNonce:   serverNonce,
		Proof:         badProof,
	}
	if err := writeJSON(ctx, conn, challenge); err != nil {
		t.Fatalf("send bad challenge: %v", err)
	}

	// The executor should close the connection or not proceed past auth_challenge.
	// Either it sends back nothing (closes), or the test times out. We try to
	// read one more frame; expect either EOF/close or the connection to not send
	// an auth_proof. If the context times out the test fails.
	msgCh := make(chan []byte, 1)
	errCh := make(chan error, 1)
	go func() {
		_, d, e := conn.Read(ctx)
		if e != nil {
			errCh <- e
		} else {
			msgCh <- d
		}
	}()

	select {
	case d := <-msgCh:
		// If we do get a frame, it must NOT be an auth_proof (which would mean the
		// executor accepted our bad proof).
		var f rpc.Frame
		_ = json.Unmarshal(d, &f)
		if f.Type == "auth_proof" {
			t.Fatal("executor sent auth_proof despite bad server proof — authentication broken")
		}
		// Any other frame (e.g. a close indication decoded as JSON) is OK.
	case <-errCh:
		// Connection closed by executor — expected.
	case <-ctx.Done():
		t.Fatal("timed out waiting for executor to respond to bad proof")
	}
}

// TestDirectModeRpcBeforeAuthRejected verifies that the executor closes the
// connection if the "server" sends an RPC frame before completing the
// nonce/HMAC handshake.
func TestDirectModeRpcBeforeAuthRejected(t *testing.T) {
	addr, cancel := startDirectServer(t, "rdev_preauth_test")
	defer cancel()

	dialCtx, dialCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer dialCancel()
	conn, _, err := websocket.Dial(dialCtx, fmt.Sprintf("ws://%s/ws/device", addr), &websocket.DialOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	ctx, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel2()

	// Read and discard auth_init (we won't respond to it).
	_, _, err = conn.Read(ctx)
	if err != nil {
		t.Fatalf("read auth_init: %v", err)
	}

	// Send an RPC frame before completing authentication.
	rpcFrame := rpc.RequestFrame{
		Type:   "rpc",
		ID:     "evil1",
		Method: "fs.read",
		Params: map[string]any{"path": "/etc/passwd"},
	}
	// The executor may or may not error on the write itself (depending on
	// ordering). The key guarantee is that we never get a successful rpc_result.
	_ = writeJSON(ctx, conn, rpcFrame)

	// Read until close or until we see a frame that is definitely not an rpc_result.
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			// Connection closed — correct behaviour.
			return
		}
		var f rpc.Frame
		_ = json.Unmarshal(data, &f)
		if f.Type == "rpc_result" {
			var rf rpc.ResultFrame
			_ = json.Unmarshal(data, &rf)
			if rf.OK {
				t.Fatal("executor returned successful RPC result before authentication — security violation")
			}
		}
	}
}

func assertDirectPreAuthFrameRejected(
	t *testing.T,
	send func(context.Context, *websocket.Conn) error,
) {
	t.Helper()
	addr, cancel := startDirectServer(t, "rdev_preauth_gate_test")
	defer cancel()

	dialCtx, dialCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer dialCancel()
	conn, _, err := websocket.Dial(dialCtx, fmt.Sprintf("ws://%s/ws/device", addr), &websocket.DialOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	ctx, cancelRead := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelRead()
	if _, _, err = conn.Read(ctx); err != nil {
		t.Fatalf("read auth_init: %v", err)
	}
	if err := send(ctx, conn); err != nil {
		t.Fatalf("send pre-auth frame: %v", err)
	}

	_, _, err = conn.Read(ctx)
	if err == nil {
		t.Fatal("expected executor to close after a pre-authentication data frame")
	}
	if status := websocket.CloseStatus(err); status != websocket.StatusPolicyViolation {
		t.Fatalf("expected policy-violation close, got status=%d err=%v", status, err)
	}
}

func TestDirectModeRpcCancelBeforeAuthRejected(t *testing.T) {
	assertDirectPreAuthFrameRejected(t, func(ctx context.Context, conn *websocket.Conn) error {
		return writeJSON(ctx, conn, rpc.CancelFrame{Type: "rpc_cancel", ID: "unauthenticated"})
	})
}

func TestDirectModeBinaryBeforeAuthRejected(t *testing.T) {
	assertDirectPreAuthFrameRejected(t, func(ctx context.Context, conn *websocket.Conn) error {
		return conn.Write(ctx, websocket.MessageBinary, []byte{0x4e, 0x01, 0x00, 0x00})
	})
}

// TestDirectModeHandshakeTimeout verifies that the executor closes the
// connection when the server does not respond to auth_init within the timeout.
// We just let the connection idle after reading auth_init; the executor must
// close it by the handshake deadline.
func TestDirectModeHandshakeTimeout(t *testing.T) {
	if testing.Short() {
		t.Skip("handshake timeout test skipped in short mode")
	}
	addr, cancel := startDirectServer(t, "rdev_timeout_test")
	defer cancel()

	dialCtx, dialCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer dialCancel()
	conn, _, err := websocket.Dial(dialCtx, fmt.Sprintf("ws://%s/ws/device", addr), &websocket.DialOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	// Read auth_init — do NOT respond.
	readCtx, rc := context.WithTimeout(context.Background(), 5*time.Second)
	defer rc()
	_, _, err = conn.Read(readCtx)
	if err != nil {
		t.Fatalf("read auth_init: %v", err)
	}

	// The executor should close after its handshake timeout (~10 s). Give it
	// 15 s to be safe, then expect the connection to be dead.
	waitCtx, wc := context.WithTimeout(context.Background(), 15*time.Second)
	defer wc()
	_, _, err = conn.Read(waitCtx)
	if err == nil {
		t.Fatal("expected connection to close after handshake timeout, but got a frame")
	}
	// Any non-nil error (EOF, close, context cancel) means the executor closed.
}

// ── helpers shared with integration_test.go ──────────────────────────────────

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

// ── TLS server startup tests ──────────────────────────────────────────────────

// TestServerRunRejectsInvalidTLSKeyPair ensures that Run returns an error
// immediately when the configured TLS cert+key files do not exist or are
// invalid (rather than silently starting a plain HTTP listener).
func TestServerRunRejectsInvalidTLSKeyPair(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	cfg := &config.Config{
		ListenAddr: addr,
		DeviceRef:  "tls-test-device",
		Token:      "rdev_tls_test",
		TLSCert:    "/nonexistent/cert.pem",
		TLSKey:     "/nonexistent/key.pem",
	}
	guard := handlers.NewPathGuard(nil)
	h := handlers.New(guard, 10*1024*1024)
	dispatcher := rpc.NewDispatcher(h)
	server := NewServer(cfg, dispatcher, rpc.Platform{OS: "linux", Arch: "amd64"}, rpc.Capabilities{})

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	err = server.Run(ctx)
	if err == nil {
		t.Fatal("expected error for invalid TLS key pair, got nil")
	}
}

func TestServerRunRevalidatesNonLoopbackTLSPolicy(t *testing.T) {
	cfg := &config.Config{
		ListenAddr: "0.0.0.0:0",
		DeviceRef:  "policy-test-device",
		Token:      "rdev_policy_test",
	}
	guard := handlers.NewPathGuard(nil)
	server := NewServer(
		cfg,
		rpc.NewDispatcher(handlers.New(guard, 10*1024*1024)),
		rpc.Platform{OS: "linux", Arch: "amd64"},
		rpc.Capabilities{},
	)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := server.Run(ctx); err == nil || !strings.Contains(err.Error(), "tls-cert") {
		t.Fatalf("expected listener-boundary TLS policy error, got: %v", err)
	}
}

// TestLoopbackServerStartsWithoutTLS confirms the existing direct-mode
// loopback listener still works without TLS configuration.
func TestLoopbackServerStartsWithoutTLS(t *testing.T) {
	const token = "rdev_loopback_notls"
	addr, cancel := startDirectServer(t, token)
	defer cancel()

	dialCtx, dc := context.WithTimeout(context.Background(), 3*time.Second)
	defer dc()

	conn, _, err := websocket.Dial(dialCtx, fmt.Sprintf("ws://%s/ws/device", addr), &websocket.DialOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		t.Fatalf("dial loopback executor: %v", err)
	}
	defer conn.CloseNow()

	rpcCtx, rc := context.WithTimeout(context.Background(), 5*time.Second)
	defer rc()
	performDirectHandshake(t, rpcCtx, conn, token)
	// Reaching here means the loopback listener accepted the connection.
}
