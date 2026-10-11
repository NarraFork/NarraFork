//go:build !windows

package windowsbackup

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"testing"
	"time"
)

// Policy/crypto fixture only, NOT ordinary Windows/helper service evidence.
type firstCapturePolicyNative struct {
	*preparedFakeNative
	pin                      *countedRawCaptureResource
	observes, captures, pins int
}

func (n *firstCapturePolicyNative) PinOrdinary(_ context.Context, root NativeDescriptor, file *os.File) (FirstCapturePinnedOrdinary, error) {
	n.pins++
	o := n.observations[file]
	o.MetadataHash = ""
	o.ContentHash = ""
	return FirstCapturePinnedOrdinary{Observation: o, GrantedAccess: FirstCaptureOrdinaryAccess, Pins: []io.Closer{n.pin}, Terminal: true}, nil
}
func (n *firstCapturePolicyNative) InspectFirstCaptureOrdinary(_ context.Context, root NativeDescriptor, file *os.File) (FirstCapturePinnedOrdinary, error) {
	o := n.observations[file]
	o.MetadataHash = ""
	o.ContentHash = ""
	return FirstCapturePinnedOrdinary{Observation: o, GrantedAccess: FirstCaptureOrdinaryAccess, Terminal: true}, nil
}
func (n *firstCapturePolicyNative) Observe(ctx context.Context, ticket Ticket, file *os.File) (NativeObservation, error) {
	n.observes++
	return n.preparedFakeNative.Observe(ctx, ticket, file)
}
func (n *firstCapturePolicyNative) Capture(ctx context.Context, file *os.File) (*Snapshot, error) {
	n.captures++
	return n.preparedFakeNative.Capture(ctx, file)
}
func firstCapturePolicyOrigin(h *preparedHarness, phase, rpc string) FirstCaptureOrigin {
	b := h.base
	return FirstCaptureOrigin{Version: 1, DeviceID: b.DeviceID, ExecutorSourceID: b.ExecutorSourceID, ScopeID: b.ScopeID, Root: b.Root, HelperInstanceID: b.HelperInstanceID, HelperKeyEpoch: h.store.config.KeyEpoch, OperationID: b.OperationID, RequestDigest: b.RequestDigest, LeaseID: b.LeaseID, Fence: b.Fence, ConnectionID: b.ConnectionID, SessionID: b.SessionID, RuntimeGeneration: b.RuntimeGeneration, Action: "capture_exact", Phase: phase, OuterRPCID: rpc}
}
func firstCapturePolicySetup(t *testing.T) (*preparedHarness, *firstCapturePolicyNative, FirstCaptureOrigin, FirstCapturePreauthorizeParams, FirstCaptureParams, FirstCaptureEnvelope, *os.File) {
	t.Helper()
	h := newPreparedHarness(t)
	file := h.file("ordinary", 20)
	n := &firstCapturePolicyNative{preparedFakeNative: h.native, pin: &countedRawCaptureResource{}}
	h.helper.Native = n
	origin := firstCapturePolicyOrigin(h, "preauthorize", "preauth-rpc")
	params := FirstCapturePreauthorizeParams{1, "ordinary-path", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}
	tokenRaw := make([]byte, 32)
	tokenRaw[0] = 42
	token := base64.RawURLEncoding.EncodeToString(tokenRaw)
	digest, err := FirstCaptureTokenDigest(token)
	if err != nil {
		t.Fatal(err)
	}
	envelope, owned, err := h.helper.preauthorizeFirstCapture(h.ctx, h.peer, origin, params, digest, uint64(time.Now().Add(20*time.Second).UnixMilli()), file)
	if err != nil || !owned {
		t.Fatal("helper ordinary preauthorization", err)
	}
	if n.captures != 0 || n.observes != 0 || n.pins != 1 || n.restores != 0 {
		t.Fatal("preauthorization invoked capture/hash/restore")
	}
	capture := FirstCaptureParams{1, token, origin.OuterRPCID, params.Nonce, "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
	duplicate := h.file("duplicate-holder", 20)
	h.native.observations[duplicate] = h.native.observations[file]
	h.native.snapshots[duplicate] = h.native.snapshots[file]
	return h, n, origin, params, capture, envelope, duplicate
}
func firstCapturePolicyTicket(h *preparedHarness, duplicate *os.File) []byte {
	ticket := h.base
	ticket.Target = h.native.observations[duplicate].Target
	ticket = h.attested(ticket)
	raw, err := h.sign(ticket)
	if err != nil {
		h.t.Fatal(err)
	}
	return raw
}
func TestFirstCaptureHelperCompletesOnlyOriginalPrivateCapturedRecord(t *testing.T) {
	h, n, preauth, _, capture, preauthEnvelope, duplicate := firstCapturePolicySetup(t)
	origin := preauth
	origin.Phase = "capture"
	origin.OuterRPCID = "outer-rpc"
	ticket := firstCapturePolicyTicket(h, duplicate)
	result, owned, nativeTerminal, resourcesTerminal, err := h.helper.executeFirstCapture(h.ctx, h.peer, origin, capture, ticket, duplicate)
	if err != nil || !owned || !nativeTerminal || !resourcesTerminal {
		t.Fatal("first completion not true terminal", err)
	}
	if n.captures != 1 || n.observes != 2 || n.restores != 0 || n.pin.closes.Load() != 1 {
		t.Fatal("original Observe->Capture->Observe/close invariants changed")
	}
	var payload FirstCaptureResultPayload
	key := h.store.config.SigningKey.Public().(ed25519.PublicKey)
	if err := verifyFirstCaptureEnvelope(result, key, &payload); err != nil || payload.Validate(key) != nil {
		t.Fatal("helper completed-domain signature", err)
	}
	if payload.Preauthorization.AttestationDigest != firstCaptureEnvelopeDigest(preauthEnvelope) || payload.Origin != origin || payload.CaptureNonce != capture.CaptureNonce {
		t.Fatal("completion request/continuation binding changed")
	}
	var envelope SignedTicket
	if err := strictEnvelopeTicket(ticket, &envelope); err != nil {
		t.Fatal(err)
	}
	raw, err := decodeTicketPayload(envelope)
	if err != nil || payload.TicketPayloadDigest != Digest(raw) {
		t.Fatal("completion did not bind actual whole issued payload")
	}
	before := n.captures
	if _, _, _, _, err := h.helper.executeFirstCapture(h.ctx, h.peer, origin, capture, ticket, duplicate); err == nil || n.captures != before {
		t.Fatal("consumed first-capture token queried result or dispatched again")
	}
}
func strictEnvelopeTicket(raw []byte, envelope *SignedTicket) error {
	canonical, err := CanonicalJSON(jsonRawObject(raw))
	if err != nil {
		return err
	}
	return strictJSON(canonical, envelope)
}
func jsonRawObject(raw []byte) any { var value any; _ = json.Unmarshal(raw, &value); return value }
func TestFirstCaptureHelperForeignContinuationNeverCaptures(t *testing.T) {
	for _, kind := range []string{"operation", "digest", "lease", "fence", "session", "source", "root", "helper-epoch", "preauth-rpc", "preauth-nonce", "token", "ticket-old-op", "challenge-old-rpc"} {
		t.Run(kind, func(t *testing.T) {
			h, n, preauth, _, capture, _, duplicate := firstCapturePolicySetup(t)
			origin := preauth
			origin.Phase = "capture"
			origin.OuterRPCID = "outer-rpc"
			ticket := firstCapturePolicyTicket(h, duplicate)
			switch kind {
			case "operation":
				origin.OperationID = "foreign"
			case "digest":
				origin.RequestDigest = Digest([]byte("foreign"))
			case "lease":
				origin.LeaseID = "foreign"
			case "fence":
				origin.Fence++
			case "session":
				origin.SessionID = "foreign"
			case "source":
				origin.ExecutorSourceID = "foreign"
			case "root":
				origin.Root.FileID = "foreign"
			case "helper-epoch":
				origin.HelperKeyEpoch++
			case "preauth-rpc":
				capture.PreauthRPCID = "foreign"
			case "preauth-nonce":
				capture.PreauthNonce = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
			case "token":
				capture.Token = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
			case "ticket-old-op":
				b := h.base
				b.OperationID = "foreign"
				b.Target = h.native.observations[duplicate].Target
				b = h.attested(b)
				ticket, _ = h.sign(b)
			case "challenge-old-rpc":
				origin.OuterRPCID = "new-outer-rpc"
			}
			_, _, _, _, err := h.helper.executeFirstCapture(h.ctx, h.peer, origin, capture, ticket, duplicate)
			if err == nil {
				t.Fatal("foreign completion accepted")
			}
			if kind != "challenge-old-rpc" && n.captures != 0 {
				t.Fatal("foreign original reached Native.Capture")
			}
		})
	}
}
