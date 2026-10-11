//go:build windows

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

type firstCapturePipeTransport interface {
	firstPreauthorize(context.Context, FirstCaptureOrigin, FirstCapturePreauthorizeParams, string, uint64, *os.File) (firstCapturePipeOutcome, error)
	firstChallenge(context.Context, FirstCaptureOrigin, FirstCaptureParams, MetadataCallback, *os.File) (*MetadataCallback, error)
	firstExecute(context.Context, FirstCaptureOrigin, FirstCaptureParams, []byte, *os.File) (firstCapturePipeOutcome, error)
}

// Immutable enrollment/configuration shared by connections; every channel,
// Original closure, issuer and request sequence is constructed for one capture.
type FirstCaptureExecutor struct {
	enrollment    FirstCaptureEnrollment
	provider      FirstCaptureOrdinaryProvider
	pipe          firstCapturePipeTransport
	key           ed25519.PublicKey
	handles       *firstCaptureHandleRegistry
	configCurrent func(context.Context) error
}

func NewFirstCaptureExecutor(enrollment FirstCaptureEnrollment, provider FirstCaptureOrdinaryProvider, pipe *PipeClient, configCurrent func(context.Context) error) (*FirstCaptureExecutor, error) {
	if enrollment.Validate() != nil || provider == nil || pipe == nil || configCurrent == nil {
		return nil, ErrFirstCaptureNotReady
	}
	creation, err := parseFirstCaptureProcessCreation(enrollment.PipePeer.CreationTime)
	if err != nil {
		return nil, err
	}
	if pipe.Name != enrollment.PipePeer.Name || pipe.ServerPID != enrollment.PipePeer.ProcessID || pipe.ServerCreationTime != creation || pipe.ServerSID != enrollment.PipePeer.SID {
		return nil, ErrFirstCaptureNotReady
	}
	key, err := base64.RawURLEncoding.Strict().DecodeString(enrollment.HelperPublicKey)
	if err != nil {
		return nil, err
	}
	return &FirstCaptureExecutor{enrollment: enrollment, provider: provider, pipe: pipe, key: key, handles: newFirstCaptureHandleRegistry(), configCurrent: configCurrent}, nil
}
func (e *FirstCaptureExecutor) current(ctx context.Context, method string) (FirstCaptureOrigin, error) {
	origin, err := FirstCaptureRequest(ctx, method)
	if err != nil {
		return origin, err
	}
	if err := ctx.Err(); err != nil {
		return origin, err
	}
	if !e.enrollment.Matches(origin) {
		return origin, ErrFirstCaptureNotReady
	}
	control, err := MetadataControl(ctx)
	if err != nil || control.OuterRPCID != origin.OuterRPCID || control.Session.ConnectionID != origin.ConnectionID || control.Session.SessionID != origin.SessionID || control.Session.Generation != origin.RuntimeGeneration {
		return origin, ErrFirstCaptureNotReady
	}
	if err := e.configCurrent(ctx); err != nil {
		return origin, err
	}
	return origin, nil
}
func (e *FirstCaptureExecutor) Disconnect(connectionID string) error {
	return e.handles.invalidateConnection(connectionID)
}
func (e *FirstCaptureExecutor) Expire() error { return e.handles.expire() }
func (e *FirstCaptureExecutor) MetadataPreauthorize(ctx context.Context, params map[string]any) (any, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	o, err := e.current(ctx, FirstCapturePreauthorizeMethod)
	if err != nil {
		return nil, err
	}
	var p FirstCapturePreauthorizeParams
	if DecodeFirstCaptureParams(params, &p) != nil || p.Version != 1 || !validID(p.Path, 4096) || !validNonce(p.Nonce) {
		return nil, ErrFirstCaptureNotReady
	}
	_ = e.handles.expire()
	expires := time.Now().Add(firstCaptureTokenTTL)
	if deadline, ok := ctx.Deadline(); ok && deadline.Before(expires) {
		expires = deadline
	}
	l, token, err := e.handles.reserve(o.ConnectionID, o.stableDigest(), expires)
	if err != nil {
		return nil, err
	}
	raw, openErr := openFirstCaptureRaw(ctx, p.Path)
	if openErr != nil {
		var resources []io.Closer
		if raw != nil {
			resources = append(resources, raw)
		}
		_ = l.attach(resources)
		if raw != nil && l.state == "opened" {
			_ = l.beginDescribe()
			_ = l.finishDescribe(false)
		}
		return nil, openErr
	}
	l.file = raw.file
	pinned, pinErr := e.provider.PinOrdinary(ctx, o.Root, raw.file)
	resources := append([]io.Closer{raw}, pinned.Pins...)
	if !pinned.Terminal {
		l.retainUnknown(resources)
		return nil, fmt.Errorf("ordinary preauthorization native lifetime unknown")
	}
	if err := l.attach(resources); err != nil {
		return nil, err
	}
	if err := l.beginDescribe(); err != nil {
		return nil, err
	}
	if pinErr != nil {
		return nil, errors.Join(pinErr, l.finishDescribe(false))
	}
	out, pipeErr := e.pipe.firstPreauthorize(ctx, o, p, l.tokenDigest, uint64(expires.UnixMilli()), raw.file)
	if pipeErr != nil || ctx.Err() != nil {
		if out.Dispatched {
			l.retainUnknown(nil)
			return nil, errors.Join(pipeErr, ctx.Err(), fmt.Errorf("preauthorization helper lifetime unknown; retained"))
		}
		return nil, errors.Join(pipeErr, ctx.Err(), l.finishDescribe(false))
	}
	var attestation FirstCapturePreauthorization
	if err := verifyFirstCaptureEnvelope(out.Attestation, e.key, &attestation); err != nil {
		return nil, errors.Join(err, l.finishDescribe(false))
	}
	if attestation.Validate() != nil || attestation.Origin != o || attestation.PreauthNonce != p.Nonce || attestation.TokenDigest != l.tokenDigest || attestation.ExpiresAt > uint64(expires.UnixMilli()) || attestation.Descriptors != (CallbackDescriptors{pinned.Observation.Root, pinned.Observation.Parent, pinned.Observation.Target}) {
		return nil, errors.Join(ErrFirstCaptureNotReady, l.finishDescribe(false))
	}
	if _, err := e.current(ctx, FirstCapturePreauthorizeMethod); err != nil {
		return nil, errors.Join(err, l.finishDescribe(false))
	}
	l.recordPreauthorization(attestation, out.Attestation)
	if err := l.finishDescribe(true); err != nil {
		return nil, err
	}
	return FirstCapturePreauthorizeResult{1, token, out.Attestation}, nil
}

// Implements only capture; the other MetadataChannel methods cannot issue a
// ticket or invoke any native restore/status/prepared action through this seam.
type firstCaptureOnlyChannel struct {
	executor                                      *FirstCaptureExecutor
	origin                                        FirstCaptureOrigin
	params                                        FirstCaptureParams
	lease                                         *firstCaptureHandleLease
	result                                        FirstCaptureEnvelope
	nativeTerminal, resourcesTerminal, dispatched bool
	targetNativeStarted, helperActionStarted      bool
}

func (c *firstCaptureOnlyChannel) ApplyOriginal(context.Context, *os.File, *Descriptor) error {
	return ErrFirstCaptureNotReady
}
func (c *firstCaptureOnlyChannel) MatchesOriginal(context.Context, *os.File, *Descriptor) error {
	return ErrFirstCaptureNotReady
}
func (c *firstCaptureOnlyChannel) ValidateOriginal(context.Context, *Descriptor) error {
	return ErrFirstCaptureNotReady
}
func (c *firstCaptureOnlyChannel) Capture(ctx context.Context, file *os.File) (*Descriptor, error) {
	if file != c.lease.file {
		return nil, ErrFirstCaptureNotReady
	}
	target := c.lease.preauthorization.Descriptors
	bridge := firstCaptureOnlyChallenge{c}
	issuer := &CallbackTicketIssuer{Transport: bridge, HelperPublicKey: c.executor.key, Original: func(callCtx context.Context) (ChallengeOrigin, error) {
		o, err := c.executor.current(callCtx, FirstCaptureMethod)
		if err != nil || o != c.origin {
			return ChallengeOrigin{}, ErrFirstCaptureNotReady
		}
		return o.challengeOrigin(), nil
	}, Describe: func(callCtx context.Context, f *os.File, o ChallengeOrigin) (NativeObservation, error) {
		if f != file {
			return NativeObservation{}, ErrFirstCaptureNotReady
		}
		c.targetNativeStarted = true
		actual, err := c.executor.provider.InspectFirstCaptureOrdinary(callCtx, c.origin.Root, f)
		if err != nil || !actual.Terminal {
			return NativeObservation{}, errors.Join(err, ErrFirstCaptureNotReady)
		}
		if (CallbackDescriptors{actual.Observation.Root, actual.Observation.Parent, actual.Observation.Target}) != target {
			return NativeObservation{}, ErrFirstCaptureNotReady
		}
		return actual.Observation, nil
	}}
	ticket, err := issuer.IssueMetadataTicket(ctx, MetadataAuthorizationRequest{Action: "capture_exact", File: file})
	if err != nil {
		return nil, err
	}
	var envelope SignedTicket
	if json.Unmarshal(ticket, &envelope) != nil {
		return nil, ErrFirstCaptureNotReady
	}
	payload, err := decodeTicketPayload(envelope)
	if err != nil {
		return nil, err
	}
	var t Ticket
	if strictJSON(payload, &t) != nil || !c.origin.matchesTicket(t) || t.Root != target.Root || t.Parent != target.Parent || t.Target != target.Target {
		return nil, ErrFirstCaptureNotReady
	}
	if _, err := c.executor.current(ctx, FirstCaptureMethod); err != nil {
		return nil, err
	}
	c.helperActionStarted = true
	out, err := c.executor.pipe.firstExecute(ctx, c.origin, c.params, ticket, file)
	c.dispatched = out.Dispatched
	c.nativeTerminal = out.NativeTerminal
	c.resourcesTerminal = out.ResourcesTerminal
	if err != nil {
		return nil, err
	}
	var completed FirstCaptureResultPayload
	if verifyFirstCaptureEnvelope(out.Attestation, c.executor.key, &completed) != nil || completed.Validate(c.executor.key) != nil {
		return nil, fmt.Errorf("helper completed-domain attestation not authentic")
	}
	expectedActor := FirstCaptureTicketActor{t.ActorSubjectKey, t.NarratorID, t.ProjectID, t.OriginRefHash, t.Issuer, t.ServiceID, t.KeyEpoch}
	ref := FirstCapturePreauthorizationRef{c.params.PreauthRPCID, c.params.PreauthNonce, c.lease.tokenDigest, firstCaptureEnvelopeDigest(c.lease.preauthEnvelope)}
	if completed.Origin != c.origin || completed.Preauthorization != ref || completed.CaptureNonce != c.params.CaptureNonce || completed.ChallengeNonce != t.ChallengeNonce || completed.TicketPayloadDigest != Digest(payload) || !firstCaptureEqual(completed.TicketActor, expectedActor) || completed.Descriptor.Root != target.Root || completed.Descriptor.Parent != target.Parent || completed.Descriptor.Target != target.Target || !out.NativeTerminal || !out.ResourcesTerminal {
		return nil, fmt.Errorf("helper result differs from this exact original issued ticket/continuation")
	}
	if _, err := c.executor.current(ctx, FirstCaptureMethod); err != nil {
		return nil, err
	}
	c.result = out.Attestation
	return &completed.Descriptor, nil
}

type firstCaptureOnlyChallenge struct{ channel *firstCaptureOnlyChannel }

func (b firstCaptureOnlyChallenge) Challenge(ctx context.Context, o ChallengeOrigin, request MetadataCallback, file *os.File) (*MetadataCallback, error) {
	c := b.channel
	if file != c.lease.file || request.Action != "capture_exact" || o != c.origin.challengeOrigin() || request.OuterRPCID != c.origin.OuterRPCID {
		return nil, ErrFirstCaptureNotReady
	}
	c.helperActionStarted = true
	return c.executor.pipe.firstChallenge(ctx, c.origin, c.params, request, file)
}
func (e *FirstCaptureExecutor) MetadataCapture(ctx context.Context, params map[string]any) (any, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	o, err := e.current(ctx, FirstCaptureMethod)
	if err != nil {
		return nil, err
	}
	var p FirstCaptureParams
	if DecodeFirstCaptureParams(params, &p) != nil || p.Version != 1 || !validID(p.PreauthRPCID, 256) || !validNonce(p.PreauthNonce) || !validNonce(p.CaptureNonce) {
		return nil, ErrFirstCaptureNotReady
	}
	key, err := FirstCaptureTokenDigest(p.Token)
	if err != nil {
		return nil, err
	}
	r := e.handles
	r.mu.Lock()
	l := r.entries[key]
	valid := l != nil && l.preauthorization.Origin.OuterRPCID == p.PreauthRPCID && l.preauthorization.PreauthNonce == p.PreauthNonce
	r.mu.Unlock()
	if !valid {
		return nil, errFirstCaptureConsumed
	}
	l, err = r.claim(p.Token, o.ConnectionID, o.stableDigest(), o.OuterRPCID)
	if err != nil {
		return nil, err
	}
	channel := &firstCaptureOnlyChannel{executor: e, origin: o, params: p, lease: l}
	_, captureErr := channel.Capture(ctx, l.file)
	if captureErr != nil && !channel.targetNativeStarted && !channel.helperActionStarted {
		// Only private control flow before THIS request starts target native,
		// pin/description or IPC work can prove local no-dispatch. Neither an
		// error string, caller flag nor untrusted pipe bool can create this case.
		closeErr := l.finishCapture("rejected", true)
		return nil, errors.Join(captureErr, closeErr)
	}
	// An unreturned/undrained helper call is never made terminal by timeout.
	if !channel.nativeTerminal || !channel.resourcesTerminal {
		_ = l.finishCapture("unknown", false)
		return nil, errors.Join(captureErr, fmt.Errorf("first capture helper/native resource lifetime unknown"))
	}
	outcome := "captured"
	if captureErr != nil || ctx.Err() != nil {
		outcome = "unknown"
	}
	closeErr := l.finishCapture(outcome, true)
	if captureErr != nil || closeErr != nil || ctx.Err() != nil {
		return nil, errors.Join(captureErr, closeErr, ctx.Err())
	}
	if _, err := e.current(ctx, FirstCaptureMethod); err != nil {
		return nil, err
	}
	return FirstCaptureResult{1, channel.result}, nil
}
