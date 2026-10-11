package windowsbackup

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
)

type ChallengeOrigin struct {
	DeviceID          string           `json:"deviceId"`
	ExecutorSourceID  string           `json:"executorSourceId"`
	ScopeID           string           `json:"scopeId"`
	Root              NativeDescriptor `json:"root"`
	OperationID       string           `json:"operationId"`
	RequestDigest     string           `json:"requestDigest"`
	LeaseID           string           `json:"leaseId"`
	Fence             uint64           `json:"fence"`
	RuntimeGeneration uint64           `json:"runtimeGeneration"`
	HelperInstanceID  string           `json:"helperInstanceId"`
	ConnectionID      string           `json:"connectionId"`
	SessionID         string           `json:"sessionId"`
}
type HelperChallenge struct {
	HelperInstanceID  string `json:"helperInstanceId"`
	KeyEpoch          uint64 `json:"keyEpoch"`
	ChallengeNonce    string `json:"challengeNonce"`
	ConnectionID      string `json:"connectionId"`
	SessionID         string `json:"sessionId"`
	RuntimeGeneration uint64 `json:"runtimeGeneration"`
	Signature         string `json:"signature"`
}
type CallbackDescriptors struct {
	Root   NativeDescriptor `json:"root"`
	Parent NativeDescriptor `json:"parent"`
	Target NativeDescriptor `json:"target"`
}
type CallbackProofs struct {
	CaptureProofID   *string `json:"captureProofId"`
	PreparedObjectID *string `json:"preparedObjectId"`
}
type CallbackCurrent struct {
	MetadataHash *string `json:"metadataHash"`
	ContentHash  *string `json:"contentHash"`
}
type MetadataCallback struct {
	Type            string              `json:"type"`
	Version         int                 `json:"version"`
	OuterRPCID      string              `json:"outerRpcId"`
	StepID          string              `json:"stepId"`
	Nonce           string              `json:"nonce"`
	Action          string              `json:"action"`
	HelperChallenge HelperChallenge     `json:"helperChallenge"`
	Descriptors     CallbackDescriptors `json:"descriptors"`
	ProofIDs        CallbackProofs      `json:"proofIds"`
	ExpectedCurrent CallbackCurrent     `json:"expectedCurrent"`
}
type RegisteredChallenge struct {
	Version  int
	Origin   ChallengeOrigin
	Request  MetadataCallback
	StageKey string
}

func challengeSignedBytes(request MetadataCallback, original ChallengeOrigin) ([]byte, error) {
	noSignature := map[string]any{"helperInstanceId": request.HelperChallenge.HelperInstanceID, "keyEpoch": request.HelperChallenge.KeyEpoch, "challengeNonce": request.HelperChallenge.ChallengeNonce, "connectionId": request.HelperChallenge.ConnectionID, "sessionId": request.HelperChallenge.SessionID, "runtimeGeneration": request.HelperChallenge.RuntimeGeneration}
	fields := map[string]any{"type": request.Type, "version": request.Version, "outerRpcId": request.OuterRPCID, "stepId": request.StepID, "nonce": request.Nonce, "action": request.Action, "helperChallenge": noSignature, "descriptors": request.Descriptors, "proofIds": request.ProofIDs, "expectedCurrent": request.ExpectedCurrent}
	return CanonicalJSON(map[string]any{"domain": "windows_metadata_callback_challenge_v1", "original": original, "request": fields})
}
func originalMatchesTicket(o ChallengeOrigin, t Ticket) bool {
	return o.DeviceID == t.DeviceID && o.ExecutorSourceID == t.ExecutorSourceID && o.ScopeID == t.ScopeID && o.Root == t.Root && o.OperationID == t.OperationID && o.RequestDigest == t.RequestDigest && o.LeaseID == t.LeaseID && o.Fence == t.Fence && o.RuntimeGeneration == t.RuntimeGeneration && o.HelperInstanceID == t.HelperInstanceID && o.ConnectionID == t.ConnectionID && o.SessionID == t.SessionID
}

// AttestChallenge only signs a descriptor already proved by the native IPC
// adapter from the ordinary duplicate handle. It does no ACL mutation and carries
// no actor assertions. Original comes from the bound authenticated outer context.
func (s *ProtectedStore) AttestChallenge(ctx context.Context, original ChallengeOrigin, request MetadataCallback, observed NativeObservation) (*MetadataCallback, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if request.Type != "windows_metadata_callback" || request.Version != 1 || !validID(request.OuterRPCID, 256) || !validID(request.StepID, 256) || !validNonce(request.Nonce) || original.HelperInstanceID != s.config.HelperInstanceID || request.Descriptors.Root != original.Root || observed.Root != request.Descriptors.Root || observed.Parent != request.Descriptors.Parent || observed.Target != request.Descriptors.Target {
		return nil, fmt.Errorf("native callback descriptor/original binding")
	}
	var entropy [32]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return nil, err
	}
	request.HelperChallenge = HelperChallenge{HelperInstanceID: s.config.HelperInstanceID, KeyEpoch: s.config.KeyEpoch, ChallengeNonce: base64.RawURLEncoding.EncodeToString(entropy[:]), ConnectionID: original.ConnectionID, SessionID: original.SessionID, RuntimeGeneration: original.RuntimeGeneration}
	stage, err := challengeStage(original, request)
	if err != nil {
		return nil, err
	}
	record := RegisteredChallenge{Version: 2, Origin: original, Request: request, StageKey: stage}
	bytes, err := challengeSignedBytes(request, original)
	if err != nil || len(bytes) > 16<<10 {
		return nil, fmt.Errorf("callback challenge budget")
	}
	request.HelperChallenge.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(s.config.SigningKey, bytes))
	record.Request = request
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.charge(16<<10, true); err != nil {
		return nil, err
	}
	if err := s.write("challenge-"+Digest([]byte(request.HelperChallenge.ChallengeNonce))+".json", record); err != nil {
		return nil, err
	}
	return &request, nil
}
func challengeStage(origin ChallengeOrigin, request MetadataCallback) (string, error) {
	// Proofs are immutable intent, NOT stage identity. Changing a proof must
	// conflict with the old stage, not mint a second mutation of the same object.
	target := request.Descriptors.Target
	// Creation is restored by this action. It remains exact signed intent, but
	// must not create a second mutation stage after our own successful restore.
	target.CreationTime = ""
	data, err := CanonicalJSON(map[string]any{"source": origin.ExecutorSourceID, "scope": origin.ScopeID, "operationId": origin.OperationID, "action": request.Action, "root": request.Descriptors.Root, "parent": request.Descriptors.Parent, "target": target})
	if err != nil {
		return "", err
	}
	if request.Action == "capture_exact" || request.Action == "status_original" {
		data = append(data, []byte("\x00"+request.StepID+"\x00"+request.Nonce)...)
	}
	return Digest(data), nil
}
func (s *ProtectedStore) RegisteredStage(t Ticket) (string, error) {
	raw, err := s.read("challenge-"+Digest([]byte(t.ChallengeNonce))+".json", 32<<10)
	if err != nil {
		return "", fmt.Errorf("helper-issued challenge not registered")
	}
	var registration RegisteredChallenge
	if err := json.Unmarshal(raw, &registration); err != nil {
		return "", err
	}
	request := registration.Request
	if registration.Version != 2 || !originalMatchesTicket(registration.Origin, t) || request.Action != t.Action || request.Descriptors.Root != t.Root || request.Descriptors.Parent != t.Parent || request.Descriptors.Target != t.Target || !nullableEqual(request.ProofIDs.CaptureProofID, t.CaptureProofID) || !nullableEqual(request.ProofIDs.PreparedObjectID, t.PreparedObjectID) || !nullableEqual(request.ExpectedCurrent.MetadataHash, t.ExpectedCurrentMetadataHash) || !nullableEqual(request.ExpectedCurrent.ContentHash, t.ExpectedCurrentContentHash) {
		return "", fmt.Errorf("helper challenge stage binding changed")
	}
	signed, err := challengeSignedBytes(request, registration.Origin)
	if err != nil {
		return "", err
	}
	sig, err := base64.RawURLEncoding.DecodeString(request.HelperChallenge.Signature)
	if err != nil || !ed25519.Verify(s.config.SigningKey.Public().(ed25519.PublicKey), signed, sig) {
		return "", fmt.Errorf("persisted helper challenge signature")
	}
	stage, err := challengeStage(registration.Origin, request)
	if err != nil || stage != registration.StageKey || request.HelperChallenge.HelperInstanceID != s.config.HelperInstanceID || request.HelperChallenge.KeyEpoch != s.config.KeyEpoch || request.HelperChallenge.ChallengeNonce != t.ChallengeNonce || request.HelperChallenge.ConnectionID != t.ConnectionID || request.HelperChallenge.SessionID != t.SessionID || request.HelperChallenge.RuntimeGeneration != t.RuntimeGeneration {
		return "", fmt.Errorf("persisted helper challenge stage/session changed")
	}
	return stage, nil
}
