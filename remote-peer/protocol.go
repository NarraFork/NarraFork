package remotepeer

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
)

// ProtocolVersion identifies the remote-access wire protocol, not executor Device RPC.
const ProtocolVersion = 2

const (
	FrameBytes  = 16384
	HeaderBytes = 24
	WindowBytes = 65536
	QueueBytes  = 4194304
	JSONBytes   = 1048576
	FileBytes   = 8388608
)

type Frame struct {
	Kind               byte
	StreamID, Sequence uint32
	Payload            []byte
}

func EncodeFrame(f Frame) ([]byte, error) {
	if f.StreamID == 0 || (f.Kind != 1 && f.Kind != 2) || len(f.Payload) > FrameBytes-HeaderBytes || (f.Kind == 2 && len(f.Payload) != 0) {
		return nil, errors.New("frame")
	}
	b := make([]byte, HeaderBytes+len(f.Payload))
	copy(b, []byte("NFDC"))
	b[4] = ProtocolVersion
	b[5] = f.Kind
	binary.BigEndian.PutUint32(b[8:12], f.StreamID)
	binary.BigEndian.PutUint32(b[12:16], f.Sequence)
	binary.BigEndian.PutUint32(b[16:20], uint32(len(f.Payload)))
	copy(b[24:], f.Payload)
	return b, nil
}
func DecodeFrame(b []byte) (Frame, error) {
	if len(b) < HeaderBytes || len(b) > FrameBytes || string(b[:4]) != "NFDC" || b[4] != ProtocolVersion || (b[5] != 1 && b[5] != 2) || binary.BigEndian.Uint16(b[6:8]) != 0 || binary.BigEndian.Uint32(b[20:24]) != 0 || int(binary.BigEndian.Uint32(b[16:20])) != len(b)-24 {
		return Frame{}, errors.New("frame")
	}
	f := Frame{Kind: b[5], StreamID: binary.BigEndian.Uint32(b[8:12]), Sequence: binary.BigEndian.Uint32(b[12:16]), Payload: b[24:]}
	if f.StreamID == 0 || (f.Kind == 2 && len(f.Payload) > 0) {
		return Frame{}, errors.New("frame")
	}
	return f, nil
}

type Ticket struct {
	InstanceID      string `json:"instanceId"`
	LeaseEpoch      string `json:"leaseEpoch"`
	SessionID       string `json:"sessionId"`
	ClientPublicKey string `json:"clientPublicKey"`
	OfferHash       string `json:"offerHash"`
	ExpiresAt       int64  `json:"expiresAt"`
	TargetKind      string `json:"targetKind"`
	TargetID        string `json:"targetId"`
	Signature       string `json:"signature"`
}

func (t Ticket) fields() []string {
	return []string{t.InstanceID, t.LeaseEpoch, t.SessionID, t.ClientPublicKey, t.OfferHash, fmt.Sprint(t.ExpiresAt), t.TargetKind, t.TargetID}
}

type Signal struct {
	Type                 string `json:"type"`
	Challenge            string `json:"challenge"`
	CoordinatorPublicKey string `json:"coordinatorPublicKey"`
	InstanceID           string `json:"instanceId"`
	LeaseEpoch           string `json:"leaseEpoch"`
	Ticket               Ticket `json:"ticket"`
	Offer                string `json:"offer"`
	OfferSignature       string `json:"offerSignature"`
	SessionID            string `json:"sessionId"`
}
type Control struct {
	Type          string      `json:"type"`
	Nonce         string      `json:"nonce"`
	Signature     string      `json:"signature"`
	PairingSecret string      `json:"pairingSecret"`
	Token         string      `json:"token"`
	StreamID      uint32      `json:"streamId"`
	Method        string      `json:"method"`
	Path          string      `json:"path"`
	Headers       [][2]string `json:"headers"`
	HasBody       bool        `json:"hasBody"`
	Bytes         int64       `json:"bytes"`
	Message       string      `json:"message"`
	Code          int         `json:"code"`
	Reason        string      `json:"reason"`
}

func ParseControl(b []byte) (Control, error) {
	if len(b) > FrameBytes {
		return Control{}, errors.New("control_size")
	}
	var c Control
	// Reject unknown fields so payloads cannot smuggle arbitrary proxy metadata.
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if e := dec.Decode(&c); e != nil {
		return c, e
	}
	var extra any
	if e := dec.Decode(&extra); !errors.Is(e, io.EOF) {
		return c, errors.New("trailing_json")
	}
	if c.Type == "" {
		return c, errors.New("control_type")
	}
	return c, nil
}

// Never forward raw SDK/network/JSON errors: they can contain URLs or client-controlled text.
func safeErrorCode(e error) string {
	if e == nil {
		return "ok"
	}
	switch e.Error() {
	case "auth_unavailable", "ticket_sdp", "ticket_hash", "ticket_identity", "ticket_expired", "ticket_future", "ticket_session":
		return e.Error()
	case "public_key", "frame", "control_size", "control_type", "trailing_json", "sdp_size", "candidate_limit", "relay_forbidden", "candidate_type", "path", "path_not_allowed", "ticket", "offer_auth", "peer_limit", "hello", "grant", "invite_invalid", "auth", "auth_status", "auth_role", "unauthorized", "unauthorized_path", "private_auth", "auth_mismatch", "socket", "socket_path", "socket_auth", "socket_limit", "socket_queue", "stream", "stream_limit", "sequence", "credit_or_size", "credit", "window", "receive_queue", "send_queue", "send_size", "send_credit", "headers", "method", "body_method", "channel_type", "gather_timeout":
		return e.Error()
	}
	return "protocol_rejected"
}
func ValidateSDP(s string) error {
	if len(s) == 0 || len(s) > 65536 {
		return errors.New("sdp_size")
	}
	n := 0
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "a=candidate:") {
			n++
			if len(line) > 2048 || n > 128 {
				return errors.New("candidate_limit")
			}
			parts := strings.Fields(line)
			found := false
			for i, p := range parts {
				if p == "typ" && i+1 < len(parts) {
					found = true
					if parts[i+1] == "relay" {
						return errors.New("relay_forbidden")
					}
					if parts[i+1] != "host" && parts[i+1] != "srflx" && parts[i+1] != "prflx" {
						return errors.New("candidate_type")
					}
				}
			}
			if !found {
				return errors.New("candidate_type")
			}
		}
	}
	return nil
}
func ValidatePath(path string) error {
	u, e := url.ParseRequestURI(path)
	if e != nil || u.IsAbs() || u.Host != "" || !strings.HasPrefix(u.Path, "/api/") || strings.HasPrefix(path, "//") || strings.ContainsAny(path, "\\\r\n\x00") {
		return errors.New("path")
	}
	for _, segment := range strings.Split(u.Path, "/") {
		if segment == "." || segment == ".." {
			return errors.New("path")
		}
	}
	// M1 exposes only the isolated fixture surface, not an arbitrary NarraFork admin proxy.
	switch u.Path {
	case "/api/auth/me", "/api/auth/login", "/api/auth/mfa/verify", "/api/json", "/api/sse", "/api/file", "/api/upload", "/api/slow", "/api/status", "/api/echo", "/api/stream", "/api/empty", "/api/error", "/api/health", "/api/projects", "/api/download", "/api/events", "/api/redirect":
		return nil
	}
	return errors.New("path_not_allowed")
}
