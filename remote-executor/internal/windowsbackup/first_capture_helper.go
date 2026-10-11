package windowsbackup

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"time"
)

// PinOrdinary must join any started native description before returning, even
// on cancellation. It never calls privilege/sentinel/SD/hash/Capture/payload IO.
// Facts come from actual handles, not caller JSON; Pins are independently owned.
type FirstCapturePinnedOrdinary struct {
	Observation   NativeObservation
	GrantedAccess uint32
	Pins          []io.Closer
	Terminal      bool
}
type FirstCaptureOrdinaryProvider interface {
	PinOrdinary(context.Context, NativeDescriptor, *os.File) (FirstCapturePinnedOrdinary, error)
	InspectFirstCaptureOrdinary(context.Context, NativeDescriptor, *os.File) (FirstCapturePinnedOrdinary, error)
}

func (h *Helper) firstCaptureOriginCurrent(peer PeerIdentity, o FirstCaptureOrigin) bool {
	if o.Validate() != nil || peer != h.Verifier.Session.Peer || o.HelperInstanceID != h.Store.config.HelperInstanceID || o.HelperKeyEpoch != h.Store.config.KeyEpoch {
		return false
	}
	s := h.Verifier.Session
	if o.DeviceID != s.DeviceID || o.ExecutorSourceID != s.SourceID || o.ConnectionID != s.ConnectionID || o.SessionID != s.SessionID || o.RuntimeGeneration != s.Generation {
		return false
	}
	for _, root := range h.Verifier.Roots {
		if root == o.Root {
			return true
		}
	}
	return false
}
func firstCaptureMasterKey(o FirstCaptureOrigin) string {
	return "first-capture-master-" + Digest([]byte(o.ExecutorSourceID+"\x00"+o.ScopeID+"\x00"+o.OperationID)) + ".json"
}
func (s *ProtectedStore) reserveFirstCaptureOriginal(o FirstCaptureOrigin, tokenDigest, preauthNonce string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := firstCaptureMasterKey(o)
	if _, err := s.read(key, 4096); err == nil {
		return fmt.Errorf("original first capture already registered; no result query or redispatch")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := s.charge(4096, true); err != nil {
		return err
	}
	return s.write(key, map[string]string{"bindingDigest": o.stableDigest(), "tokenDigest": tokenDigest, "preauthRpcId": o.OuterRPCID, "preauthNonce": preauthNonce, "state": "reserved"})
}

// The actual pipe adapter transfers duplicate ownership on admitted requests.
// Rejected-before-admission requests leave the file owned by that adapter.
func (h *Helper) preauthorizeFirstCapture(ctx context.Context, peer PeerIdentity, o FirstCaptureOrigin, params FirstCapturePreauthorizeParams, tokenDigest string, expiry uint64, file *os.File) (envelope FirstCaptureEnvelope, owned bool, resultErr error) {
	if !h.firstCaptureOriginCurrent(peer, o) || o.Phase != "preauthorize" || params.Version != 1 || !validID(params.Path, 4096) || !validNonce(params.Nonce) || !validHash(tokenDigest) || file == nil {
		return envelope, false, ErrFirstCaptureNotReady
	}
	provider, ok := h.Native.(FirstCaptureOrdinaryProvider)
	if !ok {
		return envelope, false, ErrFirstCaptureNotReady
	}
	if err := ctx.Err(); err != nil {
		return envelope, false, err
	}
	_ = h.firstCaptureHandles.expire()
	now := h.firstCaptureHandles.now()
	expires := time.UnixMilli(int64(expiry))
	l := firstPipeLease(ctx, "first_preauthorize")
	var err error
	if l == nil {
		l, err = h.firstCaptureHandles.reserveDigest(o.ConnectionID, o.stableDigest(), tokenDigest, expires)
	}
	if err != nil {
		return envelope, false, err
	}
	if l.tokenDigest != tokenDigest || l.bindingDigest != o.stableDigest() {
		return envelope, false, ErrFirstCaptureNotReady
	}
	owned = true
	l.file = file
	// Store reservation before native description. A lost response cannot mint
	// a different preauth/capture ID for this original operation after restart.
	if err := h.Store.reserveFirstCaptureOriginal(o, tokenDigest, params.Nonce); err != nil {
		_ = l.attach([]io.Closer{file})
		_ = l.beginDescribe()
		closeErr := l.finishDescribe(false)
		return envelope, true, errors.Join(err, closeErr)
	}
	description, describeErr := provider.PinOrdinary(ctx, o.Root, file)
	resources := append([]io.Closer{file}, description.Pins...)
	if !description.Terminal {
		r := l.registry
		r.mu.Lock()
		l.resources = resources
		l.state = "unknown"
		l.busy = true
		r.mu.Unlock()
		return envelope, true, fmt.Errorf("ordinary preauthorization lifetime unknown; resources retained")
	}
	if err := l.attach(resources); err != nil {
		return envelope, true, err
	}
	if err := l.beginDescribe(); err != nil {
		return envelope, true, err
	}
	if describeErr != nil {
		return envelope, true, errors.Join(describeErr, l.finishDescribe(false))
	}
	p := FirstCapturePreauthorization{Domain: "windows_metadata_preauthorization_v1", Version: 1, Origin: o, PreauthNonce: params.Nonce, TokenDigest: tokenDigest, IssuedAt: uint64(now.UnixMilli()), ExpiresAt: expiry, HelperInstanceID: h.Store.config.HelperInstanceID, HelperKeyEpoch: h.Store.config.KeyEpoch, Descriptors: CallbackDescriptors{description.Observation.Root, description.Observation.Parent, description.Observation.Target}, OrdinaryHandle: FirstCaptureOrdinaryFacts{GrantedAccess: description.GrantedAccess, RequiredAccess: FirstCaptureOrdinaryAccess, SameAccessDuplicate: true, ObjectKind: "ordinary_regular", LinkCount: 1, Reparse: false, AncestorPins: len(description.Pins), Observation: "describe_ordinary_no_read"}}
	if p.Validate() != nil || description.Observation.MetadataHash != "" || description.Observation.ContentHash != "" || ctx.Err() != nil {
		return envelope, true, errors.Join(ErrFirstCaptureNotReady, l.finishDescribe(false))
	}
	envelope, err = signFirstCaptureEnvelope(p, h.Store.config.SigningKey)
	if err != nil {
		return FirstCaptureEnvelope{}, true, errors.Join(err, l.finishDescribe(false))
	}
	h.Store.mu.Lock()
	err = h.Store.writeImmutable("first-preauth-"+tokenDigest+".json", envelope)
	h.Store.mu.Unlock()
	if err != nil {
		return FirstCaptureEnvelope{}, true, errors.Join(err, l.finishDescribe(false))
	}
	l.recordPreauthorization(p, envelope)
	if err := l.finishDescribe(true); err != nil {
		return FirstCaptureEnvelope{}, true, err
	}
	return envelope, true, nil
}

func (h *Helper) firstCaptureResultFromPrivate(ctx context.Context, o FirstCaptureOrigin, params FirstCaptureParams, l *firstCaptureHandleLease, v *VerifiedTicket, op *OperationResult) (FirstCaptureEnvelope, error) {
	var empty FirstCaptureEnvelope
	if ctx.Err() != nil || op == nil || op.State != "captured" || op.Proof == nil || op.Descriptor == nil || v == nil || !o.matchesTicket(v.ticket) || op.TicketDigest != v.digest || !firstCaptureEqual(op.Ticket, v.ticket) || !l.resourcesTerminal || !l.nativeTerminal {
		return empty, fmt.Errorf("first capture completion lacks original durable/terminal evidence")
	}
	// Re-load the completed private operation. Public/client-supplied descriptor
	// and old valid proofs are never inputs to the signing authority.
	raw, err := h.Store.read(operationKey(v.ticket, v.stage), 64<<10)
	if err != nil {
		return empty, err
	}
	var durable OperationResult
	if err := json.Unmarshal(raw, &durable); err != nil || durable.State != "captured" || durable.TicketDigest != v.digest || durable.Proof == nil || durable.Descriptor == nil || !firstCaptureEqual(durable, op) {
		return empty, fmt.Errorf("first capture private Complete not proven")
	}
	original, err := h.Store.loadCapture(*durable.Proof)
	if err != nil {
		return empty, err
	}
	if !firstCaptureEqual(original.Ticket, v.ticket) {
		return empty, fmt.Errorf("first capture proof belongs to another verified ticket")
	}
	projection, err := descriptorFromSnapshot(original.Ticket, original.Snapshot, original.ContentHash, *durable.Proof)
	if err != nil || !firstCaptureEqual(projection, durable.Descriptor) {
		return empty, fmt.Errorf("first capture private descriptor projection differs")
	}
	registrationRaw, err := h.Store.read("challenge-"+Digest([]byte(v.ticket.ChallengeNonce))+".json", 32<<10)
	if err != nil {
		return empty, err
	}
	var registration RegisteredChallenge
	if json.Unmarshal(registrationRaw, &registration) != nil || registration.Request.OuterRPCID != o.OuterRPCID || registration.Request.Action != "capture_exact" {
		return empty, fmt.Errorf("capture challenge is not this current pending RPC")
	}
	t := v.ticket
	payload := FirstCaptureResultPayload{Domain: "windows_metadata_capture_result_v1", Version: 1, Origin: o, Preauthorization: FirstCapturePreauthorizationRef{OuterRPCID: l.preauthorization.Origin.OuterRPCID, Nonce: l.preauthorization.PreauthNonce, TokenDigest: l.tokenDigest, AttestationDigest: firstCaptureEnvelopeDigest(l.preauthEnvelope)}, CaptureNonce: params.CaptureNonce, ChallengeNonce: t.ChallengeNonce, TicketPayloadDigest: v.digest, TicketActor: FirstCaptureTicketActor{t.ActorSubjectKey, t.NarratorID, t.ProjectID, t.OriginRefHash, t.Issuer, t.ServiceID, t.KeyEpoch}, HelperInstanceID: h.Store.config.HelperInstanceID, HelperKeyEpoch: h.Store.config.KeyEpoch, Descriptor: *projection, Completion: FirstCaptureCompletion{State: "captured", RecordID: "first-capture-" + l.tokenDigest, RecordDigest: Digest(raw)}}
	if payload.Validate(h.Store.config.SigningKey.Public().(ed25519.PublicKey)) != nil {
		return empty, ErrFirstCaptureNotReady
	}
	result, err := signFirstCaptureEnvelope(payload, h.Store.config.SigningKey)
	if err != nil {
		return empty, err
	}
	h.Store.mu.Lock()
	err = h.Store.writeImmutable("first-capture-result-"+l.tokenDigest+".json", result)
	h.Store.mu.Unlock()
	if err != nil || ctx.Err() != nil {
		return empty, errors.Join(err, ctx.Err())
	}
	return result, nil
}

// Helper.Execute's original complete capture pipeline is invoked exactly once,
// unmodified. This wrapper owns both the retained preauth duplicate/pins and the
// new same-access capture duplicate, and signs only after their real closes.
func (h *Helper) executeFirstCapture(ctx context.Context, peer PeerIdentity, o FirstCaptureOrigin, params FirstCaptureParams, ticket []byte, file *os.File) (result FirstCaptureEnvelope, owned, nativeTerminal, resourcesTerminal bool, resultErr error) {
	if !h.firstCaptureOriginCurrent(peer, o) || o.Phase != "capture" || params.Version != 1 || !validNonce(params.Token) || !validID(params.PreauthRPCID, 256) || !validNonce(params.PreauthNonce) || !validNonce(params.CaptureNonce) || file == nil {
		return result, false, true, false, ErrFirstCaptureNotReady
	}
	key, err := FirstCaptureTokenDigest(params.Token)
	if err != nil {
		return result, false, true, false, err
	}
	r := h.firstCaptureHandles
	r.mu.Lock()
	l := r.entries[key]
	if l == nil || l.preauthorization.Origin.OuterRPCID != params.PreauthRPCID || l.preauthorization.PreauthNonce != params.PreauthNonce || l.preauthorization.Origin.stableDigest() != o.stableDigest() {
		r.mu.Unlock()
		return result, false, true, false, errFirstCaptureConsumed
	}
	r.mu.Unlock()
	preclaimed := firstPipeLease(ctx, "first_capture")
	if preclaimed == nil {
		l, err = r.claim(params.Token, o.ConnectionID, o.stableDigest(), o.OuterRPCID)
	} else if preclaimed != l || l.state != "capturing" || l.captureRPC != o.OuterRPCID {
		err = errFirstCaptureConsumed
	}
	if err != nil {
		return result, false, true, false, err
	}
	owned = true
	// The pipe transfers duplicate ownership before dispatch; in-process tests
	// and explicit native callers attach the same new duplicate here.
	if preclaimed == nil {
		l.resources = append(l.resources, file)
	}
	provider := h.Native.(FirstCaptureOrdinaryProvider)
	check, checkErr := provider.InspectFirstCaptureOrdinary(ctx, o.Root, file)
	if len(check.Pins) != 0 {
		l.resources = append(l.resources, check.Pins...)
		checkErr = errors.Join(checkErr, fmt.Errorf("capture reinspection must not allocate another ancestor pin set"))
	}
	if !check.Terminal {
		_ = l.finishCapture("unknown", false)
		return result, true, false, false, fmt.Errorf("first capture ordinary verification lifetime unknown")
	}
	if checkErr != nil || check.GrantedAccess&FirstCaptureOrdinaryAccess != FirstCaptureOrdinaryAccess || (CallbackDescriptors{check.Observation.Root, check.Observation.Parent, check.Observation.Target}) != l.preauthorization.Descriptors {
		closeErr := l.finishCapture("rejected", true)
		return result, true, true, l.resourcesTerminal, errors.Join(ErrFirstCaptureNotReady, checkErr, closeErr)
	}
	v, err := h.Verifier.Verify(ticket, peer, extractFirstCaptureChallenge(ticket))
	if err != nil || !o.matchesTicket(vTicket(v)) {
		closeErr := l.finishCapture("rejected", true)
		return result, true, true, l.resourcesTerminal, errors.Join(ErrFirstCaptureNotReady, err, closeErr)
	}
	if ctx.Err() != nil {
		closeErr := l.finishCapture("rejected", true)
		return result, true, true, l.resourcesTerminal, errors.Join(ctx.Err(), closeErr)
	}
	challengeRaw, challengeErr := h.Store.read("challenge-"+Digest([]byte(v.ticket.ChallengeNonce))+".json", 32<<10)
	var challengeRegistration RegisteredChallenge
	if challengeErr != nil || json.Unmarshal(challengeRaw, &challengeRegistration) != nil || challengeRegistration.Request.OuterRPCID != o.OuterRPCID || challengeRegistration.Request.Action != "capture_exact" {
		closeErr := l.finishCapture("rejected", true)
		return result, true, true, l.resourcesTerminal, errors.Join(fmt.Errorf("first capture ticket challenge belongs to another pending RPC"), closeErr)
	}
	op, executeErr := h.Execute(ctx, ticket, peer, v.ticket.ChallengeNonce, l.file, nil)
	if ctx.Err() != nil {
		_ = l.finishCapture("unknown", false)
		return result, true, false, false, errors.Join(executeErr, ctx.Err())
	}
	nativeTerminal = true
	outcome := "unknown"
	if executeErr == nil && op != nil && op.State == "captured" {
		outcome = "captured"
	} else if op != nil && op.State == "rejected" {
		outcome = "rejected"
	}
	closeErr := l.finishCapture(outcome, true)
	resourcesTerminal = l.resourcesTerminal
	if executeErr != nil || closeErr != nil || outcome != "captured" {
		return result, true, true, resourcesTerminal, errors.Join(executeErr, closeErr, fmt.Errorf("first capture did not prove captured"))
	}
	result, err = h.firstCaptureResultFromPrivate(ctx, o, params, l, v, op)
	return result, true, true, resourcesTerminal, err
}
func decodeTicketPayload(envelope SignedTicket) ([]byte, error) {
	raw, err := base64.RawURLEncoding.Strict().DecodeString(envelope.Payload)
	if err != nil || len(raw) > 16<<10 {
		return nil, ErrFirstCaptureNotReady
	}
	return raw, nil
}
func vTicket(v *VerifiedTicket) Ticket {
	if v == nil {
		return Ticket{}
	}
	return v.ticket
}
func extractFirstCaptureChallenge(ticket []byte) string {
	var envelope SignedTicket
	if json.Unmarshal(ticket, &envelope) != nil {
		return ""
	}
	raw, err := decodeTicketPayload(envelope)
	if err != nil {
		return ""
	}
	var t Ticket
	if strictJSON(raw, &t) != nil {
		return ""
	}
	return t.ChallengeNonce
}
