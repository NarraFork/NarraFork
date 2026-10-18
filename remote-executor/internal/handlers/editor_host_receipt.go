package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const FeatureEditorHostReceiptV1 = "editor.host-receipt.v1"
const editorHostRecordBytes = 16 * 1024
const editorHostRecords = 256
const editorHostTerminalRetention = 10 * time.Minute
const editorHostRecordTTL = 30 * 24 * time.Hour

// Mirror of the existing Host's EditorDurableOperation. This is an association
// record, not another mutation journal: no file bodies, user-selected paths,
// transaction protocol, or remote RPC entry point.
type EditorHostReceiptRecord struct {
	Version         int    `json:"version"`
	CreatedAt       int64  `json:"createdAt"`
	UserID          string `json:"userId"`
	NarratorID      string `json:"narratorId"`
	DeviceID        string `json:"deviceId"`
	OperationID     string `json:"operationId"`
	HostOperationID string `json:"hostOperationId"`
	LeaseID         string `json:"leaseId"`
	EffectID        string `json:"effectId"`
	Saved           struct {
		Hash             string `json:"hash"`
		Bytes            int64  `json:"bytes"`
		SnapshotRevision int64  `json:"snapshotRevision"`
		HashKind         string `json:"hashKind,omitempty"`
	} `json:"saved"`
	RequestDigest string                 `json:"requestDigest"`
	Namespace     string                 `json:"namespace"`
	ResourceKey   string                 `json:"resourceKey"`
	Root          string                 `json:"root"`
	Identity      EditorResourceIdentity `json:"identity"`
	RawDigest     string                 `json:"rawDigest"`
	Bytes         int64                  `json:"bytes"`
	Receipt       *EditorApplyResult     `json:"receipt,omitempty"`
}
type editorHostReceipts struct{ io *EditorEngine }

var editorHostID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`)

// ConfigureHostReceipts is called only from trusted stdio argv, never from RPC
// parameters. The SAME existing engine file-lock primitive is rooted in the Host
// receipt directory itself, so even helpers with different stage state dirs
// serialize this inventory. There is no new lock service or daemon.
func (e *EditorEngine) ConfigureHostReceipts(root string) error {
	store, err := NewEditorEngine(e.h, root)
	if err != nil {
		return err
	}
	if samePath(store.root, e.root) {
		return fmt.Errorf("Host receipts require their own private directory")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	release, err := store.lock(ctx)
	if err != nil {
		return err
	}
	defer release()
	// Capability publication follows a real private create/write/flush/native
	// volume/metadata probe, not merely successful argument parsing.
	probe, err := os.CreateTemp(store.root, ".metadata-*")
	if err != nil {
		return err
	}
	info, err := probe.Stat()
	if err != nil {
		probe.Close()
		return err
	}
	defer func() { probe.Close(); _ = removeConditionalTemporary(probe.Name(), info) }()
	if _, err = probe.Write([]byte("{}")); err != nil {
		return err
	}
	if err = probe.Sync(); err != nil {
		return err
	}
	if err = validateEditorHostRecordFile(probe); err != nil {
		return err
	}
	if err = store.verifyPrivateRoot(); err != nil {
		return err
	}
	if err = syncEditorDirectory(store.root); err != nil {
		return err
	}
	e.hostReceipts = &editorHostReceipts{io: store}
	e.h.guard.protectPrivateRoot(store.root)
	e.h.guard.protectPrivateRoot(store.lexicalRoot)
	return nil
}

func validateHostReceipt(record *EditorHostReceiptRecord) error {
	if record.Version != 1 || record.CreatedAt <= 0 || record.CreatedAt > time.Now().UnixMilli() || !editorHostID.MatchString(record.OperationID) || !editorHostID.MatchString(record.LeaseID) || !editorHostID.MatchString(record.EffectID) {
		return fmt.Errorf("invalid Host receipt identity/version")
	}
	for _, value := range []string{record.UserID, record.NarratorID, record.DeviceID, record.HostOperationID, record.RequestDigest, record.Namespace, record.ResourceKey, record.Root, record.Identity.CanonicalPath, record.Identity.WorkspaceIdentity, record.Identity.RuntimeEpoch} {
		if len(value) == 0 || len(value) > 8192 || strings.ContainsRune(value, 0) {
			return fmt.Errorf("invalid Host receipt association")
		}
	}
	// Legacy v1 saved.hash is decoded-text SHA; only explicit raw-sha256 puts
	// it in the same domain as the bytes/installation receipt's rawDigest.
	if record.Identity.DeviceID != record.DeviceID || (record.Identity.PathFlavor != "posix" && record.Identity.PathFlavor != "windows") || record.Identity.RuntimeGeneration < 0 || record.Identity.FencingToken < 0 || !editorValidDigest(record.RequestDigest) || !editorValidDigest(record.RawDigest) || record.Bytes < 0 || record.Bytes > EditorMaxBytes || !editorValidDigest(record.Saved.Hash) || (record.Saved.HashKind == "raw-sha256" && record.Saved.Hash != record.RawDigest) || record.Saved.Bytes != record.Bytes || record.Saved.SnapshotRevision < 0 || record.Saved.SnapshotRevision > 9007199254740991 || (record.Saved.HashKind != "" && record.Saved.HashKind != "raw-sha256") {
		return fmt.Errorf("invalid Host receipt content/binding")
	}
	if record.Receipt != nil {
		r := record.Receipt
		if r.OperationID != record.OperationID || (r.Outcome != "committed" && r.Outcome != "rejected") {
			return fmt.Errorf("Host receipt requires matching terminal proof")
		}
		if r.Outcome == "committed" && (r.RawDigest == nil || *r.RawDigest != record.RawDigest || r.TotalBytes == nil || *r.TotalBytes != record.Bytes || r.Error != nil) {
			return fmt.Errorf("Host committed proof does not match sealed content")
		}
		if r.Outcome == "rejected" && (r.RawDigest != nil || r.TotalBytes != nil) {
			return fmt.Errorf("Host rejection cannot claim saved content")
		}
	}
	b, err := json.Marshal(record)
	if err != nil {
		return err
	}
	if len(b) > editorHostRecordBytes {
		return fmt.Errorf("Host receipt metadata exceeds 16KiB")
	}
	return nil
}
func (s *editorHostReceipts) path(id string) (string, error) {
	if !editorHostID.MatchString(id) {
		return "", fmt.Errorf("invalid Host operation ID")
	}
	return filepath.Join(s.io.root, id+".json"), nil
}
func (s *editorHostReceipts) read(ctx context.Context, id string) (*EditorHostReceiptRecord, os.FileInfo, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	path, err := s.path(id)
	if err != nil {
		return nil, nil, err
	}
	before, err := os.Lstat(path)
	if err != nil {
		return nil, nil, err
	}
	if !before.Mode().IsRegular() || before.Size() > editorHostRecordBytes {
		return nil, nil, fmt.Errorf("unsafe Host receipt size/type")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, nil, err
	}
	if !os.SameFile(before, info) {
		return nil, nil, fmt.Errorf("Host receipt object changed")
	}
	// Reuse native identity/type/volume checks, not full target-file ACL
	// capture for every entry in a bounded private metadata inventory.
	if err = validateEditorHostRecordFile(file); err != nil {
		return nil, nil, err
	}
	b, err := io.ReadAll(io.LimitReader(file, editorHostRecordBytes+1))
	if err != nil {
		return nil, nil, err
	}
	if len(b) > editorHostRecordBytes {
		return nil, nil, fmt.Errorf("Host receipt metadata exceeds 16KiB")
	}
	var record EditorHostReceiptRecord
	decoder := json.NewDecoder(bytes.NewReader(b))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&record); err != nil {
		return nil, nil, err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return nil, nil, fmt.Errorf("trailing Host receipt data")
	}
	if record.OperationID != id {
		return nil, nil, fmt.Errorf("Host receipt operation binding changed")
	}
	if err = validateHostReceipt(&record); err != nil {
		return nil, nil, err
	}
	after, err := os.Lstat(path)
	if err != nil {
		return nil, nil, err
	}
	if !os.SameFile(info, after) || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
		return nil, nil, fmt.Errorf("Host receipt changed while reading")
	}
	if err = s.io.verifyPrivateRoot(); err != nil {
		return nil, nil, err
	}
	return &record, after, nil
}
func hostReceiptUnavailable(record *EditorHostReceiptRecord) error {
	if time.Now().UnixMilli()-record.CreatedAt > editorHostRecordTTL.Milliseconds() {
		return fmt.Errorf("Host receipt expired; proof remains unavailable, not not-executed")
	}
	return nil
}
func (s *editorHostReceipts) inventory(ctx context.Context) (int, error) {
	dir, err := os.Open(s.io.root)
	if err != nil {
		return 0, err
	}
	defer dir.Close()
	entries, err := dir.ReadDir(editorHostRecords + 5)
	if err != nil && err != io.EOF {
		return 0, err
	}
	if len(entries) > editorHostRecords+4 {
		return 0, fmt.Errorf("Host receipt inventory exceeds budget")
	}
	type terminal struct {
		name string
		info os.FileInfo
	}
	terminals := []terminal{}
	count := 0
	for _, entry := range entries {
		if err = ctx.Err(); err != nil {
			return 0, err
		}
		name := entry.Name()
		if name == "engine.lock" {
			continue
		}
		if strings.HasPrefix(name, ".metadata-") {
			info, err := os.Lstat(filepath.Join(s.io.root, name))
			if err != nil {
				return 0, err
			}
			if !info.Mode().IsRegular() {
				return 0, fmt.Errorf("unsafe Host metadata temporary")
			}
			if err = removeConditionalTemporary(filepath.Join(s.io.root, name), info); err != nil {
				return 0, err
			}
			continue
		}
		if !strings.HasSuffix(name, ".json") {
			return 0, fmt.Errorf("unexpected Host receipt inventory entry")
		}
		record, info, err := s.read(ctx, strings.TrimSuffix(name, ".json"))
		if err != nil {
			return 0, err
		}
		count++
		if record.Receipt != nil {
			terminals = append(terminals, terminal{name: name, info: info})
		}
	}
	sort.Slice(terminals, func(i, j int) bool { return terminals[i].info.ModTime().Before(terminals[j].info.ModTime()) })
	pressure := 0
	if count >= editorHostRecords {
		pressure = count - editorHostRecords + editorReceiptCleanupBatch
	}
	cutoff := time.Now().Add(-editorHostTerminalRetention)
	for _, record := range terminals {
		if record.info.ModTime().After(cutoff) && pressure <= 0 {
			break
		}
		if err = s.io.verifyPrivateRoot(); err != nil {
			return 0, err
		}
		if err = removeConditionalTemporary(filepath.Join(s.io.root, record.name), record.info); err != nil {
			return 0, err
		}
		count--
		pressure--
	}
	return count, syncEditorDirectory(s.io.root)
}

// Only runEditorStdio invokes this function. rpc.Dispatcher deliberately has no
// hostReceipt routes: a connected device must not read the Host's recovery store.
func (h *Handlers) EditorHostReceiptDispatch(parent context.Context, method string, params map[string]any) (any, error) {
	if h.editor == nil || h.editor.hostReceipts == nil {
		return nil, fmt.Errorf("native Host receipt store unavailable")
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	s := h.editor.hostReceipts
	release, err := s.io.lock(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	switch method {
	case "editor.hostReceipt.put":
		var request struct {
			Value EditorHostReceiptRecord `json:"value"`
		}
		if err = decodeEditorWrite(params, &request); err != nil {
			return nil, err
		}
		record := request.Value
		if err = validateHostReceipt(&record); err != nil {
			return nil, err
		}
		if err = hostReceiptUnavailable(&record); err != nil {
			return nil, err
		}
		if record.Receipt != nil {
			return nil, fmt.Errorf("Host receipt put cannot publish terminal proof")
		}
		// Reserve the terminal envelope BEFORE any target dispatch. An intent
		// that fills the whole 16KiB file must not later strand successful proof.
		future := record
		future.Receipt = &EditorApplyResult{OperationID: record.OperationID, Outcome: "committed", RawDigest: &record.RawDigest, TotalBytes: &record.Bytes}
		if err = validateHostReceipt(&future); err != nil {
			return nil, err
		}
		future.Receipt = editorFailure(record.OperationID, "rejected", "EDITOR_PROVIDER_UNSUPPORTED", strings.Repeat("x", 256))
		if err = validateHostReceipt(&future); err != nil {
			return nil, err
		}
		prior, _, err := s.read(ctx, record.OperationID)
		if err == nil {
			copy := *prior
			copy.Receipt = nil
			a, _ := json.Marshal(copy)
			b, _ := json.Marshal(record)
			if !bytes.Equal(a, b) {
				return nil, fmt.Errorf("Host operation association differs")
			}
			return map[string]any{"ok": true}, nil
		}
		if !os.IsNotExist(err) {
			return nil, err
		}
		count, err := s.inventory(ctx)
		if err != nil {
			return nil, err
		}
		if count >= editorHostRecords {
			return nil, fmt.Errorf("Host receipt capacity exceeded; unknown proof retained")
		}
		path, _ := s.path(record.OperationID)
		if err = s.io.save(path, &record); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	case "editor.hostReceipt.get":
		var request struct {
			OperationID string `json:"operationId"`
		}
		if err = decodeEditorWrite(params, &request); err != nil {
			return nil, err
		}
		record, _, err := s.read(ctx, request.OperationID)
		if os.IsNotExist(err) {
			return map[string]any{"value": nil}, nil
		}
		if err != nil {
			return nil, err
		}
		if err = hostReceiptUnavailable(record); err != nil {
			return nil, err
		}
		return map[string]any{"value": record}, nil
	case "editor.hostReceipt.settle":
		var request struct {
			OperationID string            `json:"operationId"`
			Receipt     EditorApplyResult `json:"receipt"`
		}
		if err = decodeEditorWrite(params, &request); err != nil {
			return nil, err
		}
		record, _, err := s.read(ctx, request.OperationID)
		if err != nil {
			return nil, err
		}
		if err = hostReceiptUnavailable(record); err != nil {
			return nil, err
		}
		if record.Receipt != nil {
			a, _ := json.Marshal(record.Receipt)
			b, _ := json.Marshal(request.Receipt)
			if !bytes.Equal(a, b) {
				return nil, fmt.Errorf("Host terminal proof differs")
			}
			return map[string]any{"ok": true}, nil
		}
		record.Receipt = &request.Receipt
		if err = validateHostReceipt(record); err != nil {
			return nil, err
		}
		path, _ := s.path(request.OperationID)
		if err = s.io.save(path, record); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	default:
		return nil, fmt.Errorf("unknown native Host receipt method")
	}
}
