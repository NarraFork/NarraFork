package handlers

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"

	"github.com/narrafork/remote-executor/internal/session"
)

// FeatureSessionDurableV1 advertises the session.* methods: PTY sessions owned
// by the executor process rather than by an RPC or connection, with a
// sequence-numbered output journal that a new connection can resume from.
const FeatureSessionDurableV1 = "session.durable.v1"

var errSessionsUnavailable = errors.New("durable sessions are not available on this executor")

// SetSessionManager installs the process-wide session manager. It is shared by
// every connection, so a reconnect sees the same sessions.
func (h *Handlers) SetSessionManager(m *session.Manager) { h.sessions = m }

// SessionsEnabled reports whether session.* methods are served.
func (h *Handlers) SessionsEnabled() bool { return h.sessions != nil }

func (h *Handlers) sessionManager() (*session.Manager, error) {
	if h.disableShell {
		return nil, fmt.Errorf("shell/PTY execution is disabled on this executor (--disable-shell)")
	}
	if h.sessions == nil {
		return nil, errSessionsUnavailable
	}
	return h.sessions, nil
}

func requiredSessionID(params map[string]any) (string, error) {
	id := stringParam(params, "sessionId")
	if id == "" {
		return "", fmt.Errorf("missing sessionId")
	}
	return id, nil
}

// SessionOpen starts a PTY session and returns as soon as it is running. Unlike
// pty.open, the process is not tied to this request or its connection.
func (h *Handlers) SessionOpen(params map[string]any) (any, error) {
	m, err := h.sessionManager()
	if err != nil {
		return nil, err
	}
	id, err := requiredSessionID(params)
	if err != nil {
		return nil, err
	}
	if kind := stringParam(params, "kind"); kind != "" && kind != "pty" {
		return nil, fmt.Errorf("unsupported session kind %q", kind)
	}
	cwd, err := h.guardedExistingPath(params, "cwd")
	if err != nil {
		return nil, err
	}
	cmdArgs := stringSliceParam(params, "cmd")
	if len(cmdArgs) == 0 {
		shell, _ := loginShell("")
		cmdArgs = []string{shell, "-l"}
	}
	cols := uint16(intParam(params, "cols", 80))
	rows := uint16(intParam(params, "rows", 24))
	env := commandEnv(false, params)
	return m.Open(id, "pty", func() (session.Process, error) {
		return startPtyProcess(cmdArgs, cwd, env, cols, rows)
	})
}

// SessionAttach streams a session's output from params.since until it exits.
// Cancelling the request (or losing the connection) only detaches.
func (h *Handlers) SessionAttach(ctx context.Context, params map[string]any, onStream StreamFunc) (any, error) {
	m, err := h.sessionManager()
	if err != nil {
		return nil, err
	}
	id, err := requiredSessionID(params)
	if err != nil {
		return nil, err
	}
	return m.Attach(ctx, id, intParam(params, "since", 0), func(channel string, chunk []byte) {
		onStream(channel, chunk)
	})
}

// SessionWrite sends input; a repeated writeId is acknowledged without writing.
func (h *Handlers) SessionWrite(params map[string]any) (any, error) {
	m, err := h.sessionManager()
	if err != nil {
		return nil, err
	}
	id, err := requiredSessionID(params)
	if err != nil {
		return nil, err
	}
	data, err := base64.StdEncoding.DecodeString(stringParam(params, "dataB64"))
	if err != nil {
		return nil, fmt.Errorf("invalid base64: %w", err)
	}
	duplicate, err := m.Write(id, data, stringParam(params, "writeId"))
	if err != nil {
		return nil, err
	}
	return map[string]any{"duplicate": duplicate}, nil
}

func (h *Handlers) SessionResize(params map[string]any) (any, error) {
	m, err := h.sessionManager()
	if err != nil {
		return nil, err
	}
	id, err := requiredSessionID(params)
	if err != nil {
		return nil, err
	}
	cols := uint16(intParam(params, "cols", 80))
	rows := uint16(intParam(params, "rows", 24))
	return map[string]any{}, m.Resize(id, cols, rows)
}

func (h *Handlers) SessionKill(params map[string]any) (any, error) {
	m, err := h.sessionManager()
	if err != nil {
		return nil, err
	}
	id, err := requiredSessionID(params)
	if err != nil {
		return nil, err
	}
	return map[string]any{}, m.Kill(id, boolParam(params, "release"))
}

func (h *Handlers) SessionInfo(params map[string]any) (any, error) {
	m, err := h.sessionManager()
	if err != nil {
		return nil, err
	}
	id, err := requiredSessionID(params)
	if err != nil {
		return nil, err
	}
	return m.Info(id)
}

func (h *Handlers) SessionList(params map[string]any) (any, error) {
	m, err := h.sessionManager()
	if err != nil {
		return nil, err
	}
	return map[string]any{"sessions": m.List()}, nil
}

func (h *Handlers) SessionRelease(params map[string]any) (any, error) {
	m, err := h.sessionManager()
	if err != nil {
		return nil, err
	}
	id, err := requiredSessionID(params)
	if err != nil {
		return nil, err
	}
	return map[string]any{}, m.Release(id)
}
