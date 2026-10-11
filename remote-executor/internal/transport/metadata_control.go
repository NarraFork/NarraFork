package transport

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
	"github.com/narrafork/remote-executor/internal/rpc"
	"github.com/narrafork/remote-executor/internal/windowsbackup"
)

const metadataRequestBytes = 16 << 10
const metadataResponseBytes = 25 << 10
const metadataControlTimeout = 10 * time.Second
const metadataControlQueue = 64
const metadataControlWorkers = 2

// This bridge transports an already helper-attested request; it grants nothing.
// The server authenticates its original PendingRpc admission and the helper
// independently verifies the returned ticket before privileged IO.
type metadataPending struct {
	outer, step, nonce string
	entry              *requestCancel
	result             chan []byte
}

type metadataResult struct {
	Type       string                     `json:"type"`
	Version    int                        `json:"version"`
	OuterRPCID string                     `json:"outerRpcId"`
	StepID     string                     `json:"stepId"`
	Nonce      string                     `json:"nonce"`
	Ticket     windowsbackup.SignedTicket `json:"ticket"`
}

func canonicalMetadataDecode(raw []byte, limit int, target any) error {
	if len(raw) == 0 || len(raw) > limit || !utf8.Valid(raw) {
		return fmt.Errorf("metadata frame byte/encoding budget")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("invalid metadata frame")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("metadata frame trailing input")
	}
	canonical, err := windowsbackup.CanonicalJSON(target)
	if err != nil || !bytes.Equal(canonical, raw) {
		return fmt.Errorf("metadata frame must be canonical, complete and duplicate-free")
	}
	return nil
}
func metadataCorrelation(outer, step, nonce string) string {
	return outer + "\x00" + step + "\x00" + nonce
}
func metadataControlID(id string) bool {
	return len(id) > 0 && len(id) <= 256 && !strings.ContainsAny(id, "\x00\r\n")
}

func (s *connectionState) installMetadataSession(session *rpc.WindowsMetadataSession) error {
	if session == nil {
		return nil
	} // Legacy peers never acquire synthetic session facts.
	if session.Version != 1 || !metadataControlID(session.ConnectionID) || !metadataControlID(session.SessionID) || session.RuntimeGeneration == 0 || session.RuntimeGeneration > 9007199254740991 {
		return fmt.Errorf("invalid metadata handshake identity")
	}
	copy := *session
	s.metadataSession = &copy
	return nil
}
func (s *connectionState) metadataParentCurrent(outer string, entry *requestCancel) bool {
	if !s.authenticated.Load() || s.ctx.Err() != nil {
		return false
	}
	s.cancelMu.Lock()
	defer s.cancelMu.Unlock()
	return s.cancels[outer] == entry
}

func (s *connectionState) metadataRequestContext(ctx context.Context, outer string, entry *requestCancel) context.Context {
	session := s.metadataSession
	if session == nil {
		return ctx
	}
	facts := windowsbackup.Session{ConnectionID: session.ConnectionID, SessionID: session.SessionID, Generation: session.RuntimeGeneration}
	return windowsbackup.WithMetadataControl(ctx, facts, outer, func(callCtx context.Context, raw []byte) ([]byte, error) {
		return s.sendMetadataCallback(callCtx, outer, entry, raw)
	})
}

func (s *connectionState) sendMetadataCallback(ctx context.Context, outer string, entry *requestCancel, raw []byte) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, metadataControlTimeout)
	defer cancel()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if s.metadataSession == nil || !s.metadataParentCurrent(outer, entry) {
		return nil, fmt.Errorf("original metadata RPC/session unavailable")
	}
	var frame windowsbackup.MetadataCallback
	if err := canonicalMetadataDecode(raw, metadataRequestBytes, &frame); err != nil {
		return nil, err
	}
	session := s.metadataSession
	if frame.Type != "windows_metadata_callback" || frame.Version != 1 || frame.OuterRPCID != outer || !metadataControlID(frame.StepID) || len(frame.Nonce) < 32 || len(frame.Nonce) > 128 || frame.HelperChallenge.ConnectionID != session.ConnectionID || frame.HelperChallenge.SessionID != session.SessionID || frame.HelperChallenge.RuntimeGeneration != session.RuntimeGeneration {
		return nil, fmt.Errorf("metadata request differs from original RPC/session")
	}
	select {
	case s.metadataAdmission <- struct{}{}:
	default:
		return nil, fmt.Errorf("metadata control queue full")
	}
	defer func() { <-s.metadataAdmission }()
	select {
	case s.metadataWorkers <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-s.ctx.Done():
		return nil, s.ctx.Err()
	}
	defer func() { <-s.metadataWorkers }()
	if !s.metadataParentCurrent(outer, entry) {
		return nil, fmt.Errorf("original metadata RPC ended")
	}
	pending := &metadataPending{outer: outer, step: frame.StepID, nonce: frame.Nonce, entry: entry, result: make(chan []byte, 1)}
	key := metadataCorrelation(outer, frame.StepID, frame.Nonce)
	s.metadataMu.Lock()
	if _, exists := s.metadataPending[key]; exists {
		s.metadataMu.Unlock()
		return nil, fmt.Errorf("metadata step already pending")
	}
	s.metadataPending[key] = pending
	s.metadataMu.Unlock()
	defer func() {
		s.metadataMu.Lock()
		if s.metadataPending[key] == pending {
			delete(s.metadataPending, key)
		}
		s.metadataMu.Unlock()
	}()
	if err := s.writeMetadataFrame(ctx, raw); err != nil {
		return nil, err
	}
	select {
	case result := <-pending.result:
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if !s.metadataParentCurrent(outer, entry) {
			return nil, fmt.Errorf("original metadata RPC ended before ticket")
		}
		return result, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-s.ctx.Done():
		return nil, s.ctx.Err()
	}
}

func (s *connectionState) handleMetadataResult(raw []byte) {
	var frame metadataResult
	if canonicalMetadataDecode(raw, metadataResponseBytes, &frame) != nil || frame.Type != "windows_metadata_callback_result" || frame.Version != 1 || !metadataControlID(frame.OuterRPCID) || !metadataControlID(frame.StepID) || len(frame.Nonce) < 32 || len(frame.Nonce) > 128 || frame.Ticket.Payload == "" || frame.Ticket.Signature == "" {
		return
	}
	key := metadataCorrelation(frame.OuterRPCID, frame.StepID, frame.Nonce)
	s.metadataMu.Lock()
	pending := s.metadataPending[key]
	s.metadataMu.Unlock()
	if pending == nil || !s.metadataParentCurrent(frame.OuterRPCID, pending.entry) {
		return
	}
	select {
	case pending.result <- bytes.Clone(raw):
	default:
	} // One result, bounded and original-only.
}

func (s *connectionState) writeMetadataFrame(ctx context.Context, raw []byte) error {
	if err := s.writeMu.LockContext(ctx); err != nil {
		return err
	}
	defer s.writeMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := s.ctx.Err(); err != nil {
		return err
	}
	deadline, ok := ctx.Deadline()
	if !ok {
		return fmt.Errorf("metadata control deadline required")
	}
	// Caller cancellation must not tear down unrelated RPCs mid-frame. The write
	// uses the connection lifetime but the same hard metadata deadline.
	writeCtx, cancel := context.WithDeadline(s.ctx, deadline)
	defer cancel()
	return s.conn.Write(writeCtx, websocket.MessageText, raw)
}
