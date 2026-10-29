package remotepeer

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

type incoming struct {
	channel string
	data    []byte
	binary  bool
}
type outgoing struct {
	channel string
	data    []byte
	binary  bool
}
type Peer struct {
	r                      *Runtime
	pc                     *webrtc.PeerConnection
	ticket                 Ticket
	ctx                    context.Context
	cancel                 context.CancelFunc
	once                   sync.Once
	mu                     sync.Mutex
	channels               map[string]*webrtc.DataChannel
	answerHash             string
	grant                  string
	token                  string
	authExpires            int64
	hello                  bool
	authorized             bool
	streams                map[uint32]*httpStream
	retired                map[uint32]*httpStream
	sockets                map[uint32]*logicalSocket
	usedIDs                map[uint32]bool
	inbox                  chan incoming
	priority               chan outgoing
	bulk                   chan outgoing
	wake                   chan struct{}
	queueMu                sync.Mutex
	recvQueued, sendQueued int
}

func newPeer(r *Runtime, pc *webrtc.PeerConnection, t Ticket) *Peer {
	ctx, cancel := context.WithCancel(context.Background())
	p := &Peer{r: r, pc: pc, ticket: t, ctx: ctx, cancel: cancel, channels: map[string]*webrtc.DataChannel{}, streams: map[uint32]*httpStream{}, retired: map[uint32]*httpStream{}, sockets: map[uint32]*logicalSocket{}, usedIDs: map[uint32]bool{}, inbox: make(chan incoming, 256), priority: make(chan outgoing, 256), bulk: make(chan outgoing, 256), wake: make(chan struct{}, 1)}
	go p.receive()
	go p.send()
	go p.watch()
	go p.revalidate()
	go func() { <-p.ctx.Done(); p.Close() }()
	return p
}
func (p *Peer) reserveReceive(n int) bool {
	p.queueMu.Lock()
	defer p.queueMu.Unlock()
	if p.recvQueued+n > QueueBytes {
		return false
	}
	p.recvQueued += n
	return true
}
func (p *Peer) releaseReceive(n int) { p.queueMu.Lock(); p.recvQueued -= n; p.queueMu.Unlock() }
func (p *Peer) grantID() string      { p.mu.Lock(); defer p.mu.Unlock(); return p.grant }
func (p *Peer) isAuthorized() bool {
	p.mu.Lock()
	ok, g, exp := p.authorized, p.grant, p.authExpires
	p.mu.Unlock()
	if !ok || p.ctx.Err() != nil || exp <= time.Now().Unix() {
		return false
	}
	_, valid := p.r.store.GetGrant(g)
	return valid
}
func (p *Peer) Close() {
	p.once.Do(func() {
		p.cancel()
		p.mu.Lock()
		ss := []*httpStream{}
		for _, s := range p.streams {
			ss = append(ss, s)
		}
		socks := []*logicalSocket{}
		for _, s := range p.sockets {
			socks = append(socks, s)
		}
		p.mu.Unlock()
		for _, s := range ss {
			s.cancel()
		}
		for _, s := range socks {
			s.close()
		}
		p.r.mu.Lock()
		delete(p.r.peers, p.ticket.SessionID)
		if p.r.pending[p.ticket.TargetID] == p.ticket.SessionID {
			delete(p.r.pending, p.ticket.TargetID)
		}
		p.r.mu.Unlock()
		if p.pc != nil {
			_ = p.pc.Close()
		}
	})
}
func (p *Peer) attachChannel(dc *webrtc.DataChannel) {
	label := dc.Label()
	if (label != "nf.control.v1" && label != "nf.realtime.v1" && label != "nf.bulk.v1") || !dc.Ordered() || dc.MaxPacketLifeTime() != nil || dc.MaxRetransmits() != nil {
		p.cancel()
		return
	}
	p.mu.Lock()
	duplicate := p.channels[label] != nil
	if !duplicate {
		p.channels[label] = dc
	}
	p.mu.Unlock()
	if duplicate {
		p.cancel()
		return
	}
	dc.SetBufferedAmountLowThreshold(256 * 1024)
	dc.OnBufferedAmountLow(func() {
		select {
		case p.wake <- struct{}{}:
		default:
		}
	})
	dc.OnClose(p.cancel)
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		if p.ctx.Err() != nil {
			return
		}
		if len(m.Data) > FrameBytes || (label == "nf.bulk.v1" && m.IsString) || (label != "nf.bulk.v1" && !m.IsString) {
			p.cancel()
			return
		}
		p.queueMu.Lock()
		if p.recvQueued+len(m.Data) > QueueBytes {
			p.queueMu.Unlock()
			p.cancel()
			return
		}
		p.recvQueued += len(m.Data)
		p.queueMu.Unlock()
		v := incoming{channel: label, data: append([]byte(nil), m.Data...), binary: !m.IsString}
		select {
		case p.inbox <- v:
		default:
			p.cancel()
		}
	})
}
func (p *Peer) queue(v outgoing) error {
	if len(v.data) > FrameBytes {
		return errors.New("send_size")
	}
	p.queueMu.Lock()
	if p.sendQueued+len(v.data) > QueueBytes {
		p.queueMu.Unlock()
		p.Close()
		return errors.New("send_queue")
	}
	p.sendQueued += len(v.data)
	p.queueMu.Unlock()
	ch := p.priority
	if v.channel == "nf.bulk.v1" {
		ch = p.bulk
	}
	select {
	case <-p.ctx.Done():
		return p.ctx.Err()
	case ch <- v:
		return nil
	default:
		p.Close()
		return errors.New("send_queue")
	}
}
func (p *Peer) control(v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	return p.queue(outgoing{channel: "nf.control.v1", data: b})
}
func (p *Peer) realtime(v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	return p.queue(outgoing{channel: "nf.realtime.v1", data: b})
}
func (p *Peer) send() {
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	var pending, heldBulk *outgoing
	for {
		if pending == nil && heldBulk != nil {
			pending = heldBulk
			heldBulk = nil
		}
		if pending != nil && pending.channel == "nf.bulk.v1" {
			select {
			case v := <-p.priority:
				heldBulk = pending
				pending = &v
			default:
			}
		}
		if pending == nil {
			select {
			case <-p.ctx.Done():
				return
			case v := <-p.priority:
				pending = &v
			default:
				select {
				case <-p.ctx.Done():
					return
				case v := <-p.priority:
					pending = &v
				case v := <-p.bulk:
					pending = &v
				}
			}
		}
		p.mu.Lock()
		dc := p.channels[pending.channel]
		p.mu.Unlock()
		if dc == nil || dc.ReadyState() != webrtc.DataChannelStateOpen || dc.BufferedAmount()+uint64(len(pending.data)) > 1024*1024 {
			select {
			case <-p.ctx.Done():
				return
			case <-p.wake:
			case <-ticker.C:
			}
			continue
		}
		var e error
		if pending.binary {
			e = dc.Send(pending.data)
		} else {
			e = dc.SendText(string(pending.data))
		}
		if e != nil {
			p.Close()
			return
		}
		p.queueMu.Lock()
		p.sendQueued -= len(pending.data)
		p.queueMu.Unlock()
		pending = nil
	}
}
func (p *Peer) receive() {
	for {
		select {
		case <-p.ctx.Done():
			return
		case m := <-p.inbox:
			var e error
			if m.binary {
				e = p.receiveFrame(m.data)
			} else {
				var c Control
				c, e = ParseControl(m.data)
				if e == nil {
					if m.channel == "nf.realtime.v1" && c.Type != "socket.send" && c.Type != "socket.close" && c.Type != "socket.open" {
						e = errors.New("channel_type")
					} else if m.channel == "nf.control.v1" && c.Type == "socket.send" {
						e = errors.New("channel_type")
					} else {
						e = p.handleControl(c)
					}
				}
			}
			p.queueMu.Lock()
			p.recvQueued -= len(m.data)
			p.queueMu.Unlock()
			if e != nil {
				code := safeErrorCode(e)
				p.r.emit(map[string]any{"type": "error", "code": code})
				_ = p.control(map[string]any{"type": "peer.error", "code": code})
				p.Close()
				return
			}
		}
	}
}
func (p *Peer) watch() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	start := time.Now()
	for {
		select {
		case <-p.ctx.Done():
			return
		case <-ticker.C:
			p.mu.Lock()
			hello, auth, g, expiry := p.hello, p.authorized, p.grant, p.authExpires
			p.mu.Unlock()
			if !hello && time.Since(start) > 20*time.Second {
				p.Close()
				return
			}
			if hello && !auth && time.Since(start) > 35*time.Second {
				p.Close()
				return
			}
			if hello {
				if _, ok := p.r.store.GetGrant(g); !ok {
					p.Close()
					return
				}
			}
			if auth {
				if time.Now().Unix() >= expiry {
					p.Close()
					return
				}

			}
		}
	}
}

// Network revalidation must never delay the separate local grant/JWT expiry clock.
func (p *Peer) revalidate() {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-p.ctx.Done():
			return
		case <-t.C:
			p.mu.Lock()
			auth, token := p.authorized, p.token
			p.mu.Unlock()
			if !auth {
				continue
			}
			exp, e := p.checkAuth(token)
			p.mu.Lock()
			same := p.token == token
			if same && e == nil {
				p.authExpires = exp
			}
			p.mu.Unlock()
			if same && e != nil {
				p.r.emit(map[string]any{"type": "error", "code": safeErrorCode(e)})
				p.Close()
				return
			}
		}
	}
}
func (p *Peer) handleControl(c Control) error {
	switch c.Type {
	case "hello":
		p.mu.Lock()
		already, answer := p.hello, p.answerHash
		p.mu.Unlock()
		if already || answer == "" || len(c.Nonce) < 16 || len(c.Nonce) > 256 || !Verify(p.ticket.ClientPublicKey, c.Signature, "hello", p.r.id, p.ticket.SessionID, p.ticket.OfferHash, answer, c.Nonce, p.ticket.ClientPublicKey) {
			return errors.New("hello")
		}
		var g Grant
		var cap string
		if p.ticket.TargetKind == "invite" {
			var e error
			g, cap, e = p.r.store.Consume(p.ticket.TargetID, c.PairingSecret, p.ticket.ClientPublicKey, time.Now())
			if e != nil {
				return e
			}
		} else {
			var ok bool
			g, ok = p.r.store.GetGrant(p.ticket.TargetID)
			if !ok || g.PublicKey != p.ticket.ClientPublicKey {
				return errors.New("grant")
			}
		}
		p.mu.Lock()
		p.grant = g.ID
		p.hello = true
		p.mu.Unlock()
		p.r.discoveries()
		return p.control(map[string]any{"type": "hello.ready", "grantId": g.ID, "discoveryCapability": cap, "expiresAt": g.ExpiresAt})
	case "auth":
		p.mu.Lock()
		hello := p.hello
		p.mu.Unlock()
		if !hello || len(c.Token) > 8192 {
			return errors.New("auth")
		}
		exp, e := p.checkAuth(c.Token)
		if e != nil {
			return e
		}
		p.mu.Lock()
		p.token = c.Token
		p.authExpires = exp
		p.authorized = true
		p.mu.Unlock()
		return p.control(map[string]any{"type": "ready", "version": ProtocolVersion, "apiVersion": 1, "appVersion": "prototype-1"})
	default:
		if !p.isAuthorized() && c.Type != "request.open" && c.Type != "window.update" && c.Type != "stream.cancel" {
			return errors.New("unauthorized")
		}
		switch c.Type {
		case "request.open":
			return p.openRequest(c)
		case "window.update":
			p.mu.Lock()
			s := p.streams[c.StreamID]
			if s == nil {
				s = p.retired[c.StreamID]
			}
			p.mu.Unlock()
			if c.Bytes <= 0 || c.Bytes > WindowBytes {
				return errors.New("window")
			}
			if s == nil {
				return errors.New("window")
			}
			return s.update(c.Bytes)
		case "stream.cancel":
			p.mu.Lock()
			s := p.streams[c.StreamID]
			p.mu.Unlock()
			if s != nil {
				s.cancel()
			}
			return nil
		case "socket.open":
			return p.openSocket(c)
		case "socket.send":
			p.mu.Lock()
			s := p.sockets[c.StreamID]
			p.mu.Unlock()
			if s == nil || len(c.Message) > FrameBytes-256 {
				return errors.New("socket")
			}
			return s.enqueue(c.Message)
		case "socket.close":
			p.mu.Lock()
			s := p.sockets[c.StreamID]
			p.mu.Unlock()
			if s != nil {
				s.close()
			}
			return nil
		default:
			return errors.New("control_type")
		}
	}
}
func (p *Peer) receiveFrame(b []byte) error {
	p.mu.Lock()
	hello := p.hello
	p.mu.Unlock()
	if !hello {
		return errors.New("unauthorized")
	}
	f, e := DecodeFrame(b)
	if e != nil {
		return e
	}
	p.mu.Lock()
	s := p.streams[f.StreamID]
	if s == nil {
		s = p.retired[f.StreamID]
	}
	p.mu.Unlock()
	if s == nil {
		return errors.New("stream")
	}
	return s.receive(f)
}
