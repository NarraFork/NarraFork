package handlers

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const exclusiveCreateMaxBytes = 2000000
const exclusiveCreateMaxPathBytes = 32768
const exclusiveCreateMaxDepth = 128
const exclusiveCreateTimeoutMs = 30000

// BoundParentCreationSupported excludes os.Root platforms that only retain a
// pathname (js/plan9), rather than a directory descriptor/handle. Do not claim
// the stronger protocol capability on untested platforms.
func BoundParentCreationSupported() bool {
	return runtime.GOOS == "linux" || runtime.GOOS == "darwin" || runtime.GOOS == "windows"
}

func exclusiveCreateContext(parent context.Context, params map[string]any) (context.Context, context.CancelFunc, error) {
	timeoutMs := intParam(params, "timeoutMs", exclusiveCreateTimeoutMs)
	if raw, present := params["timeoutMs"]; present {
		switch n := raw.(type) {
		case float64:
			if n != float64(timeoutMs) {
				return nil, nil, fmt.Errorf("invalid exclusive create timeout")
			}
		case int, int64:
		default:
			return nil, nil, fmt.Errorf("invalid exclusive create timeout")
		}
	}
	if timeoutMs <= 0 || timeoutMs > exclusiveCreateTimeoutMs {
		return nil, nil, fmt.Errorf("invalid exclusive create timeout")
	}
	if err := parent.Err(); err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithTimeout(parent, time.Duration(timeoutMs)*time.Millisecond)
	return ctx, cancel, nil
}

func exclusivePathParam(params map[string]any, key string) (string, error) {
	path, err := requiredPathParam(params, key)
	if err != nil {
		return "", err
	}
	if len(path) > exclusiveCreateMaxPathBytes || len(strings.FieldsFunc(path, func(r rune) bool { return r == '/' || r == '\\' })) > exclusiveCreateMaxDepth {
		return "", fmt.Errorf("exclusive create path exceeds path/depth limit")
	}
	return path, nil
}

// openExclusiveParent walks the already-authorized canonical name from its
// volume root. Every next Root is bound before releasing the previous Root.
// Lstat + SameFile verifies the directory object we opened, not just its name;
// os.Root constrains each OpenRoot to that bound parent even during a swap.
// Subsequent creation MUST use this Root and a single leaf, never a full path.
func openExclusiveParent(ctx context.Context, path string) (_ *os.Root, leaf string, err error) {
	if !BoundParentCreationSupported() {
		return nil, "", fmt.Errorf("bound-parent exclusive creation unsupported on %s", runtime.GOOS)
	}
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || len(path) > exclusiveCreateMaxPathBytes {
		return nil, "", fmt.Errorf("exclusive creation requires a canonical absolute path")
	}
	volume := filepath.VolumeName(path)
	rootPath := volume + string(filepath.Separator)
	parts := strings.Split(strings.TrimPrefix(path, rootPath), string(filepath.Separator))
	if len(parts) == 0 || len(parts) > exclusiveCreateMaxDepth {
		return nil, "", fmt.Errorf("exclusive create path exceeds directory depth limit")
	}
	leaf = parts[len(parts)-1]
	if leaf == "" || leaf == "." || leaf == ".." || !filepath.IsLocal(leaf) {
		return nil, "", fmt.Errorf("exclusive creation requires a non-root leaf")
	}
	if err := ctx.Err(); err != nil {
		return nil, "", err
	}
	parent, err := os.OpenRoot(rootPath)
	if err != nil {
		return nil, "", err
	}
	defer func() {
		if err != nil {
			parent.Close()
		}
	}()
	for _, component := range parts[:len(parts)-1] {
		if err = ctx.Err(); err != nil {
			return nil, "", err
		}
		var before os.FileInfo
		before, err = parent.Lstat(component)
		if err != nil {
			return nil, "", err
		}
		if !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
			return nil, "", fmt.Errorf("canonical parent is not an ordinary directory")
		}
		var next *os.Root
		next, err = parent.OpenRoot(component)
		if err != nil {
			return nil, "", err
		}
		opened, statErr := next.Stat(".")
		if statErr != nil || !os.SameFile(before, opened) {
			next.Close()
			return nil, "", fmt.Errorf("canonical parent object changed while binding: %v", statErr)
		}
		parent.Close()
		parent = next
	}
	if err = ctx.Err(); err != nil {
		return nil, "", err
	}
	return parent, leaf, nil
}

func (h *Handlers) exclusiveCreatePath(params map[string]any) (string, error) {
	raw, err := exclusivePathParam(params, "path")
	if err != nil {
		return "", err
	}
	expected, err := exclusivePathParam(params, "expectedResolvedPath")
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(expected) || filepath.Clean(expected) != expected {
		return "", fmt.Errorf("expected resolved path must be canonical and absolute")
	}
	path, err := h.guard.CheckCreate(raw)
	if err != nil {
		return "", err
	}
	if !samePath(path, expected) {
		return "", fmt.Errorf("exclusive create canonical identity changed")
	}
	// CheckCreate checks the nearest existing ancestor; explicitly evaluate the
	// complete name as well, so a deny rule for a missing leaf is not bypassed.
	return h.guard.checkResolved(expected)
}

type exclusiveParentOpener func(context.Context, string) (*os.Root, string, error)

func (h *Handlers) fsWriteExclusive(parent context.Context, params map[string]any) (any, error) {
	return h.fsWriteExclusiveWithParent(parent, params, openExclusiveParent)
}

func (h *Handlers) fsWriteExclusiveWithParent(parent context.Context, params map[string]any, bind exclusiveParentOpener) (any, error) {
	ctx, cancel, err := exclusiveCreateContext(parent, params)
	if err != nil {
		return nil, err
	}
	defer cancel()
	raw, ok := params["dataB64"].(string)
	if !ok || len(raw) > base64.StdEncoding.EncodedLen(exclusiveCreateMaxBytes) {
		return nil, fmt.Errorf("invalid or oversized exclusive content")
	}
	data, err := base64.StdEncoding.DecodeString(raw)
	if err != nil || len(data) > exclusiveCreateMaxBytes || int64(len(data)) > h.maxRpcBytes {
		return nil, fmt.Errorf("invalid or oversized exclusive content")
	}
	release, err := acquireFileMutation(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	path, err := h.exclusiveCreatePath(params)
	if err != nil {
		return nil, err
	}
	root, leaf, err := bind(ctx, path)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	// No MkdirAll: exclusive creation can mutate only this authorized leaf.
	f, err := root.OpenFile(leaf, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	// Once O_EXCL succeeds, finish this bounded <=2 MiB write. Aborting
	// mid-write would leave an ambiguous partial file and invite retries.
	for len(data) > 0 {
		n, err := f.Write(data[:min(len(data), 64*1024)])
		if err != nil {
			return nil, err
		}
		if n == 0 {
			return nil, io.ErrNoProgress
		}
		data = data[n:]
	}
	if err := f.Close(); err != nil {
		return nil, err
	}
	return map[string]any{}, nil
}
