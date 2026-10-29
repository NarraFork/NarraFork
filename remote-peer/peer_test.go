package remotepeer

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestGolden(t *testing.T) {
	b, e := os.ReadFile("../shared/remote-access/vectors.json")
	if e != nil {
		t.Fatal(e)
	}
	var v struct {
		PublicKey, InstanceID, Label, TranscriptHex, Signature, HashInput, Hash, FrameHex string
		Fields                                                                            []string
		Frame                                                                             struct {
			Kind               byte
			StreamID, Sequence uint32
			PayloadHex         string
		}
	}
	if e = json.Unmarshal(b, &v); e != nil {
		t.Fatal(e)
	}
	id, e := InstanceID(v.PublicKey)
	if e != nil || id != v.InstanceID {
		t.Fatal("instanceId", id, e)
	}
	if hex.EncodeToString(Transcript(v.Label, v.Fields...)) != v.TranscriptHex {
		t.Fatal("transcript")
	}
	if !Verify(v.PublicKey, v.Signature, v.Label, v.Fields...) {
		t.Fatal("signature")
	}
	if Hash(v.HashInput) != v.Hash {
		t.Fatal("hash")
	}
	payload, _ := hex.DecodeString(v.Frame.PayloadHex)
	frame, e := EncodeFrame(Frame{Kind: v.Frame.Kind, StreamID: v.Frame.StreamID, Sequence: v.Frame.Sequence, Payload: payload})
	if e != nil || hex.EncodeToString(frame) != v.FrameHex {
		t.Fatal("frame", e)
	}
	if Verify(v.PublicKey, v.Signature, "hello", v.Fields...) {
		t.Fatal("domain not isolated")
	}
}
func TestFrameBounds(t *testing.T) {
	good, _ := EncodeFrame(Frame{Kind: 1, StreamID: 1, Payload: make([]byte, FrameBytes-HeaderBytes)})
	if _, e := DecodeFrame(good); e != nil {
		t.Fatal(e)
	}
	for _, pos := range []int{0, 4, 5, 6, 7, 16, 20, 23} {
		b := append([]byte{}, good...)
		b[pos] ^= 128
		if _, e := DecodeFrame(b); e == nil {
			t.Errorf("accepted mutation %d", pos)
		}
	}
	for _, b := range [][]byte{good[:23], append(good, 0)} {
		if _, e := DecodeFrame(b); e == nil {
			t.Fatal("size")
		}
	}
	if _, e := EncodeFrame(Frame{Kind: 2, StreamID: 1, Payload: []byte{1}}); e == nil {
		t.Fatal("end payload")
	}
}
func TestSDPDirectOnly(t *testing.T) {
	if ValidateSDP("v=0\r\na=candidate:1 1 UDP 1 127.0.0.1 1000 typ host\r\n") != nil {
		t.Fatal("host")
	}
	for _, s := range []string{"v=0\na=candidate:1 1 UDP 1 127.0.0.1 1000 typ relay", strings.Repeat("x", 65537), "v=0\n" + strings.Repeat("a=candidate:1 1 UDP 1 127.0.0.1 1000 typ host\n", 129)} {
		if ValidateSDP(s) == nil {
			t.Fatal("accepted invalid SDP")
		}
	}
}
func TestTargetsHeadersConfig(t *testing.T) {
	for _, p := range []string{"http://127.0.0.1:123/api/json", "//evil/api/json", "/api/../json", "/api/%2e%2e/json", "/api/unknown", "/api/json\r\nHost:x", "/api/auth/register"} {
		if ValidatePath(p) == nil {
			t.Errorf("accepted %q", p)
		}
	}
	h, e := filteredHeaders([][2]string{{"Host", "evil"}, {"X-NarraFork-Bridge", "evil"}, {"X-Forwarded-For", "evil"}, {"Proxy-Authorization", "evil"}, {"Authorization", "Bearer jwt"}})
	if e != nil || len(h) != 1 || h.Get("Authorization") != "Bearer jwt" {
		t.Fatal(h, e)
	}
	cfg := Config{SignalURL: "ws://127.0.0.1:123/signal/instance", BridgeURL: "http://127.0.0.1:234", BridgeSecret: strings.Repeat("a", 32), StatePath: filepath.Join(t.TempDir(), "state.json"), AllowLocalhost: true}
	if e = cfg.Validate(); e != nil {
		t.Fatal(e)
	}
	cfg.STUNURLs = []string{"turn:example:3478"}
	if cfg.Validate() == nil {
		t.Fatal("TURN")
	}
	cfg.STUNURLs = nil
	cfg.BridgeURL = "http://localhost:234"
	if cfg.Validate() == nil {
		t.Fatal("bridge DNS")
	}
}
func TestInviteAtomicReplay(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	s, e := OpenStore(path)
	if e != nil {
		t.Fatal(e)
	}
	i, secret, _, e := s.Invite(time.Now())
	if e != nil {
		t.Fatal(e)
	}
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	pub := PublicHex(&key.PublicKey)
	var wg sync.WaitGroup
	results := make(chan bool, 8)
	for n := 0; n < 8; n++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, _, e := s.Consume(i.ID, secret, pub, time.Now()); results <- e == nil }()
	}
	wg.Wait()
	close(results)
	success := 0
	for ok := range results {
		if ok {
			success++
		}
	}
	if success != 1 {
		t.Fatal("consume count", success)
	}
	st, e := os.Stat(path)
	if e != nil || st.Mode().Perm() != 0600 {
		t.Fatal("mode", e)
	}
	s2, e := OpenStore(path)
	if e != nil {
		t.Fatal(e)
	}
	if _, _, e = s2.Consume(i.ID, secret, pub, time.Now()); e == nil {
		t.Fatal("persisted replay")
	}
}
func TestCreditSequence(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := &httpStream{ctx: ctx, cancel: cancel, recvCredit: 4, sendCredit: WindowBytes, hasBody: true, limit: 8, chunks: make(chan []byte, 8), wake: make(chan struct{}, 1)}
	if e := s.receive(Frame{Kind: 1, StreamID: 1, Payload: []byte("1234")}); e != nil {
		t.Fatal(e)
	}
	if e := s.receive(Frame{Kind: 1, StreamID: 1, Sequence: 1, Payload: []byte("5")}); e == nil {
		t.Fatal("credit")
	}
	if e := s.update(1); e == nil {
		t.Fatal("overgrant")
	}
	s.recvSeq = 0
	if e := s.receive(Frame{Kind: 1, Sequence: 2, Payload: []byte("a")}); e == nil {
		t.Fatal("sequence")
	}
}
func testRuntime(t *testing.T, handler http.HandlerFunc) (*Runtime, func()) {
	t.Helper()
	server := httptest.NewServer(handler)
	r, e := New(Config{SignalURL: "ws://127.0.0.1:1/signal/instance", BridgeURL: server.URL, BridgeSecret: strings.Repeat("a", 32), StatePath: filepath.Join(t.TempDir(), "state.json"), AllowLocalhost: true}, func(any) {})
	if e != nil {
		t.Fatal(e)
	}
	return r, func() { r.Close(); server.Close() }
}
func TestAuthRoleExpiryAndRedirect(t *testing.T) {
	role := "user"
	r, done := testRuntime(t, func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path == "/api/auth/me" && req.Header.Get("X-NarraFork-Bridge") != strings.Repeat("a", 32) {
			t.Error("bridge secret")
		}
		if req.URL.Path == "/api/auth/me" {
			json.NewEncoder(w).Encode(map[string]any{"role": role, "expiresAt": time.Now().Add(time.Minute).Unix()})
		} else {
			http.Redirect(w, req, "http://127.0.0.1:1/secret", 302)
		}
	})
	defer done()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := &Peer{r: r, ctx: ctx}
	if _, e := p.checkAuth("jwt"); e == nil {
		t.Fatal("nonadmin accepted")
	}
	role = "admin"
	if _, e := p.checkAuth("jwt"); e != nil {
		t.Fatal(e)
	}
	res, e := r.client.Get(r.cfg.BridgeURL + "/api/json")
	if e != nil {
		t.Fatal(e)
	}
	res.Body.Close()
	if res.StatusCode != 302 {
		t.Fatal("followed redirect")
	}
}
func TestLeaseLossKeepsPeerRevokeCloses(t *testing.T) {
	r, done := testRuntime(t, func(http.ResponseWriter, *http.Request) {})
	defer done()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	i, secret, _, _ := r.store.Invite(time.Now())
	g, _, e := r.store.Consume(i.ID, secret, PublicHex(&key.PublicKey), time.Now())
	if e != nil {
		t.Fatal(e)
	}
	p := newPeer(r, nil, Ticket{SessionID: "test-lifetime"})
	p.mu.Lock()
	p.grant = g.ID
	p.hello = true
	p.authorized = true
	p.authExpires = time.Now().Add(time.Minute).Unix()
	p.mu.Unlock()
	r.mu.Lock()
	r.peers[p.ticket.SessionID] = p
	r.epoch = "lease"
	r.mu.Unlock()
	// This is deliberately the A-disconnect state transition, not a B authorization event.
	r.mu.Lock()
	r.epoch = ""
	r.mu.Unlock()
	if p.ctx.Err() != nil {
		t.Fatal("A loss closed peer")
	}
	if e = r.Revoke(g.ID); e != nil {
		t.Fatal(e)
	}
	if p.ctx.Err() == nil {
		t.Fatal("revocation did not close")
	}
}

// Real DTLS/SCTP loopback interop, not a mocked DataChannel. Browser/NAT validation is separate.
func TestPionHTTPStreaming(t *testing.T) {
	r, done := testRuntime(t, func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Authorization") != "Bearer jwt" {
			http.Error(w, "auth", 401)
			return
		}
		if req.URL.Path == "/api/auth/me" {
			json.NewEncoder(w).Encode(map[string]any{"role": "admin", "expiresAt": time.Now().Add(time.Minute).Unix()})
			return
		}
		if req.Method == "POST" {
			b, e := io.ReadAll(io.LimitReader(req.Body, 10000))
			if e != nil {
				t.Error(e)
			}
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Write(b)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte("data: 中文\n\n"))
		w.(http.Flusher).Flush()
	})
	defer done()
	setting := webrtc.SettingEngine{}
	setting.SetIncludeLoopbackCandidate(true)
	setting.SetInterfaceFilter(func(name string) bool { return name == "lo" })
	setting.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	api := webrtc.NewAPI(webrtc.WithSettingEngine(setting))
	client, e := api.NewPeerConnection(webrtc.Configuration{})
	if e != nil {
		t.Fatal(e)
	}
	defer client.Close()
	server, e := api.NewPeerConnection(webrtc.Configuration{})
	if e != nil {
		t.Fatal(e)
	}
	controls := make(chan map[string]any, 64)
	frames := make(chan Frame, 128)
	control, _ := client.CreateDataChannel("nf.control.v1", nil)
	_, _ = client.CreateDataChannel("nf.realtime.v1", nil)
	bulk, _ := client.CreateDataChannel("nf.bulk.v1", nil)
	control.OnMessage(func(m webrtc.DataChannelMessage) {
		var v map[string]any
		if json.Unmarshal(m.Data, &v) == nil {
			controls <- v
		}
	})
	bulk.OnMessage(func(m webrtc.DataChannelMessage) {
		f, e := DecodeFrame(m.Data)
		if e == nil {
			frames <- f
		}
	})
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	pub := PublicHex(&key.PublicKey)
	invite, secret, _, _ := r.store.Invite(time.Now())
	offer, _ := client.CreateOffer(nil)
	gather := webrtc.GatheringCompletePromise(client)
	if e = client.SetLocalDescription(offer); e != nil {
		t.Fatal(e)
	}
	select {
	case <-gather:
	case <-time.After(5 * time.Second):
		t.Fatal("gather")
	}
	sdp := client.LocalDescription().SDP
	ticket := Ticket{SessionID: "integration-test", ClientPublicKey: pub, TargetKind: "invite", TargetID: invite.ID, OfferHash: Hash(sdp)}
	p := newPeer(r, server, ticket)
	r.mu.Lock()
	r.peers[ticket.SessionID] = p
	r.mu.Unlock()
	server.OnDataChannel(p.attachChannel)
	if e = server.SetRemoteDescription(*client.LocalDescription()); e != nil {
		t.Fatal(e)
	}
	answer, _ := server.CreateAnswer(nil)
	gather = webrtc.GatheringCompletePromise(server)
	if e = server.SetLocalDescription(answer); e != nil {
		t.Fatal(e)
	}
	select {
	case <-gather:
	case <-time.After(5 * time.Second):
		t.Fatal("server gather")
	}
	answerSDP := server.LocalDescription().SDP
	p.mu.Lock()
	p.answerHash = Hash(answerSDP)
	p.mu.Unlock()
	if e = client.SetRemoteDescription(*server.LocalDescription()); e != nil {
		t.Fatal(e)
	}
	opened := make(chan struct{})
	control.OnOpen(func() { close(opened) })
	if control.ReadyState() == webrtc.DataChannelStateOpen {
		select {
		case <-opened:
		default:
			close(opened)
		}
	}
	select {
	case <-opened:
	case <-time.After(10 * time.Second):
		p.mu.Lock()
		labels := len(p.channels)
		p.mu.Unlock()
		t.Fatalf("DC open: client=%v server=%v clientICE=%v serverICE=%v ctx=%v channels=%d", client.ConnectionState(), server.ConnectionState(), client.ICEConnectionState(), server.ICEConnectionState(), p.ctx.Err(), labels)
	}
	send := func(v any) {
		t.Helper()
		b, _ := json.Marshal(v)
		if e := control.SendText(string(b)); e != nil {
			t.Fatal(e)
		}
	}
	await := func(typ string) map[string]any {
		t.Helper()
		deadline := time.NewTimer(5 * time.Second)
		defer deadline.Stop()
		for {
			select {
			case v := <-controls:
				if v["type"] == typ {
					return v
				}
				if v["type"] == "peer.error" || v["type"] == "stream.error" {
					t.Fatal(v)
				}
			case <-deadline.C:
				t.Fatalf("waiting %s", typ)
			}
		}
	}
	sig, _ := Sign(key, "hello", r.id, ticket.SessionID, ticket.OfferHash, Hash(answerSDP), "0123456789abcdef", pub)
	send(map[string]any{"type": "hello", "nonce": "0123456789abcdef", "signature": sig, "pairingSecret": secret})
	await("hello.ready")
	send(map[string]any{"type": "auth", "token": "jwt"})
	await("ready")
	send(map[string]any{"type": "request.open", "streamId": 1, "method": "GET", "path": "/api/sse", "headers": [][2]string{}, "hasBody": false})
	await("request.accept")
	await("response.open")
	var body bytes.Buffer
	for {
		select {
		case f := <-frames:
			if f.Kind == 2 {
				goto streamed
			}
			body.Write(f.Payload)
			send(map[string]any{"type": "window.update", "streamId": 1, "bytes": len(f.Payload)})
		case <-time.After(5 * time.Second):
			t.Fatal("response frame")
		}
	}
streamed:
	if body.String() != "data: 中文\n\n" {
		t.Fatal(body.String())
	}
	// A is absent throughout this request; only the B-local grant/JWT controls admission.
	r.mu.Lock()
	r.epoch = ""
	r.mu.Unlock()
	send(map[string]any{"type": "request.open", "streamId": 2, "method": "POST", "path": "/api/upload", "headers": [][2]string{{"Content-Type", "application/octet-stream"}}, "hasBody": true})
	await("request.accept")
	for seq, data := range [][]byte{[]byte("small upload"), nil} {
		kind := byte(1)
		if data == nil {
			kind = 2
		}
		b, _ := EncodeFrame(Frame{Kind: kind, StreamID: 2, Sequence: uint32(seq), Payload: data})
		if e = bulk.Send(b); e != nil {
			t.Fatal(e)
		}
	}
	await("response.open")
	body.Reset()
	for {
		select {
		case f := <-frames:
			if f.Kind == 2 {
				goto uploaded
			}
			body.Write(f.Payload)
			send(map[string]any{"type": "window.update", "streamId": 2, "bytes": len(f.Payload)})
		case <-time.After(5 * time.Second):
			t.Fatal("upload response")
		}
	}
uploaded:
	if body.String() != "small upload" {
		t.Fatal(body.String())
	}
	if e = r.Revoke(p.grantID()); e != nil {
		t.Fatal(e)
	}
	if p.ctx.Err() == nil {
		t.Fatal("revoke")
	}
}
