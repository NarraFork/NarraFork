package windowsbackup

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"sync/atomic"
)

type ChallengeTransport interface {
	Challenge(context.Context, ChallengeOrigin, MetadataCallback, *os.File) (*MetadataCallback, error)
}

// CallbackTicketIssuer relays only helper-attested native facts to the existing
// authenticated outer RPC. Main supplies Original from frozen admission, not any
// actor/source/PID claims on callback wire. No signing key is held by the executor.
type CallbackTicketIssuer struct {
	Transport       ChallengeTransport
	Original        func(context.Context) (ChallengeOrigin, error)
	Describe        func(context.Context, *os.File, ChallengeOrigin) (NativeObservation, error)
	HelperPublicKey ed25519.PublicKey
	sequence        atomic.Uint64
}

func (i *CallbackTicketIssuer) IssueMetadataTicket(ctx context.Context, input MetadataAuthorizationRequest) ([]byte, error) {
	facts, err := MetadataControl(ctx)
	if err != nil {
		return nil, err
	}
	if i.Transport == nil || i.Original == nil || i.Describe == nil || len(i.HelperPublicKey) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("helper-attested metadata callback configuration not ready")
	}
	origin, err := i.Original(ctx)
	if err != nil {
		return nil, err
	}
	if origin.ConnectionID != facts.Session.ConnectionID || origin.SessionID != facts.Session.SessionID || origin.RuntimeGeneration != facts.Session.Generation {
		return nil, fmt.Errorf("outer metadata session facts changed")
	}
	var observed NativeObservation
	if input.File != nil {
		observed, err = i.Describe(ctx, input.File, origin)
		if err != nil {
			return nil, err
		}
	} else if input.Original != nil {
		observed = NativeObservation{Root: input.Original.Root, Parent: input.Original.Parent, Target: input.Original.Target}
	} else {
		return nil, fmt.Errorf("ordinary metadata object unavailable")
	}
	var entropy [32]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return nil, err
	}
	nonce := base64.RawURLEncoding.EncodeToString(entropy[:])
	request := MetadataCallback{Type: "windows_metadata_callback", Version: 1, OuterRPCID: facts.OuterRPCID, StepID: fmt.Sprintf("%s-%d", input.Action, i.sequence.Add(1)), Nonce: nonce, Action: input.Action, Descriptors: CallbackDescriptors{observed.Root, observed.Parent, observed.Target}}
	if input.Original != nil {
		value := input.Original.Proof.RecordID
		request.ProofIDs.CaptureProofID = &value
	}
	if input.Prepared != nil {
		value := input.Prepared.Proof.RecordID
		request.ProofIDs.PreparedObjectID = &value
		metadata := input.Prepared.MetadataDigest
		content := input.Prepared.ContentDigest
		request.ExpectedCurrent = CallbackCurrent{&metadata, &content}
	}
	if input.Action == "status_original" && input.Original != nil {
		request.Descriptors = CallbackDescriptors{input.Original.Root, input.Original.Parent, input.Original.Target}
	}
	attested, err := i.Transport.Challenge(ctx, origin, request, input.File)
	if err != nil {
		return nil, err
	}
	if attested == nil {
		return nil, fmt.Errorf("helper challenge unavailable")
	}
	signed, err := challengeSignedBytes(*attested, origin)
	if err != nil {
		return nil, err
	}
	signature, err := base64.RawURLEncoding.Strict().DecodeString(attested.HelperChallenge.Signature)
	if err != nil || !ed25519.Verify(i.HelperPublicKey, signed, signature) {
		return nil, fmt.Errorf("helper challenge signature invalid")
	}
	canonical, err := CanonicalJSON(attested)
	if err != nil || len(canonical) > 16<<10 {
		return nil, fmt.Errorf("metadata callback budget")
	}
	response, err := facts.Send(ctx, canonical)
	if err != nil {
		return nil, err
	}
	if len(response) > 25<<10 {
		return nil, fmt.Errorf("metadata callback response budget")
	}
	var result struct {
		Type       string       `json:"type"`
		Version    int          `json:"version"`
		OuterRPCID string       `json:"outerRpcId"`
		StepID     string       `json:"stepId"`
		Nonce      string       `json:"nonce"`
		Ticket     SignedTicket `json:"ticket"`
	}
	if err := strictJSON(response, &result); err != nil {
		return nil, err
	}
	if result.Type != "windows_metadata_callback_result" || result.Version != 1 || result.OuterRPCID != request.OuterRPCID || result.StepID != request.StepID || result.Nonce != nonce {
		return nil, fmt.Errorf("metadata callback original operation correlation changed")
	}
	return json.Marshal(result.Ticket)
}
