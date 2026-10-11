package windowsbackup

import (
	"bytes"
	"encoding/json"
	"testing"
)

func publicationFixture(t *testing.T, sameSlot bool) (*preparedHarness, []byte, []byte, AttachmentPublication) {
	t.Helper()
	h := newPreparedHarness(t)
	f := h.file("attachment", 20)
	left := h.capture(f)
	o := h.native.observations[f]
	if !sameSlot {
		o.Target.PathKey = "final-slot"
		h.native.observations[f] = o
	}
	right := h.capture(f)
	a, err := EncodeDescriptor(left)
	if err != nil {
		t.Fatal(err)
	}
	b, err := EncodeDescriptor(right)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(a, b) || left.Proof.RecordID == right.Proof.RecordID || left.Proof.RecordNonce == right.Proof.RecordNonce {
		t.Fatal("old opaque bytes.Equal did not reproduce independent-proof refusal")
	}
	h.ctx = WithMetadataChannel(h.ctx, h.channel)
	return h, a, b, AttachmentPublication{Root: left.Root, Parent: left.Parent, Prepared: left.Target, Final: right.Target, ContentDigest: left.ContentDigest}
}

func TestAttachmentPublicationAuthenticatedIndependentProofs(t *testing.T) {
	for _, same := range []bool{false, true} {
		name := "rename"
		if same {
			name = "same-slot"
		}
		t.Run(name, func(t *testing.T) {
			h, a, b, frozen := publicationFixture(t, same)
			if err := VerifyAttachmentPublication(h.ctx, a, b, frozen); err != nil {
				t.Fatal(err)
			}
			if !same {
				if _, err := EquivalentMetadata(h.ctx, a, b); err == nil {
					t.Fatal("strict equivalent metadata admitted rename")
				}
			}
			if h.native.mutations != 0 || h.native.restores != 0 {
				t.Fatal("verification mutated native object")
			}
			statuses := 0
			for _, ticket := range h.tickets {
				if ticket.Action == "status_original" {
					statuses++
				}
			}
			if statuses < 2 {
				t.Fatal("private record validation bypassed")
			}
		})
	}
}

func TestAttachmentPublicationRejectsAuthenticatedFullMatrixChanges(t *testing.T) {
	for _, field := range []string{"security", "attributes", "last-access", "last-write", "ea", "streams", "manifest"} {
		t.Run(field, func(t *testing.T) {
			h := newPreparedHarness(t)
			f := h.file("attachment", 20)
			left := h.capture(f)
			s := h.native.snapshots[f]
			switch field {
			case "security":
				s.Security[0] = 1
			case "attributes":
				s.Attributes = 1
			case "last-access":
				s.LastAccess++
			case "last-write":
				s.LastWrite++
			case "ea":
				s.EA = []byte("different authenticated EA")
			case "streams":
				s.Streams = []Stream{{Name: ":test:$DATA", Size: 1, Digest: Digest([]byte("x"))}}
			case "manifest":
				s.Manifest["ea"] = "known_absent"
			}
			o := h.native.observations[f]
			o.Target.PathKey = "final-slot"
			o.MetadataHash, _ = SnapshotFingerprint(s)
			h.native.observations[f] = o
			right := h.capture(f)
			a, _ := EncodeDescriptor(left)
			b, _ := EncodeDescriptor(right)
			frozen := AttachmentPublication{Root: left.Root, Parent: left.Parent, Prepared: left.Target, Final: right.Target, ContentDigest: left.ContentDigest}
			ctx := WithMetadataChannel(h.ctx, h.channel)
			if err := VerifyAttachmentPublication(ctx, a, b, frozen); err == nil {
				t.Fatal("authenticated matrix change accepted")
			}
			if h.native.mutations != 0 {
				t.Fatal("matrix refusal mutated object")
			}
		})
	}
}

func TestAttachmentPublicationRejectsUnfrozenOrForgedEvidence(t *testing.T) {
	cases := []string{"unfrozen", "reverse", "foreign-slot", "root", "parent", "incarnation", "content-intent", "content-projection", "matrix-projection", "proof-key", "proof-helper", "private-record", "actor", "source", "scope", "session", "operation", "fence", "metadata-matrix"}
	for _, name := range cases {
		t.Run(name, func(t *testing.T) {
			h, a, b, frozen := publicationFixture(t, false)
			d, err := DecodeDescriptor(b)
			if err != nil {
				t.Fatal(err)
			}
			switch name {
			case "unfrozen":
				frozen = AttachmentPublication{}
			case "reverse":
				a, b = b, a
			case "foreign-slot":
				frozen.Final.PathKey = "foreign"
			case "root":
				frozen.Root.FileID = "foreign-root"
			case "parent":
				frozen.Parent.FileID = "foreign-parent"
			case "incarnation":
				frozen.Final.CreationTime = "21"
			case "content-intent":
				frozen.ContentDigest = Digest([]byte("other"))
			case "content-projection":
				d.ContentDigest = Digest([]byte("other"))
			case "matrix-projection":
				d.MetadataDigest = Digest([]byte("other"))
			case "proof-key":
				d.Proof.KeyEpoch++
			case "proof-helper":
				d.Proof.HelperInstanceID = "foreign-helper"
			case "private-record":
				var record CaptureRecord
				raw, err := h.store.read("capture-"+d.Proof.RecordID+".json", MetadataBytes+32<<10)
				if err != nil {
					t.Fatal(err)
				}
				if err := json.Unmarshal(raw, &record); err != nil {
					t.Fatal(err)
				}
				record.Snapshot.Creation++
				if err := h.store.write("capture-"+d.Proof.RecordID+".json", record); err != nil {
					t.Fatal(err)
				}
			case "actor":
				h.base.ActorSubjectKey = "other"
			case "source":
				h.base.ExecutorSourceID = "other"
			case "scope":
				h.base.ScopeID = "other"
			case "session":
				h.base.SessionID = "other"
			case "operation":
				h.base.OperationID = "other"
			case "fence":
				h.base.Fence++
			case "metadata-matrix":
				f := h.file("attachment", 20)
				snap := h.native.snapshots[f]
				snap.LastWrite++
				o := h.native.observations[f]
				o.Target = frozen.Final
				o.MetadataHash, _ = SnapshotFingerprint(snap)
				h.native.observations[f] = o
				d = h.capture(f)
			}
			if name != "reverse" {
				b, err = EncodeDescriptor(d)
				if err != nil {
					t.Fatal(err)
				}
			}
			if err := VerifyAttachmentPublication(h.ctx, a, b, frozen); err == nil {
				t.Fatal("unsafe publication accepted")
			}
			if h.native.mutations != 0 {
				t.Fatal("refusal mutated object")
			}
		})
	}
}
