package remotepeer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

var headerName = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")

func forbiddenHeader(name string) bool {
	name = strings.ToLower(name)
	switch name {
	case "host", "connection", "keep-alive", "upgrade", "transfer-encoding", "te", "trailer", "cookie", "set-cookie", "forwarded":
		return true
	}
	return strings.HasPrefix(name, "proxy-") || strings.HasPrefix(name, "x-forwarded-") || name == "x-narrafork-bridge" || strings.HasPrefix(name, "x-narrafork-remote-")
}
func filteredHeaders(pairs [][2]string) (http.Header, error) {
	out := http.Header{}
	total := 0
	for _, p := range pairs {
		total += len(p[0]) + len(p[1])
		if total > 8192 || strings.ContainsAny(p[0]+p[1], "\r\n\x00") {
			return nil, errors.New("headers")
		}
		name := http.CanonicalHeaderKey(p[0])
		if !headerName.MatchString(name) || forbiddenHeader(name) || strings.EqualFold(name, "Content-Length") || strings.EqualFold(name, "Origin") || strings.EqualFold(name, "Referer") || strings.HasPrefix(strings.ToLower(name), "x-narrafork-") {
			return nil, errors.New("headers")
		}
		out.Add(name, p[1])
	}
	return out, nil
}
func responseHeaders(h http.Header, mode string) [][2]string {
	out := [][2]string{}
	n := 0
	for name, vs := range h {
		lower := strings.ToLower(name)
		// The isolated prototype historically demonstrates renewal headers and manual
		// redirects. These exact compatibility headers must never enter production.
		prototypeHeader := mode == "prototype" && (lower == "location" || lower == "x-session-token" || lower == "x-narrafork-token" || lower == "x-narrafork-session-token")
		sensitive := lower == "authorization" || lower == "location" || strings.Contains(lower, "token") || strings.Contains(lower, "secret")
		if headerName.MatchString(name) && !forbiddenHeader(name) && (!sensitive || prototypeHeader) {
			for _, v := range vs {
				n += len(name) + len(v)
				if n <= 8192 {
					out = append(out, [2]string{name, v})
				}
			}
		}
	}
	return out
}
func (p *Peer) checkAuth(token string) (int64, error) {
	if token == "" || len(token) > 8192 || strings.ContainsAny(token, "\r\n\x00") {
		return 0, errors.New("auth")
	}
	ctx, cancel := context.WithTimeout(p.ctx, 15*time.Second)
	defer cancel()
	method, path := http.MethodGet, "/api/auth/me"
	var body io.Reader
	if p.r.cfg.Mode == "narrafork" {
		method = http.MethodPost
		path = "/_nf/remote/session/introspect"
		data, _ := json.Marshal(map[string]string{"token": token})
		body = bytes.NewReader(data)
	}
	req, e := http.NewRequestWithContext(ctx, method, strings.TrimRight(p.r.cfg.BridgeURL, "/")+path, body)
	if e != nil {
		return 0, e
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	if err := p.bridgeHeaders(req.Header); err != nil {
		return 0, err
	}
	res, e := p.r.client.Do(req)
	if e != nil {
		return 0, e
	}
	defer res.Body.Close()
	if res.StatusCode >= 500 {
		return 0, errors.New("auth_unavailable")
	}
	if res.StatusCode != 200 {
		return 0, errors.New("auth_status")
	}
	var a SessionProjection
	b, e := io.ReadAll(io.LimitReader(res.Body, 8193))
	if e != nil || len(b) > 8192 || json.Unmarshal(b, &a) != nil || a.Role != "admin" || a.ExpiresAt <= time.Now().Unix() {
		return 0, errors.New("auth_role")
	}
	if p.r.cfg.Mode == "narrafork" {
		if err := p.updateSession(a); err != nil {
			return 0, err
		}
		p.mu.Lock()
		expiry := p.authExpires
		p.mu.Unlock()
		return expiry, nil
	}
	return a.ExpiresAt, nil
}

type httpStream struct {
	p                      *Peer
	id                     uint32
	ctx                    context.Context
	cancel                 context.CancelFunc
	mu                     sync.Mutex
	recvSeq, sendSeq       uint32
	recvCredit, sendCredit int64
	received               int64
	queued                 int
	limit                  int64
	responseLimit          int64
	profile                string
	hasBody, ended         bool
	chunks                 chan []byte
	wake                   chan struct{}
	current                []byte
}

func (s *httpStream) receive(f Frame) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.hasBody || s.ended || f.Sequence != s.recvSeq || s.recvSeq == ^uint32(0) {
		return errors.New("sequence")
	}
	s.recvSeq++
	if f.Kind == 2 {
		s.ended = true
		if s.ctx.Err() != nil {
			return nil
		}
		select {
		case s.chunks <- nil:
			return nil
		default:
			return errors.New("receive_queue")
		}
	}
	n := int64(len(f.Payload))
	if n > s.recvCredit || s.received+n > s.limit {
		return errors.New("credit_or_size")
	}
	if n == 0 {
		return nil
	}
	if s.ctx.Err() != nil {
		s.recvCredit -= n
		s.received += n
		return nil
	}
	if s.p != nil && !s.p.reserveReceive(int(n)) {
		return errors.New("receive_queue")
	}
	s.queued += int(n)
	s.recvCredit -= n
	s.received += n
	select {
	case s.chunks <- append([]byte(nil), f.Payload...):
		return nil
	default:
		return errors.New("receive_queue")
	}
}
func (s *httpStream) Read(b []byte) (int, error) {
	if len(b) == 0 {
		return 0, nil
	}
	s.mu.Lock()
	if len(s.current) == 0 {
		s.mu.Unlock()
		var chunk []byte
		select {
		case <-s.ctx.Done():
			return 0, s.ctx.Err()
		case chunk = <-s.chunks:
			if chunk == nil {
				return 0, io.EOF
			}
		}
		s.mu.Lock()
		if s.ctx.Err() != nil {
			s.mu.Unlock()
			return 0, s.ctx.Err()
		}
		s.current = chunk
	}
	n := copy(b, s.current)
	s.current = s.current[n:]
	s.recvCredit += int64(n)
	if s.queued >= n {
		s.queued -= n
		if s.p != nil {
			s.p.releaseReceive(n)
		}
	}
	s.mu.Unlock()
	if e := s.p.control(map[string]any{"type": "window.update", "streamId": s.id, "bytes": n}); e != nil {
		return n, e
	}
	return n, nil
}
func (s *httpStream) Close() error { s.cancel(); return nil }
func (s *httpStream) update(n int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if n <= 0 || s.sendCredit+n > WindowBytes {
		return errors.New("credit")
	}
	s.sendCredit += n
	select {
	case s.wake <- struct{}{}:
	default:
	}
	return nil
}
func (s *httpStream) waitCredit() (int, error) {
	stall := 30 * time.Second
	if s.p != nil {
		stall = s.p.r.budgets.stall
	}
	timer := time.NewTimer(stall)
	defer timer.Stop()
	for {
		s.mu.Lock()
		credit := s.sendCredit
		s.mu.Unlock()
		if credit > 0 {
			if credit > FrameBytes-HeaderBytes {
				credit = FrameBytes - HeaderBytes
			}
			return int(credit), nil
		}
		select {
		case <-s.ctx.Done():
			return 0, s.ctx.Err()
		case <-timer.C:
			return 0, errors.New("credit_timeout")
		case <-s.wake:
		}
	}
}
func (s *httpStream) sendFrame(kind byte, b []byte) error {
	s.mu.Lock()
	if int64(len(b)) > s.sendCredit || s.sendSeq == ^uint32(0) {
		s.mu.Unlock()
		return errors.New("send_credit")
	}
	f := Frame{Kind: kind, StreamID: s.id, Sequence: s.sendSeq, Payload: b}
	s.sendSeq++
	s.sendCredit -= int64(len(b))
	s.mu.Unlock()
	data, e := EncodeFrame(f)
	if e != nil {
		return e
	}
	return s.p.queue(outgoing{channel: "nf.bulk.v2", data: data, binary: true})
}
func (p *Peer) openRequest(c Control) error {
	if !strings.HasPrefix(c.Path, "/api/") {
		return errors.New("path")
	}
	rule := RequestRule{Profile: "request", RequestBytes: FileBytes, ResponseBytes: FileBytes}
	if p.r.cfg.Mode == "narrafork" {
		var err error
		rule, err = p.r.requestRule(c.Method, c.Path, p.isAuthorized())
		if err != nil {
			return err
		}
	} else {
		if e := ValidatePath(c.Path); e != nil {
			return e
		}
		if c.Path == "/api/events" || c.Path == "/api/sse" {
			rule.Profile = "sse"
			rule.ResponseBytes = 64 * 1024 * 1024
		}
	}
	switch c.Method {
	case "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD":
	default:
		return errors.New("method")
	}
	if (c.Method == "GET" || c.Method == "HEAD") && c.HasBody {
		return errors.New("body_method")
	}
	p.mu.Lock()
	hello, token, grant := p.hello && (p.r.cfg.Mode != "narrafork" || p.accepted), p.token, p.grant
	p.mu.Unlock()
	if _, ok := p.r.store.GetGrant(grant); !ok {
		return errors.New("grant")
	}
	auth := p.isAuthorized()
	parsed, _ := url.ParseRequestURI(c.Path)
	login := parsed.Path == "/api/auth/login" || parsed.Path == "/api/auth/mfa/verify"
	if !auth && (!hello || !login || c.Method != "POST") {
		return errors.New("unauthorized_path")
	}
	if parsed.Path == "/api/auth/me" && !auth {
		return errors.New("private_auth")
	}
	headers, e := filteredHeaders(c.Headers)
	if e != nil {
		return e
	}
	if auth {
		if v := headers.Get("Authorization"); v != "" && v != "Bearer "+token {
			return errors.New("auth_mismatch")
		}
		headers.Set("Authorization", "Bearer "+token)
	}
	limit := int64(JSONBytes)
	if !strings.Contains(strings.ToLower(headers.Get("Content-Type")), "json") && !login {
		limit = FileBytes
	}
	if rule.RequestBytes < limit {
		limit = rule.RequestBytes
	}
	lifetime := p.r.budgets.request
	if rule.Profile == "sse" {
		lifetime = p.r.budgets.lifetime
	}
	ctx, cancel := context.WithTimeout(p.ctx, lifetime)
	s := &httpStream{p: p, profile: rule.Profile, responseLimit: rule.ResponseBytes, id: c.StreamID, ctx: ctx, cancel: cancel, recvCredit: WindowBytes, sendCredit: WindowBytes, limit: limit, hasBody: c.HasBody, chunks: make(chan []byte, 128), wake: make(chan struct{}, 1)}
	p.mu.Lock()
	if c.StreamID == 0 || p.usedIDs[c.StreamID] || len(p.streams) >= 32 || len(p.usedIDs) >= 4096 {
		p.mu.Unlock()
		cancel()
		return errors.New("stream_limit")
	}
	p.usedIDs[c.StreamID] = true
	p.streams[c.StreamID] = s
	p.mu.Unlock()
	if e = p.control(map[string]any{"type": "request.accept", "streamId": s.id, "profile": s.profile}); e != nil {
		cancel()
		return e
	}
	go s.proxy(c, headers)
	return nil
}
func (s *httpStream) proxy(c Control, headers http.Header) {
	defer func() {
		s.cancel()
		s.mu.Lock()
		s.p.releaseReceive(s.queued)
		s.queued = 0
		s.current = nil
	drain:
		for {
			select {
			case <-s.chunks:
			default:
				break drain
			}
		}
		s.mu.Unlock()
		s.p.mu.Lock()
		s.p.retired[s.id] = s
		delete(s.p.streams, s.id)
		s.p.mu.Unlock()
	}()
	fail := func() {
		_ = s.p.control(map[string]any{"type": "stream.error", "streamId": s.id, "code": "upstream_failed"})
	}
	var body io.Reader
	if c.HasBody {
		body = struct{ io.Reader }{s}
	}
	req, e := http.NewRequestWithContext(s.ctx, c.Method, strings.TrimRight(s.p.r.cfg.BridgeURL, "/")+c.Path, body)
	if e != nil {
		fail()
		return
	}
	req.Header = headers
	if s.p.bridgeHeaders(req.Header) != nil {
		fail()
		return
	}
	res, e := s.p.r.client.Do(req)
	if e != nil {
		fail()
		return
	}
	defer res.Body.Close()
	if s.p.r.cfg.Mode == "narrafork" && res.StatusCode >= 300 && res.StatusCode < 400 && res.StatusCode != 304 {
		fail()
		return
	}
	if e = s.p.control(map[string]any{"type": "response.open", "streamId": s.id, "status": res.StatusCode, "headers": responseHeaders(res.Header, s.p.r.cfg.Mode)}); e != nil {
		return
	}
	if c.Method == "HEAD" || res.StatusCode == 204 || res.StatusCode == 304 {
		if e = s.sendFrame(2, nil); e != nil {
			fail()
		}
		return
	}
	limit := int64(FileBytes)
	if strings.Contains(strings.ToLower(res.Header.Get("Content-Type")), "json") {
		limit = JSONBytes
	}
	if s.profile == "sse" {
		limit = 64 * 1024 * 1024
	}
	if s.profile != "" && s.responseLimit < limit {
		limit = s.responseLimit
	}
	var count int64
	for {
		max, e := s.waitCredit()
		if e != nil {
			fail()
			return
		}
		b := make([]byte, max)
		var idle *time.Timer
		if s.profile == "sse" {
			idle = time.AfterFunc(s.p.r.budgets.idle, s.cancel)
		}
		n, readErr := res.Body.Read(b)
		if idle != nil {
			idle.Stop()
		}
		if n > 0 {
			count += int64(n)
			if count > limit {
				fail()
				return
			}
			if e = s.sendFrame(1, b[:n]); e != nil {
				fail()
				return
			}
		}
		if readErr == io.EOF {
			if e = s.sendFrame(2, nil); e != nil {
				fail()
			}
			return
		}
		if readErr != nil {
			fail()
			return
		}
	}
}

type logicalSocket struct {
	p                          *Peer
	id                         uint32
	ctx                        context.Context
	cancel                     context.CancelFunc
	conn                       *websocket.Conn
	send                       chan socketMessage
	assembly                   *socketAssembly
	recvMessage, sendMessageID uint32
	sendCredit                 int64
	wake                       chan struct{}
	closeCode                  int
	closeReason                string
	once                       sync.Once
	mu                         sync.Mutex
	queued                     int
}

func (s *logicalSocket) enqueue(text string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ctx.Err() != nil {
		return nil
	}
	if !s.p.reserveReceive(len(text)) {
		return errors.New("socket_queue")
	}
	s.queued += len(text)
	select {
	case s.send <- socketMessage{kind: websocket.MessageText, data: []byte(text)}:
		return nil
	default:
		s.queued -= len(text)
		s.p.releaseReceive(len(text))
		return errors.New("socket_queue")
	}
}
func (s *logicalSocket) consumed(n int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.queued >= n {
		s.queued -= n
		s.p.releaseReceive(n)
	}
}
func (s *logicalSocket) close() {
	s.once.Do(func() {
		s.cancel()
		s.mu.Lock()
		conn := s.conn
		if s.assembly != nil {
			s.assembly.timer.Stop()
			s.assembly = nil
		}
		s.p.releaseReceive(s.queued)
		s.queued = 0
		s.mu.Unlock()
		if conn != nil {
			conn.CloseNow()
		}
	})
}
func (p *Peer) openSocket(c Control) error {
	if p.r.cfg.Mode == "narrafork" {
		if _, err := p.r.requestRule("GET", c.Path, p.isAuthorized()); err != nil {
			return err
		}
	}
	if c.Path != "/ws/narrator" || len(c.Token) > 8192 {
		return errors.New("socket_path")
	}
	p.mu.Lock()
	token := p.token
	p.mu.Unlock()
	if c.Token != token {
		return errors.New("socket_auth")
	}
	ctx, cancel := context.WithCancel(p.ctx)
	s := &logicalSocket{p: p, id: c.StreamID, ctx: ctx, cancel: cancel, send: make(chan socketMessage, 32), sendCredit: WindowBytes, wake: make(chan struct{}, 1), closeCode: 1006}
	p.mu.Lock()
	if c.StreamID == 0 || p.usedIDs[c.StreamID] || len(p.sockets) >= 8 || len(p.usedIDs) >= 4096 {
		p.mu.Unlock()
		cancel()
		return errors.New("socket_limit")
	}
	p.usedIDs[c.StreamID] = true
	p.sockets[c.StreamID] = s
	p.mu.Unlock()
	go s.proxy(token)
	return nil
}
func (s *logicalSocket) proxy(token string) {
	defer func() {
		s.close()
		s.p.mu.Lock()
		delete(s.p.sockets, s.id)
		s.p.mu.Unlock()
		s.mu.Lock()
		code, reason := s.closeCode, s.closeReason
		s.mu.Unlock()
		_ = s.p.realtime(map[string]any{"type": "socket.close", "streamId": s.id, "code": code, "reason": reason})
	}()
	target := strings.Replace(strings.TrimRight(s.p.r.cfg.BridgeURL, "/"), "http://", "ws://", 1) + "/ws/narrator?token=" + url.QueryEscape(token)
	ctx, cancel := context.WithTimeout(s.ctx, 15*time.Second)
	headers := http.Header{}
	if s.p.bridgeHeaders(headers) != nil {
		cancel()
		return
	}
	c, res, e := websocket.Dial(ctx, target, &websocket.DialOptions{HTTPClient: s.p.r.client, HTTPHeader: headers})
	cancel()
	if e != nil {
		s.mu.Lock()
		s.closeReason = "upstream_upgrade_failed"
		if res != nil {
			s.closeReason = "upstream_upgrade_" + strconv.Itoa(res.StatusCode)
		}
		s.mu.Unlock()
		if res != nil && res.Body != nil {
			res.Body.Close()
		}
		return
	}
	s.mu.Lock()
	s.conn = c
	s.mu.Unlock()
	c.SetReadLimit(SocketMessageBytes)
	if s.ctx.Err() != nil {
		c.CloseNow()
		return
	}
	if e = s.p.realtime(map[string]any{"type": "socket.ready", "streamId": s.id}); e != nil {
		return
	}
	go func() {
		defer s.close()
		for {
			select {
			case <-s.ctx.Done():
				return
			case text := <-s.send:
				ctx, cancel := context.WithTimeout(s.ctx, 30*time.Second)
				e := c.Write(ctx, text.kind, text.data)
				cancel()
				s.consumed(len(text.data))
				if e != nil {
					return
				}
			}
		}
	}()
	for {
		kind, reader, readErr := c.Reader(s.ctx)
		if readErr != nil {
			var closed websocket.CloseError
			if errors.As(readErr, &closed) {
				s.mu.Lock()
				s.closeCode = int(closed.Code)
				s.closeReason = closed.Reason
				s.mu.Unlock()
			}
			return
		}
		// Reserve the maximum after the header, before collecting the bounded logical message.
		wait := time.NewTimer(30 * time.Second)
		tick := time.NewTicker(10 * time.Millisecond)
		for !s.p.reserveSend(SocketMessageBytes) {
			select {
			case <-s.ctx.Done():
				wait.Stop()
				tick.Stop()
				return
			case <-wait.C:
				tick.Stop()
				return
			case <-tick.C:
			}
		}
		wait.Stop()
		tick.Stop()
		readTimer := time.AfterFunc(30*time.Second, s.cancel)
		b, e := readSocketMessage(reader)
		readTimer.Stop()
		if len(b) > SocketMessageBytes {
			s.p.releaseSend(SocketMessageBytes)
			return
		}
		if e != nil {
			s.p.releaseSend(SocketMessageBytes)
			var closed websocket.CloseError
			if errors.As(e, &closed) {
				s.mu.Lock()
				s.closeCode = int(closed.Code)
				s.closeReason = closed.Reason
				s.mu.Unlock()
			}
			return
		}
		if kind != websocket.MessageText && kind != websocket.MessageBinary {
			s.p.releaseSend(SocketMessageBytes)
			return
		}
		e = s.sendMessage(kind, b)
		s.p.releaseSend(SocketMessageBytes)
		if e != nil {
			return
		}
	}
}
