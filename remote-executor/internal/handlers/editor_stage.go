package handlers

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

func decodeEditorWrite(params map[string]any, out any) error {
	b, err := json.Marshal(params)
	if err != nil {
		return err
	}
	if len(b) > 128*1024 {
		return fmt.Errorf("editor request exceeds frame budget")
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	return d.Decode(out)
}
func editorPermissionBits(mode os.FileMode) uint32 {
	bits := uint32(mode.Perm())
	if mode&os.ModeSetuid != 0 {
		bits |= 0o4000
	}
	if mode&os.ModeSetgid != 0 {
		bits |= 0o2000
	}
	if mode&os.ModeSticky != 0 {
		bits |= 0o1000
	}
	return bits
}
func editorBinding(namespace, resource string) error {
	if !editorValidKey(namespace) || !editorValidKey(resource) {
		return fmt.Errorf("editor namespace/resource binding required")
	}
	return nil
}

func (e *EditorEngine) Capabilities() any {
	features := []string{FeatureEditorDurableWriteV1}
	if e.hostReceipts != nil {
		features = append(features, FeatureEditorHostReceiptV1)
	}
	return map[string]any{"protocolVersion": 1, "features": features, "maxChunkBytes": e.chunkBytes, "maxBytes": EditorMaxBytes, "runtimeEpoch": e.epoch}
}

// Trusted bootstrap reserves selected state paths even if ACL/IO initialization
// fails. A degraded writer must never expose old recovery evidence to legacy FS.
func (h *Handlers) ReserveEditorPrivateRoot(root string) error {
	if !filepath.IsAbs(root) {
		return fmt.Errorf("editor private directory must be absolute")
	}
	h.guard.protectPrivateRoot(filepath.Clean(root))
	if canonical, _, err := canonicalGuardCreatePath(root); err == nil {
		h.guard.protectPrivateRoot(canonical)
	}
	return nil
}

func (h *Handlers) SetEditorEngine(e *EditorEngine) {
	if e != nil {
		h.guard.protectPrivateRoot(e.root)
		h.guard.protectPrivateRoot(e.lexicalRoot)
		if e.hostReceipts != nil {
			h.guard.protectPrivateRoot(e.hostReceipts.io.root)
			h.guard.protectPrivateRoot(e.hostReceipts.io.lexicalRoot)
		}
	}
	h.editor = e
}

// Only the trusted local stdio bootstrap calls this; it is not an RPC method.
func (e *EditorEngine) SetLocalEpoch(epoch string) error {
	if !editorValidKey(epoch) {
		return fmt.Errorf("invalid local editor epoch")
	}
	e.epoch = epoch
	return nil
}
func (h *Handlers) EditorEpoch() string {
	if h.editor != nil {
		return h.editor.epoch
	}
	return EditorRuntimeEpoch()
}
func (h *Handlers) EditorEnabled() bool { return h.editor != nil }
func (h *Handlers) EditorDispatch(parent context.Context, method string, params map[string]any) (any, error) {
	if h.editor == nil {
		return nil, fmt.Errorf("EDITOR_PROVIDER_UNSUPPORTED: editor writer unavailable")
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()
	e := h.editor
	if method == "editor.capabilities" {
		return e.Capabilities(), nil
	}
	release, err := e.lock(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	switch method {
	case "editor.stage.open":
		var req EditorStageOpen
		if err := decodeEditorWrite(params, &req); err != nil {
			return nil, err
		}
		return e.stageOpen(ctx, req)
	case "editor.stage.append":
		var req EditorStageAppend
		if err := decodeEditorWrite(params, &req); err != nil {
			return nil, err
		}
		return e.stageAppend(ctx, req)
	case "editor.stage.seal":
		var req EditorStageSeal
		if err := decodeEditorWrite(params, &req); err != nil {
			return nil, err
		}
		return e.stageSeal(ctx, req)
	case "editor.stage.abort":
		var req EditorStageAbort
		if err := decodeEditorWrite(params, &req); err != nil {
			return nil, err
		}
		return e.stageAbort(req)
	case "editor.apply":
		if _, ok := params["expectedRawHash"]; !ok {
			return nil, fmt.Errorf("expectedRawHash is required (null means absent)")
		}
		var req EditorApplyRequest
		if err := decodeEditorWrite(params, &req); err != nil {
			return nil, err
		}
		return e.apply(ctx, req)
	case "editor.query":
		var req EditorQueryRequest
		if err := decodeEditorWrite(params, &req); err != nil {
			return nil, err
		}
		return e.query(req)
	default:
		return nil, fmt.Errorf("unknown editor write method")
	}
}

func (e *EditorEngine) stageOpen(ctx context.Context, req EditorStageOpen) (any, error) {
	if err := editorBinding(req.Namespace, req.ResourceKey); err != nil {
		return nil, err
	}
	if req.MaxBytes < 0 || req.MaxBytes > EditorMaxBytes || req.IdleTimeoutMs < 1 || req.IdleTimeoutMs > 30000 {
		return nil, fmt.Errorf("invalid editor stage budget")
	}
	count, total, _, err := e.inventory()
	if err != nil {
		return nil, err
	}
	if count >= editorMaxStages || total+req.MaxBytes > editorMaxStageBytes {
		return nil, fmt.Errorf("editor staging quota exceeded")
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	id, err := editorRandomID()
	if err != nil {
		return nil, err
	}
	f, err := os.OpenFile(e.bodyPath(id), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err = f.Close(); err != nil {
		return nil, err
	}
	s := editorStage{Version: 1, EditorStageHandle: EditorStageHandle{StageID: id, ResourceKey: req.ResourceKey, ExpiresAt: time.Now().UnixMilli() + req.IdleTimeoutMs}, Namespace: req.Namespace, MaxBytes: req.MaxBytes, IdleTimeoutMs: req.IdleTimeoutMs, Chunks: []editorChunk{}}
	if err = e.save(e.stagePath(id), &s); err != nil {
		os.Remove(e.bodyPath(id))
		return nil, err
	}
	return s.EditorStageHandle, nil
}
func (e *EditorEngine) stageAppend(ctx context.Context, req EditorStageAppend) (any, error) {
	if err := editorBinding(req.Namespace, req.ResourceKey); err != nil {
		return nil, err
	}
	s, err := e.readStage(req.Namespace, req.ResourceKey, req.StageID)
	if err != nil {
		return nil, err
	}
	if req.Bytes < 1 || req.Bytes > e.chunkBytes || len(req.DataB64) > base64.StdEncoding.EncodedLen(int(e.chunkBytes)) || !editorValidDigest(req.Digest) {
		return nil, fmt.Errorf("invalid editor chunk budget/digest")
	}
	b, err := base64.StdEncoding.DecodeString(req.DataB64)
	if err != nil || int64(len(b)) != req.Bytes || editorDigest(b) != req.Digest {
		return nil, fmt.Errorf("EDITOR_STAGE_DIGEST_MISMATCH: invalid chunk")
	}
	chunk := editorChunk{Seq: req.Seq, Offset: req.Offset, Bytes: req.Bytes, Digest: req.Digest}
	if req.Seq >= 0 && req.Seq < int64(len(s.Chunks)) {
		if s.Chunks[req.Seq] != chunk {
			return nil, fmt.Errorf("EDITOR_STAGE_DIGEST_MISMATCH: duplicate chunk differs")
		}
		return map[string]any{"accepted": true, "nextOffset": s.Size}, nil
	}
	if s.RawDigest != "" || req.Seq != int64(len(s.Chunks)) || req.Offset != s.Size || s.Size+req.Bytes > s.MaxBytes || len(s.Chunks) >= int(EditorMaxBytes/EditorChunkBytes)+1 {
		return nil, fmt.Errorf("editor chunk sequence/offset/quota mismatch")
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(e.bodyPath(s.StageID), os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	// A crash before metadata publication may leave an extra suffix; overwrite
	// only the unacknowledged suffix, never an acknowledged chunk.
	if err = f.Truncate(s.Size); err != nil {
		return nil, err
	}
	if _, err = f.WriteAt(b, s.Size); err != nil {
		return nil, err
	}
	if err = f.Sync(); err != nil {
		return nil, err
	}
	s.Size += req.Bytes
	s.Chunks = append(s.Chunks, chunk)
	s.ExpiresAt = time.Now().UnixMilli() + s.IdleTimeoutMs
	if err = e.save(e.stagePath(s.StageID), s); err != nil {
		return nil, err
	}
	return map[string]any{"accepted": true, "nextOffset": s.Size}, nil
}
func (e *EditorEngine) stageSeal(ctx context.Context, req EditorStageSeal) (any, error) {
	if err := editorBinding(req.Namespace, req.ResourceKey); err != nil {
		return nil, err
	}
	s, err := e.readStage(req.Namespace, req.ResourceKey, req.StageID)
	if err != nil {
		return nil, err
	}
	if !editorValidDigest(req.RawDigest) || req.TotalBytes != s.Size || s.RawDigest != "" && s.RawDigest != req.RawDigest {
		return nil, fmt.Errorf("EDITOR_STAGE_SEAL_FAILED: seal identity mismatch")
	}
	f, err := os.OpenFile(e.bodyPath(s.StageID), os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	digest, size, err := hashEditorFile(ctx, f)
	if err != nil {
		return nil, err
	}
	if size != req.TotalBytes || digest != req.RawDigest {
		return nil, fmt.Errorf("EDITOR_STAGE_SEAL_FAILED: body digest mismatch")
	}
	if err = f.Sync(); err != nil {
		return nil, err
	}
	s.RawDigest = digest
	s.ExpiresAt = time.Now().UnixMilli() + s.IdleTimeoutMs
	if err = e.save(e.stagePath(s.StageID), s); err != nil {
		return nil, err
	}
	return s.EditorStageHandle, nil
}
func (e *EditorEngine) stageAbort(req EditorStageAbort) (any, error) {
	if err := editorBinding(req.Namespace, req.ResourceKey); err != nil {
		return nil, err
	}
	if req.Reason != "cancel" && req.Reason != "idle_timeout" && req.Reason != "superseded" {
		return nil, fmt.Errorf("invalid editor abort reason")
	}
	s, err := e.readStage(req.Namespace, req.ResourceKey, req.StageID)
	if err != nil {
		return nil, err
	}
	// A crash can occur between intent and the stage's consumed marker. Receipt
	// inventory is bounded and protects every pending/uncertain body's evidence.
	d, err := os.Open(e.root)
	if err != nil {
		return nil, err
	}
	defer d.Close()
	entries, err := d.ReadDir(editorMaxStateFiles + 1)
	if err != nil && err != io.EOF {
		return nil, err
	}
	if len(entries) > editorMaxStateFiles {
		return nil, fmt.Errorf("editor inventory quota exceeded")
	}
	for _, entry := range entries {
		if len(entry.Name()) < 8 || entry.Name()[len(entry.Name())-8:] != ".op.json" {
			continue
		}
		var r editorReceipt
		if err := editorReadJSON(e.root+string(os.PathSeparator)+entry.Name(), &r); err != nil {
			return nil, err
		}
		if r.Request.StageID == s.StageID {
			return nil, fmt.Errorf("cannot abort a dispatched editor stage")
		}
	}
	if err = os.Remove(e.bodyPath(s.StageID)); err != nil {
		return nil, err
	}
	if err = os.Remove(e.stagePath(s.StageID)); err != nil {
		return nil, err
	}
	return map[string]any{"aborted": true}, syncEditorDirectory(e.root)
}
