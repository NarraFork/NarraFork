package windowsbackup

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Fake native tests are authority/durability evidence ONLY, not Windows ACL or
// ordinary-token helper deployment evidence. The separate native test uses real
// Capture/ApplyExact/Matches on explicitly bound scratch files.
type preparedFakeNative struct {
	observations        map[*os.File]NativeObservation
	snapshots           map[*os.File]*Snapshot
	restores, mutations int
	failRestore         bool
}

func (n *preparedFakeNative) DescribeOrdinary(_ context.Context, _ NativeDescriptor, f *os.File) (NativeObservation, error) {
	return n.observations[f], nil
}
func (n *preparedFakeNative) Observe(_ context.Context, _ Ticket, f *os.File) (NativeObservation, error) {
	return n.observations[f], nil
}
func (n *preparedFakeNative) Capture(_ context.Context, f *os.File) (*Snapshot, error) {
	return n.snapshots[f], nil
}
func (n *preparedFakeNative) Restore(_ context.Context, f *os.File, r *CaptureRecord) error {
	n.restores++
	n.mutations++
	if n.failRestore {
		return fmt.Errorf("injected native failure")
	}
	n.snapshots[f] = r.Snapshot
	o := n.observations[f]
	o.MetadataHash, _ = SnapshotFingerprint(r.Snapshot)
	o.Target.CreationTime = strconv.FormatUint(r.Snapshot.Creation, 10)
	n.observations[f] = o
	return nil
}
func (n *preparedFakeNative) Seal(context.Context, *VerifiedTicket, *os.File, *CaptureRecord) (*VaultReference, error) {
	n.mutations++
	return nil, nil
}
func (n *preparedFakeNative) Unseal(context.Context, *VerifiedTicket, *os.File, *CaptureRecord) error {
	n.mutations++
	return nil
}
func (n *preparedFakeNative) Cleanup(context.Context, *VerifiedTicket, *os.File, *CaptureRecord) error {
	n.mutations++
	return nil
}
func (n *preparedFakeNative) VerifyOutcome(context.Context, *VerifiedTicket, *os.File, *CaptureRecord) error {
	return nil
}

type preparedHarness struct {
	t        *testing.T
	store    *ProtectedStore
	helper   *Helper
	native   *preparedFakeNative
	key      ed25519.PrivateKey
	base     Ticket
	peer     PeerIdentity
	ctx      context.Context
	channel  *AuthorizedChannel
	tickets  []Ticket
	sequence int
}

func preparedSnapshot(creation uint64) *Snapshot {
	fields := map[string]string{}
	for _, k := range requiredFields {
		fields[k] = "captured_exact"
	}
	fields["specialSecurity"] = "known_absent"
	return &Snapshot{Version: 2, Platform: "windows", Matrix: "ordinary-file-v2", Security: make([]byte, 20), Creation: creation, Streams: []Stream{}, Manifest: fields}
}
func newPreparedHarness(t *testing.T) *preparedHarness {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, helperKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	store, err := NewProtectedStore(StoreConfig{Directory: filepath.Join(t.TempDir(), "private"), HelperInstanceID: "helper", ServiceSID: "S-1-5-80-1-2-3-4-5", KeyEpoch: 7, SigningKey: helperKey})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	n := &preparedFakeNative{observations: map[*os.File]NativeObservation{}, snapshots: map[*os.File]*Snapshot{}}
	root := NativeDescriptor{"volume", "root", "1", "root-slot"}
	now := uint64(time.Now().UnixMilli())
	base := Ticket{Version: 1, Issuer: "issuer", ServiceID: "service", KeyEpoch: 2, DeviceID: "device", ExecutorSourceID: "source", HelperInstanceID: "helper", ConnectionID: "connection", SessionID: "session", RuntimeGeneration: 1, ActorSubjectKey: "actor", OriginRefHash: strings.Repeat("a", 64), Action: "capture_exact", BudgetClass: "metadata", ScopeID: "scope", Root: root, Parent: root, Target: NativeDescriptor{"volume", "old-file", "10", "old-slot"}, OperationID: "operation", RequestDigest: strings.Repeat("b", 64), LeaseID: "lease", Fence: 1, IssuedAt: now, ExpiresAt: now + 30000}
	peer := PeerIdentity{PID: 42, CreationTime: 1, SID: "user", ServiceSID: "service", ExecutorInstance: "executor"}
	v := &Verifier{Keys: []IssuerKey{{base.Issuer, base.ServiceID, base.KeyEpoch, key.Public().(ed25519.PublicKey)}}, Roots: []NativeDescriptor{root}, Session: Session{Peer: peer, DeviceID: base.DeviceID, SourceID: base.ExecutorSourceID, HelperInstanceID: base.HelperInstanceID, ConnectionID: base.ConnectionID, SessionID: base.SessionID, Generation: base.RuntimeGeneration}}
	helper, err := NewHelper(v, store, n)
	if err != nil {
		t.Fatal(err)
	}
	h := &preparedHarness{t: t, store: store, helper: helper, native: n, key: key, base: base, peer: peer}
	transport := preparedTransport{h}
	issuer := &CallbackTicketIssuer{Transport: transport, HelperPublicKey: helperKey.Public().(ed25519.PublicKey), Original: func(context.Context) (ChallengeOrigin, error) { return challengeOrigin(h.base), nil }, Describe: func(ctx context.Context, f *os.File, o ChallengeOrigin) (NativeObservation, error) {
		return h.helper.Native.(OrdinaryDescriptorObserver).DescribeOrdinary(ctx, o.Root, f)
	}}
	h.ctx = WithMetadataControl(context.Background(), v.Session, "outer-rpc", func(_ context.Context, raw []byte) ([]byte, error) {
		var request MetadataCallback
		if err := json.Unmarshal(raw, &request); err != nil {
			return nil, err
		}
		ticket := h.base
		ticket.Action = request.Action
		ticket.Root = request.Descriptors.Root
		ticket.Parent = request.Descriptors.Parent
		ticket.Target = request.Descriptors.Target
		ticket.CaptureProofID = request.ProofIDs.CaptureProofID
		ticket.PreparedObjectID = request.ProofIDs.PreparedObjectID
		ticket.ExpectedCurrentMetadataHash = request.ExpectedCurrent.MetadataHash
		ticket.ExpectedCurrentContentHash = request.ExpectedCurrent.ContentHash
		ticket.Nonce = request.Nonce
		ticket.ChallengeNonce = request.HelperChallenge.ChallengeNonce
		h.tickets = append(h.tickets, ticket)
		envelope, err := h.sign(ticket)
		if err != nil {
			return nil, err
		}
		var signed SignedTicket
		if err := json.Unmarshal(envelope, &signed); err != nil {
			return nil, err
		}
		return json.Marshal(map[string]any{"type": "windows_metadata_callback_result", "version": 1, "outerRpcId": request.OuterRPCID, "stepId": request.StepID, "nonce": request.Nonce, "ticket": signed})
	})
	h.channel = &AuthorizedChannel{Issuer: issuer, Transport: transport, HelperInstanceID: "helper", HelperKeyEpoch: 7, HelperPublicKey: helperKey.Public().(ed25519.PublicKey)}
	return h
}
func challengeOrigin(t Ticket) ChallengeOrigin {
	return ChallengeOrigin{t.DeviceID, t.ExecutorSourceID, t.ScopeID, t.Root, t.OperationID, t.RequestDigest, t.LeaseID, t.Fence, t.RuntimeGeneration, t.HelperInstanceID, t.ConnectionID, t.SessionID}
}

type preparedTransport struct{ h *preparedHarness }

func (p preparedTransport) Challenge(ctx context.Context, o ChallengeOrigin, r MetadataCallback, f *os.File) (*MetadataCallback, error) {
	return p.h.helper.Challenge(ctx, p.h.peer, o, r, f)
}
func (p preparedTransport) Execute(ctx context.Context, raw []byte, f *os.File, proof *CaptureProof) (*OperationResult, error) {
	var envelope SignedTicket
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, err
	}
	data, err := base64.RawURLEncoding.DecodeString(envelope.Payload)
	if err != nil {
		return nil, err
	}
	var ticket Ticket
	if err := json.Unmarshal(data, &ticket); err != nil {
		return nil, err
	}
	return p.h.helper.Execute(ctx, raw, p.h.peer, ticket.ChallengeNonce, f, proof)
}
func (h *preparedHarness) sign(t Ticket) ([]byte, error) {
	data, err := CanonicalJSON(t)
	if err != nil {
		return nil, err
	}
	return json.Marshal(SignedTicket{base64.RawURLEncoding.EncodeToString(data), base64.RawURLEncoding.EncodeToString(ed25519.Sign(h.key, data))})
}
func (h *preparedHarness) attested(t Ticket) Ticket {
	h.t.Helper()
	h.sequence++
	var entropy [32]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		h.t.Fatal(err)
	}
	if t.Nonce == "" {
		t.Nonce = base64.RawURLEncoding.EncodeToString(entropy[:])
	}
	r := MetadataCallback{Type: "windows_metadata_callback", Version: 1, OuterRPCID: "outer-rpc", StepID: fmt.Sprintf("test-%d", h.sequence), Nonce: t.Nonce, Action: t.Action, Descriptors: CallbackDescriptors{t.Root, t.Parent, t.Target}, ProofIDs: CallbackProofs{t.CaptureProofID, t.PreparedObjectID}, ExpectedCurrent: CallbackCurrent{t.ExpectedCurrentMetadataHash, t.ExpectedCurrentContentHash}}
	signed, err := h.store.AttestChallenge(h.ctx, challengeOrigin(t), r, NativeObservation{Root: t.Root, Parent: t.Parent, Target: t.Target})
	if err != nil {
		h.t.Fatal(err)
	}
	t.ChallengeNonce = signed.HelperChallenge.ChallengeNonce
	return t
}
func (h *preparedHarness) execute(t Ticket, f *os.File, p *CaptureProof) (*OperationResult, error) {
	raw, err := h.sign(t)
	if err != nil {
		return nil, err
	}
	return h.helper.Execute(h.ctx, raw, h.peer, t.ChallengeNonce, f, p)
}
func (h *preparedHarness) file(id string, creation uint64) *os.File {
	h.t.Helper()
	f, err := os.CreateTemp(h.t.TempDir(), "ordinary-")
	if err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(func() { f.Close() })
	s := preparedSnapshot(creation)
	hash, _ := SnapshotFingerprint(s)
	h.native.snapshots[f] = s
	h.native.observations[f] = NativeObservation{Root: h.base.Root, Parent: h.base.Parent, Target: NativeDescriptor{"volume", id, strconv.FormatUint(creation, 10), id + "-slot"}, MetadataHash: hash, ContentHash: Digest([]byte("same-content")), RootPath: "root", ParentPath: "root", TargetPath: id}
	return f
}
func (h *preparedHarness) capture(f *os.File) *Descriptor {
	h.t.Helper()
	d, err := h.channel.Capture(h.ctx, f)
	if err != nil {
		h.t.Fatal(err)
	}
	return d
}
func (h *preparedHarness) prepare(f *os.File, d *Descriptor) Ticket {
	h.t.Helper()
	if _, err := h.channel.invoke(h.ctx, "prepare_owned", f, nil, d); err != nil {
		h.t.Fatal(err)
	}
	return h.tickets[len(h.tickets)-1]
}
func (h *preparedHarness) restoreTicket(f *os.File, old, prepared *Descriptor) Ticket {
	t := h.base
	t.Action = "restore_original"
	t.Target = h.native.observations[f].Target
	t.CaptureProofID = &old.Proof.RecordID
	t.PreparedObjectID = &prepared.Proof.RecordID
	t.ExpectedCurrentMetadataHash = &prepared.MetadataDigest
	t.ExpectedCurrentContentHash = &prepared.ContentDigest
	return t
}

func TestPreparedChannelCaptureRegisterRestoreStrict(t *testing.T) {
	h := newPreparedHarness(t)
	oldFile := h.file("old", 10)
	newFile := h.file("new", 20)
	original := h.capture(oldFile)
	if err := h.channel.ApplyOriginal(h.ctx, newFile, original); err != nil {
		t.Fatal(err)
	}
	if h.native.restores != 1 || h.native.mutations != 1 {
		t.Fatal("restore not exactly once")
	}
	if err := h.channel.MatchesOriginal(h.ctx, newFile, original); err != nil {
		t.Fatal(err)
	}
	if h.native.observations[newFile].Target.FileID == original.Target.FileID {
		t.Fatal("new target pretended to be original")
	}
	var restore Ticket
	for _, ticket := range h.tickets {
		if ticket.Action == "restore_original" {
			restore = ticket
		}
	}
	if _, err := h.store.Original(restore, original.Proof); err == nil {
		t.Fatal("Original target comparison weakened")
	}
	for i := 0; i < 2; i++ {
		retry := restore
		retry.Nonce = ""
		retry = h.attested(retry)
		op, err := h.execute(retry, newFile, &original.Proof)
		if err != nil || op.State != "completed" {
			t.Fatal("fresh nonce retry", err, op)
		}
	}
	if h.native.restores != 1 {
		t.Fatal("retry repeated ACL")
	}
	config := h.store.config
	if err := h.store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := NewProtectedStore(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { reopened.Close() })
	h.store = reopened
	h.helper.Store = reopened
	h.helper.Verifier.RegisteredChallenge = reopened.RegisteredStage
	if err := h.channel.MatchesOriginal(h.ctx, newFile, original); err != nil {
		t.Fatal("reopen lost completed association", err)
	}
	impostor := h.file("impostor", 10)
	h.native.snapshots[impostor] = h.native.snapshots[newFile]
	o := h.native.observations[impostor]
	o.MetadataHash = original.MetadataDigest
	h.native.observations[impostor] = o
	if err := h.channel.MatchesOriginal(h.ctx, impostor, original); err == nil {
		t.Fatal("same matrix different inode accepted")
	}
}

func TestPreparedRejectionsNeverDispatchNativeMutation(t *testing.T) {
	for _, kind := range []string{"unregistered", "forged-id", "forged-proof", "forged-SD", "same-bytes-inode", "creation", "slot", "root", "parent", "actor", "origin", "source", "scope", "helper", "session", "connection", "generation", "fence", "lease", "digest", "old-proof-operation", "seal-borrow", "cleanup-unregistered", "expected-metadata", "expected-content"} {
		t.Run(kind, func(t *testing.T) {
			h := newPreparedHarness(t)
			old := h.capture(h.file("old", 10))
			f := h.file("new", 20)
			prepared := h.capture(f)
			if kind != "unregistered" && kind != "cleanup-unregistered" {
				h.prepare(f, prepared)
			}
			ticket := h.restoreTicket(f, old, prepared)
			proof := old.Proof
			switch kind {
			case "forged-id":
				id := "client-selected"
				ticket.PreparedObjectID = &id
			case "forged-proof":
				proof.Signature = strings.Repeat("A", 86)
			case "forged-SD":
				raw, err := h.store.read("capture-"+proof.RecordID+".json", MetadataBytes+32<<10)
				if err != nil {
					t.Fatal(err)
				}
				var record CaptureRecord
				if err := json.Unmarshal(raw, &record); err != nil {
					t.Fatal(err)
				}
				record.Snapshot.Security[0] = 1
				if err := h.store.write("capture-"+proof.RecordID+".json", record); err != nil {
					t.Fatal(err)
				}
			case "same-bytes-inode":
				o := h.native.observations[f]
				o.Target.FileID = "replacement"
				h.native.observations[f] = o
			case "creation":
				ticket.Target.CreationTime = "changed"
			case "slot":
				ticket.Target.PathKey = "changed"
			case "root":
				ticket.Root.FileID = "changed"
				h.helper.Verifier.Roots = append(h.helper.Verifier.Roots, ticket.Root)
			case "parent":
				ticket.Parent.FileID = "changed"
			case "actor":
				ticket.ActorSubjectKey = "changed"
			case "origin":
				ticket.OriginRefHash = strings.Repeat("c", 64)
			case "source":
				ticket.ExecutorSourceID = "changed"
			case "scope":
				ticket.ScopeID = "changed"
			case "helper":
				ticket.HelperInstanceID = "changed"
			case "session":
				ticket.SessionID = "changed"
			case "connection":
				ticket.ConnectionID = "changed"
			case "generation":
				ticket.RuntimeGeneration++
			case "fence":
				ticket.Fence++
			case "lease":
				ticket.LeaseID = "changed"
			case "digest":
				ticket.RequestDigest = strings.Repeat("d", 64)
			case "old-proof-operation":
				ticket.OperationID = "other-op"
			case "seal-borrow":
				ticket.Action = "seal_owned"
			case "cleanup-unregistered":
				ticket.Action = "cleanup_created"
				ticket.CaptureProofID = nil
				proof = prepared.Proof
			case "expected-metadata":
				hash := strings.Repeat("f", 64)
				ticket.ExpectedCurrentMetadataHash = &hash
			case "expected-content":
				hash := strings.Repeat("e", 64)
				ticket.ExpectedCurrentContentHash = &hash
			}
			if kind == "helper" {
				ticket.ChallengeNonce = strings.Repeat("B", 43)
				ticket.Nonce = strings.Repeat("A", 43)
			} else {
				ticket = h.attested(ticket)
			}
			if _, err := h.execute(ticket, f, &proof); err == nil {
				t.Fatal("unauthorized request accepted")
			}
			if h.native.restores != 0 || h.native.mutations != 0 {
				t.Fatal("rejected request called actual mutation")
			}
		})
	}
}

func TestPreparedRegistrationCrashRetainsUnknownEvidence(t *testing.T) {
	for _, phase := range []string{"before_prepared_publish", "after_prepared_publish", "after_dispatch"} {
		t.Run(phase, func(t *testing.T) {
			h := newPreparedHarness(t)
			old := h.capture(h.file("old", 10))
			f := h.file("new", 20)
			prepared := h.capture(f)
			if phase == "after_dispatch" {
				h.prepare(f, prepared)
				h.native.failRestore = true
				ticket := h.attested(h.restoreTicket(f, old, prepared))
				op, err := h.execute(ticket, f, &old.Proof)
				if err == nil || op.State != "unknown" {
					t.Fatal("dispatch failure not unknown")
				}
				retry := ticket
				retry.Nonce = ""
				retry = h.attested(retry)
				op, err = h.execute(retry, f, &old.Proof)
				if err != nil || op.State != "unknown" || h.native.restores != 1 {
					t.Fatal("unknown redispatched", err)
				}
				return
			}
			// Limit failure to the immutable preparation write, after the intent is
			// durable. Every earlier ledger/fence/nonce/capture remains in place.
			h.store.config.Fault = func(p string) error {
				if p == phase {
					return os.ErrPermission
				}
				return nil
			}
			result, err := h.channel.invoke(h.ctx, "prepare_owned", f, nil, prepared)
			if err == nil || result == nil || result.State != "unknown" {
				t.Fatal("fault did not retain Unknown", err, result)
			}
			h.store.config.Fault = nil
			config := h.store.config
			if err := h.store.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := NewProtectedStore(config)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { reopened.Close() })
			h.store = reopened
			h.helper.Store = reopened
			h.helper.Verifier.RegisteredChallenge = reopened.RegisteredStage
			if phase == "after_prepared_publish" {
				if _, err := reopened.read("prepared-"+prepared.Proof.RecordID+".json", 64<<10); err != nil {
					t.Fatal("published evidence lost", err)
				}
			}
			retry := result.Ticket
			retry.Nonce = ""
			retry = h.attested(retry)
			op, err := h.execute(retry, f, &prepared.Proof)
			if err != nil || op.State != "unknown" {
				t.Fatal("reopen guessed rejected or reran prepare", err, op)
			}
			if _, err := h.execute(h.attested(h.restoreTicket(f, old, prepared)), f, &old.Proof); err == nil {
				t.Fatal("incomplete prepare authorized restore")
			}
			if h.native.mutations != 0 {
				t.Fatal("prepare durability failure caused ACL")
			}
			if _, err := h.store.loadCapture(prepared.Proof); err != nil {
				t.Fatal("original evidence lost", err)
			}
		})
	}
}

func TestPreparedNonceCannotChangeActionAndFreshRetryConsumed(t *testing.T) {
	h := newPreparedHarness(t)
	old := h.capture(h.file("old", 10))
	f := h.file("new", 20)
	prepared := h.capture(f)
	prepare := h.prepare(f, prepared)
	retry := prepare
	retry.Nonce = ""
	retry = h.attested(retry)
	op, err := h.execute(retry, f, &prepared.Proof)
	if err != nil || op.State != "prepared" {
		t.Fatal(err)
	}
	restore := h.restoreTicket(f, old, prepared)
	restore.Nonce = retry.Nonce
	restore = h.attested(restore)
	if _, err := h.execute(restore, f, &old.Proof); err == nil {
		t.Fatal("fresh query nonce reused for ACL action")
	}
	if h.native.mutations != 0 {
		t.Fatal("nonce rejection dispatched native")
	}
}
