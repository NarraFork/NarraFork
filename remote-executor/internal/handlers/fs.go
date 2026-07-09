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
	path, err := h.guardedPath(params, "path")
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{"exists": false, "isDirectory": false, "isFile": false, "size": 0}, nil
		}
		return nil, err
	}
	return map[string]any{
		"exists":      true,
		"isDirectory": info.IsDir(),
		"isFile":      info.Mode().IsRegular(),
		"size":        info.Size(),
	}, nil
}

func (h *Handlers) FsExists(params map[string]any) (any, error) {
	path, err := h.guardedPath(params, "path")
	if err != nil {
		return nil, err
	}
	_, statErr := os.Lstat(path)
	return map[string]any{"exists": statErr == nil}, nil
}

// FsRead reads a file, honouring an optional maxBytes cap.
func (h *Handlers) FsRead(params map[string]any) (any, error) {
	path, err := h.guardedPath(params, "path")
	if err != nil {
		return nil, err
	}
	maxBytes := intParam(params, "maxBytes", h.maxRpcBytes)
	if maxBytes <= 0 || maxBytes > h.maxRpcBytes {
		maxBytes = h.maxRpcBytes
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
	totalSize := info.Size()

	buf := make([]byte, maxBytes)
	n, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return nil, err
	}
	truncated := totalSize > int64(n)

	return map[string]any{
		"dataB64":   base64.StdEncoding.EncodeToString(buf[:n]),
		"truncated": truncated,
		"totalSize": totalSize,
	}, nil
}

// FsWrite writes base64 content to a path (creating parent dirs).
func (h *Handlers) FsWrite(params map[string]any) (any, error) {
	path, err := h.guardedPath(params, "path")
	if err != nil {
		return nil, err
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

func (h *Handlers) FsMkdirp(params map[string]any) (any, error) {
	path, err := h.guardedPath(params, "path")
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(path, 0o755); err != nil {
		return nil, err
	}
	return map[string]any{}, nil
}

func (h *Handlers) FsList(params map[string]any) (any, error) {
	path, err := h.guardedPath(params, "path")
	if err != nil {
		return nil, err
	}
	dirEntries, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}
	entries := make([]map[string]any, 0, len(dirEntries))
	for _, e := range dirEntries {
		entries = append(entries, map[string]any{
			"name":        e.Name(),
			"isDirectory": e.IsDir(),
		})
	}
	return map[string]any{"entries": entries}, nil
}


