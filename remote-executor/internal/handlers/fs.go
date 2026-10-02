package handlers

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// Serializes executor-managed mutations, including ordinary writes and transfer commits.
// External editors/processes do not participate; this is NOT an OS-level CAS.
var fileMutationGate = make(chan struct{}, 1)

func acquireFileMutation(ctx context.Context) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	select {
	case fileMutationGate <- struct{}{}:
		if err := ctx.Err(); err != nil {
			<-fileMutationGate
			return nil, err
		}
		return func() { <-fileMutationGate }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// FsStat returns existence + type + size for a path.
func (h *Handlers) FsStat(params map[string]any) (any, error) {
	path, err := h.guardedCreatePath(params, "path")
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{
				"exists":       false,
				"isDirectory":  false,
				"isFile":       false,
				"size":         0,
				"resolvedPath": path,
			}, nil
		}
		return nil, err
	}
	return map[string]any{
		"exists":       true,
		"isDirectory":  info.IsDir(),
		"isFile":       info.Mode().IsRegular(),
		"size":         info.Size(),
		"resolvedPath": path,
	}, nil
}

func (h *Handlers) FsExists(params map[string]any) (any, error) {
	path, err := h.guardedCreatePath(params, "path")
	if err != nil {
		return nil, err
	}
	_, statErr := os.Lstat(path)
	return map[string]any{"exists": statErr == nil}, nil
}

// openReadFile opens the guarded path and, when expectedResolvedPath is supplied,
// proves that the opened object still corresponds to that previously authorized
// canonical identity. The second resolution plus os.SameFile closes races where a
// symlink or parent directory changes after the first resolution but before open.
func (h *Handlers) openReadFile(params map[string]any) (*os.File, string, error) {
	rawPath, err := requiredPathParam(params, "path")
	if err != nil {
		return nil, "", err
	}
	resolvedPath, err := h.guard.CheckExisting(rawPath)
	if err != nil {
		return nil, "", err
	}

	expectedPath := stringParam(params, "expectedResolvedPath")
	if expectedPath != "" {
		expectedPath, err = absolutePath(expectedPath)
		if err != nil {
			return nil, "", fmt.Errorf("invalid expected resolved path: %w", err)
		}
		if !samePath(resolvedPath, expectedPath) {
			return nil, "", fmt.Errorf(
				"resolved path identity mismatch: expected %q, got %q",
				expectedPath,
				resolvedPath,
			)
		}
	}

	flags := os.O_RDONLY
	if expectedPath != "" {
		// POSIX FIFOs swapped in after stat must not hang open before type checking.
		// Windows ignores O_NONBLOCK; its regular-file validation still applies.
		flags |= syscall.O_NONBLOCK
	}
	f, err := os.OpenFile(resolvedPath, flags, 0)
	if err != nil {
		return nil, "", err
	}
	if expectedPath == "" {
		return f, resolvedPath, nil
	}

	openedInfo, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, "", err
	}
	currentResolvedPath, err := h.guard.CheckExisting(rawPath)
	if err != nil {
		f.Close()
		return nil, "", err
	}
	if !samePath(currentResolvedPath, expectedPath) {
		f.Close()
		return nil, "", fmt.Errorf(
			"resolved path identity changed while opening: expected %q, got %q",
			expectedPath,
			currentResolvedPath,
		)
	}
	currentInfo, err := os.Stat(currentResolvedPath)
	if err != nil {
		f.Close()
		return nil, "", err
	}
	if !os.SameFile(openedInfo, currentInfo) {
		f.Close()
		return nil, "", fmt.Errorf("opened file identity no longer matches %q", expectedPath)
	}
	return f, currentResolvedPath, nil
}

// FsRead reads a file, honouring an optional maxBytes cap. When
// expectedResolvedPath is present, no bytes are returned unless openReadFile has
// atomically verified the opened object against that canonical identity.
func (h *Handlers) FsRead(params map[string]any) (any, error) {
	return h.FsReadContext(context.Background(), params)
}

// FsReadContext preserves the wire result while making protected reads cancellable.
// The extra byte detects growth, and the final identity check precedes serialization.
func (h *Handlers) FsReadContext(parent context.Context, params map[string]any) (any, error) {
	if err := parent.Err(); err != nil {
		return nil, err
	}
	timeoutMs := intParam(params, "timeoutMs", 120000)
	if timeoutMs <= 0 || timeoutMs > 120000 {
		return nil, fmt.Errorf("invalid read timeout")
	}
	ctx, cancel := context.WithTimeout(parent, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	f, resolvedPath, err := h.openReadFile(params)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	// Closing on cancellation also unblocks filesystems whose reads are pollable.
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			f.Close()
		case <-done:
		}
	}()
	maxBytes := intParam(params, "maxBytes", h.maxRpcBytes)
	if maxBytes <= 0 || maxBytes > h.maxRpcBytes {
		maxBytes = h.maxRpcBytes
	}
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("refusing to read non-regular file")
	}
	check := func() error {
		if err := parent.Err(); err != nil {
			return err
		}
		return ctx.Err()
	}
	buf, probeTruncated, err := readFileChunks(ctx, f, maxBytes, check)
	if err != nil {
		return nil, err
	}
	finalInfo, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if stringParam(params, "expectedResolvedPath") != "" {
		currentPath, err := h.guard.CheckExisting(stringParam(params, "path"))
		if err != nil {
			return nil, err
		}
		if !samePath(currentPath, resolvedPath) {
			return nil, fmt.Errorf("resolved path changed while reading")
		}
		currentInfo, err := os.Stat(currentPath)
		if err != nil {
			return nil, err
		}
		if !os.SameFile(info, currentInfo) || !os.SameFile(finalInfo, currentInfo) {
			return nil, fmt.Errorf("opened file identity changed while reading")
		}
	}
	if err := check(); err != nil {
		return nil, err
	}
	totalSize := info.Size()
	if finalInfo.Size() > totalSize {
		totalSize = finalInfo.Size()
	}
	if int64(len(buf)) > totalSize {
		totalSize = int64(len(buf))
	}
	return map[string]any{
		"dataB64":      base64.StdEncoding.EncodeToString(buf),
		"truncated":    probeTruncated || totalSize > int64(len(buf)),
		"totalSize":    totalSize,
		"resolvedPath": resolvedPath,
	}, nil
}

func readFileChunks(ctx context.Context, reader io.Reader, maxBytes int64, check func() error) ([]byte, bool, error) {
	buf := make([]byte, maxBytes+1)
	n := 0
	for n < len(buf) {
		if err := check(); err != nil {
			return nil, false, err
		}
		end := n + 64*1024
		if end > len(buf) {
			end = len(buf)
		}
		count, err := reader.Read(buf[n:end])
		n += count
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			if ctx.Err() != nil {
				return nil, false, ctx.Err()
			}
			return nil, false, err
		}
		if count == 0 {
			return nil, false, io.ErrNoProgress
		}
	}
	if err := check(); err != nil {
		return nil, false, err
	}
	truncated := int64(n) > maxBytes
	if truncated {
		n = int(maxBytes)
	}
	return buf[:n], truncated, nil
}

// FsWrite writes base64 content to a path (creating parent dirs). When
// expectedResolvedPath is present, the lexical path must still resolve to the
// previously authorized canonical create/existing identity.
func (h *Handlers) FsWrite(params map[string]any) (any, error) {
	return h.FsWriteContext(context.Background(), params)
}

func (h *Handlers) FsWriteContext(ctx context.Context, params map[string]any) (any, error) {
	release, err := acquireFileMutation(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	rawPath, err := requiredPathParam(params, "path")
	if err != nil {
		return nil, err
	}
	path, err := h.guard.CheckCreate(rawPath)
	if err != nil {
		return nil, err
	}
	expectedPath := stringParam(params, "expectedResolvedPath")
	if expectedPath != "" {
		expectedPath, err = absolutePath(expectedPath)
		if err != nil {
			return nil, fmt.Errorf("invalid expected resolved path: %w", err)
		}
		guardedExpected, guardErr := h.guard.CheckCreate(expectedPath)
		if guardErr != nil {
			return nil, fmt.Errorf("expected resolved path is not allowed: %w", guardErr)
		}
		if !samePath(path, guardedExpected) || !samePath(guardedExpected, expectedPath) {
			return nil, fmt.Errorf(
				"resolved path identity mismatch before write: expected %q, got %q",
				expectedPath,
				path,
			)
		}
		path = guardedExpected
	}
	dataB64, _ := params["dataB64"].(string)
	data, err := base64.StdEncoding.DecodeString(dataB64)
	if err != nil {
		return nil, fmt.Errorf("invalid base64 content: %w", err)
	}
	if int64(len(data)) > h.maxRpcBytes {
		return nil, fmt.Errorf("write exceeds max RPC bytes (%d)", h.maxRpcBytes)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return nil, err
	}
	return map[string]any{}, nil
}

// FsWriteConditional checks content and canonical identity before a platform-native
// replacement. Windows additionally verifies merged permissions and keeps recovery
// material if a native replacement cannot be safely rolled back.
// Rechecks reduce external races but cannot exclude an external writer between the
// final check and rename. Never advertised as OS CAS. Cancellation after rename
// may lose the reply; callers must not retry automatically.
func (h *Handlers) FsWriteConditional(ctx context.Context, params map[string]any) (any, error) {
	const limit = 2000000
	timeoutMs := intParam(params, "timeoutMs", 30000)
	if timeoutMs <= 0 || timeoutMs > 30000 {
		return nil, fmt.Errorf("invalid conditional write timeout")
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	release, err := acquireFileMutation(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	decode := func(key string) ([]byte, error) {
		raw, ok := params[key].(string)
		if !ok || len(raw) > base64.StdEncoding.EncodedLen(limit) {
			return nil, fmt.Errorf("invalid or oversized %s", key)
		}
		data, err := base64.StdEncoding.DecodeString(raw)
		if err != nil || len(data) > limit || int64(len(data)) > h.maxRpcBytes {
			return nil, fmt.Errorf("invalid or oversized %s", key)
		}
		return data, nil
	}
	data, err := decode("dataB64")
	if err != nil {
		return nil, err
	}
	var expected []byte
	expectedMissing := params["expectedDataB64"] == nil
	if _, present := params["expectedDataB64"]; !present {
		return nil, fmt.Errorf("expectedDataB64 required")
	}
	if !expectedMissing {
		expected, err = decode("expectedDataB64")
		if err != nil {
			return nil, err
		}
	}
	raw, err := requiredPathParam(params, "path")
	if err != nil {
		return nil, err
	}
	expectedPath, err := requiredPathParam(params, "expectedResolvedPath")
	if err != nil {
		return nil, err
	}
	expectedPath, err = absolutePath(expectedPath)
	if err != nil {
		return nil, err
	}
	path, err := h.guard.CheckCreate(raw)
	if err != nil {
		return nil, err
	}
	if !samePath(path, expectedPath) {
		return map[string]any{"applied": false, "conflict": true}, nil
	}
	var originalMetadata conditionalMetadata
	var originalInfo os.FileInfo
	conflict := func() (bool, os.FileMode, error) {
		if err := ctx.Err(); err != nil {
			return false, 0, err
		}
		resolved, err := h.guard.CheckCreate(raw)
		if err != nil {
			return false, 0, err
		}
		if !samePath(resolved, expectedPath) {
			return true, 0, nil
		}
		f, _, err := h.openReadFile(params)
		if errors.Is(err, os.ErrNotExist) {
			return !expectedMissing || originalInfo != nil, 0o644, nil
		}
		if err != nil {
			return false, 0, err
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			return false, 0, err
		}
		if !info.Mode().IsRegular() {
			return false, 0, fmt.Errorf("conditional write requires regular file")
		}
		if expectedMissing || info.Size() > limit {
			return true, info.Mode(), nil
		}
		observed, err := io.ReadAll(io.LimitReader(f, limit+1))
		if err != nil {
			return false, 0, err
		}
		if err := ctx.Err(); err != nil {
			return false, 0, err
		}
		if !bytes.Equal(observed, expected) {
			return true, 0, nil
		}
		if originalInfo != nil {
			if !os.SameFile(originalInfo, info) {
				return true, 0, nil
			}
			if err := originalMetadata.matches(f); err != nil {
				if errors.Is(err, errConditionalMetadataChanged) {
					return true, 0, nil
				}
				return false, 0, err
			}
		} else {
			originalMetadata, err = captureConditionalMetadata(f, ctx)
			if err != nil {
				if errors.Is(err, errConditionalMetadataChanged) {
					return true, 0, nil
				}
				return false, 0, err
			}
			originalInfo = info
		}
		return false, info.Mode().Perm(), nil
	}
	changed, mode, err := conflict()
	if err != nil {
		return nil, err
	}
	if changed {
		return map[string]any{"applied": false, "conflict": true}, nil
	}
	// Parent must already exist; implicit mkdir could alter authorization identity.
	tmp, err := os.CreateTemp(filepath.Dir(path), ".nf-conditional-*")
	if err != nil {
		return nil, err
	}
	var tmpInfo os.FileInfo
	defer func() {
		// Windows CreateTemp does not share DELETE. Close before opening the
		// identity-bound cleanup handle, including on pre-commit failures.
		tmp.Close()
		if tmpInfo != nil {
			// Native commit can consume the pathname; preserve any new occupant.
			removeConditionalTemporary(tmp.Name(), tmpInfo)
		}
	}()
	tmpInfo, err = tmp.Stat()
	if err != nil {
		return nil, fmt.Errorf("cannot bind temporary identity; retained %q: %w", tmp.Name(), err)
	}
	if _, err := tmp.Write(data); err != nil {
		return nil, err
	}
	// Apply metadata only after writing: chown/writes can clear special bits and
	// security attributes. Unsupported preservation fails before touching path.
	if originalMetadata != nil {
		if err := originalMetadata.apply(tmp); err != nil {
			return nil, err
		}
	} else if err := tmp.Chmod(mode); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := tmp.Sync(); err != nil {
		return nil, err
	}
	if err := tmp.Close(); err != nil {
		return nil, err
	}
	changed, _, err = conflict()
	if err != nil {
		return nil, err
	}
	if changed {
		return map[string]any{"applied": false, "conflict": true}, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := commitConditionalReplacement(ctx, path, tmp.Name(), originalInfo, originalMetadata, data); err != nil {
		if errors.Is(err, errConditionalMetadataChanged) {
			return map[string]any{"applied": false, "conflict": true}, nil
		}
		return nil, err
	}
	return map[string]any{"applied": true}, nil
}

// FsRemove removes one file. Missing paths are a no-op; directories are rejected.
func (h *Handlers) FsRemove(params map[string]any) (any, error) {
	return h.FsRemoveContext(context.Background(), params)
}

func (h *Handlers) FsRemoveContext(ctx context.Context, params map[string]any) (any, error) {
	release, err := acquireFileMutation(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	rawPath, err := requiredPathParam(params, "path")
	if err != nil {
		return nil, err
	}
	path, err := h.guard.CheckRemove(rawPath)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{}, nil
		}
		return nil, err
	}
	if info.IsDir() {
		return nil, fmt.Errorf("refusing to remove directory %q", path)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := os.Remove(path); err != nil {
		return nil, err
	}
	return map[string]any{}, nil
}

func (h *Handlers) FsMkdirp(params map[string]any) (any, error) {
	path, err := h.guardedCreatePath(params, "path")
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(path, 0o755); err != nil {
		return nil, err
	}
	return map[string]any{}, nil
}

// maxSymlinkProbes bounds the extra stat calls one FsList may spend classifying
// symlinks. Only symlinked entries are probed, so an ordinary directory costs
// nothing; the cap protects against a directory holding tens of thousands of links
// (each stat is a syscall, and a round trip on a network filesystem).
const maxSymlinkProbes = 1000

// FsList lists one directory level.
//
// Symlinks need an extra resolution step because os.ReadDir reports lstat-derived
// types: a link pointing at a directory answers IsDir() == false. Reporting those
// as non-directories made every symlinked directory invisible in the interactive
// directory picker, which only shows entries with isDirectory == true.
//
// Resolution goes through the PathGuard rather than a bare os.Stat: a symlink may
// point outside allowRoots, and such an entry would be refused the moment the user
// tried to descend into it. Dropping it here is more honest than offering an entry
// that cannot be opened. Links that dangle, cycle, or resolve outside the guard are
// skipped without failing the listing.
func (h *Handlers) FsList(params map[string]any) (any, error) {
	path, err := h.guardedExistingPath(params, "path")
	if err != nil {
		return nil, err
	}
	dirEntries, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}
	entries := make([]map[string]any, 0, len(dirEntries))
	probesLeft := maxSymlinkProbes
	for _, e := range dirEntries {
		if e.Type()&os.ModeSymlink == 0 {
			entries = append(entries, map[string]any{
				"name":        e.Name(),
				"isDirectory": e.IsDir(),
				"isSymlink":   false,
			})
			continue
		}
		if probesLeft <= 0 {
			continue
		}
		probesLeft--
		resolved, guardErr := h.guard.CheckExisting(filepath.Join(path, e.Name()))
		if guardErr != nil {
			// Dangling link, or a target outside an allowed root.
			continue
		}
		info, statErr := os.Stat(resolved)
		if statErr != nil {
			continue
		}
		entries = append(entries, map[string]any{
			"name":        e.Name(),
			"isDirectory": info.IsDir(),
			"isSymlink":   true,
		})
	}
	return map[string]any{"entries": entries}, nil
}
