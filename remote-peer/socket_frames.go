package remotepeer

import (
	"encoding/binary"
	"errors"
	"github.com/coder/websocket"
	"io"
	"time"
	"unicode/utf8"
)

// A fixed allocation is already reserved by the caller; avoid ReadAll's growth copies.
func readSocketMessage(reader io.Reader) ([]byte, error) {
	b := make([]byte, SocketMessageBytes)
	n, err := io.ReadFull(reader, b)
	if err == io.EOF || err == io.ErrUnexpectedEOF {
		return b[:n], nil
	}
	if err != nil {
		return nil, err
	}
	var extra [1]byte
	n, err = reader.Read(extra[:])
	if n != 0 || err != io.EOF {
		return nil, errors.New("socket_message_limit")
	}
	return b, nil
}

const SocketHeaderBytes = 32
const SocketMessageBytes = 2 * 1024 * 1024
const SocketFragmentBytes = FrameBytes - SocketHeaderBytes

type SocketFrame struct {
	StreamID, MessageID, Sequence, Total uint32
	Opcode                               byte
	End                                  bool
	Payload                              []byte
}

func EncodeSocketFrame(f SocketFrame) ([]byte, error) {
	if f.StreamID == 0 || f.MessageID == 0 || (f.Opcode != 1 && f.Opcode != 2) || f.Total > SocketMessageBytes || len(f.Payload) > SocketFragmentBytes || len(f.Payload) > int(f.Total) || (!f.End && len(f.Payload) == 0) {
		return nil, errors.New("socket_frame")
	}
	b := make([]byte, SocketHeaderBytes+len(f.Payload))
	copy(b, "NFWS")
	b[4] = ProtocolVersion
	b[5] = f.Opcode
	if f.End {
		b[7] = 1
	}
	binary.BigEndian.PutUint32(b[8:], f.StreamID)
	binary.BigEndian.PutUint32(b[12:], f.MessageID)
	binary.BigEndian.PutUint32(b[16:], f.Sequence)
	binary.BigEndian.PutUint32(b[20:], f.Total)
	binary.BigEndian.PutUint32(b[24:], uint32(len(f.Payload)))
	copy(b[32:], f.Payload)
	return b, nil
}
func DecodeSocketFrame(b []byte) (SocketFrame, error) {
	if len(b) < SocketHeaderBytes || len(b) > FrameBytes || string(b[:4]) != "NFWS" || b[4] != ProtocolVersion || binary.BigEndian.Uint16(b[6:]) > 1 || binary.BigEndian.Uint32(b[28:]) != 0 || int(binary.BigEndian.Uint32(b[24:])) != len(b)-SocketHeaderBytes {
		return SocketFrame{}, errors.New("socket_frame")
	}
	f := SocketFrame{StreamID: binary.BigEndian.Uint32(b[8:]), MessageID: binary.BigEndian.Uint32(b[12:]), Sequence: binary.BigEndian.Uint32(b[16:]), Total: binary.BigEndian.Uint32(b[20:]), Opcode: b[5], End: b[7] == 1, Payload: b[32:]}
	if f.StreamID == 0 || f.MessageID == 0 || (f.Opcode != 1 && f.Opcode != 2) || f.Total > SocketMessageBytes || len(f.Payload) > int(f.Total) || (!f.End && len(f.Payload) == 0) {
		return SocketFrame{}, errors.New("socket_frame")
	}
	return f, nil
}

type socketMessage struct {
	kind websocket.MessageType
	data []byte
}
type socketAssembly struct {
	id, sequence, total uint32
	opcode              byte
	data                []byte
	timer               *time.Timer
}

func (p *Peer) receiveSocketFrame(b []byte) error {
	if !p.isAuthorized() {
		return errors.New("unauthorized")
	}
	f, err := DecodeSocketFrame(b)
	if err != nil {
		return err
	}
	p.mu.Lock()
	s := p.sockets[f.StreamID]
	used := p.usedIDs[f.StreamID]
	p.mu.Unlock()
	if s == nil {
		if used {
			return nil
		}
		return errors.New("socket")
	}
	return s.receiveFragment(f)
}
func (s *logicalSocket) receiveFragment(f SocketFrame) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ctx.Err() != nil {
		return nil
	}
	if s.assembly == nil {
		if f.MessageID != s.recvMessage+1 || f.Sequence != 0 {
			return errors.New("socket_sequence")
		}
		if !s.p.reserveReceive(int(f.Total)) {
			return errors.New("socket_queue")
		}
		s.queued += int(f.Total)
		s.assembly = &socketAssembly{id: f.MessageID, total: f.Total, opcode: f.Opcode, data: make([]byte, 0, int(f.Total)), timer: time.AfterFunc(30*time.Second, s.p.cancel)}
	}
	a := s.assembly
	if f.MessageID != a.id || f.Sequence != a.sequence || f.Total != a.total || f.Opcode != a.opcode || len(a.data)+len(f.Payload) > int(a.total) {
		return errors.New("socket_sequence")
	}
	a.data = append(a.data, f.Payload...)
	a.sequence++
	if f.End != (len(a.data) == int(a.total)) {
		return errors.New("socket_end")
	}
	if len(f.Payload) > 0 {
		if err := s.p.realtime(map[string]any{"type": "socket.window", "streamId": s.id, "bytes": len(f.Payload)}); err != nil {
			return err
		}
	}
	if f.End {
		a.timer.Stop()
		s.assembly = nil
		s.recvMessage++
		if a.opcode == 1 && !utf8.Valid(a.data) {
			return errors.New("socket_utf8")
		}
		select {
		case s.send <- socketMessage{kind: websocket.MessageType(a.opcode), data: a.data}:
		default:
			return errors.New("socket_queue")
		}
	}
	return nil
}
func (s *logicalSocket) updateCredit(n int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if n <= 0 || s.sendCredit+n > WindowBytes {
		return errors.New("socket_credit")
	}
	s.sendCredit += n
	select {
	case s.wake <- struct{}{}:
	default:
	}
	return nil
}
func (s *logicalSocket) sendMessage(kind websocket.MessageType, b []byte) error {
	s.sendMessageID++
	if s.sendMessageID == 0 {
		return errors.New("socket_sequence")
	}
	offset, sequence := 0, uint32(0)
	for {
		timer := time.NewTimer(30 * time.Second)
		for {
			s.mu.Lock()
			credit := s.sendCredit
			s.mu.Unlock()
			if credit > 0 || len(b) == 0 {
				break
			}
			select {
			case <-s.ctx.Done():
				timer.Stop()
				return s.ctx.Err()
			case <-timer.C:
				return errors.New("socket_credit_timeout")
			case <-s.wake:
			}
		}
		timer.Stop()
		s.mu.Lock()
		n := min(len(b)-offset, SocketFragmentBytes, int(s.sendCredit))
		s.sendCredit -= int64(n)
		s.mu.Unlock()
		data, err := EncodeSocketFrame(SocketFrame{StreamID: s.id, MessageID: s.sendMessageID, Sequence: sequence, Total: uint32(len(b)), Opcode: byte(kind), End: offset+n == len(b), Payload: b[offset : offset+n]})
		if err != nil {
			return err
		}
		if err = s.p.queue(outgoing{channel: "nf.realtime.v2", binary: true, data: data}); err != nil {
			return err
		}
		offset += n
		sequence++
		if offset == len(b) {
			return nil
		}
	}
}
func (p *Peer) reserveSend(n int) bool {
	p.queueMu.Lock()
	defer p.queueMu.Unlock()
	if p.sendQueued+n > QueueBytes-2*FrameBytes {
		return false
	}
	p.sendQueued += n
	return true
}
func (p *Peer) releaseSend(n int) { p.queueMu.Lock(); p.sendQueued -= n; p.queueMu.Unlock() }
