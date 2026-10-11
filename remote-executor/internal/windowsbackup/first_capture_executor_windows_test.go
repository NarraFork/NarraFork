//go:build windows

package windowsbackup

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"os"
	"testing"
	"time"
)

type firstCaptureNoIOProvider struct{ calls int }

func (p *firstCaptureNoIOProvider) PinOrdinary(context.Context, NativeDescriptor, *os.File) (FirstCapturePinnedOrdinary, error) {
	p.calls++
	return FirstCapturePinnedOrdinary{}, errors.New("unexpected native pin")
}
func (p *firstCaptureNoIOProvider) InspectFirstCaptureOrdinary(context.Context, NativeDescriptor, *os.File) (FirstCapturePinnedOrdinary, error) {
	p.calls++
	return FirstCapturePinnedOrdinary{}, errors.New("injected native description failure")
}

type firstCaptureNoIOPipe struct{ calls int }

func (p *firstCaptureNoIOPipe) firstPreauthorize(context.Context, FirstCaptureOrigin, FirstCapturePreauthorizeParams, string, uint64, *os.File) (firstCapturePipeOutcome, error) {
	p.calls++
	return firstCapturePipeOutcome{}, errors.New("unexpected pipe")
}
func (p *firstCaptureNoIOPipe) firstChallenge(context.Context, FirstCaptureOrigin, FirstCaptureParams, MetadataCallback, *os.File) (*MetadataCallback, error) {
	p.calls++
	return nil, errors.New("unexpected pipe")
}
func (p *firstCaptureNoIOPipe) firstExecute(context.Context, FirstCaptureOrigin, FirstCaptureParams, []byte, *os.File) (firstCapturePipeOutcome, error) {
	p.calls++
	return firstCapturePipeOutcome{}, errors.New("unexpected execute")
}
func TestFirstCaptureLocalControlRejectClosesButNativeFailureRetains(t *testing.T) {
	for _, phase := range []string{"local-before-native", "missing-helper-key", "native-started"} {
		t.Run(phase, func(t *testing.T) {
			registry, lease, token, resource, _ := rawLeaseFixture(t)
			o := FirstCaptureOrigin{Version: 1, DeviceID: "device", ExecutorSourceID: "source", ScopeID: "scope", Root: NativeDescriptor{"volume", "root", "1", "slot"}, HelperInstanceID: "helper", HelperKeyEpoch: 1, OperationID: "operation", RequestDigest: Digest([]byte("request")), LeaseID: "lease", Fence: 1, ConnectionID: "connection", SessionID: "session", RuntimeGeneration: 1, Action: "capture_exact", Phase: "capture", OuterRPCID: "capture-rpc"}
			preauth := o
			preauth.Phase = "preauthorize"
			preauth.OuterRPCID = "preauth-rpc"
			lease.file = os.NewFile(^uintptr(0)-42, "unit-no-native-fd")
			defer lease.file.Close()
			lease.bindingDigest = o.stableDigest()
			lease.preauthorization = FirstCapturePreauthorization{Origin: preauth, PreauthNonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}
			provider := &firstCaptureNoIOProvider{}
			pipe := &firstCaptureNoIOPipe{}
			e := &FirstCaptureExecutor{handles: registry, provider: provider, pipe: pipe, enrollment: FirstCaptureEnrollment{Version: 2, EnrollmentID: "enrollment", Revision: 1, Matrix: "ordinary-file-v2", DeviceID: o.DeviceID, ExecutorSourceID: o.ExecutorSourceID, Root: o.Root, HelperInstanceID: o.HelperInstanceID, HelperKeyEpoch: 1, HelperPublicKey: base64.RawURLEncoding.EncodeToString(make([]byte, 32)), PipePeer: FirstCapturePipePin{Name: "pipe", ProcessID: 1, CreationTime: "1", SID: "sid"}, Session: FirstCaptureEnrolledSession{o.ConnectionID, o.SessionID, o.RuntimeGeneration}, Policy: "capture_only_existing_ordinary_v2"}}
			// Complete the internal fixture with a real public key before asking
			// it to exercise Original/Describe. A missing key must fail earlier.
			public := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize)).Public().(ed25519.PublicKey)
			e.enrollment.HelperPublicKey = base64.RawURLEncoding.EncodeToString(public)
			if phase != "missing-helper-key" {
				e.key = public
			}
			checks := 0
			e.configCurrent = func(context.Context) error {
				checks++
				if phase == "local-before-native" && checks >= 2 {
					return ErrFirstCaptureNotReady
				}
				return nil
			}
			issued := 0
			ctx := WithMetadataControl(context.Background(), Session{ConnectionID: o.ConnectionID, SessionID: o.SessionID, Generation: o.RuntimeGeneration}, o.OuterRPCID, func(context.Context, []byte) ([]byte, error) { issued++; return nil, errors.New("unexpected issuance") })
			ctx, err := WithFirstCaptureRequest(ctx, FirstCaptureMethod, o.OuterRPCID, o)
			if err != nil {
				t.Fatal(err)
			}
			params := map[string]any{"version": 1, "token": token, "preauthRpcId": preauth.OuterRPCID, "preauthNonce": lease.preauthorization.PreauthNonce, "captureNonce": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
			if result, err := e.MetadataCapture(ctx, params); err == nil || result != nil {
				t.Fatal("rejection produced captured result")
			}
			t.Logf("first-capture phase=%s configChecks=%d providerCalls=%d pipeCalls=%d ticketRequests=%d localCloses=%d state=%s resourcesTerminal=%t", phase, checks, provider.calls, pipe.calls, issued, resource.closes.Load(), lease.state, lease.resourcesTerminal)
			if issued != 0 {
				t.Fatal("fixture reached platform ticket issuance")
			}
			if phase == "local-before-native" || phase == "missing-helper-key" {
				expectedChecks := 2
				if phase == "missing-helper-key" {
					expectedChecks = 1
				}
				if checks != expectedChecks || provider.calls != 0 || pipe.calls != 0 || resource.closes.Load() != 1 || lease.state != "rejected" || !lease.resourcesTerminal {
					t.Fatal("proven pre-native control rejection leaked or called native/pipe")
				}
			} else {
				if checks != 2 || provider.calls != 1 || pipe.calls != 0 || resource.closes.Load() != 0 || lease.state != "unknown" || lease.resourcesTerminal {
					t.Fatal("native-started failure was guessed terminal")
				}
				if err := lease.finishCapture("unknown", true); err != nil {
					t.Fatal(err)
				}
			}
			registry.now = func() time.Time { return time.Now().Add(time.Minute) }
			if err := registry.expire(); err != nil {
				t.Fatal(err)
			}
		})
	}
}
