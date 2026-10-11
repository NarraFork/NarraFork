package windowsbackup

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
)

// ProtectedPreparedRecord is immutable helper-private evidence. ID is the ID of
// this helper's signed capture, never a client-selected creation identifier.
// Ticket carries the complete actor/origin, operation, lease/fence and session
// tuple; Observation keeps the native incarnation AND its path slot separate.
type ProtectedPreparedRecord struct {
	Version          int               `json:"version"`
	ID               string            `json:"id"`
	HelperInstanceID string            `json:"helperInstanceId"`
	KeyEpoch         uint64            `json:"keyEpoch"`
	Proof            CaptureProof      `json:"proof"`
	Ticket           Ticket            `json:"ticket"`
	Observation      NativeObservation `json:"observation"`
	StageKey         string            `json:"stageKey"`
	State            string            `json:"state"`
}

// sameReservation deliberately excludes action, native target, proof and current
// hashes. Those are checked separately; nothing from the authority tuple is
// projected out except the recovery reference to a different historical op.
func sameReservation(a, b Ticket) bool {
	a.RecoveryOriginal, b.RecoveryOriginal = nil, nil
	x, e1 := masterFingerprint(a)
	y, e2 := masterFingerprint(b)
	return e1 == nil && e2 == nil && x == y
}

func (s *ProtectedStore) savePrepared(op *OperationResult, proof CaptureProof, observed NativeObservation) error {
	t := op.Ticket
	owned := t
	owned.CaptureProofID = t.PreparedObjectID
	record, err := s.Original(owned, proof)
	if err != nil {
		return err
	}
	metadata, err := SnapshotFingerprint(record.Snapshot)
	if err != nil {
		return err
	}
	if t.Action != "prepare_owned" || op.State != "intent" || op.StageKey == "" || t.PreparedObjectID == nil || *t.PreparedObjectID != proof.RecordID || !sameReservation(record.Ticket, t) || observed.Root != t.Root || observed.Parent != t.Parent || observed.Target != t.Target || observed.MetadataHash != metadata || observed.ContentHash != record.ContentHash || observed.RootPath != record.RootPath || observed.ParentPath != record.ParentPath || observed.TargetPath != record.TargetPath {
		return fmt.Errorf("prepared capture/native reservation mismatch")
	}
	prepared := ProtectedPreparedRecord{Version: 1, ID: proof.RecordID, HelperInstanceID: s.config.HelperInstanceID, KeyEpoch: s.config.KeyEpoch, Proof: proof, Ticket: t, Observation: observed, StageKey: op.StageKey, State: "prepared"}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.fault("before_prepared_publish"); err != nil {
		return err
	}
	if err := s.writeImmutable("prepared-"+proof.RecordID+".json", prepared); err != nil {
		return err
	}
	return s.fault("after_prepared_publish")
}

// writeImmutable is called under s.mu. Existing evidence is never overwritten,
// including evidence whose publish succeeded but acknowledgement was lost.
func (s *ProtectedStore) writeImmutable(name string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(data) > 64<<10 {
		return fmt.Errorf("prepared record budget")
	}
	if _, err := s.read(name, 64<<10); err == nil {
		return fmt.Errorf("immutable prepared evidence already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := s.charge(int64(len(data)), true); err != nil {
		return err
	}
	return s.writeBytes(name, data)
}

func (s *ProtectedStore) prepared(t Ticket) (*ProtectedPreparedRecord, *CaptureRecord, error) {
	if t.PreparedObjectID == nil || !validID(*t.PreparedObjectID, 256) {
		return nil, nil, fmt.Errorf("registered prepared ID required")
	}
	raw, err := s.read("prepared-"+*t.PreparedObjectID+".json", 64<<10)
	if err != nil {
		return nil, nil, err
	}
	var p ProtectedPreparedRecord
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, nil, err
	}
	if p.Version != 1 || p.State != "prepared" || p.ID != *t.PreparedObjectID || p.Proof.RecordID != p.ID || p.HelperInstanceID != s.config.HelperInstanceID || p.KeyEpoch != s.config.KeyEpoch || p.Ticket.Action != "prepare_owned" || !sameReservation(p.Ticket, t) || p.Observation.Root != t.Root || p.Observation.Parent != t.Parent || p.Observation.Target != t.Target {
		return nil, nil, fmt.Errorf("prepared native/authority binding")
	}
	if p.Ticket.PreparedObjectID == nil || *p.Ticket.PreparedObjectID != p.ID || p.Ticket.CaptureProofID != nil || p.Ticket.Root != p.Observation.Root || p.Ticket.Parent != p.Observation.Parent || p.Ticket.Target != p.Observation.Target {
		return nil, nil, fmt.Errorf("prepared observation differs from original registration intent")
	}
	owned := p.Ticket
	owned.CaptureProofID = &p.ID
	record, err := s.Original(owned, p.Proof)
	if err != nil {
		return nil, nil, err
	}
	metadata, err := SnapshotFingerprint(record.Snapshot)
	if err != nil || metadata != p.Observation.MetadataHash || record.ContentHash != p.Observation.ContentHash || record.RootPath != p.Observation.RootPath || record.ParentPath != p.Observation.ParentPath || record.TargetPath != p.Observation.TargetPath {
		return nil, nil, fmt.Errorf("prepared capture evidence mismatch")
	}
	raw, err = s.read(operationKey(p.Ticket, p.StageKey), 64<<10)
	if err != nil {
		return nil, nil, err
	}
	var op OperationResult
	if json.Unmarshal(raw, &op) != nil || op.Version != 2 || op.StageKey != p.StageKey || !sameStageIntent(op.Ticket, p.Ticket) || op.State != "prepared" || op.Proof == nil || *op.Proof != p.Proof {
		return nil, nil, fmt.Errorf("prepared intent not durably completed")
	}
	return &p, record, nil
}

// preparedOriginal is the ONLY target-switch path. Original itself stays exact.
// The new target must have a completed preparation from the current reservation,
// and the old proof is authenticated against its own immutable original target.
func (s *ProtectedStore) preparedOriginal(t Ticket, proof CaptureProof) (*CaptureRecord, error) {
	if t.Action != "restore_original" {
		return nil, fmt.Errorf("prepared restore action required")
	}
	p, _, err := s.prepared(t)
	if err != nil {
		return nil, err
	}
	if t.ExpectedCurrentMetadataHash == nil || t.ExpectedCurrentContentHash == nil || *t.ExpectedCurrentMetadataHash != p.Observation.MetadataHash || *t.ExpectedCurrentContentHash != p.Observation.ContentHash {
		return nil, fmt.Errorf("prepared expected-current hashes changed")
	}
	record, err := s.loadCapture(proof)
	if err != nil {
		return nil, err
	}
	bound := t
	bound.Target = record.Ticket.Target
	// Root and parent remain exact; only a prepared target in the original parent
	// may receive this snapshot. Explicit tickets do not grant arbitrary SetAcl.
	return s.Original(bound, proof)
}

// A completed restore publishes a second immutable association. It is indexed
// by original proof and native file/slot, not by bytes or a bare path. The
// operation receipt must ALSO be completed before a status can use it.
type restoredPreparedRecord struct {
	Version    int              `json:"version"`
	Proof      CaptureProof     `json:"proof"`
	PreparedID string           `json:"preparedId"`
	Ticket     Ticket           `json:"ticket"`
	StageKey   string           `json:"stageKey"`
	Target     NativeDescriptor `json:"target"`
}

// statusObservation separates the historical descriptor being authenticated from
// the optional current handle. No capture is fabricated for the current inode.
func (s *ProtectedStore) statusObservation(origin ChallengeOrigin, request MetadataCallback, current NativeObservation) error {
	if request.ProofIDs.CaptureProofID == nil || request.ProofIDs.PreparedObjectID != nil {
		return fmt.Errorf("status proof tuple")
	}
	if current.Root != request.Descriptors.Root || current.Parent != request.Descriptors.Parent {
		return fmt.Errorf("status root/parent mismatch")
	}
	if current.Target == request.Descriptors.Target {
		return nil
	}
	raw, err := s.read(restoredKey(*request.ProofIDs.CaptureProofID, current.Target), 64<<10)
	if err != nil {
		return err
	}
	var r restoredPreparedRecord
	if json.Unmarshal(raw, &r) != nil || !originalMatchesTicket(origin, r.Ticket) {
		return fmt.Errorf("status restored reservation mismatch")
	}
	t := r.Ticket
	t.Target = request.Descriptors.Target
	return s.restored(t, *request.ProofIDs.CaptureProofID, current)
}
func restoredKey(proofID string, target NativeDescriptor) string {
	data, _ := json.Marshal(struct {
		Proof  string
		Target NativeDescriptor
	}{proofID, target})
	return "restored-prepared-" + Digest(data) + ".json"
}
func (s *ProtectedStore) saveRestored(op *OperationResult, proof CaptureProof, original *CaptureRecord) error {
	if op.Ticket.PreparedObjectID == nil {
		return nil
	}
	target := op.Ticket.Target
	target.CreationTime = strconv.FormatUint(original.Snapshot.Creation, 10)
	r := restoredPreparedRecord{1, proof, *op.Ticket.PreparedObjectID, op.Ticket, op.StageKey, target}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.writeImmutable(restoredKey(proof.RecordID, target), r)
}
func (s *ProtectedStore) restored(t Ticket, proofID string, current NativeObservation) error {
	raw, err := s.read(restoredKey(proofID, current.Target), 64<<10)
	if err != nil {
		return err
	}
	var r restoredPreparedRecord
	if json.Unmarshal(raw, &r) != nil || r.Version != 1 || r.Proof.RecordID != proofID || r.Target != current.Target || r.Ticket.Root != current.Root || r.Ticket.Parent != current.Parent || !sameReservation(r.Ticket, t) || r.Ticket.Action != "restore_original" || r.Ticket.PreparedObjectID == nil || *r.Ticket.PreparedObjectID != r.PreparedID {
		return fmt.Errorf("restored prepared association mismatch")
	}
	original, err := s.preparedOriginal(r.Ticket, r.Proof)
	if err != nil {
		return err
	}
	expectedTarget := r.Ticket.Target
	expectedTarget.CreationTime = strconv.FormatUint(original.Snapshot.Creation, 10)
	if expectedTarget != r.Target || original.Ticket.Target != t.Target || original.Ticket.Parent != t.Parent {
		return fmt.Errorf("status original/prepared target mismatch")
	}
	raw, err = s.read(operationKey(r.Ticket, r.StageKey), 64<<10)
	if err != nil {
		return err
	}
	var op OperationResult
	if json.Unmarshal(raw, &op) != nil || op.Version != 2 || op.StageKey != r.StageKey || !sameStageIntent(op.Ticket, r.Ticket) || op.State != "completed" || op.Proof == nil || *op.Proof != r.Proof {
		return fmt.Errorf("prepared restore outcome not completed")
	}
	return nil
}
