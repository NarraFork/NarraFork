package rpc

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash"
	"io"
	"os"
	"sync"
	"time"

	"github.com/narrafork/remote-executor/internal/handlers"
)

const FeatureEditorRawReadV1 = "editor.raw-read.v1"
const editorReadMaxBytes int64 = 20 * 1024 * 1024
const editorReadChunkBytes int64 = 64 * 1024
const editorReadDeadline = 30 * time.Second
const editorReadIdle = 10 * time.Second

// Admission has zero queued waiters. Host scheduling owns the bounded fair queue
// and per-user limits; an executor connection is not an authenticated user.
var editorReadSlots = make(chan struct{}, 8)

type editorReads struct {
	h       *handlers.Handlers
	mu      sync.Mutex
	reads   map[string]*editorRead
	closed  bool
	binding *EditorResourceIdentity
	idle    time.Duration
}

type editorRead struct {
	open    EditorRawReadOpen
	file    *os.File
	info    os.FileInfo
	offset  int64
	digest  hash.Hash
	gate    chan struct{}
	ctx     context.Context
	cancel  context.CancelFunc
	once    sync.Once
	timerMu sync.Mutex
	idle    *time.Timer
	stopped bool
}

func newEditorReads(h *handlers.Handlers) *editorReads {
	return &editorReads{h: h, reads: make(map[string]*editorRead), idle: editorReadIdle}
}

func decodeEditorParams(params map[string]any, out any) error {
	b, err := json.Marshal(params)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, out)
}

func editorTimeout(ms int64) (time.Duration, error) {
	if ms <= 0 || ms > editorReadDeadline.Milliseconds() {
		return 0, fmt.Errorf("editor timeoutMs must be in 1..30000")
	}
	return time.Duration(ms) * time.Millisecond, nil
}

func (m *editorReads) verify(identity EditorResourceIdentity) error {
	if identity.RuntimeEpoch != handlers.EditorRuntimeEpoch() {
		return fmt.Errorf("EDITOR_RUNTIME_CHANGED: executor epoch changed")
	}
	if identity.PathFlavor != handlers.EditorPathFlavor() || identity.DeviceID == "" || identity.RuntimeGeneration < 0 || identity.FencingToken < 0 {
		return fmt.Errorf("EDITOR_IDENTITY_CHANGED: invalid resource binding")
	}
	if err := m.h.VerifyEditorRoot(identity.WorkspaceIdentity); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.bindingError(identity)
}

// Caller holds m.mu, including during admission, so concurrent first opens
// cannot latch different connection tuples.
func (m *editorReads) bindingError(identity EditorResourceIdentity) error {
	if m.closed {
		return fmt.Errorf("editor connection closed")
	}
	if m.binding != nil {
		if m.binding.DeviceID != identity.DeviceID || m.binding.RuntimeGeneration != identity.RuntimeGeneration {
			return fmt.Errorf("EDITOR_RUNTIME_CHANGED: connection binding changed")
		}
		if m.binding.FencingToken != identity.FencingToken {
			return fmt.Errorf("EDITOR_FENCING_REJECTED: connection fencing changed")
		}
	}
	return nil
}

func (m *editorReads) open(ctx context.Context, req EditorRawReadPreflight) (any, error) {
	started := time.Now()
	timeout, err := editorTimeout(req.TimeoutMs)
	if err != nil {
		return nil, err
	}
	if req.MaxBytes <= 0 || req.MaxBytes > editorReadMaxBytes || req.ResourceKey == "" {
		return nil, fmt.Errorf("invalid editor read budget or resource key")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := m.verify(req.Identity); err != nil {
		return nil, err
	}
	select {
	case editorReadSlots <- struct{}{}:
	default:
		return nil, fmt.Errorf("editor read stream capacity exceeded")
	}
	f, info, object, err := m.h.OpenEditorReadFile(req.Identity.CanonicalPath)
	if err != nil {
		<-editorReadSlots
		return nil, err
	}
	lifetime, cancel := context.WithDeadline(context.Background(), started.Add(timeout))
	var id [24]byte
	if _, err := rand.Read(id[:]); err != nil {
		f.Close()
		cancel()
		<-editorReadSlots
		return nil, err
	}
	r := &editorRead{open: EditorRawReadOpen{ReadID: hex.EncodeToString(id[:]), Identity: req.Identity, TotalBytes: info.Size()},
		file: f, info: info, digest: sha256.New(), gate: make(chan struct{}, 1), ctx: lifetime, cancel: cancel}
	m.mu.Lock()
	if err := m.bindingError(req.Identity); err != nil {
		m.mu.Unlock()
		f.Close()
		cancel()
		<-editorReadSlots
		return nil, err
	}
	// Latch only the host-owned connection tuple, not the root/path: one connection
	// legitimately serves multiple authorized workspaces and paths.
	if m.binding == nil {
		identity := req.Identity
		m.binding = &identity
	}
	m.reads[r.open.ReadID] = r
	m.mu.Unlock()
	context.AfterFunc(lifetime, func() { m.remove(r) })
	// Cancelling an open request closes its unpublished handle, but successful
	// request completion does not cancel the consumer-owned stream lifetime.
	stop := context.AfterFunc(ctx, func() { m.remove(r) })
	success := false
	defer func() {
		stop()
		if !success {
			m.remove(r)
		}
	}()
	if info.Size() < 0 || info.Size() > req.MaxBytes {
		return nil, fmt.Errorf("editor source exceeds maxBytes")
	}
	digest, total, err := hashEditorSource(ctx, lifetime, f, req.MaxBytes)
	if err != nil {
		return nil, err
	}
	if total != info.Size() {
		return nil, fmt.Errorf("EDITOR_IDENTITY_CHANGED: preflight byte count changed")
	}
	if err := m.check(r); err != nil {
		return nil, err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	r.open.RawDigest = digest
	version := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d\x00%d\x00%s", object, info.Size(), info.ModTime().UnixNano(), digest)))
	r.open.SourceGeneration = hex.EncodeToString(version[:])
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !stop() {
		return nil, ctx.Err()
	}
	if err := lifetime.Err(); err != nil {
		return nil, err
	}
	m.resetIdle(r)
	success = true
	return r.open, nil
}

func hashEditorSource(ctx, lifetime context.Context, f *os.File, max int64) (string, int64, error) {
	digest := sha256.New()
	var buffer [64 * 1024]byte
	var total int64
	for {
		if err := ctx.Err(); err != nil {
			return "", total, err
		}
		if err := lifetime.Err(); err != nil {
			return "", total, err
		}
		n, err := f.Read(buffer[:])
		total += int64(n)
		if total > max {
			return "", total, fmt.Errorf("editor source exceeds maxBytes")
		}
		digest.Write(buffer[:n])
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", total, err
		}
	}
	return hex.EncodeToString(digest.Sum(nil)), total, nil
}

func (m *editorReads) check(r *editorRead) error {
	if err := r.ctx.Err(); err != nil {
		return err
	}
	if err := m.verify(r.open.Identity); err != nil {
		return err
	}
	return m.h.VerifyEditorReadFile(r.open.Identity.CanonicalPath, r.file, r.info)
}

func (m *editorReads) resetIdle(r *editorRead) {
	r.timerMu.Lock()
	defer r.timerMu.Unlock()
	if r.stopped {
		return
	}
	if r.idle == nil {
		r.idle = time.AfterFunc(m.idle, func() { m.remove(r) })
	} else {
		r.idle.Reset(m.idle)
	}
}

func (m *editorReads) remove(r *editorRead) {
	r.once.Do(func() {
		r.timerMu.Lock()
		r.stopped = true
		if r.idle != nil {
			r.idle.Stop()
		}
		r.timerMu.Unlock()
		r.cancel()
		r.file.Close()
		m.mu.Lock()
		delete(m.reads, r.open.ReadID)
		m.mu.Unlock()
		<-editorReadSlots
	})
}

func (m *editorReads) chunk(parent context.Context, req EditorRawReadChunkRequest) (any, error) {
	m.mu.Lock()
	r := m.reads[req.ReadID]
	m.mu.Unlock()
	if r == nil {
		return nil, fmt.Errorf("EDITOR_NOT_FOUND: read handle not owned by this connection")
	}
	success := false
	defer func() {
		if !success {
			m.remove(r)
		}
	}()
	timeout, err := editorTimeout(req.TimeoutMs)
	if err != nil {
		return nil, err
	}
	if req.MaxBytes <= 0 || req.MaxBytes > editorReadChunkBytes {
		return nil, fmt.Errorf("editor chunk credit must be in 1..65536")
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	select {
	case r.gate <- struct{}{}:
	default:
		return nil, fmt.Errorf("editor read already has an active pull")
	}
	defer func() { <-r.gate }()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if req.Offset != r.offset {
		return nil, fmt.Errorf("editor chunk offset must equal %d", r.offset)
	}
	if err := m.check(r); err != nil {
		return nil, err
	}
	stop := context.AfterFunc(ctx, func() { m.remove(r) })
	defer stop()
	credit := min(req.MaxBytes, r.open.TotalBytes-r.offset)
	buffer := make([]byte, int(credit))
	n, err := io.ReadFull(r.file, buffer)
	if err != nil {
		return nil, fmt.Errorf("EDITOR_IDENTITY_CHANGED: incomplete source: %w", err)
	}
	r.digest.Write(buffer[:n])
	chunk := EditorRawReadChunk{ReadID: r.open.ReadID, SourceGeneration: r.open.SourceGeneration,
		Offset: r.offset, Bytes: int64(n), DataB64: base64.StdEncoding.EncodeToString(buffer[:n])}
	r.offset += int64(n)
	if r.offset == r.open.TotalBytes {
		var extra [1]byte
		n, err := r.file.Read(extra[:])
		if n != 0 || err != io.EOF || hex.EncodeToString(r.digest.Sum(nil)) != r.open.RawDigest {
			return nil, fmt.Errorf("EDITOR_IDENTITY_CHANGED: final raw digest or byte count changed")
		}
		if err := m.check(r); err != nil {
			return nil, err
		}
		// Recheck the current source, not only the bytes already delivered: an
		// external writer may have changed an earlier chunk and restored mtime.
		if _, err := r.file.Seek(0, io.SeekStart); err != nil {
			return nil, err
		}
		currentDigest, total, err := hashEditorSource(ctx, r.ctx, r.file, r.open.TotalBytes)
		if err != nil {
			return nil, err
		}
		if total != r.open.TotalBytes || currentDigest != r.open.RawDigest {
			return nil, fmt.Errorf("EDITOR_IDENTITY_CHANGED: current source digest changed")
		}
		if err := m.check(r); err != nil {
			return nil, err
		}
		chunk.EOF = true
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !stop() {
		return nil, ctx.Err()
	}
	if err := r.ctx.Err(); err != nil {
		return nil, err
	}
	if chunk.EOF {
		m.remove(r)
	} else {
		m.resetIdle(r)
	}
	success = true
	return chunk, nil
}

func (m *editorReads) closeRead(req EditorRawReadClose) (any, error) {
	m.mu.Lock()
	r := m.reads[req.ReadID]
	m.mu.Unlock()
	if r != nil {
		m.remove(r)
	}
	return map[string]any{"ok": true}, nil
}

func (m *editorReads) close() {
	m.mu.Lock()
	m.closed = true
	reads := make([]*editorRead, 0, len(m.reads))
	for _, r := range m.reads {
		reads = append(reads, r)
	}
	m.mu.Unlock()
	for _, r := range reads {
		m.remove(r)
	}
}
