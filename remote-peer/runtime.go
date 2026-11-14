package remotepeer

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/logging"
	"github.com/pion/webrtc/v4"
)

type Config struct {
	Mode                  string          `json:"mode"`
	IPCEpoch              string          `json:"-"`
	BackendIdentity       BackendIdentity `json:"backendIdentity"`
	RequestPolicy         []RequestRule   `json:"requestPolicy"`
	SignalURL             string          `json:"signalUrl"`
	SignalCAFile          string          `json:"signalCAFile,omitempty"`
	BridgeURL             string          `json:"bridgeUrl"`
	BridgeSecret          string          `json:"bridgeSecret"`
	StatePath             string          `json:"statePath"`
	STUNURLs              []string        `json:"stunUrls"`
	ICEIPAllowlist        []string        `json:"iceIPAllowlist,omitempty"`
	ICEInterfaceAllowlist []string        `json:"iceInterfaceAllowlist,omitempty"`
	ICENetworkTypes       []string        `json:"iceNetworkTypes,omitempty"`
	AllowLocalhost        bool            `json:"allowLocalhost"`
	LeaseSeconds          int             `json:"leaseSeconds"`
}

func (c Config) Validate() error {
	if c.Mode != "prototype" && c.Mode != "narrafork" {
		return errors.New("mode_required")
	}
	if c.Mode == "narrafork" {
		if !validIPCID(c.IPCEpoch) || !c.BackendIdentity.valid() {
			return errors.New("backend_identity")
		}
		if err := validatePolicy(c.RequestPolicy); err != nil {
			return err
		}
	}
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
	if !filepath.IsAbs(c.StatePath) || (c.Mode != "narrafork" && strings.Contains(filepath.Clean(c.StatePath), string(os.PathSeparator)+".narrafork"+string(os.PathSeparator))) {
		return errors.New("isolated_state_required")
	}
	if len(c.SignalCAFile) > 4096 || strings.ContainsAny(c.SignalCAFile, "\r\n\x00") {
		return errors.New("signal_ca_file")
	}
	if len(c.ICEIPAllowlist) > 64 || len(c.ICEInterfaceAllowlist) > 32 || len(c.ICENetworkTypes) > 2 {
		return errors.New("ice_config_limit")
	}
	for _, ip := range c.ICEIPAllowlist {
		addr, err := netip.ParseAddr(ip)
		if err != nil || addr.Zone() != "" || addr.Unmap().IsUnspecified() || addr.Unmap().IsMulticast() {
			return errors.New("ice_ip_allowlist")
		}
	}
	for _, name := range c.ICEInterfaceAllowlist {
		if name == "" || len(name) > 256 || strings.ContainsAny(name, "\r\n\x00") {
			return errors.New("ice_interface_allowlist")
		}
	}
	for _, network := range c.ICENetworkTypes {
		if network != "udp4" && network != "udp6" {
			return errors.New("ice_network_types")
		}
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

// signalTLSConfig extends system trust only for the signaling transport. Limit the
// read before parsing and reject partial/mixed PEM bundles rather than accepting
// the first usable certificate while silently ignoring malformed material.
func (c Config) signalTLSConfig() (*tls.Config, error) {
	config := &tls.Config{MinVersion: tls.VersionTLS12}
	if c.SignalCAFile == "" {
		return config, nil
	}
	f, err := os.Open(c.SignalCAFile)
	if err != nil {
		return nil, errors.New("signal_ca_file")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 65536 {
		return nil, errors.New("signal_ca_file")
	}
	data, err := io.ReadAll(io.LimitReader(f, 65537))
	if err != nil || len(data) > 65536 {
		return nil, errors.New("signal_ca_file")
	}
	rest := bytes.TrimSpace(data)
	if len(rest) == 0 {
		return nil, errors.New("signal_ca_pem")
	}
	for len(rest) > 0 {
		if !bytes.HasPrefix(rest, []byte("-----BEGIN CERTIFICATE-----")) {
			return nil, errors.New("signal_ca_pem")
		}
		endMarker := []byte("-----END CERTIFICATE-----")
		end := bytes.Index(rest, endMarker)
		if end < 0 {
			return nil, errors.New("signal_ca_pem")
		}
		end += len(endMarker)
		block, remaining := pem.Decode(rest[:end])
		if block == nil || len(bytes.TrimSpace(remaining)) != 0 || block.Type != "CERTIFICATE" || len(block.Headers) != 0 {
			return nil, errors.New("signal_ca_pem")
		}
		if _, err := x509.ParseCertificate(block.Bytes); err != nil {
			return nil, errors.New("signal_ca_pem")
		}
		rest = bytes.TrimSpace(rest[end:])
	}
	roots, err := x509.SystemCertPool()
	if err != nil || roots == nil {
		return nil, errors.New("signal_ca_system_roots")
	}
	if !roots.AppendCertsFromPEM(data) {
		return nil, errors.New("signal_ca_pem")
	}
	config.RootCAs = roots
	return config, nil
}

// Empty allowlists preserve Pion's defaults; non-empty lists are exact local
// interface/IP matches, not CIDRs or filters on server-reflexive public IPs.
func (c Config) iceSettingEngine() webrtc.SettingEngine {
	setting := webrtc.SettingEngine{}
	setting.LoggerFactory = &logging.DefaultLoggerFactory{Writer: io.Discard, DefaultLogLevel: logging.LogLevelDisabled}
	setting.SetSCTPMaxReceiveBufferSize(QueueBytes)
	setting.SetSCTPMaxMessageSize(FrameBytes)
	setting.SetIncludeLoopbackCandidate(c.AllowLocalhost)
	if len(c.ICEIPAllowlist) > 0 {
		ips := make(map[netip.Addr]bool, len(c.ICEIPAllowlist))
		for _, ip := range c.ICEIPAllowlist {
			addr, _ := netip.ParseAddr(ip) // Validate has already rejected invalid addresses.
			ips[addr.Unmap()] = true
		}
		setting.SetIPFilter(func(ip net.IP) bool {
			addr, ok := netip.AddrFromSlice(ip)
			return ok && ips[addr.Unmap()]
		})
	}
	if len(c.ICEInterfaceAllowlist) > 0 {
		names := make(map[string]bool, len(c.ICEInterfaceAllowlist))
		for _, name := range c.ICEInterfaceAllowlist {
			names[name] = true
		}
		setting.SetInterfaceFilter(func(name string) bool { return names[name] })
	}
	if len(c.ICENetworkTypes) > 0 {
		networks := make([]webrtc.NetworkType, 0, len(c.ICENetworkTypes))
		for _, network := range c.ICENetworkTypes {
			if network == "udp4" {
				networks = append(networks, webrtc.NetworkTypeUDP4)
			} else {
				networks = append(networks, webrtc.NetworkTypeUDP6)
			}
		}
		setting.SetNetworkTypes(networks)
	}
	return setting
}

type streamBudgets struct{ request, idle, stall, lifetime time.Duration }

var defaultStreamBudgets = streamBudgets{30 * time.Second, 60 * time.Second, 30 * time.Second, 2 * time.Hour}

type Runtime struct {
	budgets               streamBudgets
	policy                []*regexp.Regexp
	closeOnce             sync.Once
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
	client                *http.Client // Loopback bridge only; never given custom signaling trust.
	signalClient          *http.Client
}

func New(cfg Config, emit func(any)) (*Runtime, error) {
	if e := cfg.Validate(); e != nil {
		return nil, e
	}
	tlsConfig, e := cfg.signalTLSConfig()
	if e != nil {
		return nil, e
	}
	s, e := OpenRuntimeStore(cfg.StatePath, cfg.Mode == "narrafork")
	if e != nil {
		return nil, e
	}
	// Own the slices used asynchronously by peer negotiation.
	cfg.STUNURLs = append([]string(nil), cfg.STUNURLs...)
	cfg.ICEIPAllowlist = append([]string(nil), cfg.ICEIPAllowlist...)
	cfg.ICEInterfaceAllowlist = append([]string(nil), cfg.ICEInterfaceAllowlist...)
	cfg.ICENetworkTypes = append([]string(nil), cfg.ICENetworkTypes...)
	policy := make([]*regexp.Regexp, len(cfg.RequestPolicy))
	cfg.RequestPolicy = append([]RequestRule(nil), cfg.RequestPolicy...)
	for i, rule := range cfg.RequestPolicy {
		policy[i] = regexp.MustCompile(rule.Path)
		cfg.RequestPolicy[i].Methods = append([]string(nil), rule.Methods...)
	}
	cfg.BackendIdentity.Capabilities = append([]string(nil), cfg.BackendIdentity.Capabilities...)
	pub := PublicHex(&s.key.PublicKey)
	id, _ := InstanceID(pub)
	tr := &http.Transport{Proxy: nil, MaxConnsPerHost: 40, MaxIdleConnsPerHost: 8, ResponseHeaderTimeout: 30 * time.Second, DisableCompression: true, DialContext: (&net.Dialer{Timeout: 5 * time.Second}).DialContext}
	signalTransport := tr.Clone()
	signalTransport.TLSClientConfig = tlsConfig
	signalTransport.TLSHandshakeTimeout = 5 * time.Second
	noRedirect := func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Runtime{cfg: cfg, budgets: defaultStreamBudgets, policy: policy, store: s, id: id, public: pub, peers: map[string]*Peer{}, pending: map[string]string{}, seen: map[string]int64{}, emit: emit,
		client:       &http.Client{Transport: tr, CheckRedirect: noRedirect},
		signalClient: &http.Client{Transport: signalTransport, CheckRedirect: noRedirect}}, nil
}
func (r *Runtime) Ready() error {
	if r.cfg.Mode == "narrafork" {
		r.event("ready", map[string]any{"instanceId": r.id, "publicKey": r.public})
		return nil
	}
	i, secret, cap, e := r.store.Invite(time.Now())
	if e != nil {
		return e
	}
	r.emit(map[string]any{"type": "ready", "instanceId": r.id, "publicKey": r.public, "pairId": i.ID, "pairingSecret": secret, "discoveryCapability": cap, "expiresAt": i.ExpiresAt})
	return nil
}
func (r *Runtime) status(code string) { r.emit(map[string]any{"type": "status", "code": code}) }
func (r *Runtime) Close() {
	r.closeOnce.Do(func() {
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
		r.signalClient.CloseIdleConnections()
		_ = r.store.Close()
	})
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
	c, res, e := websocket.Dial(dctx, r.cfg.SignalURL, &websocket.DialOptions{HTTPClient: r.signalClient})
	dcancel()
	if e != nil {
		if res != nil && res.Body != nil {
			res.Body.Close()
		}
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

// validateOfferTicket performs only the bounded pre-authentication checks.
// The coordinator issues 60-second tickets; tolerate at most five seconds of
// future clock skew without accepting an already expired ticket. Signatures,
// target authorization and replay protection remain mandatory in offer.
func validateOfferTicket(s Signal, instanceID string, now time.Time) error {
	t := s.Ticket
	if ValidateSDP(s.Offer) != nil {
		return errors.New("ticket_sdp")
	}
	if Hash(s.Offer) != t.OfferHash {
		return errors.New("ticket_hash")
	}
	if t.InstanceID != instanceID {
		return errors.New("ticket_identity")
	}
	if t.ExpiresAt <= now.Unix() {
		return errors.New("ticket_expired")
	}
	if t.ExpiresAt > now.Add(65*time.Second).Unix() {
		return errors.New("ticket_future")
	}
	if len(t.SessionID) < 16 || len(t.SessionID) > 128 {
		return errors.New("ticket_session")
	}
	return nil
}

func (r *Runtime) offer(ctx context.Context, s Signal) error {
	t := s.Ticket
	now := time.Now()
	if err := validateOfferTicket(s, r.id, now); err != nil {
		return err
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
	api := webrtc.NewAPI(webrtc.WithSettingEngine(r.cfg.iceSettingEngine()))
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
