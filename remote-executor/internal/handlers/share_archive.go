package handlers

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

const shareMaxEntries = 4096
const shareMaxBytes int64 = 1024 * 1024 * 1024
const shareManifestMaxBytes = 1024 * 1024
const shareMaxChunkBytes int64 = 1024 * 1024
const shareMaxOperations = 8
const shareLifetime = 10 * time.Minute

type shareArchiveEntry struct {
	Path      string `json:"path"`
	Name      string `json:"name"`
	Size      int64  `json:"sizeBytes"`
	Directory bool   `json:"isDirectory"`
	info      os.FileInfo
}
type shareArchiveOperation struct {
	gate          chan struct{}
	id            string
	roots         []string
	entries       []shareArchiveEntry
	manifestHash  string
	expandedBytes int64
	originalName  string
	directory     bool
	created       time.Time
	dir           string
	artifact      string
	artifactId    string
	artifactInfo  os.FileInfo
	digest        string
	format        string
	filename      string
}
type shareArchiveRegistry struct {
	mu         sync.Mutex
	root       string
	rootInfo   os.FileInfo
	operations map[string]*shareArchiveOperation
}

// Private artifacts are served only through opaque share.readChunk operations.
// Neither ordinary filesystem RPC nor transfer paths gain access to this directory.
func (h *Handlers) ConfigureShareStateDirectory(directory string) error {
	if !filepath.IsAbs(directory) || filepath.Clean(directory) != directory {
		return fmt.Errorf("share state must be an absolute normalized directory")
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	actual, err := filepath.EvalSymlinks(directory)
	if err != nil || !samePath(actual, directory) {
		return fmt.Errorf("share state contains a symlink or junction")
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("invalid share state directory")
	}
	if filepath.Separator != '\\' && info.Mode().Perm()&0077 != 0 {
		return fmt.Errorf("share state must be private")
	}
	if err := h.guard.ExcludePrivateDirectories(directory); err != nil {
		return err
	}
	h.shareRegistry = &shareArchiveRegistry{root: directory, rootInfo: info, operations: make(map[string]*shareArchiveOperation)}
	return nil
}
func (h *Handlers) shareState() (*shareArchiveRegistry, error) {
	state := h.shareRegistry
	if state == nil {
		return nil, fmt.Errorf("share.archive.v1 is unavailable")
	}
	actual, err := filepath.EvalSymlinks(state.root)
	if err != nil || !samePath(actual, state.root) {
		return nil, fmt.Errorf("share private state identity changed")
	}
	info, err := os.Lstat(state.root)
	if err != nil || !os.SameFile(info, state.rootInfo) || !info.IsDir() || (filepath.Separator != '\\' && info.Mode().Perm()&0077 != 0) {
		return nil, fmt.Errorf("share private state was replaced or permissions changed")
	}
	return state, nil
}
func shareOperationID(params map[string]any) (string, error) {
	id := stringParam(params, "operationId")
	if len(id) < 8 || len(id) > 128 {
		return "", fmt.Errorf("invalid share operationId")
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return "", fmt.Errorf("invalid share operationId")
		}
	}
	return id, nil
}
func shareContext(parent context.Context, params map[string]any, defaultMs int64) (context.Context, context.CancelFunc) {
	ms := intParam(params, "timeoutMs", defaultMs)
	if ms < 1 {
		ms = 1
	}
	if ms > 300000 {
		ms = 300000
	}
	return context.WithTimeout(parent, time.Duration(ms)*time.Millisecond)
}
func shareName(value string) string {
	var out strings.Builder
	for _, r := range value {
		if r < 32 || r == 127 || strings.ContainsRune("\\/:*?\"<>|", r) {
			out.WriteByte('_')
		} else {
			out.WriteRune(r)
		}
	}
	name := out.String()
	if name == "" || name == "." || name == ".." {
		return "shared-root"
	}
	return name
}
func shareArchiveName(prefix, relative string) string {
	if relative == "." {
		return prefix
	}
	parts := strings.Split(filepath.ToSlash(relative), "/")
	for i := range parts {
		parts[i] = shareName(parts[i])
	}
	return path.Join(append([]string{prefix}, parts...)...)
}
func (h *Handlers) collectShareEntries(ctx context.Context, roots []string, limit int, byteLimit int64) ([]shareArchiveEntry, int64, error) {
	entries := make([]shareArchiveEntry, 0, 128)
	var total int64
	manifestBytes := 0
	manifestLimit := int64(shareManifestMaxBytes)
	if h.maxRpcBytes-4096 < manifestLimit {
		manifestLimit = h.maxRpcBytes - 4096
	}
	if manifestLimit < 1 {
		return nil, 0, fmt.Errorf("share metadata RPC allowance too small")
	}
	names := make(map[string]bool)
	var visit func(string, string, string, int) error
	visit = func(root, current, prefix string, depth int) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if depth > 64 || len(entries) >= limit {
			return fmt.Errorf("share enumeration limit exceeded")
		}
		info, err := os.Lstat(current)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || !(info.IsDir() || info.Mode().IsRegular()) {
			return fmt.Errorf("share refuses symlinks and unsupported objects")
		}
		canonical, err := h.guard.CheckExisting(current)
		if err != nil || !samePath(canonical, current) {
			return fmt.Errorf("share path identity changed or escaped authorization")
		}
		rel, err := filepath.Rel(root, current)
		if err != nil {
			return err
		}
		name := shareArchiveName(prefix, rel)
		if names[name] {
			return fmt.Errorf("share archive names collide after normalization")
		}
		names[name] = true
		size := info.Size()
		if info.IsDir() {
			size = 0
		}
		if size < 0 || size > byteLimit-total {
			return fmt.Errorf("share expanded-byte limit exceeded")
		}
		total += size
		entry := shareArchiveEntry{Path: canonical, Name: name, Size: size, Directory: info.IsDir(), info: info}
		encoded, err := json.Marshal(entry)
		if err != nil {
			return err
		}
		manifestBytes += len(encoded) + 1
		if int64(manifestBytes) > manifestLimit {
			return fmt.Errorf("share manifest byte limit exceeded")
		}
		entries = append(entries, entry)
		if !info.IsDir() {
			return nil
		}
		dir, err := os.Open(current)
		if err != nil {
			return err
		}
		defer dir.Close()
		for {
			children, readErr := dir.ReadDir(128)
			for _, child := range children {
				if err := visit(root, filepath.Join(current, child.Name()), prefix, depth+1); err != nil {
					return err
				}
			}
			if readErr == io.EOF {
				break
			}
			if readErr != nil {
				return readErr
			}
		}
		return nil
	}
	for index, root := range roots {
		prefix := shareName(filepath.Base(root))
		if len(roots) > 1 {
			prefix = fmt.Sprintf("%d-%s", index+1, prefix)
		}
		if err := visit(root, root, prefix, 0); err != nil {
			return nil, 0, err
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	return entries, total, nil
}
func (h *Handlers) validateShareEntries(ctx context.Context, op *shareArchiveOperation) error {
	for _, entry := range op.entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		canonical, err := h.guard.CheckExisting(entry.Path)
		if err != nil || !samePath(canonical, entry.Path) {
			return fmt.Errorf("share source path identity changed")
		}
		info, err := os.Lstat(entry.Path)
		if err != nil || !os.SameFile(info, entry.info) || info.Mode()&os.ModeSymlink != 0 || info.IsDir() != entry.Directory || (!entry.Directory && (info.Size() != entry.Size || !info.ModTime().Equal(entry.info.ModTime()))) {
			return fmt.Errorf("share source changed since inspection")
		}
	}
	return nil
}
func shareManifestResult(op *shareArchiveOperation) map[string]any {
	return map[string]any{"operationId": op.id, "manifestHash": op.manifestHash, "entries": op.entries, "entryCount": len(op.entries), "expandedBytes": op.expandedBytes, "truncated": false, "originalName": op.originalName, "isDirectory": op.directory}
}
func (h *Handlers) ShareInspect(parent context.Context, params map[string]any) (any, error) {
	ctx, cancel := shareContext(parent, params, 30000)
	defer cancel()
	started := time.Now()
	defer func() {
		if time.Since(started) > 2*time.Second {
			log.Printf("share inspect slow: %s", time.Since(started))
		}
	}()
	state, err := h.shareState()
	if err != nil {
		return nil, err
	}
	id, err := shareOperationID(params)
	if err != nil {
		return nil, err
	}
	raw := stringSliceParam(params, "paths")
	if len(raw) < 1 || len(raw) > 64 {
		return nil, fmt.Errorf("share requires 1-64 paths")
	}
	roots := make([]string, 0, len(raw))
	for _, item := range raw {
		if !filepath.IsAbs(item) {
			return nil, fmt.Errorf("share paths must be absolute")
		}
		root, err := h.guard.CheckExisting(item)
		if err != nil {
			return nil, err
		}
		roots = append(roots, root)
	}
	limit := int(intParam(params, "maxEntries", shareMaxEntries))
	if limit < 1 || limit > shareMaxEntries {
		limit = shareMaxEntries
	}
	byteLimit := intParam(params, "maxExpandedBytes", shareMaxBytes)
	if byteLimit < 1 || byteLimit > shareMaxBytes {
		byteLimit = shareMaxBytes
	}
	state.mu.Lock()
	for key, op := range state.operations {
		if time.Since(op.created) > shareLifetime {
			select {
			case op.gate <- struct{}{}:
				if op.dir != "" {
					os.RemoveAll(op.dir)
				}
				delete(state.operations, key)
				<-op.gate
			default:
			}
		}
	}
	if _, ok := state.operations[id]; ok {
		state.mu.Unlock()
		return nil, fmt.Errorf("share operationId already exists")
	}
	if len(state.operations) >= shareMaxOperations {
		state.mu.Unlock()
		return nil, fmt.Errorf("share operation capacity exceeded")
	}
	op := &shareArchiveOperation{id: id, roots: roots, gate: make(chan struct{}, 1), created: time.Now()}
	op.gate <- struct{}{}
	state.operations[id] = op
	state.mu.Unlock()
	defer func() { <-op.gate }()
	entries, total, err := h.collectShareEntries(ctx, roots, limit, byteLimit)
	if err != nil {
		state.mu.Lock()
		delete(state.operations, id)
		state.mu.Unlock()
		return nil, err
	}
	op.entries = entries
	op.expandedBytes = total
	op.originalName = shareName(filepath.Base(roots[0]))
	op.directory = len(roots) == 1 && entries[0].Directory
	encoded, _ := json.Marshal(entries)
	digest := sha256.Sum256(encoded)
	op.manifestHash = hex.EncodeToString(digest[:])
	return shareManifestResult(op), nil
}
func (h *Handlers) acquireShareOperation(ctx context.Context, params map[string]any) (*shareArchiveRegistry, *shareArchiveOperation, func(), error) {
	state, err := h.shareState()
	if err != nil {
		return nil, nil, nil, err
	}
	id, err := shareOperationID(params)
	if err != nil {
		return nil, nil, nil, err
	}
	state.mu.Lock()
	op := state.operations[id]
	state.mu.Unlock()
	if op == nil || time.Since(op.created) > shareLifetime {
		return nil, nil, nil, fmt.Errorf("share operation missing or expired")
	}
	select {
	case op.gate <- struct{}{}:
	case <-ctx.Done():
		return nil, nil, nil, ctx.Err()
	}
	state.mu.Lock()
	current := state.operations[id]
	state.mu.Unlock()
	if current != op {
		<-op.gate
		return nil, nil, nil, fmt.Errorf("share operation was released or failed")
	}
	return state, op, func() { <-op.gate }, nil
}

type boundedShareWriter struct {
	ctx       context.Context
	out       io.Writer
	remaining int64
}

func (w *boundedShareWriter) Write(bytes []byte) (int, error) {
	if err := w.ctx.Err(); err != nil {
		return 0, err
	}
	if int64(len(bytes)) > w.remaining {
		return 0, fmt.Errorf("share archive-byte limit exceeded")
	}
	n, err := w.out.Write(bytes)
	w.remaining -= int64(n)
	return n, err
}

type shareContextReader struct {
	ctx    context.Context
	source io.Reader
}

func (r *shareContextReader) Read(bytes []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.source.Read(bytes)
}
func (h *Handlers) copyShareEntry(ctx context.Context, entry shareArchiveEntry, out io.Writer) error {
	file, canonical, err := h.openReadFile(map[string]any{"path": entry.Path, "expectedResolvedPath": entry.Path})
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !samePath(canonical, entry.Path) || !os.SameFile(info, entry.info) || !info.Mode().IsRegular() || info.Size() != entry.Size || !info.ModTime().Equal(entry.info.ModTime()) {
		return fmt.Errorf("share opened source identity changed")
	}
	n, err := io.CopyBuffer(out, &shareContextReader{ctx: ctx, source: io.LimitReader(file, entry.Size+1)}, make([]byte, 65536))
	if err != nil {
		return err
	}
	if n != entry.Size {
		return fmt.Errorf("share source length changed during archive")
	}
	after, err := file.Stat()
	if err != nil || after.Size() != entry.Size || !after.ModTime().Equal(entry.info.ModTime()) {
		return fmt.Errorf("share source changed during archive")
	}
	return nil
}
func shareArtifactResult(op *shareArchiveOperation) map[string]any {
	return map[string]any{"operationId": op.id, "artifactId": op.artifactId, "archiveSizeBytes": op.artifactInfo.Size(), "archiveDigest": op.digest, "filename": op.filename, "format": op.format, "originalName": op.originalName, "isDirectory": op.directory}
}
func (h *Handlers) SharePrepare(parent context.Context, params map[string]any) (any, error) {
	ctx, cancel := shareContext(parent, params, 120000)
	defer cancel()
	started := time.Now()
	defer func() {
		if time.Since(started) > 2*time.Second {
			log.Printf("share prepare slow: %s", time.Since(started))
		}
	}()
	state, op, unlock, err := h.acquireShareOperation(ctx, params)
	if err != nil {
		return nil, err
	}
	defer unlock()
	if stringParam(params, "manifestHash") != op.manifestHash {
		return nil, fmt.Errorf("share manifest hash mismatch")
	}
	format := stringParam(params, "format")
	if format == "" {
		if len(op.roots) > 1 {
			format = "zip"
		} else if op.directory {
			format = "tar.gz"
		} else {
			format = "raw"
		}
	}
	if format != "raw" && format != "gz" && format != "tar.gz" && format != "zip" {
		return nil, fmt.Errorf("unsupported share format")
	}
	if (format == "raw" || format == "gz") && (len(op.entries) != 1 || op.entries[0].Directory) {
		return nil, fmt.Errorf("raw/gzip shares require one regular file")
	}
	if err := h.validateShareEntries(ctx, op); err != nil {
		return nil, err
	}
	outputLimit := intParam(params, "maxArchiveBytes", shareMaxBytes)
	if outputLimit < 1 {
		return nil, fmt.Errorf("share archive byte allowance must be positive")
	}
	if outputLimit > shareMaxBytes {
		outputLimit = shareMaxBytes
	}
	if op.artifact != "" {
		if format != op.format || op.artifactInfo.Size() > outputLimit {
			return nil, fmt.Errorf("share operation format or byte allowance conflict")
		}
		return shareArtifactResult(op), nil
	}
	state.mu.Lock()
	parentDir, quotaErr := os.Open(state.root)
	if quotaErr == nil {
		children, readErr := parentDir.ReadDir(shareMaxOperations + 1)
		parentDir.Close()
		if readErr != nil && readErr != io.EOF {
			quotaErr = readErr
		}
		if len(children) >= shareMaxOperations {
			quotaErr = fmt.Errorf("share private artifact quota exceeded; release prior operations")
		}
	}
	var dir string
	if quotaErr == nil {
		dir, quotaErr = os.MkdirTemp(state.root, "share-"+op.id+"-")
	}
	state.mu.Unlock()
	if quotaErr != nil {
		return nil, quotaErr
	}
	op.dir = dir
	success := false
	defer func() {
		if !success {
			os.RemoveAll(dir)
			op.dir = ""
		}
	}()
	marker, _ := json.Marshal(map[string]any{"version": 1, "operationId": op.id})
	if err := os.WriteFile(filepath.Join(dir, "operation.json"), marker, 0600); err != nil {
		return nil, err
	}
	artifact := filepath.Join(dir, "artifact")
	file, err := os.OpenFile(artifact, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	hash := sha256.New()
	out := &boundedShareWriter{ctx: ctx, out: io.MultiWriter(file, hash), remaining: outputLimit}
	writeErr := func() error {
		switch format {
		case "raw":
			return h.copyShareEntry(ctx, op.entries[0], out)
		case "gz":
			gz := gzip.NewWriter(out)
			err := h.copyShareEntry(ctx, op.entries[0], gz)
			closeErr := gz.Close()
			if err != nil {
				return err
			}
			return closeErr
		case "tar.gz":
			gz := gzip.NewWriter(out)
			archive := tar.NewWriter(gz)
			for _, entry := range op.entries {
				header, err := tar.FileInfoHeader(entry.info, "")
				if err != nil {
					return err
				}
				header.Name = entry.Name
				if err := archive.WriteHeader(header); err != nil {
					return err
				}
				if !entry.Directory {
					if err := h.copyShareEntry(ctx, entry, archive); err != nil {
						return err
					}
				}
			}
			if err := archive.Close(); err != nil {
				return err
			}
			return gz.Close()
		case "zip":
			archive := zip.NewWriter(out)
			for _, entry := range op.entries {
				header, err := zip.FileInfoHeader(entry.info)
				if err != nil {
					return err
				}
				header.Name = entry.Name
				if entry.Directory {
					header.Name += "/"
				} else {
					header.Method = zip.Deflate
				}
				dest, err := archive.CreateHeader(header)
				if err != nil {
					return err
				}
				if !entry.Directory {
					if err := h.copyShareEntry(ctx, entry, dest); err != nil {
						return err
					}
				}
			}
			return archive.Close()
		}
		return fmt.Errorf("unsupported share format")
	}()
	closeErr := file.Close()
	if writeErr != nil {
		return nil, writeErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if err := h.validateShareEntries(ctx, op); err != nil {
		return nil, err
	}
	info, err := os.Lstat(artifact)
	if err != nil || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("share artifact invalid")
	}
	op.artifact = artifact
	op.artifactId = filepath.Base(dir)
	op.artifactInfo = info
	op.digest = hex.EncodeToString(hash.Sum(nil))
	op.format = format
	op.filename = op.originalName
	if format == "zip" {
		op.filename = "share.zip"
	} else if format != "raw" {
		op.filename += "." + format
	}
	success = true
	return shareArtifactResult(op), nil
}
func (h *Handlers) ShareReadChunk(parent context.Context, params map[string]any) (any, error) {
	ctx, cancel := shareContext(parent, params, 10000)
	defer cancel()
	_, op, unlock, err := h.acquireShareOperation(ctx, params)
	if err != nil {
		return nil, err
	}
	defer unlock()
	if op.artifact == "" || stringParam(params, "artifactId") != op.artifactId {
		return nil, fmt.Errorf("share artifact unavailable or mismatched")
	}
	if err := h.validateShareEntries(ctx, op); err != nil {
		return nil, err
	}
	offset := intParam(params, "offset", -1)
	if offset < 0 || offset > op.artifactInfo.Size() {
		return nil, fmt.Errorf("invalid share chunk offset")
	}
	limit := intParam(params, "maxChunkBytes", shareMaxChunkBytes)
	if limit < 1 || limit > shareMaxChunkBytes {
		limit = shareMaxChunkBytes
	}
	rpcLimit := (h.maxRpcBytes - 4096) * 3 / 4
	if rpcLimit < 1 {
		return nil, fmt.Errorf("share RPC byte allowance too small")
	}
	if limit > rpcLimit {
		limit = rpcLimit
	}
	file, err := os.Open(op.artifact)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || !os.SameFile(info, op.artifactInfo) || info.Size() != op.artifactInfo.Size() {
		return nil, fmt.Errorf("share private artifact identity changed")
	}
	remaining := info.Size() - offset
	if limit > remaining {
		limit = remaining
	}
	buf := make([]byte, int(limit))
	n, err := file.ReadAt(buf, offset)
	if err != nil && err != io.EOF {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return map[string]any{"operationId": op.id, "artifactId": op.artifactId, "offset": offset, "contentBase64": base64.StdEncoding.EncodeToString(buf[:n]), "eof": offset+int64(n) == info.Size()}, nil
}
func (h *Handlers) ShareRelease(parent context.Context, params map[string]any) (any, error) {
	ctx, cancel := shareContext(parent, params, 10000)
	defer cancel()
	state, err := h.shareState()
	if err != nil {
		return nil, err
	}
	id, err := shareOperationID(params)
	if err != nil {
		return nil, err
	}
	state.mu.Lock()
	op := state.operations[id]
	state.mu.Unlock()
	if op == nil {
		// A restart loses ephemeral readers, not ownership markers. Explicit release
		// can reclaim this exact operation without granting private artifact reads.
		directory, err := os.Open(state.root)
		if err != nil {
			return nil, err
		}
		defer directory.Close()
		children, err := directory.ReadDir(shareMaxOperations + 1)
		if err != nil && err != io.EOF {
			return nil, err
		}
		for _, child := range children {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if !child.IsDir() || !strings.HasPrefix(child.Name(), "share-"+id+"-") {
				continue
			}
			candidate := filepath.Join(state.root, child.Name())
			actual, err := filepath.EvalSymlinks(candidate)
			if err != nil || !samePath(actual, candidate) || filepath.Dir(actual) != state.root {
				continue
			}
			markerPath := filepath.Join(candidate, "operation.json")
			info, err := os.Lstat(markerPath)
			if err != nil || !info.Mode().IsRegular() || info.Size() > 4096 {
				continue
			}
			marker, err := os.OpenFile(markerPath, os.O_RDONLY|syscall.O_NONBLOCK, 0)
			if err != nil {
				continue
			}
			opened, err := marker.Stat()
			if err != nil || !os.SameFile(info, opened) {
				marker.Close()
				continue
			}
			data, readErr := io.ReadAll(io.LimitReader(marker, 4097))
			marker.Close()
			if readErr != nil || len(data) > 4096 {
				continue
			}
			var ownership struct {
				Version int    `json:"version"`
				ID      string `json:"operationId"`
			}
			if json.Unmarshal(data, &ownership) != nil || ownership.Version != 1 || ownership.ID != id {
				continue
			}
			if err := os.RemoveAll(candidate); err != nil {
				return nil, err
			}
		}
		return map[string]any{"operationId": id, "released": true}, nil
	}
	select {
	case op.gate <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-op.gate }()
	if op.dir != "" {
		actual, err := filepath.EvalSymlinks(op.dir)
		if err != nil || !samePath(actual, op.dir) || filepath.Dir(actual) != state.root {
			return nil, fmt.Errorf("share private operation directory changed")
		}
		if err := os.RemoveAll(op.dir); err != nil {
			return nil, err
		}
	}
	state.mu.Lock()
	delete(state.operations, id)
	state.mu.Unlock()
	return map[string]any{"operationId": id, "released": true}, nil
}
