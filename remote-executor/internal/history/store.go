package history

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
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/narrafork/remote-executor/internal/windowsbackup"
)

type Guard func(path string, create bool) (string, error)

// FileIncarnation is an observed OS object witness, never a caller-generated ID.
func FileIncarnation(path string) (string, error) { return rootIdentity(path) }

// ValidateBindingSnapshot is used inside the platform mutation lock, avoiding
// lock inversion with the history IO gate while rechecking durable root/fence.
func (m *Manager) ValidateBindingSnapshot(b Binding, historical bool) error {
	if historical {
		return m.validateHistorical(b)
	}
	return m.validate(b)
}

func (m *Manager) ValidateBinding(ctx context.Context, b Binding, historical bool) error {
	if err := m.acquire(ctx); err != nil {
		return err
	}
	defer m.release()
	if historical {
		return m.validateHistorical(b)
	}
	return m.validate(b)
}

type Manager struct {
	mu             sync.Mutex
	configMu       sync.RWMutex
	objectMu       sync.Mutex
	captureQueue   chan struct{}
	captureSlots   chan struct{}
	captureActive  map[string]bool
	captureStop    context.CancelFunc
	captureContext context.Context
	captureWG      sync.WaitGroup
	gate           chan struct{}
	queue          chan struct{}
	storeIdentity  string
	dir            string
	source         string
	guard          Guard
	lock           *os.File
	bytes          int64
	entries        int
	journalBytes   int64
	testFault      func(string) error
	closed         bool
	privateEntries int
	nativeIO       NativeMutationIO
	// Administrator-provisioned per-volume private recovery roots. Nil keeps the
	// original Unix adapter behavior; Windows v2 must explicitly configure this.
	recoveryDirectory func(context.Context, Binding, string) (string, error)
	metadataChannel   windowsbackup.MetadataChannel
}

type scopeRecord struct {
	Binding Binding `json:"binding"`
}

func hash(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }
func key(value string) string { return hash([]byte(value)) }
func objectID(scope, kind, path, digest string) string {
	return key(scope + "\x00" + kind + "\x00" + path + "\x00" + digest)
}
func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }
func within(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// New acquires an OS lifetime lock. A crashed process releases that lock, but
// its pending journal survives. No PID/TTL/stale-lock inference is performed.
func New(dir string, guard Guard) (*Manager, error) {
	if guard == nil {
		return nil, fmt.Errorf("history requires a path guard")
	}
	absolute, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	if err := rejectSymlinkAncestors(absolute); err != nil {
		return nil, err
	}
	for ancestor := absolute; ; ancestor = filepath.Dir(ancestor) {
		if _, err := os.Lstat(filepath.Join(ancestor, ".git")); err == nil {
			return nil, fmt.Errorf("private stateDir must not be inside a repository")
		} else if !os.IsNotExist(err) {
			return nil, err
		}
		if filepath.Dir(ancestor) == ancestor {
			break
		}
	}
	if err := os.MkdirAll(absolute, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(absolute)
	if err != nil || !info.IsDir() {
		return nil, fmt.Errorf("history stateDir must be a private directory")
	}
	if err := secureDirectory(absolute); err != nil {
		return nil, err
	}
	identity, err := rootIdentity(absolute)
	if err != nil {
		return nil, err
	}
	m := &Manager{dir: absolute, guard: guard, storeIdentity: identity, gate: make(chan struct{}, 1), queue: make(chan struct{}, 64)}
	m.gate <- struct{}{}
	m.captureSlots = make(chan struct{}, 2)
	m.captureQueue = make(chan struct{}, 64)
	m.captureActive = map[string]bool{}
	m.captureContext, m.captureStop = context.WithCancel(context.Background())
	lockPath := filepath.Join(absolute, "store.lock")
	if err := rejectSymlinkAncestors(lockPath); err != nil {
		return nil, err
	}
	m.lock, err = os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := lockStore(m.lock); err != nil {
		m.lock.Close()
		return nil, fmt.Errorf("history store is already owned: %w", err)
	}
	success := false
	defer func() {
		if !success {
			m.lock.Close()
		}
	}()
	for _, name := range []string{"scopes", "objects", "receipts", "recovery"} {
		path := filepath.Join(absolute, name)
		if err := rejectSymlinkAncestors(path); err != nil {
			return nil, err
		}
		if err := os.MkdirAll(path, 0700); err != nil {
			return nil, err
		}
	}
	sourcePath := filepath.Join(absolute, "source.json")
	data, err := readPrivate(sourcePath, 1024)
	if os.IsNotExist(err) {
		random := make([]byte, 32)
		if _, err := rand.Read(random); err != nil {
			return nil, err
		}
		m.source = hex.EncodeToString(random)
		marker, _ := json.Marshal(struct {
			Version int    `json:"version"`
			Source  string `json:"sourceInstanceId"`
			Root    string `json:"privateRootIdentity"`
		}{1, m.source, identity})
		if err := writePrivate(sourcePath, marker); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	} else {
		var marker struct {
			Version int    `json:"version"`
			Source  string `json:"sourceInstanceId"`
			Root    string `json:"privateRootIdentity"`
		}
		if err := json.Unmarshal(data, &marker); err != nil || marker.Version != 1 || marker.Root != identity || !validDigest(marker.Source) {
			return nil, fmt.Errorf("source_store_replaced: durable source marker does not match private root identity")
		}
		m.source = marker.Source
	}
	// Bounded startup quota inventory runs in the executor, not the HTTP main thread.
	inventoryEntries := 0
	inventoryDeadline := time.Now().Add(120 * time.Second)
	err = filepath.WalkDir(absolute, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		inventoryEntries++
		if inventoryEntries > 200000 || time.Now().After(inventoryDeadline) {
			return fmt.Errorf("private store inventory budget exceeded")
		}
		if d.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("private store contains symlink")
		}
		// Quarantined originals keep their native mode/ACL/owner under a private
		// 0700/DACL-protected parent. Tightening the file itself would destroy evidence.
		if d.IsDir() || !within(filepath.Join(absolute, "recovery"), path) {
			if err := secureDirectory(path); err != nil {
				return err
			}
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		m.bytes += info.Size()
		if within(filepath.Join(absolute, "receipts"), path) {
			m.entries++
			m.journalBytes += info.Size()
		}
		if m.bytes > QuotaBytes || m.entries > MaxReceipts || m.journalBytes > JournalBytes {
			return fmt.Errorf("history quota exceeded")
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	m.privateEntries = inventoryEntries
	success = true
	return m, nil
}

// SetNativeMutationIO must run before publishing capabilities. Shared manager
// state keeps this platform adapter stable across connections.
func (m *Manager) SetNativeMutationIO(adapter NativeMutationIO) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nativeIO = adapter
}

// SetRecoveryDirectoryResolver is installed during trusted startup, before
// capability publication. Resolver must only return a configured, identity-pinned
// private root on the actual target volume, never auto-create a workspace vault.
func (m *Manager) SetRecoveryDirectoryResolver(resolve func(context.Context, Binding, string) (string, error)) {
	m.configMu.Lock()
	defer m.configMu.Unlock()
	m.recoveryDirectory = resolve
}

// NativeMetadataContext gives EA/ADS an immutable, scoped CAS in the existing
// private namespace. Legacy object IDs, origin paths and hash inputs are untouched.
func (m *Manager) SetMetadataChannel(channel windowsbackup.MetadataChannel) {
	m.configMu.Lock()
	defer m.configMu.Unlock()
	m.metadataChannel = channel
}
func (m *Manager) NativeMetadataContext(ctx context.Context, binding Binding) context.Context {
	m.configMu.RLock()
	channel := m.metadataChannel
	m.configMu.RUnlock()
	if channel != nil {
		ctx = windowsbackup.WithMetadataChannel(ctx, channel)
	}
	return windowsbackup.WithBlobs(ctx, nativeMetadataBlobs{manager: m, binding: binding})
}

type nativeMetadataBlobs struct {
	manager *Manager
	binding Binding
}

func (s nativeMetadataBlobs) Put(ctx context.Context, data []byte) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if len(data) > windowsbackup.StreamBytes {
		return "", fmt.Errorf("native stream budget")
	}
	m := s.manager
	m.objectMu.Lock()
	defer m.objectMu.Unlock()
	if err := m.validateHistorical(s.binding); err != nil {
		return "", err
	}
	digest := hash(data)
	path := m.objectPath(s.binding, "native-stream-"+digest)
	previous, err := readPrivate(path, BlobBytes)
	if err == nil {
		if !bytes.Equal(previous, data) {
			return "", fmt.Errorf("native CAS conflict")
		}
		return digest, nil
	}
	if !os.IsNotExist(err) {
		return "", err
	}
	if m.privateEntries >= 200000 {
		return "", fmt.Errorf("private entry quota")
	}
	if err := m.admission(int64(len(data))); err != nil {
		return "", err
	}
	if err := writePrivate(path, data); err != nil {
		return "", err
	}
	m.bytes += int64(len(data))
	m.privateEntries++
	return digest, nil
}
func (s nativeMetadataBlobs) Get(ctx context.Context, digest string, size int64) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !validDigest(digest) || size < 0 || size > windowsbackup.StreamBytes {
		return nil, fmt.Errorf("native stream descriptor")
	}
	if err := s.manager.validateHistorical(s.binding); err != nil {
		return nil, err
	}
	data, err := readPrivate(s.manager.objectPath(s.binding, "native-stream-"+digest), size)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) != size || hash(data) != digest {
		return nil, fmt.Errorf("native stream integrity")
	}
	return data, nil
}

// Admission is bounded and cancellable even while another capture owns the store.
func (m *Manager) acquire(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case m.queue <- struct{}{}:
	default:
		return fmt.Errorf("history queue budget exceeded")
	}
	select {
	case <-ctx.Done():
		<-m.queue
		return ctx.Err()
	case <-m.gate:
		m.mu.Lock()
		if m.closed {
			m.release()
			return fmt.Errorf("history store is closed")
		}
		return nil
	}
}

func (m *Manager) release() { m.mu.Unlock(); m.gate <- struct{}{}; <-m.queue }

func (m *Manager) checkStore() error {
	if err := rejectSymlinkAncestors(m.dir); err != nil {
		return err
	}
	identity, err := rootIdentity(m.dir)
	if err != nil {
		return err
	}
	if identity != m.storeIdentity {
		return fmt.Errorf("private store root replaced")
	}
	return nil
}

func (m *Manager) admission(extra int64) error {
	if err := m.checkStore(); err != nil {
		return err
	}
	if m.bytes+extra > QuotaBytes {
		return fmt.Errorf("quota_exceeded")
	}
	free, err := availableBytes(m.dir)
	if err != nil {
		return err
	}
	if extra > 0 && free < uint64(extra)+(1<<30) {
		return fmt.Errorf("minimum free space budget")
	}
	return nil
}

func (m *Manager) Close() error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	m.captureStop()
	m.mu.Unlock()
	m.captureWG.Wait()
	return m.lock.Close()
}

func rejectSymlinkAncestors(path string) error {
	for p := filepath.Clean(path); ; p = filepath.Dir(p) {
		info, err := os.Lstat(p)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		if err == nil && info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("symlink in private/target path: %s", p)
		}
		if filepath.Dir(p) == p {
			return nil
		}
	}
}

func readPrivate(path string, limit int64) ([]byte, error) {
	if err := rejectSymlinkAncestors(path); err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, fmt.Errorf("private object exceeds budget or is unsupported")
	}
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if len(data) > int(limit) {
		return nil, fmt.Errorf("private object exceeds budget")
	}
	return data, err
}

func syncDir(path string) error {
	// Windows replacements use MOVEFILE_WRITE_THROUGH; directory FlushFileBuffers
	// is unsupported. The immutable data and journal files are independently synced.
	if runtime.GOOS == "windows" {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	// Directory Sync is not available on Windows. Regular-file Sync still applies.
	err = f.Sync()
	if err != nil && strings.Contains(strings.ToLower(err.Error()), "incorrect function") {
		return nil
	}
	return err
}

func writePrivate(path string, data []byte) error {
	if err := rejectSymlinkAncestors(path); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".pending-")
	if err != nil {
		return err
	}
	temp := f.Name()
	defer os.Remove(temp)
	if err := f.Chmod(0600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := durableRename(temp, path); err != nil {
		return err
	}
	return syncDir(filepath.Dir(path))
}

func validDigest(digest string) bool {
	if len(digest) != 64 {
		return false
	}
	data, err := hex.DecodeString(digest)
	return err == nil && len(data) == 32 && strings.ToLower(digest) == digest
}

func (m *Manager) scopePath(scope string) string {
	return filepath.Join(m.dir, "scopes", key(scope)+".json")
}
func (m *Manager) receiptPath(b Binding, operation string) string {
	return filepath.Join(m.dir, "receipts", key(b.ScopeID+"\x00"+operation)+".json")
}
func (m *Manager) objectPath(b Binding, digest string) string {
	return filepath.Join(m.dir, "objects", key(b.ScopeID), digest)
}

func (m *Manager) Open(ctx context.Context, root, scopeID string, fence uint64) (Binding, error) {
	if err := m.acquire(ctx); err != nil {
		return Binding{}, err
	}
	defer m.release()
	if err := m.checkStore(); err != nil {
		return Binding{}, err
	}
	if scopeID == "" || len(scopeID) > 256 || fence == 0 {
		return Binding{}, fmt.Errorf("scope/fence required")
	}
	canonical, err := m.guard(root, false)
	if err != nil {
		return Binding{}, err
	}
	info, err := os.Stat(canonical)
	if err != nil || !info.IsDir() {
		return Binding{}, fmt.Errorf("history root is not a directory")
	}
	if within(m.dir, canonical) {
		return Binding{}, fmt.Errorf("workspace must not be inside private stateDir")
	}
	identity, err := rootIdentity(canonical)
	if err != nil {
		return Binding{}, err
	}
	b := Binding{m.source, key(canonical + "\x00" + identity), scopeID, canonical, identity, fence}
	existing, err := m.loadScope(scopeID)
	newScope := os.IsNotExist(err)
	if err == nil {
		if existing.Root != canonical || existing.RootIdentity != identity || existing.SourceInstanceID != m.source {
			return Binding{}, fmt.Errorf("scope root/source identity changed")
		}
		if fence < existing.Fence {
			return Binding{}, fmt.Errorf("stale history fence")
		}
		if fence > existing.Fence {
			cursor := ""
			for {
				pending, next, err := m.pending(ctx, existing, cursor, 100)
				if err != nil {
					return Binding{}, err
				}
				for _, receipt := range pending {
					if receipt.Kind != "capture" {
						return Binding{}, fmt.Errorf("recovery_required: pending mutation journal prevents fence advance")
					}
				}
				if next == "" {
					break
				}
				cursor = next
			}
		}
	} else if !os.IsNotExist(err) {
		return Binding{}, err
	}
	m.objectMu.Lock()
	defer m.objectMu.Unlock()
	data, _ := json.Marshal(scopeRecord{b})
	oldSize := 0
	if !newScope {
		previous, _ := json.Marshal(scopeRecord{existing})
		oldSize = len(previous)
	}
	if newScope && m.privateEntries+2 > 200000 {
		return Binding{}, fmt.Errorf("private entry quota exceeded")
	}
	if err := m.admission(int64(len(data) - oldSize)); err != nil {
		return Binding{}, err
	}
	if err := writePrivate(m.scopePath(scopeID), data); err != nil {
		return Binding{}, err
	}
	m.bytes += int64(len(data) - oldSize)
	if newScope {
		m.privateEntries += 2
	}
	objectDir := filepath.Join(m.dir, "objects", key(scopeID))
	if err := rejectSymlinkAncestors(objectDir); err != nil {
		return Binding{}, err
	}
	if err := os.MkdirAll(objectDir, 0700); err != nil {
		return Binding{}, err
	}
	return b, nil
}

func (m *Manager) loadScope(scopeID string) (Binding, error) {
	data, err := readPrivate(m.scopePath(scopeID), 8192)
	if err != nil {
		return Binding{}, err
	}
	var record scopeRecord
	err = json.Unmarshal(data, &record)
	return record.Binding, err
}

func (m *Manager) validateHistorical(b Binding) error {
	current, err := m.loadScope(b.ScopeID)
	if err != nil {
		return err
	}
	if b.Fence > current.Fence || b.Fence == 0 {
		return fmt.Errorf("history read fence is not registered")
	}
	pinned := b
	pinned.Fence = current.Fence
	return m.validate(pinned)
}

func (m *Manager) validate(b Binding) error {
	if err := m.checkStore(); err != nil {
		return err
	}
	existing, err := m.loadScope(b.ScopeID)
	if err != nil {
		return err
	}
	if existing != b || b.SourceInstanceID != m.source {
		return fmt.Errorf("history binding/fence mismatch")
	}
	canonical, err := m.guard(b.Root, false)
	if err != nil {
		return err
	}
	identity, err := rootIdentity(canonical)
	if err != nil {
		return err
	}
	if canonical != b.Root || identity != b.RootIdentity {
		return fmt.Errorf("history root replaced")
	}
	return nil
}

func (m *Manager) target(b Binding, relative string) (string, error) {
	if relative == "" || filepath.IsAbs(relative) || filepath.VolumeName(relative) != "" || (runtime.GOOS == "windows" && strings.Contains(relative, ":")) || relative == "." || strings.ContainsRune(relative, 0) || len(relative) > 4096 {
		return "", fmt.Errorf("invalid relative history path")
	}
	path := filepath.Join(b.Root, relative)
	if within(m.dir, path) {
		return "", fmt.Errorf("private stateDir is excluded from workspace history")
	}
	if !within(b.Root, path) || path == b.Root {
		return "", fmt.Errorf("history path escapes scope")
	}
	if err := rejectSymlinkAncestors(path); err != nil {
		return "", err
	}
	canonical, err := m.guard(path, true)
	if err != nil {
		return "", err
	}
	if canonical != path || !within(b.Root, canonical) {
		return "", fmt.Errorf("history target identity changed")
	}
	return path, nil
}

func (m *Manager) putObject(b Binding, data []byte, kind, origin string) (*Object, error) {
	m.objectMu.Lock()
	defer m.objectMu.Unlock()
	if int64(len(data)) > BlobBytes {
		return nil, fmt.Errorf("too_large")
	}
	digest := hash(data)
	id := objectID(b.ScopeID, kind, origin, digest)
	path := m.objectPath(b, id)
	_, err := readPrivate(path, BlobBytes)
	if os.IsNotExist(err) {
		if m.privateEntries >= 200000 {
			return nil, fmt.Errorf("private entry quota exceeded")
		}
		if err := m.admission(int64(len(data))); err != nil {
			return nil, err
		}
		if err := writePrivate(path, data); err != nil {
			return nil, err
		}
		m.bytes += int64(len(data))
		m.privateEntries++
	} else if err != nil {
		return nil, err
	}
	return &Object{b.SourceInstanceID, b.WorkspaceInstanceID, b.ScopeID, id, "sha256", digest, int64(len(data)), kind, origin}, nil
}

func (m *Manager) objectBytes(b Binding, object Object) ([]byte, error) {
	if object.SourceInstanceID != b.SourceInstanceID || object.WorkspaceInstanceID != b.WorkspaceInstanceID || object.ScopeID != b.ScopeID || !validDigest(object.Digest) || object.ObjectID != objectID(b.ScopeID, object.Kind, object.Path, object.Digest) || object.Algorithm != "sha256" || object.SizeBytes < 0 || object.SizeBytes > BlobBytes {
		return nil, fmt.Errorf("object provenance/size mismatch")
	}
	if object.Kind == "blob" {
		if _, err := m.target(b, object.Path); err != nil {
			return nil, err
		}
	} else if object.Kind != "tree" || object.Path != "" {
		return nil, fmt.Errorf("unsupported object provenance")
	}
	data, err := readPrivate(m.objectPath(b, object.ObjectID), BlobBytes)
	if err != nil {
		return nil, err
	}
	if hash(data) != object.Digest || int64(len(data)) != object.SizeBytes {
		return nil, fmt.Errorf("object integrity mismatch")
	}
	if object.Kind == "tree" {
		if err := m.validateTreeObject(b, data); err != nil {
			return nil, err
		}
	}
	return data, nil
}

func (m *Manager) saveReceipt(r *Receipt) error {
	m.objectMu.Lock()
	defer m.objectMu.Unlock()
	data, err := json.Marshal(r)
	if err != nil {
		return err
	}
	if len(data) > 256<<10 {
		return fmt.Errorf("receipt metadata budget exceeded")
	}
	path := m.receiptPath(r.Binding, r.OperationID)
	previous, err := readPrivate(path, 256<<10)
	extra := int64(len(data) - len(previous))
	isNew := os.IsNotExist(err)
	if err != nil && !isNew {
		return err
	}
	if isNew && (m.entries >= MaxReceipts || m.privateEntries >= 200000) || m.journalBytes+extra > JournalBytes || m.bytes+extra > QuotaBytes {
		return fmt.Errorf("receipt quota exceeded")
	}
	if err := m.admission(extra); err != nil {
		return err
	}
	if err := writePrivate(path, data); err != nil {
		return err
	}
	if isNew {
		m.entries++
		m.privateEntries++
	}
	m.bytes += extra
	m.journalBytes += extra
	return nil
}

func (m *Manager) loadReceipt(b Binding, id string) (*Receipt, error) {
	data, err := readPrivate(m.receiptPath(b, id), 256<<10)
	if err != nil {
		return nil, err
	}
	var r Receipt
	if err := json.Unmarshal(data, &r); err != nil {
		return nil, err
	}
	if r.Binding.SourceInstanceID != b.SourceInstanceID || r.Binding.WorkspaceInstanceID != b.WorkspaceInstanceID || r.Binding.ScopeID != b.ScopeID || r.Binding.RootIdentity != b.RootIdentity || r.OperationID != id {
		return nil, fmt.Errorf("receipt provenance mismatch")
	}
	return &r, nil
}

// Pending pages contain metadata summaries; callers query status for effect proof.
func (m *Manager) pending(ctx context.Context, b Binding, cursor string, limit int) ([]Receipt, string, error) {
	dir, err := os.Open(filepath.Join(m.dir, "receipts"))
	if err != nil {
		return nil, "", err
	}
	defer dir.Close()
	names := []string{}
	for {
		if err := ctx.Err(); err != nil {
			return nil, "", err
		}
		batch, err := dir.Readdirnames(100)
		names = append(names, batch...)
		if len(names) > MaxReceipts {
			return nil, "", fmt.Errorf("receipt inventory budget")
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, "", err
		}
	}
	sort.Strings(names)
	out := []Receipt{}
	last := cursor
	size := 0
	for _, name := range names {
		if err := ctx.Err(); err != nil {
			return nil, "", err
		}
		if name <= cursor || !strings.HasSuffix(name, ".json") {
			continue
		}
		data, err := readPrivate(filepath.Join(m.dir, "receipts", name), 256<<10)
		if err != nil {
			return nil, "", err
		}
		var r Receipt
		if err := json.Unmarshal(data, &r); err != nil {
			return nil, "", err
		}
		if r.Binding.ScopeID != b.ScopeID || r.State == "finalized" || r.State == "compensated" || r.State == "rejected" {
			continue
		}
		r.Effects = []Effect{}
		summary, _ := json.Marshal(r)
		if len(out) > 0 && (len(out) >= limit || size+len(summary) > 128<<10) {
			return out, last, nil
		}
		if len(summary) > 128<<10 {
			return nil, "", fmt.Errorf("receipt summary budget exceeded")
		}
		size += len(summary)
		out = append(out, r)
		last = name
	}
	return out, "", nil
}
