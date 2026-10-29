package remotepeer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/logging"
	"github.com/pion/webrtc/v4"
)

type Config struct {
	SignalURL      string   `json:"signalUrl"`
	BridgeURL      string   `json:"bridgeUrl"`
	BridgeSecret   string   `json:"bridgeSecret"`
	StatePath      string   `json:"statePath"`
	STUNURLs       []string `json:"stunUrls"`
	AllowLocalhost bool     `json:"allowLocalhost"`
	LeaseSeconds   int      `json:"leaseSeconds"`
}

func (c Config) Validate() error {
	u, e := url.Parse(c.BridgeURL)
	if e != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || len(c.BridgeSecret) < 32 {
		return errors.New("bridge_config")
	}
	if _, e := net.LookupPort("tcp", u.Port()); e != nil {
		return errors.New("bridge_port")
	}
	u, e = url.Parse(c.SignalURL)
	if e != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "/signal/instance" || u.Host == "" {
		return errors.New("signal_config")
	}
	if u.Scheme != "wss" && !(c.AllowLocalhost && u.Scheme == "ws" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost")) {
		return errors.New("signal_tls")
	}
	if !filepath.IsAbs(c.StatePath) || strings.Contains(filepath.Clean(c.StatePath), string(os.PathSeparator)+".narrafork"+string(os.PathSeparator)) {
		return errors.New("isolated_state_required")
	}
	if len(c.STUNURLs) > 4 {
		return errors.New("stun_limit")
	}
	for _, s := range c.STUNURLs {
		if (!strings.HasPrefix(s, "stun:") && !strings.HasPrefix(s, "stuns:")) || strings.ContainsAny(s, "\r\n@") {
			return errors.New("turn_forbidden")
		}
	}
	return nil
}

type Runtime struct {
	cfg                   Config
	store                 *Store
	id, public            string
	mu                    sync.Mutex
	peers                 map[string]*Peer
	pending               map[string]string
	seen                  map[string]int64
	signal                *websocket.Conn
	epoch, coordinatorKey string
	signalMu              sync.Mutex
	emit                  func(any)
	client                *http.Client
}

func New(cfg Config, emit func(any)) (*Runtime, error) {
	if e := cfg.Validate(); e != nil {
		return nil, e
	}
	s, e := OpenStore(cfg.StatePath)
	if e != nil {
		return nil, e
	}
	pub := PublicHex(&s.key.PublicKey)
	id, _ := InstanceID(pub)
	tr := &http.Transport{Proxy: nil, MaxConnsPerHost: 40, MaxIdleConnsPerHost: 8, ResponseHeaderTimeout: 15 * time.Second, DisableCompression: true, DialContext: (&net.Dialer{Timeout: 5 * time.Second}).DialContext}
	return &Runtime{cfg: cfg, store: s, id: id, public: pub, peers: map[string]*Peer{}, pending: map[string]string{}, seen: map[string]int64{}, emit: emit, client: &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func (r *Runtime) Ready() error {
	i, secret, cap, e := r.store.Invite(time.Now())
	if e != nil {
		return e
	}
	r.emit(map[string]any{"type": "ready", "instanceId": r.id, "publicKey": r.public, "pairId": i.ID, "pairingSecret": secret, "discoveryCapability": cap, "expiresAt": i.ExpiresAt})
	return nil
}
func (r *Runtime) status(code string) { r.emit(map[string]any{"type": "status", "code": code}) }
func (r *Runtime) Close() {
	r.mu.Lock()
	ps := make([]*Peer, 0, len(r.peers))
	for _, p := range r.peers {
		ps = append(ps, p)
	}
	r.mu.Unlock()
	for _, p := range ps {
		p.Close()
	}
	r.signalMu.Lock()
	if r.signal != nil {
		r.signal.CloseNow()
	}
	r.signalMu.Unlock()
	r.client.CloseIdleConnections()
}
func (r *Runtime) Revoke(id string) error {
	if e := r.store.Revoke(id); e != nil {
		return e
	}
	r.mu.Lock()
	ps := []*Peer{}
	for _, p := range r.peers {
		if id == "all" || p.grantID() == id {
			ps = append(ps, p)
		}
	}
	r.mu.Unlock()
	for _, p := range ps {
		p.Close()
	}
	r.discoveries()
	return nil
}

// InvalidateSession is a private supervisor event, not a grant/discovery revocation.
// Cancel while holding each peer's token lock so concurrent authentication cannot
// switch sessions between matching the token and stopping the peer.
func (r *Runtime) InvalidateSession(token string) error {
	if token == "" || len(token) > 8192 || strings.ContainsAny(token, "\r\n\x00") {
		return errors.New("session_token")
	}
	r.mu.Lock()
	ps := []*Peer{}
	for _, p := range r.peers {
		p.mu.Lock()
		if p.token == token {
			p.cancel()
			ps = append(ps, p)
		}
		p.mu.Unlock()
	}
	r.mu.Unlock()
	for _, p := range ps {
		p.Close()
	}
	return nil
}

func (r *Runtime) signalSend(v any) error {
	r.signalMu.Lock()
	defer r.signalMu.Unlock()
	if r.signal == nil {
		return errors.New("signal_offline")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return wsJSON(ctx, r.signal, v)
}
func wsJSON(ctx context.Context, c *websocket.Conn, v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	if len(b) > 98304 {
		return errors.New("signal_size")
	}
	return c.Write(ctx, websocket.MessageText, b)
}
func (r *Runtime) discoveries() {
	_ = r.signalSend(map[string]any{"type": "discoveries", "discoveries": r.store.Discoveries()})
}
func (r *Runtime) Run(ctx context.Context) {
	defer r.Close()
	backoff := time.Second
	for ctx.Err() == nil {
		started := time.Now()
		e := r.register(ctx)
		if ctx.Err() != nil {
			return
		}
		_ = e
		r.status("signal_offline")
		if time.Since(started) > 30*time.Second {
			backoff = time.Second
		}
		d := backoff + time.Duration(rand.Int64N(int64(backoff/2)+1))
		timer := time.NewTimer(d)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		if backoff < 30*time.Second {
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
	}
}
func (r *Runtime) register(ctx context.Context) error {
	dctx, dcancel := context.WithTimeout(ctx, 5*time.Second)
	c, _, e := websocket.Dial(dctx, r.cfg.SignalURL, nil)
	dcancel()
	if e != nil {
		return e
	}
	c.SetReadLimit(98304)
	defer c.CloseNow()
	firstCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	_, b, e := c.Read(firstCtx)
	cancel()
	if e != nil {
		return e
	}
	var s Signal
	if e = json.Unmarshal(b, &s); e != nil || s.Type != "challenge" || len(s.Challenge) > 256 {
		return errors.New("challenge")
	}
	if _, e = ParsePublic(s.CoordinatorPublicKey); e != nil {
		return e
	}
	sig, _ := Sign(r.store.key, "register", s.Challenge, r.public)
	wctx, wcancel := context.WithTimeout(ctx, 5*time.Second)
	e = wsJSON(wctx, c, map[string]any{"type": "register", "publicKey": r.public, "signature": sig, "discoveries": r.store.Discoveries()})
	wcancel()
	if e != nil {
		return e
	}
	firstCtx, cancel = context.WithTimeout(ctx, 5*time.Second)
	_, b, e = c.Read(firstCtx)
	cancel()
	if e != nil {
		return e
	}
	var reg Signal
	if json.Unmarshal(b, &reg) != nil || reg.Type != "registered" || reg.InstanceID != r.id || reg.LeaseEpoch == "" {
		return errors.New("registered")
	}
	r.signalMu.Lock()
	r.signal = c
	r.signalMu.Unlock()
	r.mu.Lock()
	r.epoch = reg.LeaseEpoch
	r.coordinatorKey = s.CoordinatorPublicKey
	r.mu.Unlock()
	r.status("registered")
	defer func() {
		r.signalMu.Lock()
		if r.signal == c {
			r.signal = nil
		}
		r.signalMu.Unlock()
		r.mu.Lock()
		if r.epoch == reg.LeaseEpoch {
			r.epoch = ""
		}
		r.mu.Unlock()
	}()
	hbCtx, hbCancel := context.WithCancel(ctx)
	defer hbCancel()
	interval := 25 * time.Second
	if r.cfg.LeaseSeconds > 0 {
		interval = time.Duration(r.cfg.LeaseSeconds) * time.Second / 3
		if interval < time.Second {
			interval = time.Second
		}
	}
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-hbCtx.Done():
				return
			case <-t.C:
				if r.signalSend(map[string]any{"type": "ping"}) != nil {
					c.CloseNow()
					return
				}
			}
		}
	}()
	for {
		readCtx, readCancel := context.WithTimeout(ctx, interval*3)
		_, b, e = c.Read(readCtx)
		readCancel()
		if e != nil {
			return e
		}
		if json.Unmarshal(b, &s) != nil {
			return errors.New("signal_json")
		}
		switch s.Type {
		case "pong":
		case "offer":
			if e = r.offer(ctx, s); e != nil {
				r.emit(map[string]any{"type": "error", "code": safeErrorCode(e)})
				_ = r.signalSend(map[string]any{"type": "error", "code": safeErrorCode(e), "sessionId": s.Ticket.SessionID})
			}
		case "cancel":
			r.mu.Lock()
			p := r.peers[s.SessionID]
			r.mu.Unlock()
			if p != nil && !p.isAuthorized() {
				p.Close()
			}
		case "error":
			r.status("signal_error")
		default:
			return errors.New("signal_type")
		}
	}
}
func (r *Runtime) offer(ctx context.Context, s Signal) error {
	t := s.Ticket
	now := time.Now()
	if ValidateSDP(s.Offer) != nil || Hash(s.Offer) != t.OfferHash || t.InstanceID != r.id || t.ExpiresAt <= now.Unix() || t.ExpiresAt > now.Add(60*time.Second).Unix() || len(t.SessionID) < 16 || len(t.SessionID) > 128 {
		return errors.New("ticket")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if t.LeaseEpoch != r.epoch || r.epoch == "" || !Verify(r.coordinatorKey, t.Signature, "ticket", t.fields()...) || !Verify(t.ClientPublicKey, s.OfferSignature, "offer", r.id, t.TargetID, t.ClientPublicKey, t.OfferHash) || !r.store.Target(t.TargetKind, t.TargetID, t.ClientPublicKey, now) {
		return errors.New("offer_auth")
	}
	for id, expiry := range r.seen {
		if expiry <= now.Unix() {
			delete(r.seen, id)
		}
	}
	if len(r.seen) >= 1024 || r.seen[t.SessionID] != 0 || r.peers[t.SessionID] != nil || len(r.peers) >= 4 || (t.TargetKind == "invite" && r.pending[t.TargetID] != "") {
		return errors.New("peer_limit")
	}
	setting := webrtc.SettingEngine{}
	setting.LoggerFactory = &logging.DefaultLoggerFactory{Writer: io.Discard, DefaultLogLevel: logging.LogLevelDisabled}
	setting.SetSCTPMaxReceiveBufferSize(QueueBytes)
	setting.SetSCTPMaxMessageSize(FrameBytes)
	setting.SetIncludeLoopbackCandidate(r.cfg.AllowLocalhost)
	api := webrtc.NewAPI(webrtc.WithSettingEngine(setting))
	servers := []webrtc.ICEServer{}
	if len(r.cfg.STUNURLs) > 0 {
		servers = append(servers, webrtc.ICEServer{URLs: r.cfg.STUNURLs})
	}
	pc, e := api.NewPeerConnection(webrtc.Configuration{ICEServers: servers})
	if e != nil {
		return e
	}
	p := newPeer(r, pc, t)
	r.peers[t.SessionID] = p
	r.seen[t.SessionID] = t.ExpiresAt
	if t.TargetKind == "invite" {
		r.pending[t.TargetID] = t.SessionID
	}
	// Negotiation is bounded separately; never hold a coordinator lease as a peer lifetime.
	go func() {
		if e := p.negotiate(ctx, s.Offer); e != nil {
			p.Close()
			r.emit(map[string]any{"type": "error", "code": safeErrorCode(e)})
		}
	}()
	return nil
}
func (p *Peer) negotiate(ctx context.Context, offer string) error {
	p.pc.OnDataChannel(p.attachChannel)
	p.pc.SCTP().Transport().ICETransport().OnSelectedCandidatePairChange(func(pair *webrtc.ICECandidatePair) {
		if pair.Local.Typ == webrtc.ICECandidateTypeRelay || pair.Remote.Typ == webrtc.ICECandidateTypeRelay {
			p.cancel()
			return
		}
		p.r.emit(map[string]any{"type": "status", "code": "selected_pair", "localType": pair.Local.Typ.String(), "remoteType": pair.Remote.Typ.String()})
	})
	p.pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		if s == webrtc.PeerConnectionStateFailed || s == webrtc.PeerConnectionStateClosed {
			p.cancel()
		}
	})
	if e := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer}); e != nil {
		return e
	}
	answer, e := p.pc.CreateAnswer(nil)
	if e != nil {
		return e
	}
	done := webrtc.GatheringCompletePromise(p.pc)
	if e = p.pc.SetLocalDescription(answer); e != nil {
		return e
	}
	timer := time.NewTimer(20 * time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-p.ctx.Done():
		return p.ctx.Err()
	case <-timer.C:
		return errors.New("gather_timeout")
	case <-done:
	}
	sdp := p.pc.LocalDescription().SDP
	if e = ValidateSDP(sdp); e != nil {
		return e
	}
	p.mu.Lock()
	p.answerHash = Hash(sdp)
	p.mu.Unlock()
	sig, _ := Sign(p.r.store.key, "answer", p.r.id, p.ticket.SessionID, p.ticket.ClientPublicKey, p.ticket.OfferHash, Hash(sdp))
	if e = p.r.signalSend(map[string]any{"type": "answer", "sessionId": p.ticket.SessionID, "answer": sdp, "signature": sig}); e != nil {
		return e
	}
	return nil
}
func (r *Runtime) String() string { return fmt.Sprintf("remote-peer %s", r.id) }
