package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func hashEditorFile(ctx context.Context, f *os.File) (string, int64, error) {
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return "", 0, err
	}
	hash := sha256.New()
	buffer := make([]byte, EditorChunkBytes)
	var size int64
	for {
		if err := ctx.Err(); err != nil {
			return "", 0, err
		}
		n, err := f.Read(buffer)
		size += int64(n)
		if size > EditorMaxBytes {
			return "", size, fmt.Errorf("editor file exceeds 20MiB budget")
		}
		if n > 0 {
			hash.Write(buffer[:n])
		}
		if err == io.EOF {
			return hex.EncodeToString(hash.Sum(nil)), size, nil
		}
		if err != nil {
			return "", size, err
		}
		if n == 0 {
			return "", size, io.ErrNoProgress
		}
	}
}
func (e *EditorEngine) verifyIdentity(i EditorResourceIdentity) error {
	if i.RuntimeEpoch != e.epoch {
		return fmt.Errorf("EDITOR_RUNTIME_CHANGED: executor epoch changed")
	}
	if i.PathFlavor != EditorPathFlavor() || !editorValidKey(i.DeviceID) || i.RuntimeGeneration < 0 || i.FencingToken < 0 || !filepath.IsAbs(i.CanonicalPath) || len(i.CanonicalPath) > 32768 || filepath.Clean(i.CanonicalPath) != i.CanonicalPath {
		return fmt.Errorf("EDITOR_IDENTITY_CHANGED: invalid resource identity")
	}
	if err := e.h.VerifyEditorRoot(i.WorkspaceIdentity); err != nil {
		return err
	}
	var root [2]string
	if err := json.Unmarshal([]byte(i.WorkspaceIdentity), &root); err != nil {
		return err
	}
	if !pathWithin(root[0], i.CanonicalPath) || samePath(root[0], i.CanonicalPath) {
		return fmt.Errorf("EDITOR_IDENTITY_CHANGED: target outside execution scope")
	}
	path, err := e.h.guard.CheckCreate(i.CanonicalPath)
	if err != nil {
		return err
	}
	if !samePath(path, i.CanonicalPath) {
		return fmt.Errorf("EDITOR_IDENTITY_CHANGED: canonical target changed")
	}
	return nil
}
func (e *EditorEngine) fence(req EditorApplyRequest) error {
	path := filepath.Join(e.root, editorKey(req.Namespace, req.Identity.WorkspaceIdentity)+".fence.json")
	var prior editorFence
	err := editorReadJSON(path, &prior)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if os.IsNotExist(err) {
		dir, err := os.Open(e.root)
		if err != nil {
			return err
		}
		entries, err := dir.ReadDir(editorMaxStateFiles + 1)
		dir.Close()
		if err != nil && err != io.EOF {
			return err
		}
		count := 0
		for _, entry := range entries {
			if strings.HasSuffix(entry.Name(), ".fence.json") {
				count++
			}
		}
		if count >= editorMaxFences || len(entries) > editorMaxStateFiles {
			return fmt.Errorf("EDITOR_FENCING_REJECTED: active fence inventory quota exceeded")
		}
	}
	if err == nil && (prior.Version != 1 || req.Identity.FencingToken < prior.Token) {
		return fmt.Errorf("EDITOR_FENCING_REJECTED: stale editor fence")
	}
	if err == nil && req.Identity.FencingToken == prior.Token {
		return nil
	}
	return e.save(path, editorFence{Version: 1, Token: req.Identity.FencingToken, Namespace: req.Namespace})
}
func editorErrorCode(err error) string {
	for _, code := range []string{"EDITOR_IDENTITY_CHANGED", "EDITOR_RUNTIME_CHANGED", "EDITOR_FENCING_REJECTED", "EDITOR_STAGE_DIGEST_MISMATCH", "EDITOR_STAGE_SEAL_FAILED", "EDITOR_PROVIDER_UNSUPPORTED"} {
		if strings.HasPrefix(err.Error(), code+":") {
			return code
		}
	}
	return "EDITOR_APPLY_REJECTED"
}

func (e *EditorEngine) apply(ctx context.Context, req EditorApplyRequest) (any, error) {
	if err := editorBinding(req.Namespace, req.ResourceKey); err != nil {
		return nil, err
	}
	if !editorValidKey(req.OperationID) || !editorValidDigest(req.RequestDigest) || req.ExpectedRawHash != nil && !editorValidDigest(*req.ExpectedRawHash) {
		return nil, fmt.Errorf("invalid editor operation/digest")
	}
	encoded, _ := json.Marshal(req)
	fingerprint := editorDigest(encoded)
	prior, err := e.loadReceipt(req.Namespace, req.ResourceKey, req.OperationID, req.RequestDigest)
	if err == nil {
		if prior.Fingerprint != fingerprint {
			return nil, fmt.Errorf("EDITOR_APPLY_REJECTED: operation request differs")
		}
		return *prior.Result, nil
	}
	if !os.IsNotExist(err) {
		return nil, err
	}
	_, _, receipts, err := e.inventory()
	if err != nil {
		return nil, err
	}
	if receipts >= editorMaxReceipts {
		return nil, fmt.Errorf("editor receipt quota exceeded (no dispatch)")
	}
	s, err := e.readStage(req.Namespace, req.ResourceKey, req.StageID)
	if err != nil {
		return nil, err
	}
	if !editorValidDigest(s.RawDigest) {
		return nil, fmt.Errorf("EDITOR_STAGE_SEAL_FAILED: stage not sealed")
	}
	r := editorReceipt{Version: 1, Request: req, Fingerprint: fingerprint, State: "intent"}
	receiptPath := e.receiptPath(req.Namespace, req.OperationID)
	if err = e.save(receiptPath, &r); err != nil {
		return nil, err
	}
	if err = e.inject("intent"); err != nil {
		return nil, err
	}
	s.OperationID = req.OperationID
	if err = e.save(e.stagePath(s.StageID), s); err != nil {
		return nil, err
	}
	finish := func(result *EditorApplyResult) (any, error) {
		r.State = result.Outcome
		r.Result = result
		if err := e.save(receiptPath, &r); err != nil {
			return nil, err
		}
		return *result, nil
	}
	reject := func(err error) (any, error) {
		return finish(editorFailure(req.OperationID, "rejected", editorErrorCode(err), "editor replacement rejected before dispatch"))
	}
	if req.MetadataPolicy != "preserve" {
		return reject(fmt.Errorf("EDITOR_PROVIDER_UNSUPPORTED: metadata policy unsupported"))
	}
	if err = e.verifyIdentity(req.Identity); err != nil {
		return reject(err)
	}
	if err = e.fence(req); err != nil {
		return reject(err)
	}
	path := req.Identity.CanonicalPath
	parentInfo, err := os.Stat(filepath.Dir(path))
	if err != nil {
		return reject(err)
	}
	var originalInfo os.FileInfo
	var metadata conditionalMetadata
	check := func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := e.verifyIdentity(req.Identity); err != nil {
			return err
		}
		parent, err := os.Stat(filepath.Dir(path))
		if err != nil {
			return err
		}
		if !parent.IsDir() || !os.SameFile(parentInfo, parent) {
			return fmt.Errorf("EDITOR_IDENTITY_CHANGED: parent replaced")
		}
		f, info, _, err := e.h.OpenEditorReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			if req.ExpectedRawHash != nil || originalInfo != nil {
				return fmt.Errorf("EDITOR_IDENTITY_CHANGED: expected source missing")
			}
			return nil
		}
		if err != nil {
			return err
		}
		defer f.Close()
		if req.ExpectedRawHash == nil {
			return fmt.Errorf("EDITOR_IDENTITY_CHANGED: expected absent target exists")
		}
		if err = validateEditorSourceWritable(f); err != nil {
			return err
		}
		digest, _, err := hashEditorFile(ctx, f)
		if err != nil {
			return err
		}
		if digest != *req.ExpectedRawHash {
			return fmt.Errorf("EDITOR_IDENTITY_CHANGED: raw baseline changed")
		}
		if err = e.h.VerifyEditorReadFile(path, f, info); err != nil {
			return err
		}
		if originalInfo != nil {
			if !os.SameFile(originalInfo, info) {
				return fmt.Errorf("EDITOR_IDENTITY_CHANGED: source replaced")
			}
			return metadata.matches(f)
		}
		metadata, err = captureConditionalMetadata(f, ctx)
		if err != nil {
			return err
		}
		originalInfo = info
		return nil
	}
	if err = check(); err != nil {
		return reject(err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".nf-editor-*")
	if err != nil {
		return reject(err)
	}
	tmpInfo, err := tmp.Stat()
	if err != nil {
		tmp.Close()
		return reject(err)
	}
	defer func() { tmp.Close(); _ = removeConditionalTemporary(tmp.Name(), tmpInfo) }()
	r.TemporaryPath = tmp.Name()
	r.TemporaryIdentity, err = editorFileIdentity(tmp, tmpInfo)
	if err != nil {
		return reject(err)
	}
	// Record the empty preparation object before any body bytes are written.
	if err = e.save(receiptPath, &r); err != nil {
		return nil, err
	}
	body, err := os.Open(e.bodyPath(s.StageID))
	if err != nil {
		return reject(err)
	}
	defer body.Close()
	// Fixed-buffer copy and seal verification; no whole-body transport collection.
	hash := sha256.New()
	buffer := make([]byte, EditorChunkBytes)
	var size int64
	for {
		if err = ctx.Err(); err != nil {
			return reject(err)
		}
		n, readErr := body.Read(buffer)
		size += int64(n)
		if size > s.Size || size > EditorMaxBytes {
			return reject(fmt.Errorf("EDITOR_STAGE_SEAL_FAILED: body grew"))
		}
		if n > 0 {
			hash.Write(buffer[:n])
			if _, err = tmp.Write(buffer[:n]); err != nil {
				return reject(err)
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return reject(readErr)
		}
		if n == 0 {
			return reject(io.ErrNoProgress)
		}
	}
	if size != s.Size || hex.EncodeToString(hash.Sum(nil)) != s.RawDigest {
		return reject(fmt.Errorf("EDITOR_STAGE_SEAL_FAILED: sealed body changed"))
	}
	if metadata != nil {
		if err = metadata.apply(tmp); err != nil {
			return reject(err)
		}
		if err = verifyEditorPreparedMetadata(metadata, tmp); err != nil {
			return reject(err)
		}
	} else {
		if err = tmp.Chmod(0o644); err != nil {
			return reject(err)
		}
		// New files must satisfy the same native volume/type/metadata safety
		// matrix; absence is not a bypass of unsupported filesystem checks.
		if _, err = captureConditionalMetadata(tmp, ctx); err != nil {
			return reject(err)
		}
	}
	if err = tmp.Sync(); err != nil {
		return reject(err)
	}
	if err = tmp.Close(); err != nil {
		return reject(err)
	}
	if err = e.inject("prepared"); err != nil {
		return nil, err
	}
	if err = check(); err != nil {
		return reject(err)
	}
	if err = e.fence(req); err != nil {
		return reject(err)
	}
	if err = ctx.Err(); err != nil {
		return reject(err)
	}
	// Point of no cancellation: applying is durable before entering native replace.
	// A disconnect/cancel after this point cannot turn a possible write into reject.
	r.State = "applying"
	if err = e.save(receiptPath, &r); err != nil {
		return nil, err
	}
	if err = e.inject("applying"); err != nil {
		return nil, err
	}
	if err = commitEditorReplacement(path, tmp.Name(), originalInfo, metadata, s.RawDigest, s.Size); err != nil {
		return finish(editorFailure(req.OperationID, "uncertain", "EDITOR_UNCERTAIN", "native replacement did not produce a durable success receipt"))
	}
	if err = e.inject("renamed"); err != nil {
		return nil, err
	}
	if err = syncEditorDirectory(filepath.Dir(path)); err != nil {
		return finish(editorFailure(req.OperationID, "uncertain", "EDITOR_UNCERTAIN", "target directory durability could not be established"))
	}
	if err = e.inject("receipt"); err != nil {
		return nil, err
	}
	result := &EditorApplyResult{OperationID: req.OperationID, Outcome: "committed", RawDigest: &s.RawDigest, TotalBytes: &s.Size}
	return finish(result)
}

func (e *EditorEngine) query(req EditorQueryRequest) (any, error) {
	if err := editorBinding(req.Namespace, req.ResourceKey); err != nil {
		return nil, err
	}
	if !editorValidKey(req.OperationID) || !editorValidDigest(req.RequestDigest) {
		return nil, fmt.Errorf("invalid editor query")
	}
	r, err := e.loadReceipt(req.Namespace, req.ResourceKey, req.OperationID, req.RequestDigest)
	if errors.Is(err, os.ErrNotExist) {
		return EditorQueryResult{OperationID: req.OperationID, Outcome: "not_found"}, nil
	}
	if err != nil {
		return nil, err
	}
	if req.AcknowledgeTerminal {
		if r.State != "committed" && r.State != "rejected" {
			return nil, fmt.Errorf("cannot acknowledge non-terminal editor proof")
		}
		if r.AcknowledgedAt == 0 {
			r.AcknowledgedAt = time.Now().UnixMilli()
			if err = e.save(e.receiptPath(req.Namespace, req.OperationID), r); err != nil {
				return nil, err
			}
		}
	}
	return EditorQueryResult{OperationID: req.OperationID, Outcome: r.State, Result: r.Result}, nil
}
