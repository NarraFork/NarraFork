package windowsbackup

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strconv"
	"unicode/utf8"
)

// Frozen consumer of shared/windows-first-capture.ts. No raw metadata/body data.
const FirstCaptureFeature = "windows.metadata.first-capture.v1"
const FirstCapturePreauthorizeMethod = "history.metadataPreauthorize"
const FirstCaptureMethod = "history.metadataCapture"
const FirstCaptureOrdinaryAccess uint32 = 0x120189
const FirstCaptureEnvelopeBytes = 16 << 10
const FirstCapturePublicBytes = 64 << 10

var ErrFirstCaptureNotReady = errFirstCaptureUnavailable

type FirstCaptureOrigin struct {
	Version           int              `json:"version"`
	DeviceID          string           `json:"deviceId"`
	ExecutorSourceID  string           `json:"executorSourceId"`
	ScopeID           string           `json:"scopeId"`
	Root              NativeDescriptor `json:"root"`
	HelperInstanceID  string           `json:"helperInstanceId"`
	HelperKeyEpoch    uint64           `json:"helperKeyEpoch"`
	OperationID       string           `json:"operationId"`
	RequestDigest     string           `json:"requestDigest"`
	LeaseID           string           `json:"leaseId"`
	Fence             uint64           `json:"fence"`
	ConnectionID      string           `json:"connectionId"`
	SessionID         string           `json:"sessionId"`
	RuntimeGeneration uint64           `json:"runtimeGeneration"`
	Action            string           `json:"action"`
	Phase             string           `json:"phase"`
	OuterRPCID        string           `json:"outerRpcId"`
}
type FirstCapturePreauthorizeParams struct {
	Version int    `json:"version"`
	Path    string `json:"path"`
	Nonce   string `json:"nonce"`
}
type FirstCaptureParams struct {
	Version      int    `json:"version"`
	Token        string `json:"token"`
	PreauthRPCID string `json:"preauthRpcId"`
	PreauthNonce string `json:"preauthNonce"`
	CaptureNonce string `json:"captureNonce"`
}
type FirstCaptureEnvelope struct {
	Version   int    `json:"version"`
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}
type FirstCaptureOrdinaryFacts struct {
	GrantedAccess       uint32 `json:"grantedAccess"`
	RequiredAccess      uint32 `json:"requiredAccess"`
	SameAccessDuplicate bool   `json:"sameAccessDuplicate"`
	ObjectKind          string `json:"objectKind"`
	LinkCount           int    `json:"linkCount"`
	Reparse             bool   `json:"reparse"`
	AncestorPins        int    `json:"ancestorPins"`
	Observation         string `json:"observation"`
}
type FirstCapturePreauthorization struct {
	Domain           string                    `json:"domain"`
	Version          int                       `json:"version"`
	Origin           FirstCaptureOrigin        `json:"origin"`
	PreauthNonce     string                    `json:"preauthNonce"`
	TokenDigest      string                    `json:"tokenDigest"`
	IssuedAt         uint64                    `json:"issuedAt"`
	ExpiresAt        uint64                    `json:"expiresAt"`
	HelperInstanceID string                    `json:"helperInstanceId"`
	HelperKeyEpoch   uint64                    `json:"helperKeyEpoch"`
	Descriptors      CallbackDescriptors       `json:"descriptors"`
	OrdinaryHandle   FirstCaptureOrdinaryFacts `json:"ordinaryHandle"`
}
type FirstCapturePreauthorizeResult struct {
	Version     int                  `json:"version"`
	Token       string               `json:"token"`
	Attestation FirstCaptureEnvelope `json:"attestation"`
}
type FirstCapturePreauthorizationRef struct {
	OuterRPCID        string `json:"outerRpcId"`
	Nonce             string `json:"nonce"`
	TokenDigest       string `json:"tokenDigest"`
	AttestationDigest string `json:"attestationDigest"`
}
type FirstCaptureTicketActor struct {
	ActorSubjectKey string  `json:"actorSubjectKey"`
	NarratorID      *string `json:"narratorId"`
	ProjectID       *string `json:"projectId"`
	OriginRefHash   string  `json:"originRefHash"`
	Issuer          string  `json:"issuer"`
	ServiceID       string  `json:"serviceId"`
	KeyEpoch        uint64  `json:"keyEpoch"`
}
type FirstCaptureCompletion struct {
	State        string `json:"state"`
	RecordID     string `json:"recordId"`
	RecordDigest string `json:"recordDigest"`
}
type FirstCaptureResultPayload struct {
	Domain              string                          `json:"domain"`
	Version             int                             `json:"version"`
	Origin              FirstCaptureOrigin              `json:"origin"`
	Preauthorization    FirstCapturePreauthorizationRef `json:"preauthorization"`
	CaptureNonce        string                          `json:"captureNonce"`
	ChallengeNonce      string                          `json:"challengeNonce"`
	TicketPayloadDigest string                          `json:"ticketPayloadDigest"`
	TicketActor         FirstCaptureTicketActor         `json:"ticketActor"`
	HelperInstanceID    string                          `json:"helperInstanceId"`
	HelperKeyEpoch      uint64                          `json:"helperKeyEpoch"`
	Descriptor          Descriptor                      `json:"descriptor"`
	Completion          FirstCaptureCompletion          `json:"completion"`
}
type FirstCaptureResult struct {
	Version     int                  `json:"version"`
	Attestation FirstCaptureEnvelope `json:"attestation"`
}
type FirstCapturePipePin struct {
	Name         string `json:"name"`
	ProcessID    uint32 `json:"processId"`
	CreationTime string `json:"creationTime"`
	SID          string `json:"sid"`
}
type FirstCaptureEnrolledSession struct {
	ConnectionID      string `json:"connectionId"`
	SessionID         string `json:"sessionId"`
	RuntimeGeneration uint64 `json:"runtimeGeneration"`
}
type FirstCaptureEnrollment struct {
	Version          int                         `json:"version"`
	EnrollmentID     string                      `json:"enrollmentId"`
	Revision         uint64                      `json:"revision"`
	Matrix           string                      `json:"matrix"`
	DeviceID         string                      `json:"deviceId"`
	ExecutorSourceID string                      `json:"executorSourceId"`
	Root             NativeDescriptor            `json:"root"`
	HelperInstanceID string                      `json:"helperInstanceId"`
	HelperPublicKey  string                      `json:"helperPublicKey"`
	HelperKeyEpoch   uint64                      `json:"helperKeyEpoch"`
	PipePeer         FirstCapturePipePin         `json:"pipePeer"`
	Session          FirstCaptureEnrolledSession `json:"session"`
	Policy           string                      `json:"policy"`
}
type FirstCaptureEnrollmentInspection struct {
	Domain               string                 `json:"domain"`
	Version              int                    `json:"version"`
	Challenge            string                 `json:"challenge"`
	IssuedAt             uint64                 `json:"issuedAt"`
	BrokerServiceID      string                 `json:"brokerServiceId"`
	ConfigDigest         string                 `json:"configDigest"`
	EnrollmentFileDigest string                 `json:"enrollmentFileDigest"`
	Enrollment           FirstCaptureEnrollment `json:"enrollment"`
}

func validateFirstCaptureNative(d NativeDescriptor) error {
	if !validID(d.VolumeID, 256) || !validID(d.FileID, 256) || !validID(d.CreationTime, 256) || !validID(d.PathKey, 4096) {
		return ErrFirstCaptureNotReady
	}
	return nil
}
func (o FirstCaptureOrigin) Validate() error {
	if o.Version != 1 || o.Action != "capture_exact" || (o.Phase != "preauthorize" && o.Phase != "capture") {
		return ErrFirstCaptureNotReady
	}
	for _, id := range []string{o.DeviceID, o.ExecutorSourceID, o.ScopeID, o.HelperInstanceID, o.OperationID, o.LeaseID, o.ConnectionID, o.SessionID, o.OuterRPCID} {
		if !validID(id, 256) {
			return ErrFirstCaptureNotReady
		}
	}
	if !validHash(o.RequestDigest) {
		return ErrFirstCaptureNotReady
	}
	for _, n := range []uint64{o.HelperKeyEpoch, o.Fence, o.RuntimeGeneration} {
		if n > 9007199254740991 {
			return ErrFirstCaptureNotReady
		}
	}
	return validateFirstCaptureNative(o.Root)
}
func (o FirstCaptureOrigin) stableDigest() string {
	o.Phase = ""
	o.OuterRPCID = ""
	raw, _ := CanonicalJSON(o)
	return Digest(raw)
}
func (o FirstCaptureOrigin) challengeOrigin() ChallengeOrigin {
	return ChallengeOrigin{o.DeviceID, o.ExecutorSourceID, o.ScopeID, o.Root, o.OperationID, o.RequestDigest, o.LeaseID, o.Fence, o.RuntimeGeneration, o.HelperInstanceID, o.ConnectionID, o.SessionID}
}
func (o FirstCaptureOrigin) matchesTicket(t Ticket) bool {
	return originalMatchesTicket(o.challengeOrigin(), t) && t.Action == "capture_exact" && t.CaptureProofID == nil && t.PreparedObjectID == nil && t.RecoveryOriginal == nil && t.ExpectedCurrentMetadataHash == nil && t.ExpectedCurrentContentHash == nil
}
func (e FirstCaptureEnrollment) Validate() error {
	if e.Version != 2 || e.Matrix != "ordinary-file-v2" || e.Policy != "capture_only_existing_ordinary_v2" {
		return ErrFirstCaptureNotReady
	}
	for _, id := range []string{e.EnrollmentID, e.DeviceID, e.ExecutorSourceID, e.HelperInstanceID, e.PipePeer.Name, e.PipePeer.SID, e.Session.ConnectionID, e.Session.SessionID} {
		if !validID(id, 256) {
			return ErrFirstCaptureNotReady
		}
	}
	if e.Revision > 9007199254740991 || e.HelperKeyEpoch > 9007199254740991 || e.Session.RuntimeGeneration > 9007199254740991 || e.PipePeer.ProcessID == 0 {
		return ErrFirstCaptureNotReady
	}
	n, err := strconv.ParseUint(e.PipePeer.CreationTime, 10, 64)
	if err != nil || n == 0 || strconv.FormatUint(n, 10) != e.PipePeer.CreationTime {
		return ErrFirstCaptureNotReady
	}
	key, err := base64.RawURLEncoding.Strict().DecodeString(e.HelperPublicKey)
	if err != nil || len(key) != 32 {
		return ErrFirstCaptureNotReady
	}
	return validateFirstCaptureNative(e.Root)
}
func (e FirstCaptureEnrollment) Matches(o FirstCaptureOrigin) bool {
	return e.Validate() == nil && o.Validate() == nil && e.DeviceID == o.DeviceID && e.ExecutorSourceID == o.ExecutorSourceID && e.Root == o.Root && e.HelperInstanceID == o.HelperInstanceID && e.HelperKeyEpoch == o.HelperKeyEpoch && e.Session.ConnectionID == o.ConnectionID && e.Session.SessionID == o.SessionID && e.Session.RuntimeGeneration == o.RuntimeGeneration
}
func decodeFirstCapture(raw []byte, target any, limit int) error {
	if len(raw) == 0 || len(raw) > limit {
		return ErrFirstCaptureNotReady
	}
	return strictJSON(raw, target)
}
func verifyFirstCaptureEnvelope(envelope FirstCaptureEnvelope, key ed25519.PublicKey, target any) error {
	if envelope.Version != 1 || len(key) != 32 || len(envelope.Payload) == 0 || len(envelope.Payload) > FirstCapturePublicBytes-256 || len(envelope.Signature) != 86 {
		return ErrFirstCaptureNotReady
	}
	data, err := base64.RawURLEncoding.Strict().DecodeString(envelope.Payload)
	if err != nil {
		return ErrFirstCaptureNotReady
	}
	signature, err := base64.RawURLEncoding.Strict().DecodeString(envelope.Signature)
	if err != nil || len(signature) != 64 || !ed25519.Verify(key, data, signature) {
		return fmt.Errorf("first capture envelope signature invalid")
	}
	return decodeFirstCapture(data, target, FirstCapturePublicBytes)
}
func signFirstCaptureEnvelope(value any, key ed25519.PrivateKey) (FirstCaptureEnvelope, error) {
	var envelope FirstCaptureEnvelope
	if len(key) != 64 {
		return envelope, ErrFirstCaptureNotReady
	}
	raw, err := CanonicalJSON(value)
	if err != nil {
		return envelope, err
	}
	envelope = FirstCaptureEnvelope{1, base64.RawURLEncoding.EncodeToString(raw), base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, raw))}
	if len(envelope.Payload) > FirstCapturePublicBytes-256 {
		return FirstCaptureEnvelope{}, fmt.Errorf("first capture signed payload budget")
	}
	body, err := CanonicalJSON(envelope)
	if err != nil || len(body) > FirstCapturePublicBytes {
		return FirstCaptureEnvelope{}, fmt.Errorf("first capture signed envelope budget")
	}
	return envelope, nil
}
func (p FirstCapturePreauthorization) Validate() error {
	if p.Domain != "windows_metadata_preauthorization_v1" || p.Version != 1 || p.Origin.Validate() != nil || p.Origin.Phase != "preauthorize" || !validNonce(p.PreauthNonce) || !validHash(p.TokenDigest) || p.HelperInstanceID != p.Origin.HelperInstanceID || p.HelperKeyEpoch != p.Origin.HelperKeyEpoch {
		return ErrFirstCaptureNotReady
	}
	if p.IssuedAt > 9007199254740991 || p.ExpiresAt > 9007199254740991 || p.ExpiresAt <= p.IssuedAt || p.ExpiresAt-p.IssuedAt > 30000 {
		return ErrFirstCaptureNotReady
	}
	for _, d := range []NativeDescriptor{p.Descriptors.Root, p.Descriptors.Parent, p.Descriptors.Target} {
		if validateFirstCaptureNative(d) != nil || d.VolumeID != p.Origin.Root.VolumeID {
			return ErrFirstCaptureNotReady
		}
	}
	if p.Descriptors.Root != p.Origin.Root {
		return ErrFirstCaptureNotReady
	}
	f := p.OrdinaryHandle
	if f.RequiredAccess != FirstCaptureOrdinaryAccess || f.GrantedAccess&FirstCaptureOrdinaryAccess != FirstCaptureOrdinaryAccess || !f.SameAccessDuplicate || f.ObjectKind != "ordinary_regular" || f.LinkCount != 1 || f.Reparse || f.AncestorPins < 1 || f.AncestorPins > 64 || f.Observation != "describe_ordinary_no_read" {
		return ErrFirstCaptureNotReady
	}
	return nil
}
func (p FirstCaptureResultPayload) Validate(key ed25519.PublicKey) error {
	if p.Domain != "windows_metadata_capture_result_v1" || p.Version != 1 || p.Origin.Validate() != nil || p.Origin.Phase != "capture" || !validNonce(p.CaptureNonce) || !validNonce(p.ChallengeNonce) || !validHash(p.TicketPayloadDigest) || p.HelperInstanceID != p.Origin.HelperInstanceID || p.HelperKeyEpoch != p.Origin.HelperKeyEpoch {
		return ErrFirstCaptureNotReady
	}
	ref := p.Preauthorization
	if !validID(ref.OuterRPCID, 256) || !validNonce(ref.Nonce) || !validHash(ref.TokenDigest) || !validHash(ref.AttestationDigest) {
		return ErrFirstCaptureNotReady
	}
	a := p.TicketActor
	for _, id := range []string{a.ActorSubjectKey, a.Issuer, a.ServiceID} {
		if !validID(id, 256) {
			return ErrFirstCaptureNotReady
		}
	}
	for _, id := range []*string{a.NarratorID, a.ProjectID} {
		if id != nil && !validID(*id, 256) {
			return ErrFirstCaptureNotReady
		}
	}
	if !validHash(a.OriginRefHash) || a.KeyEpoch > 9007199254740991 {
		return ErrFirstCaptureNotReady
	}
	if p.Descriptor.Validate() != nil || p.Descriptor.Root != p.Origin.Root || p.Descriptor.Proof.HelperInstanceID != p.HelperInstanceID || p.Descriptor.Proof.KeyEpoch != p.HelperKeyEpoch || VerifyProof(p.Descriptor.Proof, key) != nil {
		return ErrFirstCaptureNotReady
	}
	if p.Completion.State != "captured" || !validID(p.Completion.RecordID, 256) || !validHash(p.Completion.RecordDigest) {
		return ErrFirstCaptureNotReady
	}
	return nil
}

// Frozen golden hashes the verified raw canonical payload, not its outer
// base64url envelope representation. Callers verify the envelope before use.
func firstCaptureEnvelopeDigest(envelope FirstCaptureEnvelope) string {
	raw, err := base64.RawURLEncoding.Strict().DecodeString(envelope.Payload)
	if err != nil {
		return ""
	}
	return Digest(raw)
}
func FirstCaptureTokenDigest(token string) (string, error) {
	if !validNonce(token) {
		return "", ErrFirstCaptureNotReady
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(token)
	if err != nil || len(raw) < 24 || len(raw) > 96 {
		return "", ErrFirstCaptureNotReady
	}
	return Digest(raw), nil
}
func canonicalFirstCaptureParams(params map[string]any, target any) error {
	raw, err := CanonicalJSON(params)
	if err != nil {
		return err
	}
	return decodeFirstCapture(raw, target, FirstCaptureEnvelopeBytes)
}
func firstCaptureEqual(a, b any) bool {
	x, e1 := CanonicalJSON(a)
	y, e2 := CanonicalJSON(b)
	return e1 == nil && e2 == nil && bytes.Equal(x, y)
}

type firstCaptureOriginContext struct {
	Origin          FirstCaptureOrigin
	Method, FrameID string
}
type firstCaptureOriginContextKey struct{}

func WithFirstCaptureRequest(ctx context.Context, method, frameID string, origin FirstCaptureOrigin) (context.Context, error) {
	phase := ""
	switch method {
	case FirstCapturePreauthorizeMethod:
		phase = "preauthorize"
	case FirstCaptureMethod:
		phase = "capture"
	default:
		return nil, ErrFirstCaptureNotReady
	}
	if origin.Validate() != nil || origin.Phase != phase || origin.OuterRPCID != frameID {
		return nil, ErrFirstCaptureNotReady
	}
	return context.WithValue(ctx, firstCaptureOriginContextKey{}, firstCaptureOriginContext{origin, method, frameID}), nil
}
func FirstCaptureRequest(ctx context.Context, method string) (FirstCaptureOrigin, error) {
	facts, ok := ctx.Value(firstCaptureOriginContextKey{}).(firstCaptureOriginContext)
	if !ok || facts.Method != method || facts.Origin.OuterRPCID != facts.FrameID || facts.Origin.Validate() != nil {
		return FirstCaptureOrigin{}, ErrFirstCaptureNotReady
	}
	return facts.Origin, nil
}

// Existing maps are converted with the same strict canonical rules. No params
// key can replace the independently installed envelope origin.
func DecodeFirstCaptureParams(params map[string]any, target any) error {
	return canonicalFirstCaptureParams(params, target)
}

// RPC frames may use ordinary JSON property order, unlike signed payloads.
// Reject duplicate/unknown/missing fields first, normalize order only, then
// compare the typed canonical object so missing zero/false fields cannot pass.
func DecodeFirstCaptureObject(raw []byte, target any, limit int) error {
	if len(raw) == 0 || len(raw) > limit || !utf8.Valid(raw) || rejectDuplicateJSON(raw) != nil {
		return ErrFirstCaptureNotReady
	}
	var object any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&object); err != nil {
		return ErrFirstCaptureNotReady
	}
	canonical, err := CanonicalJSON(object)
	if err != nil {
		return err
	}
	return strictJSON(canonical, target)
}
func parseFirstCaptureProcessCreation(value string) (uint64, error) {
	n, err := strconv.ParseUint(value, 10, 64)
	if err != nil || n == 0 || strconv.FormatUint(n, 10) != value {
		return 0, ErrFirstCaptureNotReady
	}
	return n, nil
}
func FirstCaptureOriginBytes(origin FirstCaptureOrigin) (json.RawMessage, error) {
	raw, err := CanonicalJSON(origin)
	return json.RawMessage(raw), err
}
