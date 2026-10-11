package windowsbackup

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestPreparedStableStageRejectsNewProofAndKeepsMultiFileOperation(t *testing.T) {
	h := newPreparedHarness(t)
	oldFile := h.file("old", 10)
	original := h.capture(oldFile)
	anotherOriginal := h.capture(oldFile)
	first := h.file("first", 20)
	prepared := h.capture(first)
	anotherCapture := h.capture(first)
	h.prepare(first, prepared)
	if _, err := h.channel.invoke(h.ctx, "prepare_owned", first, nil, anotherCapture); err == nil {
		t.Fatal("changed proof minted a second prepare stage")
	}
	request := h.attested(h.restoreTicket(first, original, prepared))
	if op, err := h.execute(request, first, &original.Proof); err != nil || op.State != "completed" {
		t.Fatal(err, op)
	}
	changed := request
	changed.Nonce = ""
	changed.CaptureProofID = &anotherOriginal.Proof.RecordID
	if _, err := h.execute(h.attested(changed), first, &anotherOriginal.Proof); err == nil {
		t.Fatal("changed original proof minted a second restore stage")
	}
	if h.native.restores != 1 {
		t.Fatal("proof equivocation called restore")
	}
	// One outer operation legitimately restores several independently captured
	// native files. The master ledger cannot collapse them into one mutation.
	second := h.file("second", 30)
	if err := h.channel.ApplyOriginal(h.ctx, second, original); err != nil {
		t.Fatal("second file in same outer operation rejected", err)
	}
	if h.native.restores != 2 {
		t.Fatal("multi-file operation did not restore both files")
	}
	// A successful restore changes CreationTime, but cannot grant a new prepare
	// stage of the same native file within the same operation.
	if err := h.channel.ApplyOriginal(h.ctx, first, original); err == nil {
		t.Fatal("restored creation minted another prepare stage")
	}
	if h.native.restores != 2 {
		t.Fatal("restarted channel repeated ACL mutation")
	}
}

func TestPreparedExplicitRecoveryBindsHistoricalAndCurrentReservations(t *testing.T) {
	for _, changed := range []string{"valid", "original-op", "original-digest", "original-fence", "original-lease", "missing"} {
		t.Run(changed, func(t *testing.T) {
			h := newPreparedHarness(t)
			old := h.capture(h.file("old", 10))
			oldTuple := OriginalOperation{h.base.OperationID, h.base.RequestDigest, h.base.LeaseID, h.base.Fence}
			h.base.OperationID = "current-recovery"
			h.base.RequestDigest = strings.Repeat("d", 64)
			h.base.LeaseID = "current-lease"
			h.base.Fence++
			f := h.file("prepared", 20)
			prepared := h.capture(f)
			h.prepare(f, prepared)
			request := h.restoreTicket(f, old, prepared)
			request.RecoveryOriginal = &oldTuple
			switch changed {
			case "original-op":
				oldTuple.OperationID = "unrelated"
			case "original-digest":
				oldTuple.RequestDigest = strings.Repeat("e", 64)
			case "original-fence":
				oldTuple.Fence++
			case "original-lease":
				oldTuple.LeaseID = "unrelated"
			case "missing":
				request.RecoveryOriginal = nil
			}
			op, err := h.execute(h.attested(request), f, &old.Proof)
			if changed == "valid" {
				if err != nil || op.State != "completed" || h.native.restores != 1 {
					t.Fatal("explicit recovery refused", err, op)
				}
				status := h.base
				status.Action = "status_original"
				status.Target = old.Target
				status.CaptureProofID = &old.Proof.RecordID
				status.RecoveryOriginal = &oldTuple
				if _, err := h.execute(h.attested(status), f, &old.Proof); err != nil {
					t.Fatal("recovery restored association unavailable", err)
				}
			} else if err == nil || h.native.mutations != 0 {
				t.Fatal("wrong historical tuple dispatched", err)
			}
		})
	}
}

func TestPreparedChallengeRegistrationCannotChangeStableTuple(t *testing.T) {
	for _, field := range []string{"stage", "nonce", "helper", "epoch", "session", "generation", "proof", "action"} {
		t.Run(field, func(t *testing.T) {
			h := newPreparedHarness(t)
			old := h.capture(h.file("old", 10))
			f := h.file("prepared", 20)
			prepared := h.capture(f)
			h.prepare(f, prepared)
			ticket := h.attested(h.restoreTicket(f, old, prepared))
			name := "challenge-" + Digest([]byte(ticket.ChallengeNonce)) + ".json"
			raw, err := h.store.read(name, 32<<10)
			if err != nil {
				t.Fatal(err)
			}
			var registration RegisteredChallenge
			if err := json.Unmarshal(raw, &registration); err != nil {
				t.Fatal(err)
			}
			switch field {
			case "stage":
				registration.StageKey = strings.Repeat("f", 64)
			case "nonce":
				registration.Request.HelperChallenge.ChallengeNonce = strings.Repeat("A", 43)
			case "helper":
				registration.Request.HelperChallenge.HelperInstanceID = "other"
			case "epoch":
				registration.Request.HelperChallenge.KeyEpoch++
			case "session":
				registration.Request.HelperChallenge.SessionID = "other"
			case "generation":
				registration.Request.HelperChallenge.RuntimeGeneration++
			case "proof":
				id := "other"
				registration.Request.ProofIDs.PreparedObjectID = &id
			case "action":
				registration.Request.Action = "cleanup_created"
			}
			if err := h.store.write(name, registration); err != nil {
				t.Fatal(err)
			}
			if _, err := h.execute(ticket, f, &old.Proof); err == nil || h.native.mutations != 0 {
				t.Fatal("tampered challenge dispatched", err)
			}
		})
	}
}

func TestPreparedLegacyLedgerFailsClosedWithoutDeletingEvidence(t *testing.T) {
	h := newPreparedHarness(t)
	old := h.capture(h.file("old", 10))
	f := h.file("prepared", 20)
	prepared := h.capture(f)
	h.prepare(f, prepared)
	key := "master-v2-" + Digest([]byte(h.base.ExecutorSourceID+"\x00"+h.base.ScopeID+"\x00"+h.base.OperationID)) + ".json"
	fingerprint, err := masterFingerprint(h.base)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.store.write(key, map[string]string{"fingerprint": fingerprint}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.execute(h.attested(h.restoreTicket(f, old, prepared)), f, &old.Proof); err == nil || h.native.mutations != 0 {
		t.Fatal("legacy ledger silently upgraded and dispatched", err)
	}
	if _, err := os.Stat(h.store.Directory() + string(os.PathSeparator) + key); err != nil {
		t.Fatal("legacy master removed", err)
	}
	if _, err := h.store.loadCapture(old.Proof); err != nil {
		t.Fatal("legacy original evidence removed", err)
	}
}

func TestPreparedCaptureProofEpochAndDescriptorTamperingNeverDispatch(t *testing.T) {
	for _, field := range []string{"helper", "epoch", "metadata", "attributes", "field-manifest", "target"} {
		t.Run(field, func(t *testing.T) {
			h := newPreparedHarness(t)
			old := h.capture(h.file("old", 10))
			f := h.file("prepared", 20)
			switch field {
			case "helper":
				old.Proof.HelperInstanceID = "foreign"
			case "epoch":
				old.Proof.KeyEpoch++
			case "metadata":
				old.MetadataDigest = strings.Repeat("f", 64)
			case "attributes":
				old.Attributes++
			case "field-manifest":
				old.Fields["streams"] = "known_absent"
			case "target":
				old.Target.FileID = "foreign"
			}
			if err := h.channel.ApplyOriginal(h.ctx, f, old); err == nil || h.native.mutations != 0 {
				t.Fatal("client descriptor replaced signed original", err)
			}
		})
	}
}
