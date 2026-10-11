package windowsbackup

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
)

type OrdinaryDescriptorObserver interface {
	DescribeOrdinary(context.Context, NativeDescriptor, *os.File) (NativeObservation, error)
}

// Challenge validates actual pipe peer and the ordinary original object before
// signing the fixed shared callback domain. It activates no backup privileges.
func (h *Helper) Challenge(ctx context.Context, peer PeerIdentity, original ChallengeOrigin, request MetadataCallback, file *os.File) (*MetadataCallback, error) {
	if peer != h.Verifier.Session.Peer || original.DeviceID != h.Verifier.Session.DeviceID || original.ExecutorSourceID != h.Verifier.Session.SourceID || original.HelperInstanceID != h.Verifier.Session.HelperInstanceID || original.ConnectionID != h.Verifier.Session.ConnectionID || original.SessionID != h.Verifier.Session.SessionID || original.RuntimeGeneration != h.Verifier.Session.Generation {
		return nil, fmt.Errorf("challenge actual peer/session binding")
	}
	var historical *CaptureRecord
	if request.Action == "status_original" {
		if request.ProofIDs.CaptureProofID == nil || request.ProofIDs.PreparedObjectID != nil || !validID(*request.ProofIDs.CaptureProofID, 256) {
			return nil, fmt.Errorf("ordinary authorization handle required")
		}
		raw, err := h.Store.read("capture-"+*request.ProofIDs.CaptureProofID+".json", MetadataBytes+64<<10)
		if err != nil {
			return nil, err
		}
		var record CaptureRecord
		if err := json.Unmarshal(raw, &record); err != nil {
			return nil, err
		}
		if record.Version != 2 || record.State != "captured" || record.Ticket.Action != "capture_exact" || record.Ticket.DeviceID != original.DeviceID || record.Ticket.HelperInstanceID != original.HelperInstanceID || record.ID != *request.ProofIDs.CaptureProofID || record.Ticket.ExecutorSourceID != original.ExecutorSourceID || record.Ticket.ScopeID != original.ScopeID || record.Ticket.Root != original.Root || record.Ticket.Target != request.Descriptors.Target || record.Ticket.Parent != request.Descriptors.Parent {
			return nil, fmt.Errorf("original preauthorization record tuple mismatch")
		}
		historical = &record
		if file == nil {
			return h.Store.AttestChallenge(ctx, original, request, NativeObservation{Root: record.Ticket.Root, Parent: record.Ticket.Parent, Target: record.Ticket.Target})
		}
	}
	if file == nil {
		return nil, fmt.Errorf("ordinary authorization handle required")
	}
	observer, ok := h.Native.(OrdinaryDescriptorObserver)
	if !ok {
		return nil, fmt.Errorf("native ordinary descriptor observer unavailable")
	}
	observation, err := observer.DescribeOrdinary(ctx, original.Root, file)
	if err != nil {
		return nil, err
	}
	if request.Action == "status_original" {
		if err := h.Store.statusObservation(original, request, observation); err != nil {
			return nil, err
		}
		// Status attests the stored historical projection, not a claim that the
		// new handle has the old file ID. Execute independently checks the current
		// native object and completed prepared-restore association again.
		return h.Store.AttestChallenge(ctx, original, request, NativeObservation{Root: historical.Ticket.Root, Parent: historical.Ticket.Parent, Target: historical.Ticket.Target})
	}
	return h.Store.AttestChallenge(ctx, original, request, observation)
}
