// Package handlers implements the RPC methods the executor exposes: filesystem
// primitives, glob, grep, command execution, and git diagnostics. Each method
// takes decoded params and returns a JSON-serialisable result or an error.
package handlers

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"

	"github.com/narrafork/remote-executor/internal/history"
)

// StreamFunc is invoked by streaming methods (exec) to push output chunks back
// to the server. channel is "stdout" or "stderr".
type StreamFunc func(channel string, chunk []byte)

// ptyController is platform-neutral: Windows sessions own a Job/worker rather
// than a POSIX fd. Existing Unix state remains untouched for compatibility.
type ptyController interface {
	Write([]byte) error
	Resize(int16, int16) error
	Close(string)
}

type ptySession struct {
	ptmx   *os.File
	cmd    *exec.Cmd
	native ptyController
	cancel func() // Windows pending spawn cancellation; nil for legacy Unix.
}

// Handlers holds executor state (path guard + limits). PTY sessions are scoped
// to one transport connection so a reconnect cannot access or replace an old
// connection's terminals.
type Handlers struct {
	guard            *PathGuard
	maxRpcBytes      int64
	disableShell     bool
	history          *history.Manager
	worktreeStateDir string
	shareStateDir    string
	shareRegistry    *shareArchiveRegistry
	attachments      *attachmentRegistry
	firstCapture     WindowsFirstCaptureExecutor

	ptyMu       sync.Mutex
	ptySessions map[string]*ptySession
}

func New(guard *PathGuard, maxRpcBytes int64) *Handlers {
	if maxRpcBytes <= 0 {
		maxRpcBytes = 10 * 1024 * 1024
	}
	return &Handlers{
		guard:       guard,
		maxRpcBytes: maxRpcBytes,
		ptySessions: make(map[string]*ptySession),
	}
}

// NewWithOptions creates a Handlers with additional options.
func NewWithOptions(guard *PathGuard, maxRpcBytes int64, disableShell bool) *Handlers {
	h := New(guard, maxRpcBytes)
	h.disableShell = disableShell
	return h
}

// ConnectionScoped returns a handler set with the same immutable configuration
// and a fresh PTY registry for one transport connection.
func (h *Handlers) ConnectionScoped() *Handlers {
	connection := NewWithOptions(h.guard, h.maxRpcBytes, h.disableShell)
	connection.history = h.history
	connection.worktreeStateDir = h.worktreeStateDir
	connection.shareStateDir = h.shareStateDir
	connection.shareRegistry = h.shareRegistry
	connection.attachments = h.attachments
	connection.firstCapture = h.firstCapture
	return connection
}

func requiredPathParam(params map[string]any, key string) (string, error) {
	raw, ok := params[key].(string)
	if !ok || raw == "" {
		return "", fmt.Errorf("missing %q parameter", key)
	}
	if strings.ContainsRune(raw, 0) {
		return "", fmt.Errorf("invalid %q parameter: path contains NUL byte", key)
	}
	return raw, nil
}

func (h *Handlers) guardedExistingPath(params map[string]any, key string) (string, error) {
	raw, err := requiredPathParam(params, key)
	if err != nil {
		return "", err
	}
	path, err := h.guard.CheckExisting(raw)
	if err != nil {
		return "", err
	}
	if err := h.ValidateExpectedNativeDescriptor(context.Background(), params, path, "existing"); err != nil {
		return "", err
	}
	return path, nil
}

func (h *Handlers) guardedCreatePath(params map[string]any, key string) (string, error) {
	raw, err := requiredPathParam(params, key)
	if err != nil {
		return "", err
	}
	path, err := h.guard.CheckCreate(raw)
	if err != nil {
		return "", err
	}
	if err := h.ValidateExpectedNativeDescriptor(context.Background(), params, path, "create"); err != nil {
		return "", err
	}
	return path, nil
}

func stringParam(params map[string]any, key string) string {
	if v, ok := params[key].(string); ok {
		return v
	}
	return ""
}

func boolParam(params map[string]any, key string) bool {
	if v, ok := params[key].(bool); ok {
		return v
	}
	return false
}

// intParam reads a numeric param (JSON numbers decode to float64) with a default.
func intParam(params map[string]any, key string, def int64) int64 {
	switch v := params[key].(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	case int:
		return int64(v)
	default:
		return def
	}
}

// stringSliceParam reads a []string param (JSON arrays decode to []any).
func stringSliceParam(params map[string]any, key string) []string {
	raw, ok := params[key].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, v := range raw {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}
