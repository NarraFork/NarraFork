//go:build !windows

package windowsbackup

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// These are policy/durability tests on a Unix test backing store, not Windows
// native ACL or ordinary-user/helper deployment evidence.
func policyStore(t *testing.T) (*ProtectedStore, Ticket) {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s, err := NewProtectedStore(StoreConfig{Directory: filepath.Join(t.TempDir(), "store"), HelperInstanceID: "helper", ServiceSID: "unit-only-service", SigningKey: key})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	root := NativeDescriptor{"volume", "root", "creation", "slot"}
	ticket := Ticket{Version: 1, Issuer: "issuer", ServiceID: "service", DeviceID: "device", ExecutorSourceID: "source", HelperInstanceID: "helper", ScopeID: "scope", Root: root, Parent: root, Target: NativeDescriptor{"volume", "file", "creation", "file-slot"}, OperationID: "op", RequestDigest: strings.Repeat("a", 64), ActorSubjectKey: "actor", OriginRefHash: strings.Repeat("b", 64), SessionID: "session", ConnectionID: "conn", RuntimeGeneration: 1, LeaseID: "lease", Fence: 1, Action: "capture_exact", BudgetClass: "metadata", Nonce: strings.Repeat("A", 43), ChallengeNonce: strings.Repeat("B", 43)}
	return s, ticket
}
func policySnapshot() *Snapshot {
	fields := map[string]string{}
	for _, k := range requiredFields {
		fields[k] = "captured_exact"
	}
	fields["specialSecurity"] = "known_absent"
	return &Snapshot{Version: 2, Platform: "windows", Matrix: "ordinary-file-v2", Security: make([]byte, 20), Streams: []Stream{}, Manifest: fields}
}
func TestProtectedOriginalProofCannotMoveActorRootOrBytes(t *testing.T) {
	store, ticket := policyStore(t)
	proof, err := store.SaveCapture(ticket, policySnapshot(), strings.Repeat("c", 64))
	if err != nil {
		t.Fatal(err)
	}
	request := ticket
	request.Action = "restore_original"
	request.CaptureProofID = &proof.RecordID
	if _, err := store.Original(request, *proof); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"actor", "root", "scope", "file", "fence", "signature", "record"} {
		t.Run(kind, func(t *testing.T) {
			changed := request
			bad := *proof
			switch kind {
			case "actor":
				changed.ActorSubjectKey = "other"
			case "root":
				changed.Root.FileID = "other"
			case "scope":
				changed.ScopeID = "other"
			case "file":
				changed.Target.FileID = "other"
			case "fence":
				changed.Fence++
			case "signature":
				bad.Signature = strings.Repeat("A", 86)
			case "record":
				bad.RecordID = "other"
			}
			if _, err := store.Original(changed, bad); err == nil {
				t.Fatal("cross original binding accepted")
			}
		})
	}
	path := filepath.Join(store.Directory(), "capture-"+proof.RecordID+".json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var record CaptureRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		t.Fatal(err)
	}
	record.Snapshot.Security = []byte("client malicious SD bytes")
	raw, _ = json.Marshal(record)
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Original(request, *proof); err == nil {
		t.Fatal("tampered protected SD returned under original proof")
	}
}
func TestProtectedStageReplayAndMasterEquivocation(t *testing.T) {
	store, ticket := policyStore(t)
	capture := &VerifiedTicket{ticket: ticket, digest: strings.Repeat("d", 64), stage: strings.Repeat("1", 64)}
	op, repeated, err := store.Begin(capture)
	if err != nil || repeated {
		t.Fatal(err)
	}
	op.State = "captured"
	if err := store.Complete(op); err != nil {
		t.Fatal(err)
	}
	fresh := *capture
	fresh.ticket.Nonce = strings.Repeat("C", 43)
	fresh.digest = strings.Repeat("e", 64)
	queried, repeated, err := store.Begin(&fresh)
	if err != nil || !repeated || queried.State != "captured" {
		t.Fatal("same stage fresh ticket redispatched", err)
	}
	restore := *capture
	restore.ticket.Action = "restore_original"
	restore.ticket.Nonce = strings.Repeat("D", 43)
	restore.stage = strings.Repeat("2", 64)
	restore.digest = strings.Repeat("f", 64)
	if _, repeated, err := store.Begin(&restore); err != nil || repeated {
		t.Fatal("legitimate next metadata stage rejected", err)
	}
	wrong := restore
	wrong.ticket.RequestDigest = strings.Repeat("0", 64)
	wrong.stage = strings.Repeat("3", 64)
	if _, _, err := store.Begin(&wrong); err == nil {
		t.Fatal("same op different digest admitted")
	}
	replay := restore
	replay.stage = strings.Repeat("4", 64)
	if _, _, err := store.Begin(&replay); err == nil {
		t.Fatal("consumed nonce admitted new action")
	}
}
func TestCaptureProofNotIssuedAfterDurabilityFailure(t *testing.T) {
	store, ticket := policyStore(t)
	store.config.Fault = func(phase string) error {
		if phase == "after_store_fsync" {
			return os.ErrPermission
		}
		return nil
	}
	if proof, err := store.SaveCapture(ticket, policySnapshot(), strings.Repeat("c", 64)); err == nil || proof != nil {
		t.Fatal("proof issued without durable original record")
	}
}
func TestStreamCASBoundedAndVerified(t *testing.T) {
	store, _ := policyStore(t)
	digest, err := store.Put(context.Background(), []byte("stream bytes"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(context.Background(), digest, 12); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(context.Background(), digest, 11); err == nil {
		t.Fatal("truncated stream returned as complete")
	}
	if _, err := store.Get(context.Background(), strings.Repeat("g", 64), 1); err == nil {
		t.Fatal("invalid stream digest accepted")
	}
}
