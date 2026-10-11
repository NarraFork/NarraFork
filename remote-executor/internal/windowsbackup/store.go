package windowsbackup

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
)

const StoreQuota int64 = 5 << 30
const StoreRecords = 100000

// Configuration comes from administrator-protected configuration, never IPC.
type StoreConfig struct {
	Directory, HelperInstanceID, ServiceSID string
	KeyEpoch                                uint64
	SigningKey                              ed25519.PrivateKey
	Quota                                   int64
	// Fault is an optional test injection. No record/SD data is passed to it.
	Fault func(string) error
}
type ProtectedStore struct {
	config   StoreConfig
	mu       sync.Mutex
	used     int64
	records  int
	identity string
	root     *os.File
}
type CaptureRecord struct {
	Version               int             `json:"version"`
	ID                    string          `json:"id"`
	Nonce                 string          `json:"nonce"`
	Ticket                Ticket          `json:"ticket"`
	Snapshot              *Snapshot       `json:"snapshot"`
	ContentHash           string          `json:"contentHash"`
	HistoricalFingerprint string          `json:"historicalFingerprint"`
	SealedFingerprint     string          `json:"sealedFingerprint"`
	Vault                 *VaultReference `json:"vault"`
	State                 string          `json:"state"`
	RootPath              string          `json:"rootPath"`
	ParentPath            string          `json:"parentPath"`
	TargetPath            string          `json:"targetPath"`
}
type OperationResult struct {
	Version      int           `json:"version"`
	StageKey     string        `json:"stageKey"`
	TicketDigest string        `json:"ticketDigest"`
	Ticket       Ticket        `json:"ticket"`
	State        string        `json:"state"`
	Proof        *CaptureProof `json:"proof"`
	Descriptor   *Descriptor   `json:"descriptor"`
	Reason       string        `json:"reason"`
}
type fenceRecord struct {
	SourceID, ScopeID, SessionID string
	Fence                        uint64
	Generation                   uint64
}
type storeLedger struct {
	Version  int
	Used     int64
	Records  int
	Identity string
}

func NewProtectedStore(c StoreConfig) (*ProtectedStore, error) {
	if !filepath.IsAbs(c.Directory) || !validID(c.HelperInstanceID, 256) || len(c.SigningKey) != ed25519.PrivateKeySize || c.ServiceSID == "" {
		return nil, fmt.Errorf("helper protected store/config not ready")
	}
	if c.Quota == 0 {
		c.Quota = StoreQuota
	}
	if c.Quota < MetadataBytes || c.Quota > StoreQuota {
		return nil, fmt.Errorf("store quota")
	}
	if err := prepareProtectedDirectory(c.Directory, c.ServiceSID); err != nil {
		return nil, err
	}
	root, err := pinProtectedDirectory(c.Directory)
	if err != nil {
		return nil, err
	}
	identity, err := pinnedProtectedIdentity(root)
	if err != nil {
		root.Close()
		return nil, err
	}
	s := &ProtectedStore{config: c, identity: identity, root: root}
	ready := false
	defer func() {
		if !ready {
			root.Close()
		}
	}()
	raw, err := s.read("ledger.json", 4096)
	if err == nil {
		var l storeLedger
		if err := json.Unmarshal(raw, &l); err != nil {
			return nil, err
		}
		if l.Version != 1 || l.Identity != identity || l.Used < 0 || l.Used > c.Quota || l.Records < 0 || l.Records > StoreRecords {
			return nil, fmt.Errorf("helper ledger mismatch")
		}
		s.used = l.Used
		s.records = l.Records
	} else if errors.Is(err, os.ErrNotExist) {
		// Fresh store initialization is explicit administrator construction. Existing
		// evidence without its ledger is not rebuilt by an unbounded directory scan.
		directory, err := os.Open(c.Directory)
		if err != nil {
			return nil, err
		}
		entries, readErr := directory.ReadDir(1)
		directory.Close()
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return nil, readErr
		}
		if len(entries) != 0 {
			return nil, fmt.Errorf("store ledger missing; operator recovery required")
		}
		if err := s.write("ledger.json", storeLedger{1, 0, 0, identity}); err != nil {
			return nil, err
		}
	} else {
		return nil, err
	}
	ready = true
	return s, nil
}
func (s *ProtectedStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.root == nil {
		return nil
	}
	err := s.root.Close()
	s.root = nil
	return err
}
func (s *ProtectedStore) Directory() string { return s.config.Directory }
func (s *ProtectedStore) fault(phase string) error {
	if s.config.Fault != nil {
		return s.config.Fault(phase)
	}
	return nil
}
func (s *ProtectedStore) read(name string, limit int64) ([]byte, error) {
	if filepath.Base(name) != name {
		return nil, fmt.Errorf("store key")
	}
	if s.root == nil {
		return nil, fmt.Errorf("protected store closed")
	}
	if identity, err := pinnedProtectedIdentity(s.root); err != nil || identity != s.identity {
		return nil, fmt.Errorf("protected store identity changed")
	}
	file, err := os.Open(filepath.Join(s.config.Directory, name))
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, fmt.Errorf("store record budget/type")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if len(data) > int(limit) {
		return nil, fmt.Errorf("store record budget")
	}
	return data, err
}
func (s *ProtectedStore) write(name string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return s.writeBytes(name, data)
}
func (s *ProtectedStore) writeBytes(name string, data []byte) error {
	if filepath.Base(name) != name {
		return fmt.Errorf("store key")
	}
	if err := s.fault("before_store_write"); err != nil {
		return err
	}
	if s.root == nil {
		return fmt.Errorf("protected store closed")
	}
	if identity, err := pinnedProtectedIdentity(s.root); err != nil || identity != s.identity {
		return fmt.Errorf("protected store identity mismatch (query=%v expected=%q actual=%q)", err, s.identity, identity)
	}
	file, err := os.CreateTemp(s.config.Directory, ".pending-")
	if err != nil {
		return err
	}
	defer file.Close()
	// Install protection on THIS object before writing any secret, not just parent.
	if err := protectStoreObject(file, s.config.ServiceSID); err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := s.fault("after_store_fsync"); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := renameProtected(file.Name(), filepath.Join(s.config.Directory, name)); err != nil {
		return err
	}
	if err := syncProtectedDirectory(s.config.Directory); err != nil {
		return err
	}
	return s.fault("after_store_publish")
}
func (s *ProtectedStore) charge(bytes int64, record bool) error {
	count := s.records
	if record {
		count++
	}
	if bytes < 0 || bytes > s.config.Quota-s.used || count > StoreRecords {
		return fmt.Errorf("private store quota")
	}
	// Reserve durably BEFORE the object write/mutation. Failed writes remain
	// charged; crash recovery never undercounts pending objects or hidden files.
	if err := s.write("ledger.json", storeLedger{1, s.used + bytes, count, s.identity}); err != nil {
		return err
	}
	s.used += bytes
	s.records = count
	return nil
}
func (s *ProtectedStore) Put(ctx context.Context, data []byte) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if len(data) > StreamBytes {
		return "", ErrIncomplete
	}
	digest := Digest(data)
	s.mu.Lock()
	defer s.mu.Unlock()
	if old, err := s.read("blob-"+digest, int64(len(data))); err == nil {
		if !bytes.Equal(old, data) {
			return "", fmt.Errorf("CAS conflict")
		}
		return digest, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if err := s.charge(int64(len(data)), false); err != nil {
		return "", err
	}
	if err := s.writeBytes("blob-"+digest, data); err != nil {
		return "", err
	}
	return digest, nil
}
func (s *ProtectedStore) Get(ctx context.Context, digest string, size int64) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !validHash(digest) || size < 0 || size > StreamBytes {
		return nil, ErrIncomplete
	}
	data, err := s.read("blob-"+digest, size)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) != size || Digest(data) != digest {
		return nil, fmt.Errorf("CAS content changed")
	}
	return data, nil
}
func operationKey(t Ticket, stage ...string) string {
	value := t.ExecutorSourceID + "\x00" + t.ScopeID + "\x00" + t.OperationID
	if len(stage) == 1 && stage[0] != "" {
		return "stage-v2-" + Digest([]byte(value+"\x00"+stage[0])) + ".json"
	}
	return "operation-" + Digest([]byte(value)) + ".json"
}
func masterFingerprint(t Ticket) (string, error) {
	t.Action = ""
	t.BudgetClass = ""
	t.Parent = NativeDescriptor{}
	t.Target = NativeDescriptor{}
	t.CaptureProofID = nil
	t.PreparedObjectID = nil
	t.ExpectedCurrentContentHash = nil
	t.ExpectedCurrentMetadataHash = nil
	t.Nonce = ""
	t.ChallengeNonce = ""
	t.IssuedAt = 0
	t.ExpiresAt = 0
	t.RecoveryOriginal = nil
	data, err := CanonicalJSON(t)
	if err != nil {
		return "", err
	}
	return Digest(data), nil
}
func sameStageIntent(a, b Ticket) bool {
	a.Nonce = ""
	a.ChallengeNonce = ""
	a.IssuedAt = 0
	a.ExpiresAt = 0
	b.Nonce = ""
	b.ChallengeNonce = ""
	b.IssuedAt = 0
	b.ExpiresAt = 0
	x, e1 := CanonicalJSON(a)
	y, e2 := CanonicalJSON(b)
	return e1 == nil && e2 == nil && bytes.Equal(x, y)
}
func (s *ProtectedStore) Begin(v *VerifiedTicket) (*OperationResult, bool, error) {
	if v == nil {
		return nil, false, fmt.Errorf("verified ticket required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	t := v.ticket
	if t.HelperInstanceID != s.config.HelperInstanceID {
		return nil, false, fmt.Errorf("helper instance")
	}
	nonceKey := "nonce-" + Digest([]byte(t.Nonce)) + ".json"
	nonceUsed := false
	if raw, err := s.read(nonceKey, 4096); err == nil {
		var saved map[string]string
		if json.Unmarshal(raw, &saved) != nil || saved["ticketDigest"] != v.digest || saved["operationId"] != t.OperationID {
			return nil, false, fmt.Errorf("consumed nonce for different ticket/action")
		}
		nonceUsed = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, false, err
	}
	if v.stage != "" {
		master, err := masterFingerprint(t)
		if err != nil {
			return nil, false, err
		}
		masterKey := "master-v2-" + Digest([]byte(t.ExecutorSourceID+"\x00"+t.ScopeID+"\x00"+t.OperationID)) + ".json"
		if raw, err := s.read(masterKey, 4096); err == nil {
			var saved map[string]string
			if json.Unmarshal(raw, &saved) != nil || saved["fingerprint"] != master {
				return nil, false, fmt.Errorf("original actor/root/session/digest/fence equivocation")
			}
			// Old stage derivations included proof IDs. Never silently dispatch a
			// second action under the new stable-object derivation. Preserve all
			// old evidence for explicit operator recovery, without directory scans.
			if saved["stageScheme"] != "prepared-v1" {
				return nil, false, fmt.Errorf("legacy stage ledger retained; original evidence recovery required")
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, false, err
		} else {
			if err := s.charge(4096, true); err != nil {
				return nil, false, err
			}
			if err := s.write(masterKey, map[string]string{"fingerprint": master, "stageScheme": "prepared-v1"}); err != nil {
				return nil, false, err
			}
		}
	}
	if raw, err := s.read(operationKey(t, v.stage), 64<<10); err == nil {
		var op OperationResult
		if err := json.Unmarshal(raw, &op); err != nil {
			return nil, false, err
		}
		expectedVersion := 1
		if v.stage != "" {
			expectedVersion = 2
		}
		if op.Version != expectedVersion || op.StageKey != v.stage || op.TicketDigest != v.digest && !sameStageIntent(op.Ticket, t) {
			return nil, false, fmt.Errorf("same stage different original intent")
		}
		if v.stage == "" && op.TicketDigest != v.digest {
			return nil, false, fmt.Errorf("same operation different exact ticket")
		}
		// Even a fresh nonce that only queries a stable stage is consumed. It
		// cannot later authorize a different action or existing stage.
		if !nonceUsed {
			if err := s.charge(4096, true); err != nil {
				return nil, false, err
			}
			if err := s.write(nonceKey, map[string]string{"ticketDigest": v.digest, "operationId": t.OperationID}); err != nil {
				return nil, false, err
			}
		}
		// A crash left intent/dispatched evidence, not proof of non-execution.
		if op.State == "intent" || op.State == "dispatched" {
			op.State = "unknown"
		}
		return &op, true, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, false, err
	}
	fenceKey := "fence-" + Digest([]byte(t.ExecutorSourceID+"\x00"+t.ScopeID)) + ".json"
	if raw, err := s.read(fenceKey, 4096); err == nil {
		var f fenceRecord
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, false, err
		}
		if f.SourceID != t.ExecutorSourceID || f.ScopeID != t.ScopeID || t.Fence < f.Fence || t.RuntimeGeneration < f.Generation || t.Fence == f.Fence && f.SessionID != t.SessionID {
			return nil, false, fmt.Errorf("stale fence/session")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, false, err
	}
	if nonceUsed {
		return nil, false, fmt.Errorf("consumed nonce without completed intent evidence")
	}
	if err := s.charge(64<<10, true); err != nil {
		return nil, false, err
	}
	version := 1
	if v.stage != "" {
		version = 2
	}
	op := &OperationResult{Version: version, StageKey: v.stage, TicketDigest: v.digest, Ticket: t, State: "intent"}
	if err := s.write(nonceKey, map[string]string{"ticketDigest": v.digest, "operationId": t.OperationID}); err != nil {
		return nil, false, err
	}
	if err := s.write(fenceKey, fenceRecord{t.ExecutorSourceID, t.ScopeID, t.SessionID, t.Fence, t.RuntimeGeneration}); err != nil {
		return nil, false, err
	}
	if err := s.write(operationKey(t, v.stage), op); err != nil {
		return nil, false, err
	}
	return op, false, nil
}
func (s *ProtectedStore) Complete(op *OperationResult) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.write(operationKey(op.Ticket, op.StageKey), op)
}
func (s *ProtectedStore) SaveCapture(t Ticket, snapshot *Snapshot, contentHash string, location ...NativeObservation) (*CaptureProof, error) {
	if err := snapshot.Validate(); err != nil {
		return nil, err
	}
	if !validHash(contentHash) {
		return nil, fmt.Errorf("content digest")
	}
	var random [32]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, err
	}
	recordID := base64.RawURLEncoding.EncodeToString(random[:])
	if _, err := rand.Read(random[:]); err != nil {
		return nil, err
	}
	snapshotData, err := Encode(snapshot)
	if err != nil {
		return nil, err
	}
	record := CaptureRecord{Version: 2, ID: recordID, Nonce: base64.RawURLEncoding.EncodeToString(random[:]), Ticket: t, Snapshot: snapshot, ContentHash: contentHash, HistoricalFingerprint: Digest(snapshotData), State: "captured"}
	if len(location) == 1 {
		record.RootPath = location[0].RootPath
		record.ParentPath = location[0].ParentPath
		record.TargetPath = location[0].TargetPath
	}
	data, err := json.Marshal(record)
	if err != nil {
		return nil, err
	}
	if len(data) > MetadataBytes+32<<10 {
		return nil, fmt.Errorf("capture record budget")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.charge(int64(len(data)), true); err != nil {
		return nil, err
	}
	if err := s.writeBytes("capture-"+recordID+".json", data); err != nil {
		return nil, err
	}
	p := CaptureProof{Version: 1, HelperInstanceID: s.config.HelperInstanceID, KeyEpoch: s.config.KeyEpoch, RecordID: recordID, RecordNonce: record.Nonce, RecordDigest: Digest(data)}
	signed, err := proofSignedBytes(p)
	if err != nil {
		return nil, err
	}
	p.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(s.config.SigningKey, signed))
	return &p, nil
}
func (s *ProtectedStore) loadCapture(p CaptureProof) (*CaptureRecord, error) {
	if p.HelperInstanceID != s.config.HelperInstanceID || p.KeyEpoch != s.config.KeyEpoch {
		return nil, fmt.Errorf("proof helper/key binding")
	}
	if err := VerifyProof(p, s.config.SigningKey.Public().(ed25519.PublicKey)); err != nil {
		return nil, err
	}
	raw, err := s.read("capture-"+p.RecordID+".json", MetadataBytes+32<<10)
	if err != nil {
		return nil, err
	}
	if Digest(raw) != p.RecordDigest {
		return nil, fmt.Errorf("original record digest")
	}
	var record CaptureRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		return nil, err
	}
	if record.Version != 2 || record.ID != p.RecordID || record.Nonce != p.RecordNonce || record.Snapshot == nil {
		return nil, fmt.Errorf("original capture record")
	}
	if record.State != "captured" || record.Ticket.Action != "capture_exact" || record.Ticket.HelperInstanceID != s.config.HelperInstanceID {
		return nil, fmt.Errorf("original capture state")
	}
	if err := record.Snapshot.Validate(); err != nil {
		return nil, err
	}
	encoded, err := Encode(record.Snapshot)
	if err != nil || Digest(encoded) != record.HistoricalFingerprint || !validHash(record.ContentHash) {
		return nil, fmt.Errorf("original snapshot fingerprint")
	}
	return &record, nil
}
func (s *ProtectedStore) Original(t Ticket, p CaptureProof) (*CaptureRecord, error) {
	if t.CaptureProofID == nil || *t.CaptureProofID != p.RecordID {
		return nil, fmt.Errorf("ticket proof binding")
	}
	record, err := s.loadCapture(p)
	if err != nil {
		return nil, err
	}
	old := record.Ticket
	if old.DeviceID != t.DeviceID || old.HelperInstanceID != t.HelperInstanceID || old.ExecutorSourceID != t.ExecutorSourceID || old.ScopeID != t.ScopeID || old.ActorSubjectKey != t.ActorSubjectKey || old.Root != t.Root || old.Parent != t.Parent || old.Target != t.Target || old.OriginRefHash != t.OriginRefHash || !nullableEqual(old.NarratorID, t.NarratorID) || !nullableEqual(old.ProjectID, t.ProjectID) {
		return nil, fmt.Errorf("original actor/root/object/credential binding")
	}
	if t.RecoveryOriginal != nil {
		original := t.RecoveryOriginal
		if original.OperationID != old.OperationID || original.RequestDigest != old.RequestDigest || original.Fence != old.Fence || original.LeaseID != old.LeaseID {
			return nil, fmt.Errorf("original recovery tuple")
		}
	} else if old.OperationID != t.OperationID || old.RequestDigest != t.RequestDigest || old.RuntimeGeneration != t.RuntimeGeneration || old.SessionID != t.SessionID || old.ConnectionID != t.ConnectionID || old.Fence != t.Fence || old.LeaseID != t.LeaseID {
		return nil, fmt.Errorf("original session/fence")
	}
	return record, nil
}
func nullableEqual(a, b *string) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}
