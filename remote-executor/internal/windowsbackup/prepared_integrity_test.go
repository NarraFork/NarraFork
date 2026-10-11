package windowsbackup

import (
	"context"
	"encoding/json"
	"os"
	"testing"
)

func TestPreparedStoredObservationCannotReplaceCaptureNativeID(t *testing.T) {
	h := newPreparedHarness(t)
	old := h.capture(h.file("old", 10))
	f := h.file("prepared", 20)
	prepared := h.capture(f)
	h.prepare(f, prepared)
	name := "prepared-" + prepared.Proof.RecordID + ".json"
	raw, err := h.store.read(name, 64<<10)
	if err != nil {
		t.Fatal(err)
	}
	var record ProtectedPreparedRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		t.Fatal(err)
	}
	record.Observation.Target.FileID = "same-bytes-different-incarnation"
	if err := h.store.write(name, record); err != nil {
		t.Fatal(err)
	}
	observation := h.native.observations[f]
	observation.Target = record.Observation.Target
	h.native.observations[f] = observation
	request := h.attested(h.restoreTicket(f, old, prepared))
	if _, err := h.execute(request, f, &old.Proof); err == nil || h.native.mutations != 0 {
		t.Fatal("stored observation replaced signed native incarnation", err)
	}
}

func TestPreparedRestoredAssociationCannotReplaceCompletedTarget(t *testing.T) {
	h := newPreparedHarness(t)
	old := h.capture(h.file("old", 10))
	f := h.file("prepared", 20)
	if err := h.channel.ApplyOriginal(h.ctx, f, old); err != nil {
		t.Fatal(err)
	}
	current := h.native.observations[f]
	raw, err := h.store.read(restoredKey(old.Proof.RecordID, current.Target), 64<<10)
	if err != nil {
		t.Fatal(err)
	}
	var record restoredPreparedRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		t.Fatal(err)
	}
	record.Target.FileID = "other-inode"
	if err := h.store.write(restoredKey(old.Proof.RecordID, record.Target), record); err != nil {
		t.Fatal(err)
	}
	current.Target = record.Target
	h.native.observations[f] = current
	if err := h.channel.MatchesOriginal(h.ctx, f, old); err == nil {
		t.Fatal("forged completed association authorized another native inode")
	}
	if h.native.mutations != 1 {
		t.Fatal("status dispatched another mutation")
	}
}

type changedOutcomeNative struct {
	*preparedFakeNative
	field string
}

func (n *changedOutcomeNative) VerifyOutcome(_ context.Context, _ *VerifiedTicket, f *os.File, _ *CaptureRecord) error {
	o := n.observations[f]
	switch n.field {
	case "metadata":
		o.MetadataHash = Digest([]byte("other metadata"))
	case "content":
		o.ContentHash = Digest([]byte("other bytes"))
	case "file":
		o.Target.FileID = "other-inode"
	case "creation":
		o.Target.CreationTime = "21"
	case "slot":
		o.Target.PathKey = "other-slot"
	case "parent":
		o.Parent.FileID = "other-parent"
	}
	n.observations[f] = o
	return nil // A backend's success alone cannot override the helper's outcome.
}
func TestPreparedStrictOutcomeMismatchStaysUnknownWithoutRetryACL(t *testing.T) {
	for _, field := range []string{"metadata", "content", "file", "creation", "slot", "parent"} {
		t.Run(field, func(t *testing.T) {
			h := newPreparedHarness(t)
			old := h.capture(h.file("old", 10))
			f := h.file("prepared", 20)
			prepared := h.capture(f)
			h.prepare(f, prepared)
			h.helper.Native = &changedOutcomeNative{h.native, field}
			request := h.attested(h.restoreTicket(f, old, prepared))
			op, err := h.execute(request, f, &old.Proof)
			if err == nil || op.State != "unknown" || h.native.mutations != 1 {
				t.Fatal("changed outcome reported complete", err, op)
			}
			retry := request
			retry.Nonce = ""
			op, err = h.execute(h.attested(retry), f, &old.Proof)
			if err != nil || op.State != "unknown" || h.native.mutations != 1 {
				t.Fatal("unknown retry repeated native ACL", err, op)
			}
		})
	}
}

func TestPreparedCaptureCannotSignMixedObservedMatrix(t *testing.T) {
	h := newPreparedHarness(t)
	f := h.file("prepared", 20)
	h.native.snapshots[f] = preparedSnapshot(21)
	if _, err := h.channel.Capture(h.ctx, f); err == nil || h.native.mutations != 0 {
		t.Fatal("mixed capture signed", err)
	}
}
