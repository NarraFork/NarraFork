package windowsbackup

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"time"
)

type firstPipeAdmission struct {
	lease     *firstCaptureHandleLease
	operation string
	duplicate *os.File
}
type firstPipeAdmissionKey struct{}

func (h *Helper) admitFirstPipe(ctx context.Context, peer PeerIdentity, operation string, o FirstCaptureOrigin, pre *FirstCapturePreauthorizeParams, capture *FirstCaptureParams, tokenDigest string, expiry uint64) (context.Context, *firstPipeAdmission, error) {
	if !h.firstCaptureOriginCurrent(peer, o) || ctx.Err() != nil {
		return nil, nil, ErrFirstCaptureNotReady
	}
	_ = h.firstCaptureHandles.expire()
	a := &firstPipeAdmission{operation: operation}
	if operation == "first_preauthorize" {
		if o.Phase != "preauthorize" || pre == nil || capture != nil || pre.Version != 1 || !validID(pre.Path, 4096) || !validNonce(pre.Nonce) || !validHash(tokenDigest) || expiry > 9007199254740991 {
			return nil, nil, ErrFirstCaptureNotReady
		}
		l, err := h.firstCaptureHandles.reserveDigest(o.ConnectionID, o.stableDigest(), tokenDigest, time.UnixMilli(int64(expiry)))
		if err != nil {
			return nil, nil, err
		}
		a.lease = l
	} else {
		if o.Phase != "capture" || capture == nil || pre != nil || capture.Version != 1 || !validID(capture.PreauthRPCID, 256) || !validNonce(capture.PreauthNonce) || !validNonce(capture.CaptureNonce) {
			return nil, nil, ErrFirstCaptureNotReady
		}
		key, err := FirstCaptureTokenDigest(capture.Token)
		if err != nil {
			return nil, nil, err
		}
		r := h.firstCaptureHandles
		r.mu.Lock()
		l := r.entries[key]
		if l == nil || !l.currentLocked() || l.state != "described" || l.busy || l.preauthorization.Origin.OuterRPCID != capture.PreauthRPCID || l.preauthorization.PreauthNonce != capture.PreauthNonce || l.bindingDigest != o.stableDigest() {
			r.mu.Unlock()
			return nil, nil, errFirstCaptureConsumed
		}
		if l.challengeRPC != "" && (l.challengeRPC != o.OuterRPCID || l.challengeCaptureNonce != capture.CaptureNonce) {
			r.mu.Unlock()
			return nil, nil, errFirstCaptureConsumed
		}
		l.challengeRPC = o.OuterRPCID
		l.challengeCaptureNonce = capture.CaptureNonce
		switch operation {
		case "first_capture_challenge":
			l.state = "challenging"
			l.busy = true
		case "first_capture":
			l.state = "capturing"
			l.busy = true
			l.captureRPC = o.OuterRPCID
		default:
			r.mu.Unlock()
			return nil, nil, ErrFirstCaptureNotReady
		}
		r.mu.Unlock()
		a.lease = l
	}
	return context.WithValue(ctx, firstPipeAdmissionKey{}, a), a, nil
}
func (a *firstPipeAdmission) attachDuplicate(file *os.File) {
	a.duplicate = file
	if a.operation == "first_preauthorize" {
		a.lease.file = file
	}
	a.lease.resources = append(a.lease.resources, file)
}
func (a *firstPipeAdmission) finish(ctx context.Context) error {
	l := a.lease
	r := l.registry
	r.mu.Lock()
	state := l.state
	busy := l.busy
	r.mu.Unlock()
	if a.operation == "first_capture_challenge" {
		if !busy || state != "challenging" {
			return nil
		}
		var closeErr error
		if a.duplicate != nil {
			closeErr = a.duplicate.Close()
		}
		r.mu.Lock()
		defer r.mu.Unlock()
		if closeErr != nil || ctx.Err() != nil {
			l.state = "unknown"
			l.invalid = true
			l.busy = ctx.Err() != nil
			return errors.Join(closeErr, ctx.Err(), fmt.Errorf("first capture challenge lifetime unavailable; retained capacity"))
		}
		if a.duplicate != nil {
			l.resources = l.resources[:len(l.resources)-1]
		}
		l.state = "described"
		l.busy = false
		return nil
	}
	if state == "opening" {
		if err := l.attach(l.resources); err != nil {
			return err
		}
		if err := l.beginDescribe(); err != nil {
			return err
		}
		return l.finishDescribe(false)
	}
	if state == "capturing" && busy {
		return l.finishCapture("rejected", true)
	}
	// A preauthorization may remain described by design, and unknown native
	// calls retain their exact old references/capacity instead of TTL deletion.
	return nil
}
func firstPipeLease(ctx context.Context, operation string) *firstCaptureHandleLease {
	a, ok := ctx.Value(firstPipeAdmissionKey{}).(*firstPipeAdmission)
	if !ok || a.operation != operation {
		return nil
	}
	return a.lease
}

func (h *Helper) challengeFirstCapture(ctx context.Context, peer PeerIdentity, o FirstCaptureOrigin, params FirstCaptureParams, request MetadataCallback, file *os.File) (*MetadataCallback, error) {
	if !h.firstCaptureOriginCurrent(peer, o) || o.Phase != "capture" || request.Action != "capture_exact" || request.OuterRPCID != o.OuterRPCID || request.ProofIDs.CaptureProofID != nil || request.ProofIDs.PreparedObjectID != nil || request.ExpectedCurrent.MetadataHash != nil || request.ExpectedCurrent.ContentHash != nil || file == nil {
		return nil, ErrFirstCaptureNotReady
	}
	key, err := FirstCaptureTokenDigest(params.Token)
	if err != nil {
		return nil, err
	}
	r := h.firstCaptureHandles
	r.mu.Lock()
	l := r.entries[key]
	valid := l != nil && l.currentLocked() && (l.state == "described" || l.state == "challenging") && l.bindingDigest == o.stableDigest() && l.preauthorization.Origin.OuterRPCID == params.PreauthRPCID && l.preauthorization.PreauthNonce == params.PreauthNonce && request.Descriptors == l.preauthorization.Descriptors
	r.mu.Unlock()
	if !valid {
		return nil, errFirstCaptureConsumed
	}
	return h.Challenge(ctx, peer, o.challengeOrigin(), request, file)
}

var _ io.Closer = (*os.File)(nil)
