package handlers

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const editorMaxStages = 32
const editorMaxStageBytes int64 = 128 * 1024 * 1024
const editorMaxReceipts = 4096
const editorMaxFences = 4096
const editorReceiptCleanupBatch = 16
const editorReceiptRetention = 7 * 24 * time.Hour
const editorMaxStateFiles = editorMaxReceipts + editorMaxFences + editorMaxStages*2 + 16
const editorMaxMetadata = 128 * 1024

// EditorEngine is editor-only: no network, credentials, daemon, or general
// transaction API. Its kernel file lock also serializes independent stdio helpers.
// Only terminal receipts whose proof the Host durably acknowledged can expire:
// up to seven days, or oldest-first under the bounded inventory budget. Sole
// proof and uncertain evidence never expire. Missing proof never permits retry.
type EditorEngine struct {
	h            *Handlers
	root         string
	lexicalRoot  string
	rootInfo     os.FileInfo
	chunkBytes   int64
	epoch        string
	hostReceipts *editorHostReceipts
	// Tests inject failures at durable boundaries without touching real executors.
	fault func(string) error
}

type editorChunk struct {
	Seq    int64  `json:"seq"`
	Offset int64  `json:"offset"`
	Bytes  int64  `json:"bytes"`
	Digest string `json:"digest"`
}
type editorStage struct {
	Version int `json:"version"`
	EditorStageHandle
	Namespace     string        `json:"namespace"`
	MaxBytes      int64         `json:"maxBytes"`
	IdleTimeoutMs int64         `json:"idleTimeoutMs"`
	Size          int64         `json:"size"`
	Chunks        []editorChunk `json:"chunks"`
	RawDigest     string        `json:"rawDigest"`
	OperationID   string        `json:"operationId"`
}
type editorReceipt struct {
	Version           int                `json:"version"`
	Request           EditorApplyRequest `json:"request"`
	Fingerprint       string             `json:"fingerprint"`
	State             string             `json:"state"`
	Result            *EditorApplyResult `json:"result"`
	TemporaryPath     string             `json:"temporaryPath"`
	TemporaryIdentity string             `json:"temporaryIdentity"`
	AcknowledgedAt    int64              `json:"acknowledgedAt,omitempty"`
}
type editorFence struct {
	Version   int    `json:"version"`
	Token     int64  `json:"token"`
	Namespace string `json:"namespace"`
}

func editorDigest(b []byte) string     { v := sha256.Sum256(b); return hex.EncodeToString(v[:]) }
func editorKey(parts ...string) string { b, _ := json.Marshal(parts); return editorDigest(b) }
func editorValidDigest(s string) bool {
	b, err := hex.DecodeString(s)
	return err == nil && len(b) == sha256.Size && s == strings.ToLower(s)
}
func editorValidKey(s string) bool {
	return len(s) > 0 && len(s) <= 1024 && !strings.ContainsRune(s, 0)
}
func editorRandomID() (string, error) {
	var b [24]byte
	_, err := rand.Read(b[:])
	return hex.EncodeToString(b[:]), err
}
func (e *EditorEngine) inject(point string) error {
	if e.fault != nil {
		return e.fault(point)
	}
	return nil
}

func NewEditorEngine(h *Handlers, root string) (*EditorEngine, error) {
	if !filepath.IsAbs(root) {
		return nil, fmt.Errorf("editor state directory must be absolute")
	}
	if err := h.ReserveEditorPrivateRoot(root); err != nil {
		return nil, err
	}
	if err := ensureEditorPrivateDirectory(root); err != nil {
		return nil, err
	}
	canonical, err := canonicalGuardPath(root)
	if err != nil {
		return nil, err
	}
	h.guard.protectPrivateRoot(canonical)
	info, err := os.Lstat(canonical)
	if err != nil {
		return nil, err
	}
	chunk := EditorChunkBytes
	if budget := (h.maxRpcBytes - 8192) * 3 / 4; budget < chunk {
		chunk = budget
	}
	if chunk < 1 {
		return nil, fmt.Errorf("editor RPC budget too small")
	}
	return &EditorEngine{h: h, root: canonical, lexicalRoot: filepath.Clean(root), rootInfo: info, chunkBytes: chunk, epoch: EditorRuntimeEpoch()}, nil
}

func (e *EditorEngine) lock(ctx context.Context) (func(), error) {
	release, err := acquireFileMutation(ctx)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(e.root)
	if err != nil || !os.SameFile(e.rootInfo, info) {
		release()
		return nil, fmt.Errorf("editor private directory identity changed")
	}
	f, err := os.OpenFile(filepath.Join(e.root, "engine.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		release()
		return nil, err
	}
	if err = lockEditorFile(ctx, f); err != nil {
		f.Close()
		release()
		return nil, err
	}
	return func() { unlockEditorFile(f); f.Close(); release() }, nil
}

func editorReadJSON(path string, out any) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > editorMaxMetadata {
		return fmt.Errorf("invalid editor journal size/type")
	}
	b, err := io.ReadAll(io.LimitReader(f, editorMaxMetadata+1))
	if err != nil {
		return err
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err = d.Decode(out); err != nil {
		return err
	}
	if d.Decode(new(any)) != io.EOF {
		return fmt.Errorf("invalid trailing editor journal data")
	}
	return nil
}
func (e *EditorEngine) verifyPrivateRoot() error {
	info, err := os.Lstat(e.root)
	if err != nil || !os.SameFile(e.rootInfo, info) {
		return fmt.Errorf("editor private directory identity changed")
	}
	return nil
}
func (e *EditorEngine) save(path string, value any) error {
	if err := e.verifyPrivateRoot(); err != nil {
		return err
	}
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(b) > editorMaxMetadata {
		return fmt.Errorf("editor metadata quota exceeded")
	}
	f, err := os.CreateTemp(e.root, ".metadata-*")
	if err != nil {
		return err
	}
	name := f.Name()
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	defer func() { f.Close(); _ = removeConditionalTemporary(name, info) }()
	if _, err = f.Write(b); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = e.verifyPrivateRoot(); err != nil {
		return err
	}
	if err = os.Rename(name, path); err != nil {
		return err
	}
	if err = e.verifyPrivateRoot(); err != nil {
		return err
	}
	return syncEditorDirectory(e.root)
}
func (e *EditorEngine) stagePath(id string) string { return filepath.Join(e.root, id+".stage.json") }
func (e *EditorEngine) bodyPath(id string) string  { return filepath.Join(e.root, id+".body") }
func (e *EditorEngine) receiptPath(namespace, op string) string {
	return filepath.Join(e.root, editorKey(namespace, op)+".op.json")
}
func (e *EditorEngine) readStage(namespace, resource, id string) (*editorStage, error) {
	if len(id) != 48 {
		return nil, fmt.Errorf("EDITOR_NOT_FOUND: unknown stage")
	}
	if _, err := hex.DecodeString(id); err != nil {
		return nil, fmt.Errorf("invalid stage handle")
	}
	var s editorStage
	if err := editorReadJSON(e.stagePath(id), &s); err != nil {
		return nil, fmt.Errorf("EDITOR_NOT_FOUND: unknown stage")
	}
	if s.Version != 1 || s.StageID != id || s.Namespace != namespace || s.ResourceKey != resource {
		return nil, fmt.Errorf("EDITOR_NOT_FOUND: stage binding mismatch")
	}
	if s.OperationID != "" {
		return nil, fmt.Errorf("editor stage already dispatched")
	}
	if s.ExpiresAt < time.Now().UnixMilli() {
		return nil, fmt.Errorf("EDITOR_NOT_FOUND: stage expired")
	}
	return &s, nil
}

// inventory uses a bounded directory read, never a recursive scan. Interrupted
// metadata temps/orphan bodies and expired *undispatched* stages are reclaimable.
func (e *EditorEngine) inventory() (int, int64, int, error) {
	d, err := os.Open(e.root)
	if err != nil {
		return 0, 0, 0, err
	}
	defer d.Close()
	entries, err := d.ReadDir(editorMaxStateFiles + 1)
	if err != nil && err != io.EOF {
		return 0, 0, 0, err
	}
	if len(entries) > editorMaxStateFiles {
		return 0, 0, 0, fmt.Errorf("editor state inventory quota exceeded")
	}
	protected := map[string]bool{}
	receipts := map[string]*editorReceipt{}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".op.json") {
			continue
		}
		var r editorReceipt
		if err := editorReadJSON(filepath.Join(e.root, entry.Name()), &r); err != nil {
			return 0, 0, 0, err
		}
		if r.State == "intent" || r.State == "applying" {
			recovered, err := e.loadReceipt(r.Request.Namespace, r.Request.ResourceKey, r.Request.OperationID, r.Request.RequestDigest)
			if err != nil {
				return 0, 0, 0, err
			}
			r = *recovered
		}
		if r.State == "uncertain" || r.State == "rejected" && r.TemporaryPath != "" && !e.cleanupRejectedTemporary(&r) {
			protected[r.Request.StageID] = true
		}
		receipts[entry.Name()] = &r
	}
	if err := e.pruneReceipts(receipts, protected); err != nil {
		return 0, 0, 0, err
	}
	stages := 0
	var total int64
	known := map[string]bool{}
	unappliedNamespaces := map[string]bool{}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".stage.json") {
			continue
		}
		var s editorStage
		if err := editorReadJSON(filepath.Join(e.root, entry.Name()), &s); err != nil {
			if os.IsNotExist(err) {
				continue
			} // an acknowledged receipt retired its stage
			return 0, 0, 0, err
		}
		if s.Version != 1 || len(s.StageID) != 48 {
			return 0, 0, 0, fmt.Errorf("invalid editor stage inventory")
		}
		known[s.StageID] = true
		if !protected[s.StageID] && (s.ExpiresAt < time.Now().UnixMilli() || s.OperationID != "") {
			if err := os.Remove(e.bodyPath(s.StageID)); err != nil && !os.IsNotExist(err) {
				return 0, 0, 0, err
			}
			if err := os.Remove(e.stagePath(s.StageID)); err != nil {
				return 0, 0, 0, err
			}
			continue
		}
		if s.OperationID == "" {
			unappliedNamespaces[s.Namespace] = true
		}
		stages++
		total += s.MaxBytes // reserve promised bytes, not only uploaded prefix
	}
	liveFences := map[string]bool{}
	for _, receipt := range receipts {
		liveFences[editorKey(receipt.Request.Namespace, receipt.Request.Identity.WorkspaceIdentity)+".fence.json"] = true
	}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasSuffix(name, ".fence.json") && !liveFences[name] {
			var fence editorFence
			if err := editorReadJSON(filepath.Join(e.root, name), &fence); err != nil {
				return 0, 0, 0, err
			}
			// A not-yet-dispatched stage can still carry an older fence. Retain
			// this namespace's ceilings until its bounded stage TTL is resolved.
			if !unappliedNamespaces[fence.Namespace] {
				if err := os.Remove(filepath.Join(e.root, name)); err != nil {
					return 0, 0, 0, err
				}
			}
		}
		if strings.HasPrefix(name, ".metadata-") || strings.HasSuffix(name, ".body") && !known[strings.TrimSuffix(name, ".body")] && !protected[strings.TrimSuffix(name, ".body")] {
			if err := os.Remove(filepath.Join(e.root, name)); err != nil && !os.IsNotExist(err) {
				return 0, 0, 0, err
			}
		}
	}
	return stages, total, len(receipts), syncEditorDirectory(e.root)
}

// The Host explicitly acknowledges only AFTER its own durable evidence/lease
// transaction. Pressure retention may then shorten the seven-day cache; it never
// deletes an executor-only proof. No per-operation tombstone is accumulated.
func (e *EditorEngine) pruneReceipts(receipts map[string]*editorReceipt, protected map[string]bool) error {
	names := make([]string, 0, len(receipts))
	for name, r := range receipts {
		if r.Version == 1 && r.AcknowledgedAt > 0 && (r.State == "committed" || r.State == "rejected") && r.Result != nil && r.Result.Outcome == r.State && !protected[r.Request.StageID] {
			names = append(names, name)
		}
	}
	sort.Slice(names, func(i, j int) bool { return receipts[names[i]].AcknowledgedAt < receipts[names[j]].AcknowledgedAt })
	pressure := 0
	if len(receipts) >= editorMaxReceipts {
		pressure = len(receipts) - editorMaxReceipts + editorReceiptCleanupBatch
	}
	cutoff := time.Now().Add(-editorReceiptRetention).UnixMilli()
	for _, name := range names {
		r := receipts[name]
		if r.AcknowledgedAt > cutoff && pressure <= 0 {
			break
		}
		// Retire the unforgeable stage capability durably BEFORE the receipt.
		// Replaying the exact old apply request after expiry cannot dispatch:
		// stage IDs are server-generated, immutable, and never reconstructed.
		if len(r.Request.StageID) != 48 {
			return fmt.Errorf("invalid acknowledged receipt stage")
		}
		if _, err := hex.DecodeString(r.Request.StageID); err != nil {
			return err
		}
		var stage editorStage
		err := editorReadJSON(e.stagePath(r.Request.StageID), &stage)
		if err == nil {
			if stage.Namespace != r.Request.Namespace || stage.ResourceKey != r.Request.ResourceKey || stage.OperationID != "" && stage.OperationID != r.Request.OperationID {
				continue
			}
		} else if !os.IsNotExist(err) {
			return err
		}
		for _, path := range []string{e.bodyPath(r.Request.StageID), e.stagePath(r.Request.StageID)} {
			if err = os.Remove(path); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
		if err = syncEditorDirectory(e.root); err != nil {
			return err
		}
		if err = e.inject("receipt-stage-retired"); err != nil {
			return err
		}
		if err = os.Remove(filepath.Join(e.root, name)); err != nil {
			return err
		}
		if err = e.inject("receipt-retired"); err != nil {
			return err
		}
		delete(receipts, name)
		pressure--
	}
	return syncEditorDirectory(e.root)
}

// Only inventory/admission performs this cleanup, never receipt query. The
// recorded identity limits cleanup to our own preparation object. A moved root,
// changed occupant or denied path keeps its stage quota reserved, not forgotten.
func (e *EditorEngine) cleanupRejectedTemporary(r *editorReceipt) bool {
	if r.State != "rejected" && r.State != "committed" {
		return false
	}
	path := r.TemporaryPath
	if filepath.Dir(path) != filepath.Dir(r.Request.Identity.CanonicalPath) || !strings.HasPrefix(filepath.Base(path), ".nf-editor-") {
		return false
	}
	if err := e.h.VerifyEditorRoot(r.Request.Identity.WorkspaceIdentity); err != nil {
		return false
	}
	canonical, err := e.h.guard.CheckCreate(path)
	if err != nil || !samePath(canonical, path) {
		return false
	}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return true
	}
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	identity, err := editorObjectIdentity(path, info)
	if err != nil || identity != r.TemporaryIdentity {
		return false
	}
	return removeConditionalTemporary(path, info) == nil
}

func (e *EditorEngine) loadReceipt(namespace, resource, op, digest string) (*editorReceipt, error) {
	var r editorReceipt
	if err := editorReadJSON(e.receiptPath(namespace, op), &r); err != nil {
		return nil, err
	}
	if r.Version != 1 || r.Request.Namespace != namespace || r.Request.OperationID != op || r.Request.ResourceKey != resource {
		return nil, fmt.Errorf("editor receipt binding mismatch")
	}
	if r.Request.RequestDigest != digest {
		return nil, fmt.Errorf("EDITOR_APPLY_REJECTED: operation digest mismatch")
	}
	// The file lock proves no live writer owns this incomplete journal. Intent
	// precedes dispatch; applying precedes rename. Never infer success from hash.
	if r.State == "intent" || r.State == "applying" {
		outcome, code, message := "rejected", "EDITOR_APPLY_REJECTED", "interrupted before replacement"
		if r.State == "applying" {
			outcome, code, message = "uncertain", "EDITOR_UNCERTAIN", "replacement may have executed"
		}
		r.State = outcome
		r.Result = editorFailure(op, outcome, code, message)
		if err := e.save(e.receiptPath(namespace, op), &r); err != nil {
			return nil, err
		}
	}
	if r.Result == nil || r.Result.OperationID != op || r.Result.Outcome != r.State {
		return nil, fmt.Errorf("invalid editor receipt")
	}
	return &r, nil
}
func editorFailure(op, outcome, code, message string) *EditorApplyResult {
	return &EditorApplyResult{OperationID: op, Outcome: outcome, Error: &EditorProviderError{Code: code, Message: message}}
}
