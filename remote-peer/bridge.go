package remotepeer

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

func filteredHeaders(pairs [][2]string) (http.Header, error) {
	out := http.Header{}
	total := 0
	for _, p := range pairs {
		total += len(p[0]) + len(p[1])
		if total > 8192 || strings.ContainsAny(p[0]+p[1], "\r\n\x00") {
			return nil, errors.New("headers")
		}
		name := http.CanonicalHeaderKey(p[0])
		switch name {
		case "Authorization", "Content-Type", "Accept", "Range", "If-None-Match", "If-Modified-Since":
			out.Add(name, p[1])
		}
	}
	return out, nil
}
func responseHeaders(h http.Header) [][2]string {
	out := [][2]string{}
	n := 0
	for name, vs := range h {
		switch http.CanonicalHeaderKey(name) {
		case "Content-Type", "Content-Length", "Content-Disposition", "Content-Range", "Accept-Ranges", "Cache-Control", "Etag", "Last-Modified", "Location", "X-Session-Token", "X-Narrafork-Token", "X-Narrafork-Session-Token", "X-Fixture-Response":
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
	req, e := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(p.r.cfg.BridgeURL, "/")+"/api/auth/me", nil)
	if e != nil {
		return 0, e
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-NarraFork-Bridge", p.r.cfg.BridgeSecret)
	res, e := p.r.client.Do(req)
	if e != nil {
		return 0, e
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return 0, errors.New("auth_status")
	}
	var a struct {
		Role      string `json:"role"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	b, e := io.ReadAll(io.LimitReader(res.Body, 8193))
	if e != nil || len(b) > 8192 || json.Unmarshal(b, &a) != nil || a.Role != "admin" || a.ExpiresAt <= time.Now().Unix() {
		return 0, errors.New("auth_role")
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
	timer := time.NewTimer(30 * time.Second)
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
	return s.p.queue(outgoing{channel: "nf.bulk.v1", data: data, binary: true})
}
func (p *Peer) openRequest(c Control) error {
	if e := ValidatePath(c.Path); e != nil {
		return e
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
	hello, token, grant := p.hello, p.token, p.grant
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
	ctx, cancel := context.WithTimeout(p.ctx, 30*time.Second)
	s := &httpStream{p: p, id: c.StreamID, ctx: ctx, cancel: cancel, recvCredit: WindowBytes, sendCredit: WindowBytes, limit: limit, hasBody: c.HasBody, chunks: make(chan []byte, 128), wake: make(chan struct{}, 1)}
	p.mu.Lock()
	if c.StreamID == 0 || p.usedIDs[c.StreamID] || len(p.streams) >= 32 || len(p.usedIDs) >= 4096 {
		p.mu.Unlock()
		cancel()
		return errors.New("stream_limit")
	}
	p.usedIDs[c.StreamID] = true
	p.streams[c.StreamID] = s
	p.mu.Unlock()
	if e = p.control(map[string]any{"type": "request.accept", "streamId": s.id}); e != nil {
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
	req.Header.Set("X-NarraFork-Bridge", s.p.r.cfg.BridgeSecret)
	res, e := s.p.r.client.Do(req)
	if e != nil {
		fail()
		return
	}
	defer res.Body.Close()
	if e = s.p.control(map[string]any{"type": "response.open", "streamId": s.id, "status": res.StatusCode, "headers": responseHeaders(res.Header)}); e != nil {
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
	var count int64
	for {
		max, e := s.waitCredit()
		if e != nil {
			fail()
			return
		}
		b := make([]byte, max)
		n, readErr := res.Body.Read(b)
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
	p      *Peer
	id     uint32
	ctx    context.Context
	cancel context.CancelFunc
	conn   *websocket.Conn
	send   chan string
	once   sync.Once
	mu     sync.Mutex
	queued int
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
	case s.send <- text:
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
		s.p.releaseReceive(s.queued)
		s.queued = 0
		s.mu.Unlock()
		if conn != nil {
			conn.CloseNow()
		}
	})
}
func (p *Peer) openSocket(c Control) error {
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
	s := &logicalSocket{p: p, id: c.StreamID, ctx: ctx, cancel: cancel, send: make(chan string, 32)}
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
		_ = s.p.realtime(map[string]any{"type": "socket.close", "streamId": s.id, "code": 1000, "reason": "closed"})
	}()
	target := strings.Replace(strings.TrimRight(s.p.r.cfg.BridgeURL, "/"), "http://", "ws://", 1) + "/ws/narrator?token=" + url.QueryEscape(token)
	ctx, cancel := context.WithTimeout(s.ctx, 15*time.Second)
	c, res, e := websocket.Dial(ctx, target, &websocket.DialOptions{HTTPClient: s.p.r.client, HTTPHeader: http.Header{"X-NarraFork-Bridge": []string{s.p.r.cfg.BridgeSecret}}})
	cancel()
	if e != nil {
		if res != nil && res.Body != nil {
			res.Body.Close()
		}
		return
	}
	s.mu.Lock()
	s.conn = c
	s.mu.Unlock()
	c.SetReadLimit(FrameBytes - 256)
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
				e := c.Write(ctx, websocket.MessageText, []byte(text))
				cancel()
				s.consumed(len(text))
				if e != nil {
					return
				}
			}
		}
	}()
	for {
		kind, b, e := c.Read(s.ctx)
		if e != nil {
			return
		}
		if kind != websocket.MessageText {
			return
		}
		if e = s.p.realtime(map[string]any{"type": "socket.message", "streamId": s.id, "message": string(b)}); e != nil {
			return
		}
	}
}
