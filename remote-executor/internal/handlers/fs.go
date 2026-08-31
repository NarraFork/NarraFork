package handlers

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

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

	f, err := os.Open(resolvedPath)
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
	f, resolvedPath, err := h.openReadFile(params)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	maxBytes := intParam(params, "maxBytes", h.maxRpcBytes)
	if maxBytes <= 0 || maxBytes > h.maxRpcBytes {
		maxBytes = h.maxRpcBytes
	}

	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	totalSize := info.Size()

	buf := make([]byte, maxBytes)
	n, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return nil, err
	}
	truncated := totalSize > int64(n)

	return map[string]any{
		"dataB64":      base64.StdEncoding.EncodeToString(buf[:n]),
		"truncated":    truncated,
		"totalSize":    totalSize,
		"resolvedPath": resolvedPath,
	}, nil
}

// FsWrite writes base64 content to a path (creating parent dirs). When
// expectedResolvedPath is present, the lexical path must still resolve to the
// previously authorized canonical create/existing identity.
func (h *Handlers) FsWrite(params map[string]any) (any, error) {
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
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return nil, err
	}
	return map[string]any{}, nil
}

// FsRemove removes one file. Missing paths are a no-op; directories are rejected.
func (h *Handlers) FsRemove(params map[string]any) (any, error) {
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
