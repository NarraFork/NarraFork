//go:build windows

package handlers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"

	"github.com/narrafork/remote-executor/internal/winpty"
)

// PtyOpen uses the native ConPTY worker in the same executor executable. The
// registry is connection-scoped; a reconnect cannot attach or launch by ptyId.
func (h *Handlers) PtyOpen(ctx context.Context, params map[string]any, stream StreamFunc) (any, error) {
	if h.disableShell {
		return nil, fmt.Errorf("shell/PTY execution is disabled on this executor (--disable-shell)")
	}
	if !PtySupported() {
		return nil, fmt.Errorf("native ConPTY requires Windows build 17763 and available APIs")
	}
	id := stringParam(params, "ptyId")
	if id == "" {
		return nil, fmt.Errorf("missing ptyId")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	slot := &ptySession{cancel: cancel}
	h.ptyMu.Lock()
	if h.ptySessions[id] != nil || len(h.ptySessions) >= winpty.MaxSessions {
		h.ptyMu.Unlock()
		return nil, fmt.Errorf("PTY session duplicate or capacity exceeded")
	}
	h.ptySessions[id] = slot
	h.ptyMu.Unlock()
	defer func() {
		h.ptyMu.Lock()
		if h.ptySessions[id] == slot {
			delete(h.ptySessions, id)
		}
		h.ptyMu.Unlock()
	}()
	// Reserve the original connection-scoped request BEFORE path IO so a
	// ready-before-cancel race cannot start an untracked new shell.
	cwd, err := h.guardedExistingPath(params, "cwd")
	if err != nil {
		return nil, err
	}
	command := stringSliceParam(params, "cmd")
	if len(command) == 0 {
		command = interactiveShell()
	}
	cols, rows := intParam(params, "cols", 80), intParam(params, "rows", 24)
	if cols <= 0 || rows <= 0 || cols > 32767 || rows > 32767 {
		return nil, fmt.Errorf("invalid ConPTY dimensions")
	}
	releaseDirectory, err := h.PinNativeDirectoryV2(ctx, params, cwd)
	if err != nil {
		return nil, err
	}
	defer releaseDirectory()
	native, err := winpty.Start(ctx, winpty.Options{Command: command, Cwd: cwd, Env: commandEnv(false, params), Cols: int16(cols), Rows: int16(rows)})
	if native != nil {
		defer native.Close("cancelled")
	}
	if err != nil {
		if native != nil {
			result := native.Wait()
			return lifecycleResult(result), nil
		}
		return nil, err
	}
	h.ptyMu.Lock()
	slot.native = native
	h.ptyMu.Unlock()
	if err = native.Prepare(ctx); err != nil {
		native.Close("startup_failed")
		return lifecycleResult(native.Wait()), nil
	}
	if err = native.Resume(ctx); err != nil {
		native.Close("startup_failed")
		return lifecycleResult(native.Wait()), nil
	}
	releaseDirectory() // Do not keep a mutation-denying cwd pin for the shell lifetime.
	ready, _ := json.Marshal(map[string]any{"version": 1, "ptyId": id, "state": "ready"})
	stream("pty_ready", ready)
	for {
		select {
		case data := <-native.Output():
			stream("pty", data)
		case <-native.Done():
			// Deliver already bounded native output before the final lifecycle result.
			for {
				select {
				case data := <-native.Output():
					stream("pty", data)
				default:
					result := native.Wait()
					if result.Reason == "io_failed" {
						detail, _ := json.Marshal(map[string]any{"reason": "io_failed", "message": "ConPTY IO failed or bounded queue overran"})
						stream("pty_error", detail)
					}
					return lifecycleResult(result), nil
				}
			}
		}
	}
}
func lifecycleResult(result winpty.Result) map[string]any {
	var code any
	if result.ExitCode != nil && result.TreeStopped && result.CleanupComplete {
		code = *result.ExitCode
	}
	reason := result.Reason
	if !result.TreeStopped || !result.CleanupComplete || result.ExitCode == nil {
		reason = "unknown"
	}
	return map[string]any{"exitCode": code, "processExitObserved": result.ExitCode != nil, "treeStopped": result.TreeStopped, "cleanupComplete": result.CleanupComplete, "reason": reason}
}
func (h *Handlers) nativePTY(params map[string]any) (ptyController, error) {
	id := stringParam(params, "ptyId")
	h.ptyMu.Lock()
	defer h.ptyMu.Unlock()
	session := h.ptySessions[id]
	if session == nil || session.native == nil {
		return nil, fmt.Errorf("unknown or unready ptyId %q", id)
	}
	return session.native, nil
}
func (h *Handlers) PtyWrite(params map[string]any) (any, error) {
	encoded := stringParam(params, "dataB64")
	if len(encoded) > base64.StdEncoding.EncodedLen(winpty.MaxInputChunk) {
		return nil, fmt.Errorf("PTY input chunk exceeds 64KiB")
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, err
	}
	session, err := h.nativePTY(params)
	if err != nil {
		return nil, err
	}
	if err = session.Write(data); err != nil {
		return nil, err
	}
	return map[string]any{}, nil
}
func (h *Handlers) PtyResize(params map[string]any) (any, error) {
	cols, rows := intParam(params, "cols", 80), intParam(params, "rows", 24)
	if cols <= 0 || rows <= 0 || cols > 32767 || rows > 32767 {
		return nil, fmt.Errorf("invalid ConPTY dimensions")
	}
	session, err := h.nativePTY(params)
	if err != nil {
		return nil, err
	}
	if err = session.Resize(int16(cols), int16(rows)); err != nil {
		return nil, err
	}
	return map[string]any{}, nil
}
func (h *Handlers) PtyKill(params map[string]any) (any, error) {
	id := stringParam(params, "ptyId")
	h.ptyMu.Lock()
	slot := h.ptySessions[id]
	if slot == nil {
		h.ptyMu.Unlock()
		return nil, fmt.Errorf("unknown ptyId %q", id)
	}
	native, cancel := slot.native, slot.cancel
	h.ptyMu.Unlock()
	if native != nil {
		native.Close("killed")
	} else if cancel != nil {
		cancel()
	}
	return map[string]any{"accepted": true, "state": "closing"}, nil
}
func PtySupported() bool { return winpty.Supported() }
