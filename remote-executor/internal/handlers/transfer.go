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
	"sync"

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
	transferId string
	direction  string // "download" (executor sends) | "upload" (executor receives)
	path       string
	partPath   string
	chunkSize  int64
	totalChunks int
	fileSize   int64
	verify     string

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
	mu       sync.Mutex
	sessions map[string]*transferSession
	// backpressure high-water mark in bytes.
	highWater int
}

func NewTransfers(h *Handlers, sender BinarySender) *Transfers {
	return &Transfers{
		h:         h,
		sender:    sender,
		sessions:  map[string]*transferSession{},
		highWater: 8 * 1024 * 1024,
	}
}

// TransferStat returns file/dir metadata, optionally recursively enumerating a
// dir. It lives on Handlers (no binary sender needed) so the dispatcher can call
// it without a per-connection Transfers instance.
func (h *Handlers) TransferStat(params map[string]any) (any, error) {
	path, err := h.guardedPath(params, "path")
	if err != nil {
		return nil, err
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
		rel, _ := filepath.Rel(path, p)
		entries = append(entries, map[string]any{
			"relPath":     filepath.ToSlash(rel),
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
	remotePath, err := t.h.guardedPath(params, "remotePath")
	if err != nil {
		return nil, err
	}
	chunkSize := intParam(params, "chunkSize", 1024*1024)
	totalChunks := int(intParam(params, "totalChunks", 0))
	fileSize := intParam(params, "fileSize", 0)
	verify := stringParam(params, "verify")

	sessCtx, sessCancel := context.WithCancel(context.Background())
	sess := &transferSession{
		transferId:  transferId,
		direction:   direction,
		path:        remotePath,
		chunkSize:   chunkSize,
		totalChunks: totalChunks,
		fileSize:    fileSize,
		verify:      verify,
		ctx:         sessCtx,
		cancel:      sessCancel,
		received:    map[int]bool{},
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
		t.register(sess)
		// Kick off sending in the background under the session ctx; the terminal
		// RPC result is the begin ack, so we don't block it on the whole transfer.
		go t.sendFile(sess.ctx, sess)

	case "upload":
		// Executor receives the file. Open .part for random-access writes.
		sess.partPath = remotePath + ".nfpart"
		if mkErr := os.MkdirAll(filepath.Dir(remotePath), 0o755); mkErr != nil {
			sessCancel()
			return nil, mkErr
		}
		f, openErr := os.OpenFile(sess.partPath, os.O_RDWR|os.O_CREATE, 0o644)
		if openErr != nil {
			sessCancel()
			return nil, openErr
		}
		sess.recvFile = f
		// Resume: if a matching manifest + .part exist, report already-received
		// chunks so the sender can skip them.
		if m := loadManifest(remotePath, chunkSize, fileSize); m != nil {
			for _, idx := range m.CompletedChunks {
				sess.received[idx] = true
			}
			completed = m.CompletedChunks
		}
		t.register(sess)

	default:
		sessCancel()
		return nil, fmt.Errorf("unknown transfer direction %q", direction)
	}

	return map[string]any{"completedChunks": completed, "restarted": false}, nil
}

func (t *Transfers) register(sess *transferSession) {
	t.mu.Lock()
	t.sessions[sess.transferId] = sess
	t.mu.Unlock()
}

func (t *Transfers) get(transferId string) *transferSession {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.sessions[transferId]
}

func (t *Transfers) remove(transferId string) *transferSession {
	t.mu.Lock()
	defer t.mu.Unlock()
	sess := t.sessions[transferId]
	delete(t.sessions, transferId)
	if sess != nil && sess.cancel != nil {
		sess.cancel()
	}
	return sess
}

// sendFile reads the source file and pushes chunk frames (download direction).
func (t *Transfers) sendFile(ctx context.Context, sess *transferSession) {
	f, err := os.Open(sess.path)
	if err != nil {
		return
	}
	defer f.Close()

	for i := 0; i < sess.totalChunks; i++ {
		if ctx.Err() != nil {
			return
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
			if ctx.Err() != nil {
				return
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
	if sess == nil || sess.recvFile == nil {
		return
	}
	sess.recvMu.Lock()
	defer sess.recvMu.Unlock()
	if sess.received[chunkIndex] {
		return
	}
	offset := int64(chunkIndex) * sess.chunkSize
	if _, err := sess.recvFile.WriteAt(payload, offset); err != nil {
		return
	}
	sess.received[chunkIndex] = true

	// Persist the resume manifest periodically (every 32 chunks) and fsync so a
	// crash mid-transfer leaves a recoverable state. Cheap relative to the write.
	if len(sess.received)%32 == 0 {
		_ = sess.recvFile.Sync()
		saveManifest(sess.path, sess.chunkSize, sess.fileSize, sess.received)
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
	sess := t.remove(transferId)
	if sess == nil {
		return map[string]any{"ok": true, "fileSize": 0}, nil
	}

	if sess.direction != "upload" {
		return map[string]any{"ok": true, "fileSize": sess.fileSize}, nil
	}

	if sess.recvFile != nil {
		_ = sess.recvFile.Sync()
		_ = sess.recvFile.Close()
	}

	info, statErr := os.Stat(sess.partPath)
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

	if wantHash := stringParam(params, "sha256"); wantHash != "" {
		got, hashErr := hashFileSha256(sess.partPath)
		if hashErr != nil {
			return map[string]any{"ok": false, "fileSize": info.Size(), "error": hashErr.Error()}, nil
		}
		if got != wantHash {
			return map[string]any{"ok": false, "fileSize": info.Size(), "error": "sha256 mismatch"}, nil
		}
	}

	if renErr := os.Rename(sess.partPath, sess.path); renErr != nil {
		return map[string]any{"ok": false, "fileSize": info.Size(), "error": renErr.Error()}, nil
	}
	removeManifest(sess.path)
	return map[string]any{"ok": true, "fileSize": info.Size()}, nil
}

// Abort cancels a transfer and cleans up the .part file.
func (t *Transfers) Abort(params map[string]any) (any, error) {
	transferId := stringParam(params, "transferId")
	sess := t.remove(transferId)
	if sess == nil {
		return map[string]any{}, nil
	}
	if sess.recvFile != nil {
		_ = sess.recvFile.Close()
		_ = os.Remove(sess.partPath)
		removeManifest(sess.path)
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

func hashFileSha256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
