package remotepeer

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"github.com/coder/websocket"
	"net/http"
	"os"
	"testing"
	"time"
)

func socketForTest(p *Peer, id uint32) *logicalSocket {
	ctx, cancel := context.WithCancel(p.ctx)
	return &logicalSocket{p: p, id: id, ctx: ctx, cancel: cancel, send: make(chan socketMessage, 32), sendCredit: WindowBytes, wake: make(chan struct{}, 1)}
}
func TestSocketGoldenAndMalformedFrames(t *testing.T) {
	var vector struct {
		SocketFrameHex string `json:"socketFrameHex"`
	}
	b, err := os.ReadFile("../shared/remote-access/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	if json.Unmarshal(b, &vector) != nil {
		t.Fatal("vectors")
	}
	encoded, err := EncodeSocketFrame(SocketFrame{StreamID: 9, MessageID: 1, Opcode: 2, Total: 3, End: true, Payload: []byte{0, 128, 255}})
	if err != nil || hex.EncodeToString(encoded) != vector.SocketFrameHex {
		t.Fatal("socket vector", err)
	}
	for _, offset := range []int{0, 4, 5, 6, 20, 24, 28} {
		bad := bytes.Clone(encoded)
		bad[offset] ^= 255
		if _, err := DecodeSocketFrame(bad); err == nil {
			t.Fatal("bad frame accepted", offset)
		}
	}
}
func TestSocketTwoMiBTextAndBinaryCreditDoesNotDeadlock(t *testing.T) {
	r, _ := productionRuntime(t, func(http.ResponseWriter, *http.Request) {})
	p := pairedProductionPeer(t, r, "socket")
	acceptProduction(t, p)
	p.authorized = true
	p.authExpires = time.Now().Add(time.Hour).Unix()
	a, b := socketForTest(p, 1), socketForTest(p, 2)
	p.sockets[1] = a
	p.sockets[2] = b
	p.usedIDs[1] = true
	p.usedIDs[2] = true
	defer a.close()
	defer b.close()
	data := bytes.Repeat([]byte("x"), SocketMessageBytes)
	done := make(chan error, 2)
	go func() { done <- a.sendMessage(websocket.MessageText, data) }()
	go func() { done <- b.sendMessage(websocket.MessageBinary, data) }()
	results := map[uint32][]byte{1: {}, 2: {}}
	ids := map[uint32]uint32{}
	deadline := time.After(3 * time.Second)
	for len(results[1]) < len(data) || len(results[2]) < len(data) {
		select {
		case out := <-p.priority:
			p.releaseSend(len(out.data)) // deterministic replacement for the channel writer
			f, err := DecodeSocketFrame(out.data)
			if err != nil {
				t.Fatal(err)
			}
			if f.Sequence != ids[f.StreamID] || f.Total != SocketMessageBytes || f.MessageID != 1 {
				t.Fatal("sequence/total")
			}
			ids[f.StreamID]++
			results[f.StreamID] = append(results[f.StreamID], f.Payload...)
			if f.End != (len(results[f.StreamID]) == len(data)) {
				t.Fatal("end")
			}
			target := a
			if f.StreamID == 2 {
				target = b
			}
			if err := target.updateCredit(int64(len(f.Payload))); err != nil {
				t.Fatal(err)
			}
		case <-deadline:
			t.Fatal("credit deadlock")
		}
	}
	for range 2 {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	if !bytes.Equal(results[1], data) || !bytes.Equal(results[2], data) {
		t.Fatal("socket corruption")
	}
	if a.updateCredit(1) == nil {
		t.Fatal("manufactured credit accepted")
	}
}
func TestSocketAssemblyReservationOrderAndCancel(t *testing.T) {
	r, _ := productionRuntime(t, func(http.ResponseWriter, *http.Request) {})
	p := pairedProductionPeer(t, r, "assembly")
	s := socketForTest(p, 1)
	defer s.close()
	first := SocketFrame{StreamID: 1, MessageID: 1, Opcode: 1, Total: SocketMessageBytes, Payload: []byte("{")}
	if err := s.receiveFragment(first); err != nil {
		t.Fatal(err)
	}
	if p.recvQueued != SocketMessageBytes {
		t.Fatal("full logical allocation was not reserved")
	}
	if err := s.receiveFragment(first); err == nil {
		t.Fatal("duplicate accepted")
	}
	s.close()
	if p.recvQueued != 0 {
		t.Fatal("partial assembly retained budget")
	}
}
func TestSocketAssemblyCompletesThenReturnsBudgetAfterUpstreamWrite(t *testing.T) {
	r, _ := productionRuntime(t, func(http.ResponseWriter, *http.Request) {})
	p := pairedProductionPeer(t, r, "assembly2")
	s := socketForTest(p, 1)
	defer s.close()
	data := bytes.Repeat([]byte{0, 255, 128}, 100000)
	for offset, seq := 0, uint32(0); offset < len(data); seq++ {
		n := min(SocketFragmentBytes, len(data)-offset)
		err := s.receiveFragment(SocketFrame{StreamID: 1, MessageID: 1, Sequence: seq, Opcode: 2, Total: uint32(len(data)), End: offset+n == len(data), Payload: data[offset : offset+n]})
		if err != nil {
			t.Fatal(err)
		}
		// Each copied fragment must release credit, even before the 64KiB window fills.
		select {
		case out := <-p.priority:
			var c Control
			_ = json.Unmarshal(out.data, &c)
			if c.Type != "socket.window" || c.Bytes != int64(n) {
				t.Fatal("no fragment credit")
			}
			p.releaseSend(len(out.data))
		default:
			t.Fatal("credit withheld until END")
		}
		offset += n
	}
	message := <-s.send
	if message.kind != websocket.MessageBinary || !bytes.Equal(message.data, data) {
		t.Fatal("binary corruption")
	}
	if p.recvQueued != len(data) {
		t.Fatal("budget freed before upstream consumed message")
	}
	s.consumed(len(data))
	if p.recvQueued != 0 {
		t.Fatal("budget leak")
	}
}
