//go:build !windows

package windowsbackup

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"testing"
	"time"
)

func TestFirstCaptureTerminalTombstonesRecycle65FreshRequests(t *testing.T) {
	r := newFirstCaptureHandleRegistry()
	now := time.Now()
	r.now = func() time.Time { return now }
	for i := 0; i < 65; i++ {
		l, token, err := r.reserve("same-connection", Digest([]byte(fmt.Sprintf("fresh-original-%d", i))), now.Add(30*time.Second))
		if err != nil {
			t.Fatalf("fresh request %d could not reserve after true terminal expiry", i)
		}
		resource := &countedRawCaptureResource{}
		if l.attach([]io.Closer{resource}) != nil || l.beginDescribe() != nil || l.finishDescribe(true) != nil {
			t.Fatal("description lifetime")
		}
		if _, err := r.claim(token, l.connection, l.bindingDigest, fmt.Sprintf("rpc-%d", i)); err != nil {
			t.Fatal(err)
		}
		if err := l.finishCapture("captured", true); err != nil || resource.closes.Load() != 1 {
			t.Fatal("true resource close not proven", err)
		}
		if _, err := r.claim(token, l.connection, l.bindingDigest, "later-result-query"); err == nil {
			t.Fatal("terminal tombstone was a result query")
		}
		now = now.Add(31 * time.Second)
		if err := r.expire(); err != nil {
			t.Fatal(err)
		}
		if len(r.entries) != 0 {
			t.Fatal("true-terminal expired tombstone retained in-memory capacity")
		}
	}
}
func TestFirstCaptureDurableMasterPreventsOldOperationAfterRestart(t *testing.T) {
	h, n, origin, params, _, _, _ := firstCapturePolicySetup(t)
	// Close the old unconsumed native references with real registry termination.
	if err := h.helper.firstCaptureHandles.invalidateConnection(origin.ConnectionID); err != nil {
		t.Fatal(err)
	}
	if n.pin.closes.Load() != 1 {
		t.Fatal("old ordinary pins not actually closed")
	}
	config := h.store.config
	if err := h.store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err := NewProtectedStore(config)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	verifier := *h.helper.Verifier
	fresh, err := NewHelper(&verifier, store, n)
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"same", "lease", "fence", "digest", "frame", "nonce", "token"} {
		o := origin
		p := params
		o.OuterRPCID = "fresh-preauth-frame"
		switch kind {
		case "lease":
			o.LeaseID = "new-lease"
		case "fence":
			o.Fence++
		case "digest":
			o.RequestDigest = Digest([]byte("new digest"))
		case "frame":
			o.OuterRPCID = "other-frame"
		case "nonce":
			p.Nonce = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
		}
		file := h.file("fresh-holder", 20)
		token := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf("ordinary-source-token-%032d", len(kind))))
		digest, err := FirstCaptureTokenDigest(token)
		if err != nil {
			t.Fatal(err)
		}
		beforeCapture, beforePin := n.captures, n.pins
		_, _, err = fresh.preauthorizeFirstCapture(context.Background(), h.peer, o, p, digest, uint64(time.Now().Add(20*time.Second).UnixMilli()), file)
		if err == nil || n.captures != beforeCapture || n.pins != beforePin {
			t.Fatalf("old op %s reauthorized/captured after restart", kind)
		}
		// Expire the TRUE terminated rejection tombstone, not the durable master.
		fresh.firstCaptureHandles.now = func() time.Time { return time.Now().Add(time.Minute) }
		if err := fresh.firstCaptureHandles.expire(); err != nil {
			t.Fatal(err)
		}
		fresh.firstCaptureHandles.now = time.Now
	}
	if _, err := store.read(firstCaptureMasterKey(origin), 4096); err != nil {
		t.Fatal("old durable master deleted", err)
	}
}
func TestFirstCaptureCompleteOrSigningFaultNeverReturnsCompletion(t *testing.T) {
	for _, phase := range []string{"captured-complete", "result-signature-persist", "close-failure"} {
		t.Run(phase, func(t *testing.T) {
			h, n, preauth, _, capture, _, duplicate := firstCapturePolicySetup(t)
			origin := preauth
			origin.Phase = "capture"
			origin.OuterRPCID = "outer-rpc"
			ticket := firstCapturePolicyTicket(h, duplicate)
			if phase == "close-failure" {
				n.pin.fail = true
			}
			if phase == "captured-complete" {
				// SaveCapture's quota/record writes happen first; fail its subsequent
				// operation completion write, never issue a false captured envelope.
				writes := 0
				h.store.config.Fault = func(step string) error {
					if step == "before_store_write" && n.captures == 1 && n.observes >= 2 {
						writes++
						if writes >= 3 {
							return os.ErrPermission
						}
					}
					return nil
				}
			}
			if phase == "result-signature-persist" {
				h.store.config.Fault = func(step string) error {
					if step == "before_store_write" && n.pin.closes.Load() > 0 {
						return os.ErrPermission
					}
					return nil
				}
			}
			result, _, _, _, err := h.helper.executeFirstCapture(h.ctx, h.peer, origin, capture, ticket, duplicate)
			if err == nil || result.Payload != "" || n.captures != 1 {
				t.Fatal("fault produced signed completion or skipped original Capture", err)
			}
			h.store.config.Fault = nil
			if _, _, _, _, err := h.helper.executeFirstCapture(h.ctx, h.peer, origin, capture, ticket, duplicate); err == nil || n.captures != 1 {
				t.Fatal("failed/lost result was recaptured or queried")
			}
		})
	}
}
func TestFirstCapturePreauthorizationStoreFailureNoNativeCapture(t *testing.T) {
	h := newPreparedHarness(t)
	file := h.file("ordinary", 20)
	n := &firstCapturePolicyNative{preparedFakeNative: h.native, pin: &countedRawCaptureResource{}}
	h.helper.Native = n
	o := firstCapturePolicyOrigin(h, "preauthorize", "preauth-rpc")
	p := FirstCapturePreauthorizeParams{1, "ordinary", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}
	h.store.config.Fault = func(string) error { return errors.New("master durable fault") }
	_, _, err := h.helper.preauthorizeFirstCapture(h.ctx, h.peer, o, p, Digest([]byte("opaque-token")), uint64(time.Now().Add(20*time.Second).UnixMilli()), file)
	if err == nil || n.captures != 0 || n.pins != 0 {
		t.Fatal("store-intent fault reached ordinary/native capture")
	}
}
