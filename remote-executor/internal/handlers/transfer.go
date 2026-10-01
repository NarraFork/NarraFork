package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/narrafork/remote-executor/internal/wire"
)

// crc32cTable is the Castagnoli table, matching the server's crc32c.ts.
var crc32cTable = crc32.MakeTable(crc32.Castagnoli)

// BinarySender lets the transfer handler push binary chunk frames back to the
// server. Provided by the transport layer.
type BinarySender interface {
	SendBinary(frame []byte) error
	// BufferedAmount reports the outbound send-buffer size for backpressure.
	BufferedAmount() int
}

// transferSession tracks one in-flight transfer on the executor side.
type transferSession struct {
	transferId      string
	direction       string // "download" (executor sends) | "upload" (executor receives)
	path            string
	partPath        string
	manifestPath    string
	manifestTmpPath string
	chunkSize       int64
	totalChunks     int
	fileSize        int64
	verify          string
	contentIdentity transferContentIdentity

	// Transfer-scoped cancellation, independent of the begin RPC's lifetime.
	ctx    context.Context
	cancel context.CancelFunc

	// Receiver (upload) state.
	recvFile *os.File
	received map[int]bool
	recvMu   sync.Mutex
}

// Transfers holds active sessions and the binary sender. A single Transfers is
// shared by the connection.
type Transfers struct {
	h        *Handlers
	sender   BinarySender
	ctx      context.Context
	mu       sync.Mutex
	sessions map[string]*transferSession
	closed   bool
	// backpressure high-water mark in bytes.
	highWater int
}

func NewTransfers(h *Handlers, sender BinarySender) *Transfers {
	return NewTransfersWithContext(context.Background(), h, sender)
}

// NewTransfersWithContext creates a transfer manager bound to one transport
// connection. Cancelling ctx stops download senders; Close persists upload
// checkpoints and releases all session resources.
func NewTransfersWithContext(ctx context.Context, h *Handlers, sender BinarySender) *Transfers {
	return &Transfers{
		h:         h,
		sender:    sender,
		ctx:       ctx,
		sessions:  map[string]*transferSession{},
		highWater: 8 * 1024 * 1024,
	}
}

func requiredAbsoluteTransferPath(params map[string]any, key string) (string, error) {
	raw, err := requiredPathParam(params, key)
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(raw) {
		return "", fmt.Errorf("invalid remote path %q: must be absolute for the executor platform", raw)
	}
	return raw, nil
}

func validateTransferRelPath(rel string) (string, error) {
	if rel == "" {
		return "", fmt.Errorf("invalid transfer manifest relPath: empty path")
	}
	clean := filepath.Clean(rel)
	if filepath.IsAbs(clean) || filepath.VolumeName(clean) != "" {
		return "", fmt.Errorf("invalid transfer manifest relPath %q: must be relative", rel)
	}
	for _, segment := range strings.FieldsFunc(rel, func(r rune) bool { return r == '/' || r == '\\' }) {
		if segment == ".." {
			return "", fmt.Errorf("invalid transfer manifest relPath %q: contains path traversal", rel)
		}
	}
	return filepath.ToSlash(clean), nil
}

// TransferStat returns file/dir metadata, optionally recursively enumerating a
// dir. It lives on Handlers (no binary sender needed) so the dispatcher can call
// it without a per-connection Transfers instance.
func (h *Handlers) TransferStat(params map[string]any) (any, error) {
	rawPath, err := requiredAbsoluteTransferPath(params, "path")
	if err != nil {
		return nil, err
	}
	path, err := h.guard.CheckCreate(rawPath)
	if err != nil {
		return nil, fmt.Errorf("invalid remote path %q: %w", rawPath, err)
	}
	info, statErr := os.Lstat(path)
	if statErr != nil {
		if os.IsNotExist(statErr) {
			return map[string]any{"exists": false, "isDirectory": false, "size": 0, "mtimeMs": 0}, nil
		}
		return nil, statErr
	}
	if !info.IsDir() || !boolParam(params, "recursive") {
		return map[string]any{
			"exists":      true,
			"isDirectory": info.IsDir(),
			"size":        info.Size(),
			"mtimeMs":     info.ModTime().UnixMilli(),
		}, nil
	}

	maxEntries := int(intParam(params, "maxEntries", 50000))
	entries := make([]map[string]any, 0, 128)
	truncated := false
	walkErr := filepath.Walk(path, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return nil // skip unreadable entries
		}
		if fi.IsDir() {
			return nil
		}
		if len(entries) >= maxEntries {
			truncated = true
			return io.EOF // stop walking
		}
		rel, relErr := filepath.Rel(path, p)
		if relErr != nil {
			return fmt.Errorf("build transfer manifest path for %q: %w", p, relErr)
		}
		rel, relErr = validateTransferRelPath(rel)
		if relErr != nil {
			return relErr
		}
		entries = append(entries, map[string]any{
			"relPath":     rel,
			"size":        fi.Size(),
			"mtimeMs":     fi.ModTime().UnixMilli(),
			"isDirectory": false,
		})
		return nil
	})
	if walkErr != nil && walkErr != io.EOF {
		return nil, walkErr
	}
	return map[string]any{
		"exists":      true,
		"isDirectory": true,
		"size":        info.Size(),
		"mtimeMs":     info.ModTime().UnixMilli(),
		"entries":     entries,
		"truncated":   truncated,
	}, nil
}

// Begin starts a transfer session. For "download" the executor is the sender
// and immediately starts pushing chunk frames in a goroutine. For "upload" the
// executor is the receiver and opens the .part file.
//
// The passed ctx bounds only the begin RPC itself; the transfer runs under its
// own session context so streaming survives after begin returns.
func (t *Transfers) Begin(_ context.Context, params map[string]any) (any, error) {
	transferId := stringParam(params, "transferId")
	direction := stringParam(params, "direction")
	rawRemotePath, err := requiredAbsoluteTransferPath(params, "remotePath")
	if err != nil {
		return nil, err
	}
	var remotePath string
	switch direction {
	case "download":
		remotePath, err = t.h.guard.CheckExisting(rawRemotePath)
	case "upload":
		remotePath, err = t.h.guard.CheckCreate(rawRemotePath)
	default:
		return nil, fmt.Errorf("unknown transfer direction %q", direction)
	}
	if err != nil {
		return nil, fmt.Errorf("invalid remote path %q: %w", rawRemotePath, err)
	}
	chunkSize := intParam(params, "chunkSize", 1024*1024)
	totalChunks := int(intParam(params, "totalChunks", 0))
	fileSize := intParam(params, "fileSize", 0)
	verify := stringParam(params, "verify")
	contentIdentity := contentIdentityParam(params)

	sessCtx, sessCancel := context.WithCancel(t.ctx)
	sess := &transferSession{
		transferId:      transferId,
		direction:       direction,
		path:            remotePath,
		chunkSize:       chunkSize,
		totalChunks:     totalChunks,
		fileSize:        fileSize,
		verify:          verify,
		contentIdentity: contentIdentity,
		ctx:             sessCtx,
		cancel:          sessCancel,
		received:        map[int]bool{},
	}

	completed := []int{}

	switch direction {
	case "download":
		// Executor sends the file. Verify it exists and is readable.
		info, statErr := os.Stat(remotePath)
		if statErr != nil {
			sessCancel()
			return nil, statErr
		}
		sess.fileSize = info.Size()
		if rawCompleted, ok := params["completedChunks"].([]any); ok {
			for _, raw := range rawCompleted {
				if value, ok := raw.(float64); ok {
					idx := int(value)
					if idx >= 0 && idx < sess.totalChunks {
						sess.received[idx] = true
					}
				}
			}
		}
		if registerErr := t.register(sess); registerErr != nil {
			sessCancel()
			return nil, registerErr
		}
		// Kick off sending in the background under the session ctx; the terminal
		// RPC result is the begin ack, so we don't block it on the whole transfer.
		go t.sendFile(sess.ctx, sess)

	case "upload":
		// Executor receives the file. Validate every derived sidecar path before
		// opening it, since a pre-created sidecar symlink could otherwise escape.
		sess.partPath, err = t.h.guard.CheckCreate(remotePath + ".nfpart")
		if err == nil {
			sess.manifestPath, err = t.h.guard.CheckCreate(remotePath + ".nfmeta")
		}
		if err == nil {
			sess.manifestTmpPath, err = t.h.guard.CheckCreate(remotePath + ".nfmeta.tmp")
		}
		if err != nil {
			sessCancel()
			return nil, err
		}
		if mkErr := os.MkdirAll(filepath.Dir(remotePath), 0o755); mkErr != nil {
			sessCancel()
			return nil, mkErr
		}
		_, partStatErr := os.Stat(sess.partPath)
		_, manifestStatErr := os.Stat(sess.manifestPath)
		hadSidecars := partStatErr == nil || manifestStatErr == nil
		manifest := loadManifest(sess.manifestPath, chunkSize, fileSize, contentIdentity)
		if manifest == nil {
			removeManifest(sess.manifestPath)
			_ = os.Remove(sess.manifestTmpPath)
		}

		f, openErr := os.OpenFile(sess.partPath, os.O_RDWR|os.O_CREATE, 0o644)
		if openErr != nil {
			sessCancel()
			return nil, openErr
		}
		sess.recvFile = f
		if manifest == nil {
			if truncateErr := f.Truncate(0); truncateErr != nil {
				_ = f.Close()
				sessCancel()
				return nil, truncateErr
			}
		} else {
			for _, idx := range manifest.CompletedChunks {
				if idx >= 0 && idx < totalChunks {
					sess.received[idx] = true
					completed = append(completed, idx)
				}
			}
		}
		if registerErr := t.register(sess); registerErr != nil {
			_ = f.Close()
			sess.recvFile = nil
			sessCancel()
			return nil, registerErr
		}
		return map[string]any{
			"completedChunks": completed,
			"restarted":       manifest == nil && hadSidecars,
		}, nil
	}

	return map[string]any{"completedChunks": completed, "restarted": false}, nil
}

func (t *Transfers) register(sess *transferSession) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return fmt.Errorf("transfer manager is closed")
	}
	if _, exists := t.sessions[sess.transferId]; exists {
		return fmt.Errorf("transfer %q already exists", sess.transferId)
	}
	t.sessions[sess.transferId] = sess
	return nil
}

func (t *Transfers) get(transferId string) *transferSession {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.sessions[transferId]
}

func (t *Transfers) take(transferId string) *transferSession {
	t.mu.Lock()
	defer t.mu.Unlock()
	sess := t.sessions[transferId]
	if sess != nil {
		delete(t.sessions, transferId)
	}
	return sess
}

func (t *Transfers) removeOwned(sess *transferSession) {
	t.mu.Lock()
	if t.sessions[sess.transferId] == sess {
		delete(t.sessions, sess.transferId)
	}
	t.mu.Unlock()
	sess.cancel()
}

// Close cancels every active session owned by this connection. Uploads retain
// their .nfpart file and a current manifest so a later connection can resume;
// download goroutines are cancelled and can no longer use the old sender.
func (t *Transfers) Close() {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return
	}
	t.closed = true
	sessions := make([]*transferSession, 0, len(t.sessions))
	for id, sess := range t.sessions {
		sessions = append(sessions, sess)
		delete(t.sessions, id)
	}
	t.mu.Unlock()

	for _, sess := range sessions {
		sess.cancel()
		if sess.direction != "upload" || sess.recvFile == nil {
			continue
		}
		sess.recvMu.Lock()
		_ = sess.recvFile.Sync()
		saveManifest(
			sess.manifestPath,
			sess.manifestTmpPath,
			sess.chunkSize,
			sess.fileSize,
			sess.contentIdentity,
			sess.received,
		)
		_ = sess.recvFile.Close()
		sess.recvFile = nil
		sess.recvMu.Unlock()
	}
}

// sendFile reads the source file and pushes chunk frames (download direction).
func (t *Transfers) sendFile(ctx context.Context, sess *transferSession) {
	defer t.removeOwned(sess)
	path, err := t.h.guard.CheckExisting(sess.path)
	if err != nil {
		return
	}
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	for i := 0; i < sess.totalChunks; i++ {
		if ctx.Err() != nil {
			return
		}
		if sess.received[i] {
			continue
		}
		offset := int64(i) * sess.chunkSize
		length := sess.chunkSize
		if remaining := sess.fileSize - offset; remaining < length {
			length = remaining
		}
		buf := make([]byte, length)
		if _, readErr := f.ReadAt(buf, offset); readErr != nil && readErr != io.EOF {
			return
		}
		// Backpressure: wait for the send buffer to drain.
		for t.sender.BufferedAmount() > t.highWater {
			select {
			case <-ctx.Done():
				return
			case <-time.After(5 * time.Millisecond):
			}
		}
		frame, frameErr := wire.EncodeChunkFrame(
			wire.ChunkFrameHeader{TransferID: sess.transferId, ChunkIndex: i},
			buf,
		)
		if frameErr != nil {
			return
		}
		if sendErr := t.sender.SendBinary(frame); sendErr != nil {
			return
		}
	}
}

// WriteChunk handles an inbound chunk frame (upload direction).
func (t *Transfers) WriteChunk(transferId string, chunkIndex int, payload []byte) {
	sess := t.get(transferId)
	if sess == nil || chunkIndex < 0 || chunkIndex >= sess.totalChunks {
		return
	}
	offset := int64(chunkIndex) * sess.chunkSize
	expectedLength := sess.chunkSize
	if remaining := sess.fileSize - offset; remaining < expectedLength {
		expectedLength = remaining
	}
	if expectedLength < 0 || int64(len(payload)) != expectedLength {
		return
	}
	sess.recvMu.Lock()
	defer sess.recvMu.Unlock()
	if sess.recvFile == nil || sess.received[chunkIndex] {
		return
	}
	if _, err := sess.recvFile.WriteAt(payload, offset); err != nil {
		return
	}
	sess.received[chunkIndex] = true

	// Persist the resume manifest periodically (every 32 chunks) and fsync so a
	// crash mid-transfer leaves a recoverable state. Cheap relative to the write.
	if len(sess.received)%32 == 0 {
		_ = sess.recvFile.Sync()
		manifestPath, manifestErr := t.h.guard.CheckCreate(sess.manifestPath)
		manifestTmpPath, tmpErr := t.h.guard.CheckCreate(sess.manifestTmpPath)
		if manifestErr == nil && tmpErr == nil {
			saveManifest(
				manifestPath,
				manifestTmpPath,
				sess.chunkSize,
				sess.fileSize,
				sess.contentIdentity,
				sess.received,
			)
		}
	}
}

// Ack (download direction): the server confirms received chunks with crc32c.
// The executor could re-send on mismatch; for now we trust WS integrity and
// treat acks as progress only.
func (t *Transfers) Ack(_ map[string]any) (any, error) {
	return map[string]any{}, nil
}

// Complete finalizes a transfer. For upload the executor renames .part → dst
// and verifies size/sha256.
func (t *Transfers) Complete(params map[string]any) (any, error) {
	transferId := stringParam(params, "transferId")
	sess := t.take(transferId)
	if sess == nil {
		return map[string]any{"ok": true, "fileSize": 0}, nil
	}
	sess.cancel()

	if sess.direction != "upload" {
		return map[string]any{"ok": true, "fileSize": sess.fileSize}, nil
	}

	sess.recvMu.Lock()
	if sess.recvFile != nil {
		_ = sess.recvFile.Sync()
		_ = sess.recvFile.Close()
		sess.recvFile = nil
	}
	sess.recvMu.Unlock()

	partPath, pathErr := t.h.guard.CheckExisting(sess.partPath)
	if pathErr != nil {
		return map[string]any{"ok": false, "fileSize": 0, "error": pathErr.Error()}, nil
	}
	destinationPath, pathErr := t.h.guard.CheckCreate(sess.path)
	if pathErr != nil {
		return map[string]any{"ok": false, "fileSize": 0, "error": pathErr.Error()}, nil
	}

	info, statErr := os.Stat(partPath)
	if statErr != nil {
		return map[string]any{"ok": false, "fileSize": 0, "error": statErr.Error()}, nil
	}
	if sess.fileSize > 0 && info.Size() != sess.fileSize {
		return map[string]any{
			"ok":       false,
			"fileSize": info.Size(),
			"error":    fmt.Sprintf("size mismatch: got %d expected %d", info.Size(), sess.fileSize),
		}, nil
	}

	wantHash := stringParam(params, "sha256")
	if sess.contentIdentity.valid() {
		if wantHash != "" && wantHash != sess.contentIdentity.Digest {
			return map[string]any{
				"ok": false, "fileSize": info.Size(), "error": "content identity changed during upload",
			}, nil
		}
		wantHash = sess.contentIdentity.Digest
	}
	if wantHash != "" {
		got, hashErr := hashFileSha256(t.ctx, partPath)
		if hashErr != nil {
			return map[string]any{"ok": false, "fileSize": info.Size(), "error": hashErr.Error()}, nil
		}
		if got != wantHash {
			return map[string]any{"ok": false, "fileSize": info.Size(), "error": "sha256 mismatch"}, nil
		}
	}

	release, lockErr := acquireFileMutation(t.ctx)
	if lockErr != nil {
		return nil, lockErr
	}
	defer release()
	// Revalidate after waiting for other executor-managed file mutations.
	destinationPath, pathErr = t.h.guard.CheckCreate(sess.path)
	if pathErr != nil {
		return nil, pathErr
	}
	if renErr := os.Rename(partPath, destinationPath); renErr != nil {
		return map[string]any{"ok": false, "fileSize": info.Size(), "error": renErr.Error()}, nil
	}
	removeManifest(sess.manifestPath)
	return map[string]any{"ok": true, "fileSize": info.Size()}, nil
}

// Abort cancels a transfer. preservePartial keeps the durable checkpoint so a
// later begin request can resume with a new transfer id.
func (t *Transfers) Abort(params map[string]any) (any, error) {
	transferId := stringParam(params, "transferId")
	preserve := boolParam(params, "preservePartial")
	sess := t.take(transferId)
	if sess == nil {
		return map[string]any{}, nil
	}
	sess.cancel()
	sess.recvMu.Lock()
	if sess.recvFile != nil {
		_ = sess.recvFile.Sync()
		if preserve {
			saveManifest(
				sess.manifestPath,
				sess.manifestTmpPath,
				sess.chunkSize,
				sess.fileSize,
				sess.contentIdentity,
				sess.received,
			)
		}
		_ = sess.recvFile.Close()
		sess.recvFile = nil
	}
	sess.recvMu.Unlock()
	if !preserve {
		_ = os.Remove(sess.partPath)
		removeManifest(sess.manifestPath)
	}
	return map[string]any{}, nil
}

// completedChunksSorted returns received chunk indices in order (for resume).
func (sess *transferSession) completedChunksSorted() []int {
	sess.recvMu.Lock()
	defer sess.recvMu.Unlock()
	out := make([]int, 0, len(sess.received))
	for i := range sess.received {
		out = append(out, i)
	}
	sort.Ints(out)
	return out
}

func hashFileSha256(ctx context.Context, path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	buf := make([]byte, 256*1024) // 256 KiB per read to check ctx periodically
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		n, readErr := f.Read(buf)
		if n > 0 {
			h.Write(buf[:n])
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return "", readErr
		}
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
