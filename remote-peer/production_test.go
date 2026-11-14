package remotepeer

import (
	"context"
	"encoding/json"
	"github.com/coder/websocket"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"
)

func testBackendIdentity() BackendIdentity {
	return BackendIdentity{NFVersion: "1.2.3", SourceCommit: strings.Repeat("a", 40), Repository: "owner/repo", BootstrapABI: 1, APIEpoch: 1, WireVersion: 2, Capabilities: []string{"projects", "sse", "binary-socket"}}
}
func productionRuntime(t *testing.T, handler http.HandlerFunc) (*Runtime, chan map[string]any) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	cfg := Config{Mode: "narrafork", IPCEpoch: "nf-epoch", BackendIdentity: testBackendIdentity(), RequestPolicy: []RequestRule{
		{ID: "login", Methods: []string{"POST"}, Path: "^/api/auth/login$", Phase: "paired", Profile: "request", RequestBytes: JSONBytes, ResponseBytes: JSONBytes},
		{ID: "projects", Methods: []string{"GET"}, Path: "^/api/projects$", Phase: "ready", Profile: "request", ResponseBytes: JSONBytes},
		{ID: "events", Methods: []string{"GET"}, Path: "^/api/events$", Phase: "ready", Profile: "sse", ResponseBytes: 64 * 1024 * 1024},
	}, SignalURL: "ws://127.0.0.1:1/signal/instance", BridgeURL: srv.URL, BridgeSecret: strings.Repeat("b", 32), StatePath: filepath.Join(t.TempDir(), "private", "state.json"), AllowLocalhost: true}
	events := make(chan map[string]any, 128)
	r, err := New(cfg, func(v any) { events <- v.(map[string]any) })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	return r, events
}
func pairedProductionPeer(t *testing.T, r *Runtime, id string) *Peer {
	t.Helper()
	i, secret, _, err := r.store.Invite(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	g, _, err := r.store.Consume(i.ID, secret, r.public, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	p := &Peer{r: r, ctx: ctx, cancel: cancel, ticket: Ticket{SessionID: id}, grant: g.ID, hello: true, helloAt: time.Now(), helloReady: map[string]any{"type": "hello.ready", "version": 2, "backendIdentity": r.cfg.BackendIdentity}, streams: map[uint32]*httpStream{}, retired: map[uint32]*httpStream{}, sockets: map[uint32]*logicalSocket{}, usedIDs: map[uint32]bool{}, priority: make(chan outgoing, 256), bulk: make(chan outgoing, 256)}
	r.peers[id] = p
	return p
}
func acceptProduction(t *testing.T, p *Peer) {
	t.Helper()
	if err := p.accept(PeerAccept{PeerID: p.ticket.SessionID, ContextID: "ctx-" + p.ticket.SessionID, ContextCapability: strings.Repeat("c", 64), BackendIdentity: p.r.cfg.BackendIdentity}); err != nil {
		t.Fatal(err)
	}
	<-p.priority
}
func command(t *testing.T, r *Runtime, kind string, payload any) (any, error) {
	t.Helper()
	b, _ := json.Marshal(payload)
	return r.Command(IPCEnvelope{IPCVersion: 2, Epoch: r.cfg.IPCEpoch, RequestID: "cmd-1", Type: kind, Payload: b})
}
func TestPrototypeResponseCompatibilityNeverWeakensProductionFiltering(t *testing.T) {
	headers := http.Header{
		"Content-Type": []string{"application/json"}, "X-Fixture-Response": []string{"preserved"},
		"Location": []string{"http://192.0.2.1/private"}, "X-Session-Token": []string{"renewal"}, "X-Narrafork-Token": []string{"renewal"}, "X-Narrafork-Session-Token": []string{"renewal"},
		"Authorization": []string{"private"}, "Set-Cookie": []string{"private"}, "X-Narrafork-Bridge": []string{"private"}, "X-Narrafork-Remote-Capability": []string{"private"}, "X-Other-Token": []string{"private"}, "X-Api-Secret": []string{"private"},
	}
	for _, mode := range []string{"prototype", "narrafork", ""} {
		t.Run(mode, func(t *testing.T) {
			result := http.Header{}
			for _, pair := range responseHeaders(headers, mode) {
				result.Add(pair[0], pair[1])
			}
			for _, name := range []string{"Location", "X-Session-Token", "X-Narrafork-Token", "X-Narrafork-Session-Token"} {
				if (result.Get(name) != "") != (mode == "prototype") {
					t.Fatalf("%s compatibility leaked or missing for mode %q", name, mode)
				}
			}
			for _, name := range []string{"Authorization", "Set-Cookie", "X-Narrafork-Bridge", "X-Narrafork-Remote-Capability", "X-Other-Token", "X-Api-Secret"} {
				if result.Get(name) != "" {
					t.Fatalf("secret %s escaped in mode %q", name, mode)
				}
			}
			if result.Get("Content-Type") != "application/json" || result.Get("X-Fixture-Response") != "preserved" {
				t.Fatal("ordinary response headers lost")
			}
		})
	}
}

func TestProductionReadyNoInviteAndStateReopen(t *testing.T) {
	r, events := productionRuntime(t, func(http.ResponseWriter, *http.Request) {})
	if err := r.Ready(); err != nil {
		t.Fatal(err)
	}
	v := <-events
	if v["type"] != "ready" || len(r.store.state.Invites) != 0 || len(v["payload"].(map[string]any)) != 2 {
		t.Fatal("ready leaked invitation", v)
	}
	result, err := command(t, r, "pair.create", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	invitation := result.(map[string]any)["invitation"].(map[string]any)
	g, _, err := r.store.Consume(invitation["pairId"].(string), invitation["pairingSecret"].(string), r.public, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = command(t, r, "grants.revoke", map[string]string{"grantId": g.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := New(r.cfg, func(any) {}); err == nil {
		t.Fatal("second writer accepted")
	}
	identity := r.public
	r.Close()
	again, err := New(r.cfg, func(any) {})
	if err != nil {
		t.Fatal("same state reopen", err)
	}
	defer again.Close()
	if again.public != identity {
		t.Fatal("identity changed on reopen")
	}
	if _, ok := again.store.GetGrant(g.ID); ok {
		t.Fatal("revocation not persisted")
	}
	if strings.Contains(string(mustJSON(t, again.store.ListGrants())), "discoveryHash") {
		t.Fatal("grant secret hash disclosed")
	}
}
func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, e := json.Marshal(v)
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func TestProductionPrivateDirectoryRefusesWideOrLink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("native Windows DACL test is in state_windows_test.go")
	}
	parent := filepath.Join(t.TempDir(), "broad")
	if err := os.Mkdir(parent, 0755); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenRuntimeStore(filepath.Join(parent, "state.json"), true); err == nil {
		t.Fatal("wide parent accepted")
	}
	target := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenRuntimeStore(filepath.Join(link, "state.json"), true); err == nil {
		t.Fatal("symlink parent accepted")
	}
}
func TestProductionContextAckAndReadOnlyIntrospection(t *testing.T) {
	requests := make(chan string, 8)
	expires := time.Now().Add(time.Hour).Unix()
	r, _ := productionRuntime(t, func(w http.ResponseWriter, req *http.Request) {
		requests <- req.URL.Path
		if req.URL.Path != "/_nf/remote/session/introspect" || req.Method != "POST" || req.Header.Get("X-Narrafork-Remote-Epoch") != "nf-epoch" || req.Header.Get("X-Narrafork-Remote-Context") != "ctx-p1" || req.Header.Get("X-Narrafork-Remote-Capability") != strings.Repeat("c", 64) {
			t.Error("untrusted or public introspection request")
			w.WriteHeader(403)
			return
		}
		var body map[string]string
		_ = json.NewDecoder(req.Body).Decode(&body)
		if body["token"] != "nfs_opaque" {
			t.Error("token missing")
		}
		_ = json.NewEncoder(w).Encode(SessionProjection{SessionID: "sid-1", UserID: "admin-1", Role: "admin", ExpiresAt: expires, AuthRevision: 4})
	})
	p := pairedProductionPeer(t, r, "p1")
	if err := p.openRequest(Control{Type: "request.open", StreamID: 1, Method: "POST", Path: "/api/auth/login"}); err == nil {
		t.Fatal("login passed before ACK")
	}
	if _, err := p.checkAuth("nfs_opaque"); err == nil {
		t.Fatal("auth passed before ACK")
	}
	if len(requests) != 0 {
		t.Fatal("bridge accessed before ACK")
	}
	bad := PeerAccept{PeerID: "p1", ContextID: "ctx-p1", ContextCapability: strings.Repeat("c", 64), BackendIdentity: r.cfg.BackendIdentity}
	bad.BackendIdentity.NFVersion = "9.9.9"
	if p.accept(bad) == nil {
		t.Fatal("identity drift accepted")
	}
	acceptProduction(t, p)
	if err := p.handleControl(Control{Type: "auth", Token: "nfs_opaque"}); err != nil {
		t.Fatal(err)
	}
	if !p.isAuthorized() || p.session.SessionID != "sid-1" || p.authExpires != expires {
		t.Fatal("session not bound")
	}
	if p.handleControl(Control{Type: "auth", Token: "nfs_opaque"}) == nil {
		t.Fatal("second auth accepted")
	}
	fresh := SessionProjection{SessionID: "sid-1", UserID: "admin-1", Role: "admin", ExpiresAt: expires + 100, AuthRevision: 5}
	if err := p.updateSession(fresh); err != nil {
		t.Fatal(err)
	}
	exp, err := p.checkAuth("nfs_opaque")
	if err != nil || exp != fresh.ExpiresAt {
		t.Fatal("stale introspection overwrote renewal", exp, err)
	}
}
func TestProductionSessionInvalidationIsPerSID(t *testing.T) {
	r, _ := productionRuntime(t, func(http.ResponseWriter, *http.Request) {})
	first, second := pairedProductionPeer(t, r, "p1"), pairedProductionPeer(t, r, "p2")
	for _, p := range []*Peer{first, second} {
		acceptProduction(t, p)
		p.authorized = true
	}
	first.session = SessionProjection{SessionID: "s1", UserID: "same-user"}
	second.session = SessionProjection{SessionID: "s2", UserID: "same-user"}
	_, err := command(t, r, "session.invalidated", map[string]string{"sessionId": "s1"})
	if err != nil {
		t.Fatal(err)
	}
	if first.ctx.Err() == nil || second.ctx.Err() != nil {
		t.Fatal("sid invalidation affected wrong peer")
	}
}
func TestIPCAndProductionPolicyRejectUntrustedPaths(t *testing.T) {
	r, _ := productionRuntime(t, func(http.ResponseWriter, *http.Request) {})
	for _, raw := range []string{`{"ipcVersion":1,"epoch":"e","requestId":"r","type":"init","payload":{}}`, `{"ipcVersion":2,"epoch":"e","requestId":"r","type":"init","payload":{},"extra":true}`, `{"ipcVersion":2,"epoch":"e","requestId":"r","type":"init","payload":[]} trailing`} {
		if _, err := ParseIPC([]byte(raw)); err == nil {
			t.Fatal("invalid IPC accepted")
		}
	}
	if _, err := r.Command(IPCEnvelope{Epoch: "old", Type: "pair.create", Payload: json.RawMessage(`{}`)}); err == nil {
		t.Fatal("stale epoch")
	}
	for _, path := range []string{"/api/projects/extra", "/api/%2e%2e/projects", "/api//projects", "http://127.0.0.1/api/projects", "/api/projects?token=x", "/api/projects#x"} {
		if _, err := r.requestRule("GET", path, true); err == nil {
			t.Fatal("path accepted", path)
		}
	}
	if _, err := r.requestRule("GET", "/api/projects", false); err == nil {
		t.Fatal("paired phase escaped")
	}
	if rule, err := r.requestRule("GET", "/api/events?offset=5", true); err != nil || rule.Profile != "sse" {
		t.Fatal("SSE policy", err)
	}
}
func TestProductionSocketPreservesLargeBinaryAndUpstreamClose(t *testing.T) {
	payload := []byte(strings.Repeat("x", SocketMessageBytes))
	r, _ := productionRuntime(t, func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("X-Narrafork-Remote-Context") != "ctx-ws" || req.URL.Query().Get("token") != "nfs_bound" {
			t.Error("socket lost trusted context")
			w.WriteHeader(403)
			return
		}
		c, err := websocket.Accept(w, req, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer c.CloseNow()
		ctx, cancel := context.WithTimeout(req.Context(), 3*time.Second)
		defer cancel()
		if err = c.Write(ctx, websocket.MessageBinary, payload); err != nil {
			t.Error(err)
			return
		}
		_ = c.Close(websocket.StatusCode(4001), "session_revoked")
	})
	p := pairedProductionPeer(t, r, "ws")
	acceptProduction(t, p)
	p.authorized = true
	p.authExpires = time.Now().Add(time.Hour).Unix()
	p.token = "nfs_bound"
	// An explicit socket rule mirrors NF init, without broadening the HTTP request surface.
	r.cfg.RequestPolicy = append(r.cfg.RequestPolicy, RequestRule{ID: "ws", Methods: []string{"GET"}, Path: "^/ws/narrator$", Phase: "ready", Profile: "request", ResponseBytes: JSONBytes})
	r.policy = append(r.policy, regexp.MustCompile("^/ws/narrator$"))
	if err := p.openSocket(Control{StreamID: 1, Path: "/ws/narrator", Token: "nfs_bound"}); err != nil {
		t.Fatal(err)
	}
	total := 0
	ready := false
	for {
		select {
		case out := <-p.priority:
			p.releaseSend(len(out.data))
			if out.binary {
				f, err := DecodeSocketFrame(out.data)
				if err != nil || !ready || f.Opcode != 2 {
					t.Fatal("socket frame", err)
				}
				total += len(f.Payload)
				if err = p.handleControl(Control{Type: "socket.window", StreamID: 1, Bytes: int64(len(f.Payload))}); err != nil {
					t.Fatal(err)
				}
			} else {
				var c Control
				_ = json.Unmarshal(out.data, &c)
				if c.Type == "socket.ready" {
					ready = true
				} else if c.Type == "socket.close" {
					if c.Code != 4001 || c.Reason != "session_revoked" || total != len(payload) {
						t.Fatal("close/data lost", c, total)
					}
					return
				}
			}
		case <-time.After(4 * time.Second):
			t.Fatal("upstream socket timeout")
		}
	}
}

func TestSSEIdleAndPolicyByteBudgetCancelUpstream(t *testing.T) {
	for _, mode := range []string{"idle", "bytes"} {
		t.Run(mode, func(t *testing.T) {
			canceled := make(chan struct{}, 1)
			r, _ := productionRuntime(t, func(w http.ResponseWriter, req *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				w.WriteHeader(200)
				w.(http.Flusher).Flush()
				if mode == "bytes" {
					_, _ = w.Write([]byte("data: too large\n\n"))
					w.(http.Flusher).Flush()
				}
				<-req.Context().Done()
				canceled <- struct{}{}
			})
			r.budgets = streamBudgets{request: 10 * time.Millisecond, idle: 25 * time.Millisecond, stall: 25 * time.Millisecond, lifetime: time.Second}
			if mode == "bytes" {
				r.cfg.RequestPolicy[2].ResponseBytes = 8
			}
			p := pairedProductionPeer(t, r, "budget")
			acceptProduction(t, p)
			p.authorized = true
			p.authExpires = time.Now().Add(time.Hour).Unix()
			if err := p.openRequest(Control{StreamID: 1, Method: "GET", Path: "/api/events"}); err != nil {
				t.Fatal(err)
			}
			select {
			case <-canceled:
			case <-time.After(time.Second):
				t.Fatal("budget failed to abort upstream")
			}
			if len(p.bulk) != 0 {
				t.Fatal("over-budget bytes escaped")
			}
		})
	}
}

func TestDataChannelQueueHasIndependentStallDeadline(t *testing.T) {
	r, _ := productionRuntime(t, func(http.ResponseWriter, *http.Request) {})
	r.budgets.stall = 25 * time.Millisecond
	p := pairedProductionPeer(t, r, "stall")
	acceptProduction(t, p)
	if err := p.control(map[string]any{"type": "test"}); err != nil {
		t.Fatal(err)
	}
	go p.send()
	select {
	case <-p.ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("unopened/backpressured datachannel retained queue indefinitely")
	}
}

func TestLoginWindowIsTenMinutesNotHandshakeTimeout(t *testing.T) {
	r, _ := productionRuntime(t, func(http.ResponseWriter, *http.Request) {})
	p := pairedProductionPeer(t, r, "login")
	acceptProduction(t, p)
	p.helloAt = time.Now().Add(-9 * time.Minute)
	go p.watch()
	select {
	case <-p.ctx.Done():
		t.Fatal("human login expired before ten minutes")
	case <-time.After(1100 * time.Millisecond):
	}
	p.mu.Lock()
	p.helloAt = time.Now().Add(-11 * time.Minute)
	p.mu.Unlock()
	select {
	case <-p.ctx.Done():
	case <-time.After(1500 * time.Millisecond):
		t.Fatal("ten-minute login deadline was not enforced")
	}
}

func TestSSEOutlivesOrdinaryBudgetAndCancellationReleases(t *testing.T) {
	canceled := make(chan struct{}, 1)
	r, _ := productionRuntime(t, func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		select {
		case <-time.After(75 * time.Millisecond):
			_, _ = w.Write([]byte("data: alive\n\n"))
			w.(http.Flusher).Flush()
		case <-req.Context().Done():
			canceled <- struct{}{}
			return
		}
		<-req.Context().Done()
		canceled <- struct{}{}
	})
	r.budgets = streamBudgets{request: 25 * time.Millisecond, idle: 150 * time.Millisecond, stall: 150 * time.Millisecond, lifetime: time.Second}
	p := pairedProductionPeer(t, r, "sse")
	acceptProduction(t, p)
	p.authorized = true
	p.authExpires = time.Now().Add(time.Hour).Unix()
	if err := p.openRequest(Control{StreamID: 1, Method: "GET", Path: "/api/events"}); err != nil {
		t.Fatal(err)
	}
	select {
	case data := <-p.bulk:
		f, e := DecodeFrame(data.data)
		if e != nil || string(f.Payload) != "data: alive\n\n" {
			t.Fatal("stream failed before ordinary budget", e)
		}
	case <-time.After(time.Second):
		t.Fatal("SSE timeout")
	}
	if err := p.handleControl(Control{Type: "stream.cancel", StreamID: 1}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("cancel did not reach HTTP")
	}
	p.mu.Lock()
	s := p.streams[1]
	p.mu.Unlock()
	if s != nil && s.ctx.Err() == nil {
		t.Fatal("stream context leaked")
	}
}
