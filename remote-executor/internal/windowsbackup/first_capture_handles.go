package windowsbackup

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

// Implementation-only ownership; not a wire contract, authority assertion, or
// result-query API. The caller supplies a digest of the frozen shared tuple.
// Reserve capacity BEFORE ordinary open. Slots/tombstones remain charged until
// expiry; active/unknown kernel resources cannot be freed merely by expiry.
const firstCaptureTokenTTL = 30 * time.Second
const firstCapturePerConnection = 4
const firstCaptureGlobal = 64
const firstCapturePins = 64

var errFirstCaptureUnavailable = errors.New("windows_first_capture_unavailable")
var errFirstCaptureConsumed = errors.New("windows_first_capture_token_consumed_or_invalid")

type firstCaptureHandleRegistry struct {
	mu      sync.Mutex
	entries map[string]*firstCaptureHandleLease
	now     func() time.Time
}
type firstCaptureHandleLease struct {
	registry                                         *firstCaptureHandleRegistry
	tokenDigest, connection, bindingDigest           string
	expires                                          time.Time
	state                                            string
	resources                                        []io.Closer
	busy, invalid, nativeTerminal, resourcesTerminal bool
	captureRPC                                       string
	file                                             *os.File
	preauthorization                                 FirstCapturePreauthorization
	preauthEnvelope                                  FirstCaptureEnvelope
	challengeRPC, challengeCaptureNonce              string
}

func newFirstCaptureHandleRegistry() *firstCaptureHandleRegistry {
	return &firstCaptureHandleRegistry{entries: make(map[string]*firstCaptureHandleLease), now: time.Now}
}

func (r *firstCaptureHandleRegistry) reserve(connection, bindingDigest string, expiry time.Time) (*firstCaptureHandleLease, string, error) {
	if !validID(connection, 256) || !validHash(bindingDigest) {
		return nil, "", errFirstCaptureUnavailable
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	r.sweepTerminalLocked(now)
	if !expiry.After(now) || expiry.After(now.Add(firstCaptureTokenTTL)) {
		return nil, "", errFirstCaptureUnavailable
	}
	count := 0
	for _, e := range r.entries {
		if e.bindingDigest == bindingDigest {
			return nil, "", fmt.Errorf("first capture original binding already reserved or consumed")
		}
		if e.connection == connection {
			count++
		}
	}
	if count >= firstCapturePerConnection || len(r.entries) >= firstCaptureGlobal {
		return nil, "", fmt.Errorf("first capture retained-handle capacity")
	}
	var entropy [32]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return nil, "", err
	}
	token := base64.RawURLEncoding.EncodeToString(entropy[:])
	key, err := FirstCaptureTokenDigest(token)
	if err != nil {
		return nil, "", err
	}
	if _, exists := r.entries[key]; exists {
		return nil, "", errFirstCaptureUnavailable
	}
	lease := &firstCaptureHandleLease{registry: r, tokenDigest: key, connection: connection, bindingDigest: bindingDigest, expires: expiry, state: "opening", busy: true}
	r.entries[key] = lease
	return lease, token, nil
}

// Helper-side admission consumes the executor-generated token digest, not a
// client-selected object ID. Only validated domain/tuple bindings reach here.
func (r *firstCaptureHandleRegistry) reserveDigest(connection, bindingDigest, key string, expiry time.Time) (*firstCaptureHandleLease, error) {
	if !validID(connection, 256) || !validHash(bindingDigest) || !validHash(key) {
		return nil, ErrFirstCaptureNotReady
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	r.sweepTerminalLocked(now)
	if !expiry.After(now) || expiry.After(now.Add(firstCaptureTokenTTL)) {
		return nil, ErrFirstCaptureNotReady
	}
	count := 0
	for _, entry := range r.entries {
		if entry.bindingDigest == bindingDigest {
			return nil, errFirstCaptureConsumed
		}
		if entry.connection == connection {
			count++
		}
	}
	if count >= firstCapturePerConnection || len(r.entries) >= firstCaptureGlobal || r.entries[key] != nil {
		return nil, errFirstCaptureConsumed
	}
	l := &firstCaptureHandleLease{registry: r, tokenDigest: key, connection: connection, bindingDigest: bindingDigest, expires: expiry, state: "opening", busy: true}
	r.entries[key] = l
	return l, nil
}
func (r *firstCaptureHandleRegistry) sweepTerminalLocked(now time.Time) {
	for key, e := range r.entries {
		if !now.Before(e.expires) && e.resourcesTerminal && !e.busy {
			delete(r.entries, key)
		}
	}
}
func (l *firstCaptureHandleLease) currentLocked() bool {
	return l.registry.entries[l.tokenDigest] == l && !l.invalid && l.registry.now().Before(l.expires)
}

// Called only after the raw opener has really returned (success or failure).
// On timeout/disconnect resources are closed here, never while open is pending.
func (l *firstCaptureHandleLease) attach(resources []io.Closer) error {
	r := l.registry
	r.mu.Lock()
	if r.entries[l.tokenDigest] != l || l.state != "opening" || !l.busy {
		r.mu.Unlock()
		return errFirstCaptureConsumed
	}
	l.resources = resources
	l.busy = false
	valid := l.currentLocked() && len(resources) > 0 && len(resources) <= firstCapturePins+1
	for _, resource := range resources {
		if resource == nil {
			valid = false
		}
	}
	if valid {
		l.state = "opened"
		r.mu.Unlock()
		return nil
	}
	l.invalid = true
	l.state = "closing"
	l.busy = true
	r.mu.Unlock()
	closeErr := l.closeOwned()
	return errors.Join(errFirstCaptureUnavailable, closeErr)
}
func (l *firstCaptureHandleLease) retainUnknown(resources []io.Closer) {
	r := l.registry
	r.mu.Lock()
	defer r.mu.Unlock()
	if resources != nil {
		l.resources = resources
	}
	l.state = "unknown"
	l.invalid = true
	l.busy = true
}
func (l *firstCaptureHandleLease) recordPreauthorization(p FirstCapturePreauthorization, envelope FirstCaptureEnvelope) {
	r := l.registry
	r.mu.Lock()
	defer r.mu.Unlock()
	l.preauthorization = p
	l.preauthEnvelope = envelope
}

func (l *firstCaptureHandleLease) beginDescribe() error {
	r := l.registry
	r.mu.Lock()
	defer r.mu.Unlock()
	if !l.currentLocked() || l.state != "opened" || l.busy {
		return errFirstCaptureConsumed
	}
	l.busy = true
	l.state = "describing"
	return nil
}
func (l *firstCaptureHandleLease) finishDescribe(success bool) error {
	r := l.registry
	r.mu.Lock()
	if r.entries[l.tokenDigest] != l || l.state != "describing" || !l.busy {
		r.mu.Unlock()
		return errFirstCaptureConsumed
	}
	l.busy = false
	if success && l.currentLocked() {
		l.state = "described"
		r.mu.Unlock()
		return nil
	}
	l.invalid = true
	l.state = "closing"
	l.busy = true
	r.mu.Unlock()
	return errors.Join(errFirstCaptureUnavailable, l.closeOwned())
}
func (r *firstCaptureHandleRegistry) claim(token, connection, bindingDigest, captureRPC string) (*firstCaptureHandleLease, error) {
	if !validNonce(token) || !validID(captureRPC, 256) {
		return nil, errFirstCaptureConsumed
	}
	key, err := FirstCaptureTokenDigest(token)
	if err != nil {
		return nil, errFirstCaptureConsumed
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	l := r.entries[key]
	if l == nil || !l.currentLocked() || l.connection != connection || l.bindingDigest != bindingDigest || l.state != "described" || l.busy {
		return nil, errFirstCaptureConsumed
	}
	l.state = "capturing"
	l.busy = true
	l.captureRPC = captureRPC
	return l, nil
}

// nativeTerminal is factual evidence from the finished local/helper native
// lifetime, NOT a timeout, ACK, reply-loss inference, or client completed flag.
// Unknown keeps capacity and references. A later true native completion can
// drain that SAME lease; it never grants another capture/token consumption.
func (l *firstCaptureHandleLease) finishCapture(state string, nativeTerminal bool) error {
	if state != "captured" && state != "rejected" && state != "unknown" {
		return errFirstCaptureUnavailable
	}
	r := l.registry
	r.mu.Lock()
	if r.entries[l.tokenDigest] != l || l.captureRPC == "" || !(l.state == "capturing" || l.state == "unknown") || !l.busy {
		r.mu.Unlock()
		return errFirstCaptureConsumed
	}
	if !nativeTerminal {
		l.state = "unknown"
		r.mu.Unlock()
		return fmt.Errorf("first capture native lifetime unknown; retained capacity")
	}
	l.nativeTerminal = true
	l.state = "closing"
	r.mu.Unlock()
	if err := l.closeOwned(); err != nil {
		return err
	}
	r.mu.Lock()
	l.state = state
	r.mu.Unlock()
	return nil
}
func (l *firstCaptureHandleLease) closeOwned() error {
	// Ownership is fixed by the opening reservation; no other path consumes or
	// closes resources while busy. Attempt every resource even if one close fails.
	var failure error
	for i := len(l.resources) - 1; i >= 0; i-- {
		if l.resources[i] == nil {
			failure = errors.Join(failure, fmt.Errorf("nil retained capture resource"))
			continue
		}
		failure = errors.Join(failure, l.resources[i].Close())
	}
	r := l.registry
	r.mu.Lock()
	defer r.mu.Unlock()
	l.busy = false
	if failure != nil {
		l.state = "unknown"
		l.invalid = true
		l.resourcesTerminal = false
		return fmt.Errorf("first capture resource close failed; references retained: %w", failure)
	}
	l.resources = nil
	l.resourcesTerminal = true
	l.state = "rejected"
	return nil
}
func (r *firstCaptureHandleRegistry) invalidateConnection(connection string) error {
	r.mu.Lock()
	var closeNow []*firstCaptureHandleLease
	for _, l := range r.entries {
		if l.connection != connection {
			continue
		}
		l.invalid = true
		if !l.busy && !l.resourcesTerminal && (l.state == "opened" || l.state == "described") {
			l.state = "closing"
			l.busy = true
			closeNow = append(closeNow, l)
		}
	}
	r.mu.Unlock()
	var failure error
	for _, l := range closeNow {
		failure = errors.Join(failure, l.closeOwned())
	}
	return failure
}
func (r *firstCaptureHandleRegistry) expire() error {
	r.mu.Lock()
	now := r.now()
	var closeNow []*firstCaptureHandleLease
	for _, l := range r.entries {
		if now.Before(l.expires) {
			continue
		}
		l.invalid = true
		if !l.busy && !l.resourcesTerminal && (l.state == "opened" || l.state == "described") {
			l.state = "closing"
			l.busy = true
			closeNow = append(closeNow, l)
		}
	}
	r.mu.Unlock()
	var failure error
	for _, l := range closeNow {
		failure = errors.Join(failure, l.closeOwned())
	}
	r.mu.Lock()
	r.sweepTerminalLocked(r.now())
	r.mu.Unlock()
	return failure
}
