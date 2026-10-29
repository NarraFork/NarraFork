package remotepeer

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/webrtc/v4"
)

func TestControlStrictBounded(t *testing.T) {
	for _, s := range []string{`{"type":"auth","token":"x","target":"evil"}`, `{"type":"auth"} {}`, `{"type":"auth"} INVALID`, strings.Repeat(" ", FrameBytes+1), `{"type":"request.open","streamId":4294967296}`} {
		if _, e := ParseControl([]byte(s)); e == nil {
			t.Errorf("accepted %q", s[:min(len(s), 100)])
		}
	}
	if _, e := ParseControl([]byte(`{"type":"request.open","streamId":1,"method":"GET","path":"/api/json","headers":[],"hasBody":false}`)); e != nil {
		t.Fatal(e)
	}
}
func TestBudgetCapsAndCancel(t *testing.T) {
	r, done := testRuntime(t, func(http.ResponseWriter, *http.Request) {})
	defer done()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := &Peer{r: r, ctx: ctx, cancel: cancel, channels: map[string]*webrtc.DataChannel{}, streams: map[uint32]*httpStream{}, sockets: map[uint32]*logicalSocket{}, usedIDs: map[uint32]bool{}, priority: make(chan outgoing, 256), bulk: make(chan outgoing, 256)}
	p.authorized = true
	p.hello = true
	p.token = "jwt"
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	invite, secret, _, _ := r.store.Invite(time.Now())
	grant, _, e := r.store.Consume(invite.ID, secret, PublicHex(&key.PublicKey), time.Now())
	if e != nil {
		t.Fatal(e)
	}
	p.grant = grant.ID
	p.authExpires = time.Now().Add(time.Minute).Unix()
	for n := 1; n <= 32; n++ {
		p.streams[uint32(n)] = &httpStream{cancel: func() {}}
	}
	if e := p.openRequest(Control{StreamID: 33, Method: "GET", Path: "/api/json"}); e == nil {
		t.Fatal("streams")
	}
	p.streams = map[uint32]*httpStream{}
	for n := 1; n <= 8; n++ {
		p.sockets[uint32(n)] = &logicalSocket{cancel: func() {}, p: p}
	}
	if e := p.openSocket(Control{StreamID: 9, Path: "/ws/narrator", Token: "jwt"}); e == nil {
		t.Fatal("sockets")
	}
	p.sockets = map[uint32]*logicalSocket{}
	if e := p.openSocket(Control{StreamID: 1, Path: "/ws/terminal", Token: "jwt"}); e == nil {
		t.Fatal("socket target")
	}
	p.recvQueued = QueueBytes
	if p.reserveReceive(1) {
		t.Fatal("receive queue")
	}
	p.recvQueued = 0
	if _, e := filteredHeaders([][2]string{{"Accept", strings.Repeat("a", 8193)}}); e == nil {
		t.Fatal("headers")
	}
	ctx2, cancel2 := context.WithCancel(ctx)
	s := &httpStream{ctx: ctx2, cancel: cancel2, sendCredit: 0, wake: make(chan struct{}, 1)}
	cancel2()
	if _, e := s.waitCredit(); e == nil {
		t.Fatal("cancel stalled response")
	}
}
func TestInvalidateSessionIsImmediateAndPreservesGrant(t *testing.T) {
	r, done := testRuntime(t, func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Authorization") != "Bearer fresh-session" {
			http.Error(w, "invalid session", 401)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"role": "admin", "expiresAt": time.Now().Add(time.Minute).Unix()})
	})
	defer done()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	pub := PublicHex(&key.PublicKey)
	invite, secret, _, e := r.store.Invite(time.Now())
	if e != nil {
		t.Fatal(e)
	}
	grant, _, e := r.store.Consume(invite.ID, secret, pub, time.Now())
	if e != nil {
		t.Fatal(e)
	}
	makePeer := func(id, token string) *Peer {
		p := newPeer(r, nil, Ticket{SessionID: id, TargetKind: "grant", TargetID: grant.ID, ClientPublicKey: pub})
		p.mu.Lock()
		p.grant = grant.ID
		p.hello = true
		p.authorized = true
		p.token = token
		p.authExpires = time.Now().Add(time.Minute).Unix()
		p.mu.Unlock()
		r.mu.Lock()
		r.peers[id] = p
		r.mu.Unlock()
		return p
	}
	affected := makePeer("affected-session", "invalidated-session")
	other := makePeer("other-session", "other-token")
	streamCtx, streamCancel := context.WithCancel(context.Background())
	socketCtx, socketCancel := context.WithCancel(context.Background())
	affected.mu.Lock()
	affected.streams[1] = &httpStream{ctx: streamCtx, cancel: streamCancel}
	affected.sockets[2] = &logicalSocket{p: affected, ctx: socketCtx, cancel: socketCancel}
	affected.mu.Unlock()
	if e = r.InvalidateSession("invalidated-session"); e != nil {
		t.Fatal(e)
	}
	if affected.ctx.Err() == nil || streamCtx.Err() == nil || socketCtx.Err() == nil {
		t.Fatal("matching session resources not immediately cancelled")
	}
	if other.ctx.Err() != nil || !other.isAuthorized() {
		t.Fatal("other session affected")
	}
	r.mu.Lock()
	removed := r.peers["affected-session"] == nil
	retained := r.peers["other-session"] == other
	r.mu.Unlock()
	if !removed || !retained {
		t.Fatal("peer registry did not retain only other session")
	}
	if !r.store.Target("grant", grant.ID, pub, time.Now()) {
		t.Fatal("connect grant revoked with session")
	}
	if e = r.InvalidateSession("not-present"); e != nil || other.ctx.Err() != nil {
		t.Fatal("unknown session invalidation affected peer", e)
	}
	for _, token := range []string{"", strings.Repeat("x", 8193), "jwt\rheader", "jwt\nheader", "jwt\x00"} {
		if e = r.InvalidateSession(token); e == nil {
			t.Fatal("invalid token accepted")
		}
		if other.ctx.Err() != nil {
			t.Fatal("invalid command affected peer")
		}
	}
	// Reconnecting with the existing connect-only grant can independently log into B again.
	fresh := makePeer("fresh-peer", "")
	fresh.mu.Lock()
	fresh.authorized = false
	fresh.mu.Unlock()
	if e = fresh.handleControl(Control{Type: "auth", Token: "fresh-session"}); e != nil {
		t.Fatal("fresh login failed", e)
	}
	if !fresh.isAuthorized() {
		t.Fatal("existing grant could not authorize fresh login")
	}
}

func TestCancelledReceiptAndBodyLimit(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s := &httpStream{ctx: ctx, cancel: cancel, hasBody: true, recvCredit: 8, limit: 8, sendCredit: WindowBytes - 4}
	if e := s.receive(Frame{Kind: 1, Sequence: 0, Payload: []byte("1234")}); e != nil {
		t.Fatal(e)
	}
	if e := s.receive(Frame{Kind: 2, Sequence: 1}); e != nil {
		t.Fatal("late END", e)
	}
	if e := s.receive(Frame{Kind: 1, Sequence: 2, Payload: []byte("5")}); e == nil {
		t.Fatal("data after end")
	}
	if e := s.update(4); e != nil {
		t.Fatal("late legitimate window", e)
	}
	if e := s.update(1); e == nil {
		t.Fatal("late overgrant")
	}
	for _, limit := range []int64{JSONBytes, FileBytes} {
		ctx2, cancel2 := context.WithCancel(context.Background())
		s2 := &httpStream{ctx: ctx2, cancel: cancel2, hasBody: true, recvCredit: WindowBytes, received: limit, limit: limit, chunks: make(chan []byte, 1)}
		if e := s2.receive(Frame{Kind: 1, Payload: []byte("x")}); e == nil {
			t.Fatal("body limit", limit)
		}
		cancel2()
	}
	if safeErrorCode(errors.New("Bearer secret in raw SDK error")) != "protocol_rejected" {
		t.Fatal("secret error reflected")
	}
}

func TestTicketOfferBinding(t *testing.T) {
	r, done := testRuntime(t, func(http.ResponseWriter, *http.Request) {})
	defer done()
	coordinator, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	client, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	pub := PublicHex(&client.PublicKey)
	i, _, _, _ := r.store.Invite(time.Now())
	r.epoch = "lease"
	r.coordinatorKey = PublicHex(&coordinator.PublicKey)
	offer := "v=0\r\n"
	ticket := Ticket{InstanceID: r.id, LeaseEpoch: r.epoch, SessionID: randomHex(16), ClientPublicKey: pub, OfferHash: Hash(offer), ExpiresAt: time.Now().Add(30 * time.Second).Unix(), TargetKind: "invite", TargetID: i.ID}
	ticket.Signature, _ = Sign(coordinator, "ticket", ticket.fields()...)
	sig, _ := Sign(client, "offer", r.id, i.ID, pub, Hash(offer))
	bad := ticket
	bad.TargetID = "unknown"
	bad.Signature, _ = Sign(coordinator, "ticket", bad.fields()...)
	if e := r.offer(context.Background(), Signal{Ticket: bad, Offer: offer, OfferSignature: sig}); e == nil {
		t.Fatal("target")
	}
	bad = ticket
	bad.LeaseEpoch = "old"
	bad.Signature, _ = Sign(coordinator, "ticket", bad.fields()...)
	if e := r.offer(context.Background(), Signal{Ticket: bad, Offer: offer, OfferSignature: sig}); e == nil {
		t.Fatal("epoch")
	}
	if e := r.offer(context.Background(), Signal{Ticket: ticket, Offer: offer, OfferSignature: strings.Repeat("0", 128)}); e == nil {
		t.Fatal("browser signature")
	}
	if e := r.offer(context.Background(), Signal{Ticket: ticket, Offer: offer + "x", OfferSignature: sig}); e == nil {
		t.Fatal("offer hash")
	}
	r.pending[i.ID] = "occupied"
	if e := r.offer(context.Background(), Signal{Ticket: ticket, Offer: offer, OfferSignature: sig}); e == nil {
		t.Fatal("one pending invite")
	}
}
func TestCoordinatorDisconnectKeepsAuthorizedPeer(t *testing.T) {
	coordinator, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	disconnect := make(chan struct{})
	registered := make(chan struct{})
	a := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		c, e := websocket.Accept(w, req, nil)
		if e != nil {
			return
		}
		defer c.CloseNow()
		ctx := req.Context()
		if wsJSON(ctx, c, map[string]any{"type": "challenge", "challenge": "test-challenge", "coordinatorPublicKey": PublicHex(&coordinator.PublicKey)}) != nil {
			return
		}
		_, b, e := c.Read(ctx)
		if e != nil {
			return
		}
		var reg struct{ PublicKey, Signature string }
		if json.Unmarshal(b, &reg) != nil || !Verify(reg.PublicKey, reg.Signature, "register", "test-challenge", reg.PublicKey) {
			t.Error("register signature")
			return
		}
		id, _ := InstanceID(reg.PublicKey)
		if wsJSON(ctx, c, map[string]any{"type": "registered", "instanceId": id, "leaseEpoch": "lease-test"}) != nil {
			return
		}
		close(registered)
		<-disconnect
	}))
	defer a.Close()
	r, done := testRuntime(t, func(http.ResponseWriter, *http.Request) {})
	defer done()
	r.cfg.SignalURL = strings.Replace(a.URL, "http://", "ws://", 1) + "/signal/instance"
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	i, secret, _, _ := r.store.Invite(time.Now())
	g, _, e := r.store.Consume(i.ID, secret, PublicHex(&key.PublicKey), time.Now())
	if e != nil {
		t.Fatal(e)
	}
	p := newPeer(r, nil, Ticket{SessionID: "live-peer"})
	p.mu.Lock()
	p.grant = g.ID
	p.hello = true
	p.authorized = true
	p.token = "jwt"
	p.authExpires = time.Now().Add(time.Minute).Unix()
	p.mu.Unlock()
	r.mu.Lock()
	r.peers[p.ticket.SessionID] = p
	r.mu.Unlock()
	result := make(chan error, 1)
	go func() { result <- r.register(context.Background()) }()
	select {
	case <-registered:
	case <-time.After(5 * time.Second):
		t.Fatal("register")
	}
	close(disconnect)
	select {
	case e := <-result:
		if e == nil {
			t.Fatal("disconnect missing")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("disconnect timeout")
	}
	r.mu.Lock()
	epoch := r.epoch
	r.mu.Unlock()
	if epoch != "" || p.ctx.Err() != nil {
		t.Fatal("signal lifetime coupled", epoch, p.ctx.Err())
	}
	if e = r.Revoke(g.ID); e != nil {
		t.Fatal(e)
	}
	if p.ctx.Err() == nil {
		t.Fatal("revoke")
	}
}

func TestLogicalSocketUpgradeAndEcho(t *testing.T) {
	var mu sync.Mutex
	upgraded := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/ws/narrator" || req.URL.Query().Get("token") != "jwt" || req.Header.Get("X-NarraFork-Bridge") != strings.Repeat("a", 32) {
			http.Error(w, "unauthorized", 401)
			return
		}
		c, e := websocket.Accept(w, req, nil)
		if e != nil {
			return
		}
		defer c.CloseNow()
		mu.Lock()
		upgraded = true
		mu.Unlock()
		kind, b, e := c.Read(req.Context())
		if e == nil {
			_ = c.Write(req.Context(), kind, b)
		}
		<-req.Context().Done()
	}))
	defer srv.Close()
	r, e := New(Config{SignalURL: "ws://127.0.0.1:1/signal/instance", BridgeURL: srv.URL, BridgeSecret: strings.Repeat("a", 32), StatePath: filepath.Join(t.TempDir(), "state.json"), AllowLocalhost: true}, func(any) {})
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := &Peer{r: r, ctx: ctx, cancel: cancel, authorized: true, hello: true, token: "jwt", sockets: map[uint32]*logicalSocket{}, usedIDs: map[uint32]bool{}, priority: make(chan outgoing, 32), bulk: make(chan outgoing, 32)}
	if e = p.openSocket(Control{StreamID: 1, Path: "/ws/narrator", Token: "jwt"}); e != nil {
		t.Fatal(e)
	}
	await := func(typ string) {
		t.Helper()
		select {
		case v := <-p.priority:
			var msg map[string]any
			json.Unmarshal(v.data, &msg)
			if msg["type"] != typ {
				t.Fatal(msg)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("socket timeout", typ)
		}
	}
	await("socket.ready")
	mu.Lock()
	ok := upgraded
	mu.Unlock()
	if !ok {
		t.Fatal("ready before upgrade")
	}
	p.mu.Lock()
	s := p.sockets[1]
	p.mu.Unlock()
	if e = s.enqueue(`{"type":"ping"}`); e != nil {
		t.Fatal(e)
	}
	await("socket.message")
	s.close()
	await("socket.close")
	p.mu.Lock()
	remaining := len(p.sockets)
	p.mu.Unlock()
	if remaining != 0 {
		t.Fatal("socket leaked")
	}
	p.queueMu.Lock()
	bytes := p.recvQueued
	p.queueMu.Unlock()
	if bytes != 0 {
		t.Fatal("socket queue bytes leaked", bytes)
	}
}
