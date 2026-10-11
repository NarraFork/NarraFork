package handlers

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/narrafork/remote-executor/internal/history"
	"github.com/narrafork/remote-executor/internal/windowsbackup"
)

const attachmentBytes int64 = 100 << 20
const attachmentChunk = 64 << 10

type attachmentIntent struct {
	Binding       history.Binding `json:"binding"`
	OperationID   string          `json:"operationId"`
	RequestDigest string          `json:"requestDigest"`
	Path          string          `json:"path"`
	SizeBytes     int64           `json:"sizeBytes"`
	Digest        string          `json:"digest"`
	Expected      string          `json:"expected"`
	NoOverwrite   bool            `json:"noOverwrite"`
}
type attachmentProof struct {
	Version              int             `json:"version"`
	Binding              history.Binding `json:"binding"`
	OperationID          string          `json:"operationId"`
	RequestDigest        string          `json:"requestDigest"`
	Path                 string          `json:"path"`
	SizeBytes            int64           `json:"sizeBytes"`
	Digest               string          `json:"digest"`
	Incarnation          string          `json:"incarnation"`
	NativeMetadataDigest string          `json:"nativeMetadataDigest"`
	CreationProof        string          `json:"creationProof"`
	State                string          `json:"state"`
	CreatedAt            string          `json:"createdAt"`
}
type attachmentStatus struct {
	Binding       history.Binding  `json:"binding"`
	OperationID   string           `json:"operationId"`
	RequestDigest string           `json:"requestDigest"`
	Path          string           `json:"path"`
	WrittenBytes  int64            `json:"writtenBytes"`
	State         string           `json:"state"`
	Proof         *attachmentProof `json:"proof,omitempty"`
	Reason        string           `json:"reason,omitempty"`
}
type attachmentRecord struct {
	Intent   attachmentIntent `json:"intent"`
	Status   attachmentStatus `json:"status"`
	Chunks   map[int64]string `json:"chunks"`
	Metadata []byte           `json:"metadata,omitempty"`
}
type attachmentRegistry struct {
	mu        sync.Mutex
	directory string
	// Test-only boundary injection; nil in production and scoped to one registry.
	beforeCleanupMove func()
}

func (h *Handlers) ConfigureAttachmentStateDirectory(directory string) error {
	if !filepath.IsAbs(directory) {
		return fmt.Errorf("private attachment state must be absolute")
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	actual, err := filepath.EvalSymlinks(directory)
	if err != nil || !samePath(actual, directory) {
		return fmt.Errorf("private attachment directory contains alias")
	}
	if err := h.guard.ExcludePrivateDirectories(directory); err != nil {
		return err
	}
	h.attachments = &attachmentRegistry{directory: directory}
	return nil
}
func attachmentHash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
func boundedAttachmentHash(ctx context.Context, file *os.File, max int64) (string, int64, error) {
	if _, err := file.Seek(0, 0); err != nil {
		return "", 0, err
	}
	hash := sha256.New()
	buf := make([]byte, attachmentChunk)
	var size int64
	for {
		if err := ctx.Err(); err != nil {
			return "", size, err
		}
		n, err := file.Read(buf)
		size += int64(n)
		if size > max {
			return "", size, fmt.Errorf("attachment expanded byte budget")
		}
		hash.Write(buf[:n])
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", size, err
		}
	}
	return hex.EncodeToString(hash.Sum(nil)), size, nil
}
func saveAttachment(path string, record attachmentRecord) error {
	return saveAttachmentJSON(path, record)
}
func saveAttachmentJSON(path string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(raw) > 512<<10 {
		return fmt.Errorf("attachment journal metadata budget")
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".pending-")
	if err != nil {
		return err
	}
	temp := file.Name()
	defer os.Remove(temp)
	if _, err := file.Write(raw); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	file.Close()
	if err := os.Rename(temp, path); err != nil {
		return err
	}
	return syncHistoryDirectory(filepath.Dir(path))
}
func readAttachment(path string) (attachmentRecord, error) {
	var record attachmentRecord
	info, err := os.Lstat(path)
	if err != nil {
		return record, err
	}
	if !info.Mode().IsRegular() || info.Size() > 512<<10 {
		return record, fmt.Errorf("attachment journal budget/object")
	}
	file, err := os.Open(path)
	if err != nil {
		return record, err
	}
	defer file.Close()
	opened, _ := file.Stat()
	if !os.SameFile(info, opened) {
		return record, fmt.Errorf("attachment private identity changed")
	}
	raw, err := io.ReadAll(io.LimitReader(file, (512<<10)+1))
	if err != nil || len(raw) > 512<<10 {
		return record, fmt.Errorf("attachment journal budget")
	}
	if err := json.Unmarshal(raw, &record); err != nil {
		return record, err
	}
	if record.Chunks == nil {
		record.Chunks = map[int64]string{}
	}
	return record, nil
}
func (h *Handlers) WorkspaceAttachment(parent context.Context, method string, params map[string]any) (any, error) {
	if h.attachments == nil || h.history == nil {
		return nil, fmt.Errorf("workspace attachment namespace unavailable")
	}
	deadline := 10 * time.Second
	if method == "attachment.commit" || method == "attachment.cleanup" {
		deadline = 120 * time.Second
	}
	ctx, cancel := context.WithTimeout(parent, deadline)
	defer cancel()
	raw, err := json.Marshal(params)
	if err != nil || len(raw) > 2*attachmentChunk+16384 {
		return nil, fmt.Errorf("attachment RPC input budget")
	}
	var intent attachmentIntent
	if err := json.Unmarshal(raw, &intent); err != nil {
		return nil, err
	}
	if intent.OperationID == "" || len(intent.OperationID) > 256 || len(intent.RequestDigest) != 64 {
		return nil, fmt.Errorf("attachment operation ID/digest required")
	}
	historical := method == "attachment.status"
	if err := h.history.ValidateBinding(ctx, intent.Binding, historical); err != nil {
		return nil, err
	}
	registry := h.attachments
	registry.mu.Lock()
	defer registry.mu.Unlock()
	root, err := filepath.EvalSymlinks(registry.directory)
	if err != nil || !samePath(root, registry.directory) {
		return nil, fmt.Errorf("attachment private root replaced")
	}
	lookupID := intent.OperationID
	var cleanupProof attachmentProof
	if method == "attachment.cleanup" {
		proofRaw, _ := json.Marshal(params["proof"])
		if err := json.Unmarshal(proofRaw, &cleanupProof); err != nil || cleanupProof.OperationID == "" || cleanupProof.Binding.SourceInstanceID != intent.Binding.SourceInstanceID || cleanupProof.Binding.ScopeID != intent.Binding.ScopeID || cleanupProof.Binding.RootIdentity != intent.Binding.RootIdentity || cleanupProof.Binding.WorkspaceInstanceID != intent.Binding.WorkspaceInstanceID || cleanupProof.Binding.Root != intent.Binding.Root {
			return nil, fmt.Errorf("cleanup proof source/root mismatch")
		}
		lookupID = cleanupProof.OperationID
	}
	key := attachmentHash([]byte(intent.Binding.ScopeID + "\x00" + lookupID))
	recordPath := filepath.Join(root, key+".json")
	partPath := filepath.Join(root, key+".part")
	record, loadErr := readAttachment(recordPath)
	if loadErr != nil && !os.IsNotExist(loadErr) {
		return nil, loadErr
	}
	if os.IsNotExist(loadErr) {
		if method != "attachment.begin" {
			return nil, fmt.Errorf("attachment original receipt not found")
		}
		if intent.Expected != "absent" || !intent.NoOverwrite || intent.SizeBytes < 0 || intent.SizeBytes > attachmentBytes || len(intent.Digest) != 64 || intent.Path == "" || filepath.IsAbs(intent.Path) || filepath.VolumeName(intent.Path) != "" {
			return nil, fmt.Errorf("invalid exclusive attachment intent")
		}
		target := filepath.Join(intent.Binding.Root, intent.Path)
		if !pathWithin(intent.Binding.Root, target) || samePath(target, intent.Binding.Root) {
			return nil, fmt.Errorf("attachment path escapes source root")
		}
		canonical, err := h.guard.CheckCreate(target)
		if err != nil || !samePath(canonical, target) {
			return nil, fmt.Errorf("attachment target denied/changed")
		}
		if _, err := os.Lstat(target); !os.IsNotExist(err) {
			return nil, fmt.Errorf("attachment target already exists or is unobservable")
		}
		files, err := os.Open(root)
		if err != nil {
			return nil, err
		}
		names, err := files.Readdirnames(129)
		files.Close()
		if err != nil && err != io.EOF {
			return nil, err
		}
		if len(names) > 128 {
			return nil, fmt.Errorf("attachment private operation quota")
		}
		part, err := os.OpenFile(partPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return nil, err
		}
		part.Sync()
		part.Close()
		record = attachmentRecord{Intent: intent, Status: attachmentStatus{Binding: intent.Binding, OperationID: intent.OperationID, RequestDigest: intent.RequestDigest, Path: intent.Path, State: "pending"}, Chunks: map[int64]string{}}
		if err := saveAttachment(recordPath, record); err != nil {
			return nil, err
		}
	} else if method == "attachment.cleanup" {
		if record.Status.Proof == nil || *record.Status.Proof != cleanupProof || record.Intent.Binding != cleanupProof.Binding || record.Intent.RequestDigest != cleanupProof.RequestDigest || record.Intent.OperationID != cleanupProof.OperationID {
			return nil, fmt.Errorf("cleanup proof does not match original durable publisher record")
		}
	} else if record.Intent.Binding != intent.Binding || record.Intent.RequestDigest != intent.RequestDigest || record.Intent.OperationID != intent.OperationID {
		return nil, fmt.Errorf("attachment original operation binding/digest conflict")
	}
	if method == "attachment.begin" {
		if record.Intent != intent {
			return nil, fmt.Errorf("attachment intent changed")
		}
		return record.Status, nil
	}
	if method == "attachment.status" {
		return record.Status, nil
	}
	if method == "attachment.append" {
		if record.Status.State == "committed" {
			return record.Status, nil
		}
		if record.Status.State != "pending" {
			return record.Status, fmt.Errorf("attachment unknown/conflict retained")
		}
		encoded := stringParam(params, "contentBase64")
		chunkDigest := stringParam(params, "chunkDigest")
		offset := intParam(params, "offset", -1)
		if len(encoded) > base64.StdEncoding.EncodedLen(attachmentChunk) {
			return nil, fmt.Errorf("attachment chunk cap")
		}
		data, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(data) > attachmentChunk || attachmentHash(data) != chunkDigest {
			return nil, fmt.Errorf("attachment chunk digest mismatch")
		}
		if offset < record.Status.WrittenBytes {
			if record.Chunks[offset] != chunkDigest {
				return nil, fmt.Errorf("attachment retry chunk conflict")
			}
			return record.Status, nil
		}
		if offset != record.Status.WrittenBytes || offset+int64(len(data)) > record.Intent.SizeBytes {
			return nil, fmt.Errorf("attachment offset/size conflict")
		}
		file, err := os.OpenFile(partPath, os.O_WRONLY, 0600)
		if err != nil {
			return nil, err
		}
		defer file.Close()
		info, _ := file.Stat()
		if info.Size() != record.Status.WrittenBytes {
			record.Status.State = "unknown"
			saveAttachment(recordPath, record)
			return record.Status, fmt.Errorf("attachment unacknowledged suffix retained")
		}
		if _, err := file.WriteAt(data, offset); err != nil {
			record.Status.State = "unknown"
			saveAttachment(recordPath, record)
			return record.Status, err
		}
		if err := file.Sync(); err != nil {
			return record.Status, err
		}
		record.Chunks[offset] = chunkDigest
		record.Status.WrittenBytes += int64(len(data))
		if err := saveAttachment(recordPath, record); err != nil {
			return record.Status, err
		}
		return record.Status, nil
	}
	target := filepath.Join(record.Intent.Binding.Root, record.Intent.Path)
	checked, err := h.guard.CheckCreate(target)
	if err != nil || !samePath(checked, target) {
		return nil, fmt.Errorf("attachment source target denied/changed")
	}
	if method == "attachment.commit" {
		if record.Status.State == "committed" {
			return record.Status, nil
		}
		if record.Status.State != "pending" || record.Status.WrittenBytes != record.Intent.SizeBytes {
			return record.Status, fmt.Errorf("attachment not complete")
		}
		file, err := os.Open(partPath)
		if err != nil {
			return nil, err
		}
		digest, size, err := boundedAttachmentHash(ctx, file, attachmentBytes)
		file.Close()
		if err != nil || digest != record.Intent.Digest || size != record.Intent.SizeBytes {
			return nil, fmt.Errorf("attachment complete digest mismatch")
		}
		release, err := acquireFileMutation(ctx)
		if err != nil {
			return nil, err
		}
		defer release()
		if _, err := os.Lstat(target); !os.IsNotExist(err) {
			record.Status.State = "conflict"
			saveAttachment(recordPath, record)
			return record.Status, nil
		}
		parentPath := filepath.Dir(target)
		if err := h.ensureAttachmentParents(parentPath, record.Intent.Binding.Root); err != nil {
			return nil, err
		}
		evidence, releaseParent, err := h.pinAttachmentPublicationParent(ctx, parentPath, record.Intent.Binding.Root, digest)
		if err != nil {
			return record.Status, err
		}
		defer releaseParent()
		temp, err := os.CreateTemp(parentPath, ".nf-attachment-")
		if err != nil {
			return nil, err
		}
		tempInfo, _ := temp.Stat()
		defer func() { _ = temp.Close(); _ = removeConditionalTemporary(temp.Name(), tempInfo) }()
		source, err := os.Open(partPath)
		if err != nil {
			return nil, err
		}
		defer source.Close()
		buffer := make([]byte, attachmentChunk)
		for {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			n, e := source.Read(buffer)
			if n > 0 {
				if _, err := temp.Write(buffer[:n]); err != nil {
					return nil, err
				}
			}
			if e == io.EOF {
				break
			}
			if e != nil {
				return nil, e
			}
		}
		if err := temp.Sync(); err != nil {
			return nil, err
		}
		// Complete capability and the prepared object's metadata must be known
		// before publication. Missing audit rights is a predictable preflight
		// refusal, not a reason to leave a publicly visible unproved attachment.
		preparedFile, err := h.prepareAttachmentPublication(ctx, temp, tempInfo, target, evidence)
		if err != nil {
			return record.Status, err
		}
		defer preparedFile.Close()
		preparedMetadata, err := captureHistoryMetadata(ctx, preparedFile)
		if err != nil {
			return record.Status, fmt.Errorf("attachment metadata preflight not ready: %w", err)
		}
		if err := validateAttachmentPrepared(ctx, preparedMetadata, evidence); err != nil {
			return record.Status, err
		}
		record.Metadata = preparedMetadata
		if err := saveAttachment(recordPath, record); err != nil {
			return record.Status, err
		}
		record.Status.State = "unknown"
		record.Status.Reason = "exclusive publication dispatched"
		if err := saveAttachment(recordPath, record); err != nil {
			return nil, err
		}
		if err := h.history.ValidateBindingSnapshot(record.Intent.Binding, false); err != nil {
			return record.Status, err
		}
		if err := ctx.Err(); err != nil {
			return record.Status, err
		}
		if err := publishAttachmentPrepared(preparedFile, target); err != nil {
			// A publication primitive can fail after its native dispatch. Do not
			// turn a possible side effect into a rejected/conflict receipt.
			record.Status.Reason = "publication result unknown; prepared proof retained"
			_ = saveAttachment(recordPath, record)
			return record.Status, err
		}
		actual, err := windowsbackup.OpenObservation(target)
		if err != nil {
			return record.Status, err
		}
		defer actual.Close()
		publishedInfo, err := actual.Stat()
		if err != nil || !os.SameFile(tempInfo, publishedInfo) {
			return record.Status, fmt.Errorf("exclusive published incarnation changed; unknown retained")
		}
		actualDigest, actualSize, err := boundedAttachmentHash(ctx, actual, attachmentBytes)
		if err != nil || actualDigest != digest || actualSize != size {
			return record.Status, fmt.Errorf("attachment after bytes changed")
		}
		metadata, err := captureHistoryMetadata(ctx, actual)
		if err != nil {
			return record.Status, err
		}
		if err := verifyAttachmentPrepared(ctx, preparedMetadata, metadata, evidence); err != nil {
			return record.Status, fmt.Errorf("published prepared metadata changed; unknown retained: %w", err)
		}
		if err := ctx.Err(); err != nil {
			return record.Status, err
		}
		if err := h.history.ValidateBindingSnapshot(record.Intent.Binding, false); err != nil {
			return record.Status, err
		}
		incarnation, err := history.FileIncarnation(target)
		if err != nil {
			return record.Status, err
		}
		nonce := make([]byte, 32)
		if _, err := rand.Read(nonce); err != nil {
			return record.Status, err
		}
		proof := &attachmentProof{1, record.Intent.Binding, record.Intent.OperationID, record.Intent.RequestDigest, record.Intent.Path, size, digest, incarnation, attachmentHash(metadata), hex.EncodeToString(nonce), "committed", time.Now().UTC().Format(time.RFC3339Nano)}
		record.Metadata = metadata
		record.Status.Proof = proof
		record.Status.State = "committed"
		record.Status.Reason = ""
		if err := saveAttachment(recordPath, record); err != nil {
			return record.Status, err
		}
		return record.Status, nil
	}
	if method == "attachment.cleanup" {
		cleanupResult := func(outcome, reason string) map[string]any {
			return map[string]any{"binding": intent.Binding, "operationId": intent.OperationID, "requestDigest": intent.RequestDigest, "outcome": outcome, "reason": reason}
		}
		cleanupPath := filepath.Join(root, attachmentHash([]byte(intent.Binding.ScopeID+"\x00cleanup\x00"+intent.OperationID))+".json")
		var previous struct {
			OperationID   string          `json:"operationId"`
			RequestDigest string          `json:"requestDigest"`
			Proof         attachmentProof `json:"proof"`
			Outcome       string          `json:"outcome"`
		}
		if data, err := os.ReadFile(cleanupPath); err == nil {
			if err := json.Unmarshal(data, &previous); err != nil || previous.OperationID != intent.OperationID || previous.RequestDigest != intent.RequestDigest || previous.Proof != cleanupProof {
				return nil, fmt.Errorf("cleanup own operation ID/digest/proof conflict")
			}
			if previous.Outcome == "deleted" {
				return map[string]any{"binding": intent.Binding, "operationId": intent.OperationID, "requestDigest": intent.RequestDigest, "outcome": "already_deleted"}, nil
			}
		}
		if record.Status.State == "cleaned" {
			return map[string]any{"binding": intent.Binding, "operationId": intent.OperationID, "requestDigest": intent.RequestDigest, "outcome": "already_deleted"}, nil
		}
		previous.OperationID = intent.OperationID
		previous.RequestDigest = intent.RequestDigest
		previous.Proof = cleanupProof
		previous.Outcome = "unknown"
		if err := saveAttachmentJSON(cleanupPath, previous); err != nil {
			return nil, err
		}
		supplied, _ := json.Marshal(params["proof"])
		var proof attachmentProof
		if err := json.Unmarshal(supplied, &proof); err != nil || record.Status.Proof == nil || proof != *record.Status.Proof {
			return nil, fmt.Errorf("attachment cleanup original creation proof conflict")
		}
		release, err := acquireFileMutation(ctx)
		if err != nil {
			return nil, err
		}
		defer release()
		if err := h.history.ValidateBindingSnapshot(intent.Binding, false); err != nil {
			return nil, err
		}
		file, err := windowsbackup.OpenMutation(target)
		if err != nil {
			return nil, err
		}
		defer file.Close()
		incarnation, err := history.FileIncarnation(target)
		if err != nil || incarnation != proof.Incarnation {
			return cleanupResult("conflict", "created incarnation changed"), nil
		}
		digest, size, err := boundedAttachmentHash(ctx, file, attachmentBytes)
		if err != nil || digest != proof.Digest || size != proof.SizeBytes {
			return cleanupResult("conflict", "created content changed"), nil
		}
		metadata, err := captureHistoryMetadata(ctx, file)
		if err != nil || !bytes.Equal(metadata, record.Metadata) {
			return cleanupResult("conflict", "created metadata changed"), nil
		}
		named, err := os.Stat(target)
		pinned, _ := file.Stat()
		if err != nil || !os.SameFile(named, pinned) {
			return cleanupResult("conflict", "created file entry changed"), nil
		}
		if registry.beforeCleanupMove != nil {
			registry.beforeCleanupMove()
		}
		quarantine := filepath.Join(root, key+".deleted")
		if err := quarantineHistoryOriginal(file, quarantine); err != nil {
			return cleanupResult("unknown", "quarantine failed; retained"), err
		}
		unknownAfterMove := func(reason string) (any, error) {
			record.Status.State = "unknown"
			record.Status.Reason = reason
			if err := saveAttachment(recordPath, record); err != nil {
				return cleanupResult("unknown", "quarantine retained; receipt persistence failed"), err
			}
			return cleanupResult("unknown", reason), nil
		}
		movedFile, err := windowsbackup.OpenObservation(quarantine)
		if err != nil {
			return unknownAfterMove("quarantine unreadable; retained")
		}
		defer movedFile.Close()
		moved, err := movedFile.Stat()
		if err != nil || !os.SameFile(pinned, moved) {
			return unknownAfterMove("foreign quarantine retained")
		}
		movedIncarnation, err := history.FileIncarnation(quarantine)
		if err != nil || movedIncarnation != proof.Incarnation {
			return unknownAfterMove("quarantined incarnation changed; retained")
		}
		movedDigest, movedSize, err := boundedAttachmentHash(ctx, movedFile, attachmentBytes)
		if err != nil || movedDigest != proof.Digest || movedSize != proof.SizeBytes {
			return unknownAfterMove("quarantined content changed; retained")
		}
		movedMetadata, err := captureHistoryMetadata(ctx, movedFile)
		if err != nil || !bytes.Equal(movedMetadata, record.Metadata) || attachmentHash(movedMetadata) != proof.NativeMetadataDigest {
			return unknownAfterMove("quarantined native metadata changed; retained")
		}
		if err := h.history.ValidateBindingSnapshot(intent.Binding, false); err != nil {
			return unknownAfterMove("cleanup source/root/fence changed; quarantine retained")
		}
		previous.Outcome = "deleted"
		if err := saveAttachmentJSON(cleanupPath, previous); err != nil {
			return unknownAfterMove("cleanup acknowledgement persistence failed; quarantine retained")
		}
		record.Status.State = "cleaned"
		if err := saveAttachment(recordPath, record); err != nil {
			return cleanupResult("unknown", "cleanup receipt unknown"), err
		}
		return cleanupResult("deleted", ""), nil
	}
	return nil, fmt.Errorf("unknown attachment operation")
}
func attachmentCleanup(record attachmentRecord, outcome, reason string) map[string]any {
	return map[string]any{"binding": record.Intent.Binding, "operationId": record.Intent.OperationID, "requestDigest": record.Intent.RequestDigest, "outcome": outcome, "reason": reason}
}
func (h *Handlers) ensureAttachmentParents(parent, root string) error {
	if !pathWithin(root, parent) {
		return fmt.Errorf("attachment parent escapes root")
	}
	missing := []string{}
	for p := parent; !samePath(p, root); p = filepath.Dir(p) {
		if _, err := os.Stat(p); err == nil {
			break
		}
		missing = append(missing, p)
	}
	for i := len(missing) - 1; i >= 0; i-- {
		if _, err := h.guard.CheckCreate(missing[i]); err != nil {
			return err
		}
		if err := os.Mkdir(missing[i], 0700); err != nil && !os.IsExist(err) {
			return err
		}
	}
	return nil
}
