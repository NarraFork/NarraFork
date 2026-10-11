package windowsbackup

import (
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type countedRawCaptureResource struct {
	closes atomic.Int32
	fail   bool
}

func (c *countedRawCaptureResource) Close() error {
	c.closes.Add(1)
	if c.fail {
		return errors.New("injected retained close failure")
	}
	return nil
}
func rawLeaseFixture(t *testing.T) (*firstCaptureHandleRegistry, *firstCaptureHandleLease, string, *countedRawCaptureResource, string) {
	t.Helper()
	r := newFirstCaptureHandleRegistry()
	binding := Digest([]byte("full frozen original tuple"))
	l, token, err := r.reserve("connection", binding, time.Now().Add(firstCaptureTokenTTL))
	if err != nil {
		t.Fatal(err)
	}
	resource := &countedRawCaptureResource{}
	if err := l.attach([]io.Closer{resource}); err != nil {
		t.Fatal(err)
	}
	if err := l.beginDescribe(); err != nil {
		t.Fatal(err)
	}
	if err := l.finishDescribe(true); err != nil {
		t.Fatal(err)
	}
	return r, l, token, resource, binding
}
func TestFirstCaptureRawRegistrySingleConsumer(t *testing.T) {
	r, l, token, resource, binding := rawLeaseFixture(t)
	var accepted atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			if claimed, err := r.claim(token, "connection", binding, fmt.Sprintf("capture-rpc-%d", index)); err == nil {
				if claimed != l {
					t.Error("different reservation accepted")
				}
				accepted.Add(1)
			}
		}(i)
	}
	wg.Wait()
	if accepted.Load() != 1 || resource.closes.Load() != 0 {
		t.Fatal("capture admission not atomic or active resource prematurely closed")
	}
	if err := l.finishCapture("captured", true); err != nil {
		t.Fatal(err)
	}
	if resource.closes.Load() != 1 || !l.resourcesTerminal {
		t.Fatal("true completion did not close exactly once")
	}
	if _, err := r.claim(token, "connection", binding, "capture-rpc-new"); err == nil {
		t.Fatal("consumed token returned old result or dispatched again")
	}
}
func TestFirstCaptureRawRegistryTupleExpiryDisconnect(t *testing.T) {
	for _, kind := range []string{"connection", "binding", "expiry", "disconnect"} {
		t.Run(kind, func(t *testing.T) {
			r, l, token, resource, binding := rawLeaseFixture(t)
			connection := "connection"
			switch kind {
			case "connection":
				connection = "foreign"
			case "binding":
				binding = Digest([]byte("changed actor/source/root/op/digest/lease/fence/session tuple"))
			case "expiry":
				r.now = func() time.Time { return l.expires }
			case "disconnect":
				if err := r.invalidateConnection(connection); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := r.claim(token, connection, binding, "capture-rpc"); err == nil {
				t.Fatal("foreign or expired continuation admitted")
			}
			if kind == "expiry" {
				if err := r.expire(); err != nil {
					t.Fatal(err)
				}
				if resource.closes.Load() != 1 {
					t.Fatal("expired unclaimed resource not closed")
				}
			}
			if kind == "disconnect" && resource.closes.Load() != 1 {
				t.Fatal("disconnect did not close unclaimed original")
			}
			if kind == "connection" || kind == "binding" {
				if resource.closes.Load() != 0 {
					t.Fatal("foreign claim destroyed valid original reservation")
				}
				if _, err := r.claim(token, "connection", l.bindingDigest, "valid-capture-rpc"); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}
func TestFirstCaptureRawRegistryUnknownRetainsCapacityAndMemory(t *testing.T) {
	r, l, token, resource, binding := rawLeaseFixture(t)
	if _, err := r.claim(token, "connection", binding, "first-capture-rpc"); err != nil {
		t.Fatal(err)
	}
	if err := l.finishCapture("unknown", false); err == nil {
		t.Fatal("timeout falsely proved native terminal")
	}
	r.now = func() time.Time { return l.expires.Add(time.Hour) }
	if err := r.invalidateConnection("connection"); err != nil {
		t.Fatal(err)
	}
	if err := r.expire(); err != nil {
		t.Fatal(err)
	}
	if resource.closes.Load() != 0 || len(r.entries) != 1 || len(l.resources) != 1 || !l.busy {
		t.Fatal("expiry/disconnect released unknown native resource")
	}
	if _, err := r.claim(token, "connection", binding, "new-rpc"); err == nil {
		t.Fatal("unknown token became a result-query or new dispatch")
	}
	if err := l.finishCapture("unknown", true); err != nil {
		t.Fatal(err)
	}
	if resource.closes.Load() != 1 {
		t.Fatal("real eventual native completion did not drain same old resource")
	}
	if err := r.expire(); err != nil {
		t.Fatal(err)
	}
	if len(r.entries) != 0 {
		t.Fatal("expired true-terminal tombstone leaked capacity")
	}
}
func TestFirstCaptureRawRegistryCannotMintAnotherTokenForSameOriginal(t *testing.T) {
	r, l, token, _, binding := rawLeaseFixture(t)
	if _, _, err := r.reserve("connection", binding, l.expires); err == nil {
		t.Fatal("original binding minted a second unconsumed token")
	}
	if _, err := r.claim(token, "connection", binding, "capture-rpc"); err != nil {
		t.Fatal(err)
	}
	if err := l.finishCapture("unknown", false); err == nil {
		t.Fatal("unknown lifecycle incorrectly terminal")
	}
	if _, _, err := r.reserve("new-connection", binding, l.expires); err == nil {
		t.Fatal("lost reply evaded consumption with a new token/frame")
	}
}

func TestFirstCaptureRawRegistryCloseFailureRetainsEvidence(t *testing.T) {
	r, l, token, resource, binding := rawLeaseFixture(t)
	resource.fail = true
	if _, err := r.claim(token, "connection", binding, "first-capture-rpc"); err != nil {
		t.Fatal(err)
	}
	if err := l.finishCapture("captured", true); err == nil {
		t.Fatal("failed local close returned success")
	}
	r.now = func() time.Time { return l.expires.Add(time.Hour) }
	if err := r.expire(); err != nil {
		t.Fatal(err)
	}
	if len(r.entries) != 1 || len(l.resources) != 1 || l.resourcesTerminal || l.state != "unknown" {
		t.Fatal("close failure released evidence/capacity")
	}
}
func TestFirstCaptureRawRegistryBoundsReserveBeforeOpen(t *testing.T) {
	r := newFirstCaptureHandleRegistry()
	now := time.Now()
	r.now = func() time.Time { return now }
	binding := Digest([]byte("frozen"))
	for i := 0; i < firstCaptureGlobal; i++ {
		if _, _, err := r.reserve(fmt.Sprintf("connection-%d", i/firstCapturePerConnection), Digest([]byte(fmt.Sprintf("frozen-%d", i))), now.Add(firstCaptureTokenTTL)); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := r.reserve("other", binding, now.Add(firstCaptureTokenTTL)); err == nil {
		t.Fatal("global capacity exceeded before open")
	}
	r2 := newFirstCaptureHandleRegistry()
	r2.now = r.now
	for i := 0; i < firstCapturePerConnection; i++ {
		if _, _, err := r2.reserve("same", Digest([]byte(fmt.Sprintf("frozen-%d", i))), now.Add(firstCaptureTokenTTL)); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := r2.reserve("same", binding, now.Add(firstCaptureTokenTTL)); err == nil {
		t.Fatal("per-connection capacity exceeded")
	}
	if _, _, err := r2.reserve("new", binding, now.Add(firstCaptureTokenTTL+time.Nanosecond)); err == nil {
		t.Fatal("token TTL exceeded")
	}
}
func TestFirstCaptureRawRegistryDisconnectDuringOpenDescribe(t *testing.T) {
	for _, phase := range []string{"opening", "describing"} {
		t.Run(phase, func(t *testing.T) {
			r := newFirstCaptureHandleRegistry()
			l, _, err := r.reserve("connection", Digest([]byte("frozen")), time.Now().Add(firstCaptureTokenTTL))
			if err != nil {
				t.Fatal(err)
			}
			resource := &countedRawCaptureResource{}
			if phase == "describing" {
				if err := l.attach([]io.Closer{resource}); err != nil {
					t.Fatal(err)
				}
				if err := l.beginDescribe(); err != nil {
					t.Fatal(err)
				}
			}
			if err := r.invalidateConnection("connection"); err != nil {
				t.Fatal(err)
			}
			if resource.closes.Load() != 0 {
				t.Fatal("disconnect closed resource while actual operation pending")
			}
			if phase == "opening" {
				err = l.attach([]io.Closer{resource})
			} else {
				err = l.finishDescribe(true)
			}
			if err == nil || resource.closes.Load() != 1 || !l.resourcesTerminal {
				t.Fatal("real preauth termination did not drain invalidated original", err)
			}
		})
	}
}
