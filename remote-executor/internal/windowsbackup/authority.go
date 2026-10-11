package windowsbackup

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type NativeDescriptor struct {
	VolumeID     string `json:"volumeId"`
	FileID       string `json:"fileId"`
	CreationTime string `json:"creationTime"`
	PathKey      string `json:"pathKey"`
}
type OriginalOperation struct {
	OperationID   string `json:"operationId"`
	RequestDigest string `json:"requestDigest"`
	LeaseID       string `json:"leaseId"`
	Fence         uint64 `json:"fence"`
}
type Ticket struct {
	Version                     int                `json:"version"`
	Issuer                      string             `json:"issuer"`
	ServiceID                   string             `json:"serviceId"`
	KeyEpoch                    uint64             `json:"keyEpoch"`
	DeviceID                    string             `json:"deviceId"`
	ExecutorSourceID            string             `json:"executorSourceId"`
	HelperInstanceID            string             `json:"helperInstanceId"`
	ChallengeNonce              string             `json:"challengeNonce"`
	ConnectionID                string             `json:"connectionId"`
	SessionID                   string             `json:"sessionId"`
	RuntimeGeneration           uint64             `json:"runtimeGeneration"`
	ActorSubjectKey             string             `json:"actorSubjectKey"`
	NarratorID                  *string            `json:"narratorId"`
	ProjectID                   *string            `json:"projectId"`
	OriginRefHash               string             `json:"originRefHash"`
	Action                      string             `json:"action"`
	BudgetClass                 string             `json:"budgetClass"`
	ScopeID                     string             `json:"scopeId"`
	Root                        NativeDescriptor   `json:"root"`
	Parent                      NativeDescriptor   `json:"parent"`
	Target                      NativeDescriptor   `json:"target"`
	OperationID                 string             `json:"operationId"`
	RequestDigest               string             `json:"requestDigest"`
	LeaseID                     string             `json:"leaseId"`
	Fence                       uint64             `json:"fence"`
	ExpectedCurrentMetadataHash *string            `json:"expectedCurrentMetadataHash"`
	ExpectedCurrentContentHash  *string            `json:"expectedCurrentContentHash"`
	CaptureProofID              *string            `json:"captureProofId"`
	PreparedObjectID            *string            `json:"preparedObjectId"`
	RecoveryOriginal            *OriginalOperation `json:"recoveryOriginal"`
	IssuedAt                    uint64             `json:"issuedAt"`
	ExpiresAt                   uint64             `json:"expiresAt"`
	Nonce                       string             `json:"nonce"`
}
type SignedTicket struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}
type CaptureProof struct {
	Version          int    `json:"version"`
	HelperInstanceID string `json:"helperInstanceId"`
	KeyEpoch         uint64 `json:"keyEpoch"`
	RecordID         string `json:"recordId"`
	RecordNonce      string `json:"recordNonce"`
	RecordDigest     string `json:"recordDigest"`
	Signature        string `json:"signature"`
}

// PeerIdentity MUST originate from the named pipe's actual peer PID/token and
// process creation time. There is no client-supplied PeerIdentity wire field.
type PeerIdentity struct {
	PID              uint32
	CreationTime     uint64
	SID              string
	ServiceSID       string
	ExecutorInstance string
}

// Session is enrolled through trusted service startup, not first-client trust.
// A same-SID Shell or another executor cannot enroll itself.
type Session struct {
	Peer                                                                          PeerIdentity
	DeviceID, SourceID, HelperInstanceID, ConnectionID, SessionID, ChallengeNonce string
	Generation                                                                    uint64
}
type IssuerKey struct {
	Issuer, ServiceID string
	Epoch             uint64
	PublicKey         ed25519.PublicKey
}
type Verifier struct {
	Keys                []IssuerKey
	Session             Session
	Roots               []NativeDescriptor
	Now                 func() time.Time
	RegisteredChallenge func(Ticket) (string, error)
}
type VerifiedTicket struct {
	ticket Ticket
	digest string
	raw    []byte
	stage  string
}

func (v *VerifiedTicket) Ticket() Ticket { return v.ticket }
func (v *VerifiedTicket) Digest() string { return v.digest }

func CanonicalJSON(value any) ([]byte, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var decoded any
	if err := decoder.Decode(&decoded); err != nil {
		return nil, err
	}
	var out bytes.Buffer
	var appendValue func(any) error
	appendValue = func(v any) error {
		switch x := v.(type) {
		case nil:
			out.WriteString("null")
		case bool:
			if x {
				out.WriteString("true")
			} else {
				out.WriteString("false")
			}
		case string:
			out.WriteByte('"')
			for _, r := range x {
				switch r {
				case '"':
					out.WriteString("\\\"")
				case '\\':
					out.WriteString("\\\\")
				case '\b':
					out.WriteString("\\b")
				case '\f':
					out.WriteString("\\f")
				case '\n':
					out.WriteString("\\n")
				case '\r':
					out.WriteString("\\r")
				case '\t':
					out.WriteString("\\t")
				default:
					if r < 32 {
						out.WriteString(fmt.Sprintf("\\u%04x", r))
					} else {
						out.WriteRune(r)
					}
				}
			}
			out.WriteByte('"')
		case json.Number:
			n, err := strconv.ParseUint(string(x), 10, 64)
			if err != nil || n > 9007199254740991 {
				return fmt.Errorf("invalid canonical unsigned integer")
			}
			out.WriteString(strconv.FormatUint(n, 10))
		case []any:
			out.WriteByte('[')
			for i, item := range x {
				if i > 0 {
					out.WriteByte(',')
				}
				if err := appendValue(item); err != nil {
					return err
				}
			}
			out.WriteByte(']')
		case map[string]any:
			keys := make([]string, 0, len(x))
			for k := range x {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			out.WriteByte('{')
			for i, k := range keys {
				if i > 0 {
					out.WriteByte(',')
				}
				if err := appendValue(k); err != nil {
					return err
				}
				out.WriteByte(':')
				if err := appendValue(x[k]); err != nil {
					return err
				}
			}
			out.WriteByte('}')
		default:
			return fmt.Errorf("invalid canonical JSON value")
		}
		return nil
	}
	if err := appendValue(decoded); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
func strictJSON(raw []byte, value any) error {
	if !utf8.Valid(raw) {
		return fmt.Errorf("invalid UTF8")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("trailing JSON")
	}
	canonical, err := CanonicalJSON(value)
	if err != nil {
		return err
	}
	if !bytes.Equal(canonical, raw) {
		return fmt.Errorf("noncanonical, duplicate or missing fields")
	}
	return nil
}
func validID(s string, max int) bool {
	if s == "" || len(s) > max || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if r < 32 || r == 127 {
			return false
		}
	}
	return true
}
func validHash(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, r := range s {
		if !strings.ContainsRune("0123456789abcdef", r) {
			return false
		}
	}
	return true
}
func validNonce(s string) bool {
	if len(s) < 32 || len(s) > 128 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}
func (t *Ticket) Validate() error {
	if t.Version != 1 {
		return fmt.Errorf("ticket version")
	}
	for _, s := range []string{t.Issuer, t.ServiceID, t.DeviceID, t.ExecutorSourceID, t.HelperInstanceID, t.ConnectionID, t.SessionID, t.ActorSubjectKey, t.ScopeID, t.OperationID, t.LeaseID} {
		if !validID(s, 256) {
			return fmt.Errorf("ticket id")
		}
	}
	for _, s := range []*string{t.NarratorID, t.ProjectID, t.CaptureProofID, t.PreparedObjectID} {
		if s != nil && !validID(*s, 256) {
			return fmt.Errorf("optional id")
		}
	}
	for _, d := range []NativeDescriptor{t.Root, t.Parent, t.Target} {
		if !validID(d.VolumeID, 256) || !validID(d.FileID, 256) || !validID(d.CreationTime, 256) || !validID(d.PathKey, 4096) {
			return fmt.Errorf("native descriptor")
		}
	}
	if !validHash(t.RequestDigest) || !validHash(t.OriginRefHash) || !validNonce(t.Nonce) || !validNonce(t.ChallengeNonce) {
		return fmt.Errorf("ticket digest/nonce")
	}
	for _, h := range []*string{t.ExpectedCurrentMetadataHash, t.ExpectedCurrentContentHash} {
		if h != nil && !validHash(*h) {
			return fmt.Errorf("expected digest")
		}
	}
	for _, n := range []uint64{t.KeyEpoch, t.RuntimeGeneration, t.Fence, t.IssuedAt, t.ExpiresAt} {
		if n > 9007199254740991 {
			return fmt.Errorf("unsafe integer")
		}
	}
	ttl := uint64(0)
	switch t.BudgetClass {
	case "metadata":
		ttl = 30000
	case "operation":
		ttl = 120000
	case "attachment":
		ttl = 300000
	default:
		return fmt.Errorf("budget class")
	}
	if t.ExpiresAt <= t.IssuedAt || t.ExpiresAt-t.IssuedAt > ttl {
		return fmt.Errorf("ticket TTL")
	}
	switch t.Action {
	case "capture_exact":
		if t.CaptureProofID != nil || t.PreparedObjectID != nil || t.RecoveryOriginal != nil {
			return fmt.Errorf("capture cannot borrow proof")
		}
	case "restore_original", "unseal_original", "seal_owned", "status_original":
		if t.CaptureProofID == nil {
			return fmt.Errorf("original proof required")
		}
	case "prepare_owned", "cleanup_created":
		if t.PreparedObjectID == nil || t.CaptureProofID != nil {
			return fmt.Errorf("owned registration required")
		}
	default:
		return fmt.Errorf("ticket action")
	}
	if t.RecoveryOriginal != nil {
		switch t.Action {
		case "restore_original", "unseal_original", "status_original":
		default:
			return fmt.Errorf("invalid recovery action")
		}
		r := t.RecoveryOriginal
		if !validID(r.OperationID, 256) || !validID(r.LeaseID, 256) || !validHash(r.RequestDigest) || r.Fence > 9007199254740991 {
			return fmt.Errorf("recovery tuple")
		}
	}
	return nil
}

// Verify verifies the exact raw bytes signed by the platform, then strict parses
// the shared DTO. A VerifiedTicket cannot be constructed outside this package.
func (v *Verifier) Verify(envelope []byte, actual PeerIdentity, challenge string) (*VerifiedTicket, error) {
	if len(envelope) > 24<<10 || len(v.Keys) == 0 || len(v.Keys) > 64 || len(v.Roots) == 0 || len(v.Roots) > 64 {
		return nil, fmt.Errorf("helper trust config/budget")
	}
	if actual != v.Session.Peer || actual.PID == 0 || actual.CreationTime == 0 || actual.ServiceSID == "" || actual.ExecutorInstance == "" {
		return nil, fmt.Errorf("unregistered actual pipe peer")
	}
	if err := rejectDuplicateJSON(envelope); err != nil {
		return nil, err
	}
	var signed SignedTicket
	decoder := json.NewDecoder(bytes.NewReader(envelope))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&signed); err != nil {
		return nil, err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return nil, fmt.Errorf("trailing envelope")
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(signed.Payload)
	if err != nil || len(raw) > 16<<10 {
		return nil, fmt.Errorf("ticket payload")
	}
	signature, err := base64.RawURLEncoding.Strict().DecodeString(signed.Signature)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return nil, fmt.Errorf("ticket signature")
	}
	// Never trust parsed issuer fields to add a key. Only pinned admin keys verify.
	var pinned *IssuerKey
	for i := range v.Keys {
		key := &v.Keys[i]
		if len(key.PublicKey) == ed25519.PublicKeySize && ed25519.Verify(key.PublicKey, raw, signature) {
			pinned = key
			break
		}
	}
	if pinned == nil {
		return nil, fmt.Errorf("untrusted ticket signature")
	}
	var t Ticket
	if err := strictJSON(raw, &t); err != nil {
		return nil, err
	}
	if err := t.Validate(); err != nil {
		return nil, err
	}
	if t.Issuer != pinned.Issuer || t.ServiceID != pinned.ServiceID || t.KeyEpoch != pinned.Epoch {
		return nil, fmt.Errorf("issuer binding")
	}
	s := v.Session
	if t.DeviceID != s.DeviceID || t.ExecutorSourceID != s.SourceID || t.HelperInstanceID != s.HelperInstanceID || t.ConnectionID != s.ConnectionID || t.SessionID != s.SessionID || t.RuntimeGeneration != s.Generation || challenge != t.ChallengeNonce {
		return nil, fmt.Errorf("helper session/challenge binding")
	}
	allowed := false
	for _, root := range v.Roots {
		if t.Root == root {
			allowed = true
		}
	}
	if !allowed || t.Target.VolumeID != t.Root.VolumeID || t.Parent.VolumeID != t.Root.VolumeID {
		return nil, fmt.Errorf("root/volume binding")
	}
	now := time.Now()
	if v.Now != nil {
		now = v.Now()
	}
	ms := uint64(now.UnixMilli())
	if ms < t.IssuedAt || ms >= t.ExpiresAt {
		return nil, fmt.Errorf("expired/future ticket")
	}
	stage := ""
	if v.RegisteredChallenge != nil {
		stage, err = v.RegisteredChallenge(t)
		if err != nil {
			return nil, err
		}
	} else if t.ChallengeNonce != s.ChallengeNonce {
		return nil, fmt.Errorf("helper-issued challenge not registered")
	}
	return &VerifiedTicket{ticket: t, digest: Digest(raw), raw: bytes.Clone(raw), stage: stage}, nil
}
func proofSignedBytes(p CaptureProof) ([]byte, error) {
	return CanonicalJSON(struct {
		Version          int    `json:"version"`
		HelperInstanceID string `json:"helperInstanceId"`
		KeyEpoch         uint64 `json:"keyEpoch"`
		RecordID         string `json:"recordId"`
		RecordNonce      string `json:"recordNonce"`
		RecordDigest     string `json:"recordDigest"`
	}{p.Version, p.HelperInstanceID, p.KeyEpoch, p.RecordID, p.RecordNonce, p.RecordDigest})
}
func VerifyProof(p CaptureProof, key ed25519.PublicKey) error {
	if p.Version != 1 || !validID(p.HelperInstanceID, 256) || !validID(p.RecordID, 256) || !validNonce(p.RecordNonce) || !validHash(p.RecordDigest) || p.KeyEpoch > 9007199254740991 {
		return fmt.Errorf("proof shape")
	}
	sig, err := base64.RawURLEncoding.Strict().DecodeString(p.Signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return fmt.Errorf("proof signature")
	}
	raw, err := proofSignedBytes(p)
	if err != nil {
		return err
	}
	if !ed25519.Verify(key, raw, sig) {
		return fmt.Errorf("proof authentication")
	}
	return nil
}
