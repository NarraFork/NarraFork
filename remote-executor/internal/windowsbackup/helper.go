package windowsbackup

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"time"
)

// NativeObservation is produced by a trusted helper backend which checks the
// ordinary duplicated handle, exact root/ancestor/case/deny-hole/parent identity
// and both expected hashes. Client strings and file IDs alone are insufficient.
type NativeObservation struct {
	Root, Parent, Target             NativeDescriptor
	MetadataHash, ContentHash        string
	RootPath, ParentPath, TargetPath string
}
type NativeOperations interface {
	Observe(context.Context, Ticket, *os.File) (NativeObservation, error)
	Capture(context.Context, *os.File) (*Snapshot, error)
	Restore(context.Context, *os.File, *CaptureRecord) error
	Seal(context.Context, *VerifiedTicket, *os.File, *CaptureRecord) (*VaultReference, error)
	Unseal(context.Context, *VerifiedTicket, *os.File, *CaptureRecord) error
	Cleanup(context.Context, *VerifiedTicket, *os.File, *CaptureRecord) error
	VerifyOutcome(context.Context, *VerifiedTicket, *os.File, *CaptureRecord) error
}
type Helper struct {
	Verifier            *Verifier
	Store               *ProtectedStore
	Native              NativeOperations
	queue               chan struct{}
	workers             chan struct{}
	firstCaptureHandles *firstCaptureHandleRegistry
}

func NewHelper(verifier *Verifier, store *ProtectedStore, native NativeOperations) (*Helper, error) {
	if verifier == nil || store == nil || native == nil || verifier.Session.HelperInstanceID != store.config.HelperInstanceID || verifier.Session.Peer.ServiceSID == "" || len(verifier.Keys) == 0 {
		return nil, fmt.Errorf("helper authority/native configuration not ready")
	}
	verifier.RegisteredChallenge = store.RegisteredStage
	handles := newFirstCaptureHandleRegistry()
	if verifier.Now != nil {
		handles.now = verifier.Now
	}
	return &Helper{Verifier: verifier, Store: store, Native: native, queue: make(chan struct{}, QueueSize), workers: make(chan struct{}, Workers), firstCaptureHandles: handles}, nil
}

// Execute is the production wire seam. It never accepts SD/metadata bytes; the
// only client proof is an opaque signed reference to the helper's own record.
// PeerIdentity and handle are supplied by the native IPC server, not request JSON.
func (h *Helper) Execute(ctx context.Context, envelope []byte, peer PeerIdentity, challenge string, file *os.File, proof *CaptureProof) (*OperationResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	select {
	case h.queue <- struct{}{}:
	default:
		return nil, fmt.Errorf("helper queue full")
	}
	defer func() { <-h.queue }()
	select {
	case h.workers <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-h.workers }()
	verified, err := h.Verifier.Verify(envelope, peer, challenge)
	if err != nil {
		return nil, err
	}
	t := verified.ticket
	// Restore/seal proof authentication is BEFORE any native metadata/ACL IO.
	var original *CaptureRecord
	switch t.Action {
	case "restore_original", "seal_owned", "unseal_original", "status_original":
		if proof == nil {
			return nil, fmt.Errorf("helper original proof required")
		}
		if t.PreparedObjectID != nil {
			// Only restore may use the durable target-switch capability. Seal,
			// unseal and historical status cannot borrow a prepared registration.
			original, err = h.Store.preparedOriginal(t, *proof)
		} else {
			original, err = h.Store.Original(t, *proof)
		}
		if err != nil {
			return nil, err
		}
	case "cleanup_created", "prepare_owned":
		// There is deliberately no client-selected prepared ID registration. An
		// owned entry must already be captured and registered by this helper.
		if proof == nil || t.PreparedObjectID == nil || *t.PreparedObjectID != proof.RecordID {
			return nil, fmt.Errorf("helper registered created-object proof required")
		}
		ownedTicket := t
		ownedTicket.CaptureProofID = t.PreparedObjectID
		original, err = h.Store.Original(ownedTicket, *proof)
		if err != nil {
			return nil, err
		}
		if t.Action == "cleanup_created" {
			if _, _, err := h.Store.prepared(t); err != nil {
				return nil, err
			}
			// Runtime projection only: the signed immutable capture is untouched.
			original.State = "prepared"
		}
	case "capture_exact":
		if proof != nil {
			return nil, fmt.Errorf("capture cannot accept client proof")
		}
	}
	op, repeated, err := h.Store.Begin(verified)
	if err != nil {
		return nil, err
	}
	if repeated {
		return op, nil
	}
	ctx = WithBlobs(ctx, h.Store)
	if t.Action == "status_original" {
		if file != nil {
			current, e := h.Native.Observe(ctx, t, file)
			if e != nil {
				return h.reject(op, e)
			}
			if current.Root != t.Root || current.Parent != t.Parent {
				return h.reject(op, fmt.Errorf("status native root/parent changed"))
			}
			if current.Target != t.Target {
				if e := h.Store.restored(t, proof.RecordID, current); e != nil {
					return h.reject(op, e)
				}
			}
			metadata, e := SnapshotFingerprint(original.Snapshot)
			if e != nil || metadata != current.MetadataHash {
				return h.reject(op, fmt.Errorf("status native metadata changed"))
			}
		}
		op.State = "original_status"
		op.Proof = proof
		op.Descriptor, err = descriptorFromSnapshot(original.Ticket, original.Snapshot, original.ContentHash, *proof)
		if err != nil {
			return nil, err
		}
		return op, h.Store.Complete(op)
	}
	if file == nil {
		return nil, fmt.Errorf("actual ordinary handle required")
	}
	ctx = WithBlobs(ctx, h.Store)
	observed, err := h.Native.Observe(ctx, t, file)
	if err != nil {
		return h.reject(op, err)
	}
	if observed.Root != t.Root || observed.Parent != t.Parent || observed.Target != t.Target {
		return h.reject(op, fmt.Errorf("actual native identity/containment changed"))
	}
	if t.ExpectedCurrentMetadataHash != nil && observed.MetadataHash != *t.ExpectedCurrentMetadataHash || t.ExpectedCurrentContentHash != nil && observed.ContentHash != *t.ExpectedCurrentContentHash {
		return h.reject(op, fmt.Errorf("expected-current state changed"))
	}
	if err := ctx.Err(); err != nil {
		return h.reject(op, err)
	}
	if t.Action == "capture_exact" {
		snapshot, err := h.Native.Capture(ctx, file)
		if err != nil {
			return h.reject(op, err)
		}
		if snapshot == nil {
			return h.reject(op, fmt.Errorf("native capture returned no snapshot"))
		}
		metadata, fingerprintErr := SnapshotFingerprint(snapshot)
		if fingerprintErr != nil || metadata != observed.MetadataHash || strconv.FormatUint(snapshot.Creation, 10) != observed.Target.CreationTime {
			return h.reject(op, fmt.Errorf("native capture matrix/creation changed"))
		}
		// Re-observe after capture: no mixed-incarnation capture proof is issued.
		after, err := h.Native.Observe(ctx, t, file)
		if err != nil || after != observed {
			return h.reject(op, fmt.Errorf("native capture state changed"))
		}
		p, err := h.Store.SaveCapture(t, snapshot, observed.ContentHash, observed)
		if err != nil {
			return h.reject(op, err)
		}
		op.Proof = p
		op.Descriptor, err = descriptorFromSnapshot(t, snapshot, observed.ContentHash, *p)
		if err != nil {
			return h.reject(op, err)
		}
		op.State = "captured"
		return op, h.Store.Complete(op)
	}
	// Every actual ACL/move/delete action requires BOTH current hashes. A caller
	// cannot use null expected fields to bypass conflicting original state.
	if t.ExpectedCurrentMetadataHash == nil || t.ExpectedCurrentContentHash == nil {
		return h.reject(op, fmt.Errorf("mutation expected-current proofs required"))
	}
	if t.Action == "prepare_owned" {
		if err := h.Store.savePrepared(op, *proof, observed); err != nil {
			op.State = "unknown"
			op.Reason = "prepared registration durability unknown"
			_ = h.Store.Complete(op)
			return op, err
		}
		op.State = "prepared"
		op.Proof = proof
		if err := h.Store.Complete(op); err != nil {
			op.State = "unknown"
			return op, err
		}
		return op, nil
	}
	op.State = "dispatched"
	if err := h.Store.Complete(op); err != nil {
		return nil, err
	}
	// Once dispatched, every native/final receipt failure is UNKNOWN, never
	// rejected, and exact retries query this original intent instead of reapply.
	switch t.Action {
	case "restore_original":
		err = h.Native.Restore(ctx, file, original)
	case "seal_owned":
		_, err = h.Native.Seal(ctx, verified, file, original)
	case "unseal_original":
		err = h.Native.Unseal(ctx, verified, file, original)
	case "cleanup_created":
		err = h.Native.Cleanup(ctx, verified, file, original)
	default:
		err = fmt.Errorf("unsupported helper action")
	}
	if err != nil {
		op.State = "unknown"
		op.Reason = "native dispatch outcome unknown"
		_ = h.Store.Complete(op)
		return op, err
	}
	if err := h.Native.VerifyOutcome(ctx, verified, file, original); err != nil {
		op.State = "unknown"
		op.Reason = "postdispatch identity outcome unknown"
		_ = h.Store.Complete(op)
		return op, fmt.Errorf("postdispatch verification failed")
	}
	if t.Action == "restore_original" {
		// Verify the complete matrix AND retained main stream on the new native
		// incarnation. Creation time is intentionally restored; file ID/path/root
		// are not substituted with the historical object's identity.
		after, observeErr := h.Native.Observe(ctx, t, file)
		metadata, metadataErr := SnapshotFingerprint(original.Snapshot)
		target := t.Target
		target.CreationTime = strconv.FormatUint(original.Snapshot.Creation, 10)
		if observeErr != nil || metadataErr != nil || after.Root != t.Root || after.Parent != t.Parent || after.Target != target || after.MetadataHash != metadata || after.ContentHash != observed.ContentHash || after.RootPath != observed.RootPath || after.ParentPath != observed.ParentPath || after.TargetPath != observed.TargetPath {
			op.State = "unknown"
			op.Reason = "restored full matrix/native/content outcome unknown"
			_ = h.Store.Complete(op)
			return op, fmt.Errorf("restored full outcome mismatch")
		}
		if err := h.Store.saveRestored(op, *proof, original); err != nil {
			op.State = "unknown"
			op.Reason = "restored association durability unknown"
			_ = h.Store.Complete(op)
			return op, err
		}
	}
	// Native.Restore performs exact matrix verification; the returned identity
	// check is additional. Seal/cleanup adapters must supply their own final state.
	op.State = "completed"
	op.Proof = proof
	if err := h.Store.Complete(op); err != nil {
		op.State = "unknown"
		return op, err
	}
	return op, nil
}
func (h *Helper) reject(op *OperationResult, err error) (*OperationResult, error) {
	op.State = "rejected"
	op.Reason = "native action not dispatched"
	if e := h.Store.Complete(op); e != nil {
		return nil, e
	}
	return op, err
}
