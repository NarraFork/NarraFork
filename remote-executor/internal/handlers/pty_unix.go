//go:build !windows

package handlers

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"sync"

	"github.com/creack/pty"
)

// ptySession tracks a live PTY on the executor.
type ptySession struct {
	ptmx *os.File
	cmd  *exec.Cmd
}

var (
	ptyMu       sync.Mutex
	ptySessions = map[string]*ptySession{}
)

// PtyOpen starts a shell attached to a new PTY and streams its output back via
// the stream callback (channel "pty") until the shell exits. It blocks until
// exit, then returns the exit code — mirroring exec.start's long-RPC shape.
func (h *Handlers) PtyOpen(ctx context.Context, params map[string]any, onStream StreamFunc) (any, error) {
	ptyID := stringParam(params, "ptyId")
	if ptyID == "" {
		return nil, fmt.Errorf("missing ptyId")
	}
	cwd, err := h.guardedPath(params, "cwd")
	if err != nil {
		return nil, err
	}
	cmdArgs := stringSliceParam(params, "cmd")
	if len(cmdArgs) == 0 {
		shell, args := loginShell("")
		cmdArgs = append([]string{shell}, args...)
		// Drop the trailing "-c ''" from loginShell — for a PTY we want an
		// interactive login shell, not a one-shot command.
		cmdArgs = []string{shell, "-l"}
	}
	cols := uint16(intParam(params, "cols", 80))
	rows := uint16(intParam(params, "rows", 24))

	cmd := exec.CommandContext(ctx, cmdArgs[0], cmdArgs[1:]...)
	cmd.Dir = cwd
	cmd.Env = commandEnv(false, params)

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, err
	}

	session := &ptySession{ptmx: ptmx, cmd: cmd}
	ptyMu.Lock()
	ptySessions[ptyID] = session
	ptyMu.Unlock()

	defer func() {
		ptyMu.Lock()
		delete(ptySessions, ptyID)
		ptyMu.Unlock()
		_ = ptmx.Close()
	}()

	// Kill the PTY when the context is cancelled (server sent rpc_cancel).
	go func() {
		<-ctx.Done()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = ptmx.Close()
	}()

	// Stream output until EOF (shell exit).
	buf := make([]byte, 32*1024)
	for {
		n, readErr := ptmx.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			onStream("pty", chunk)
		}
		if readErr != nil {
			break
		}
	}

	waitErr := cmd.Wait()
	exitCode := exitCodeFromError(waitErr, cmd)
	return map[string]any{"exitCode": exitCode}, nil
}

// PtyWrite writes bytes to a live PTY's stdin.
func (h *Handlers) PtyWrite(params map[string]any) (any, error) {
	ptyID := stringParam(params, "ptyId")
	dataB64 := stringParam(params, "dataB64")
	data, err := base64.StdEncoding.DecodeString(dataB64)
	if err != nil {
		return nil, fmt.Errorf("invalid base64: %w", err)
	}
	ptyMu.Lock()
	session := ptySessions[ptyID]
	ptyMu.Unlock()
	if session == nil {
		return nil, fmt.Errorf("unknown ptyId %q", ptyID)
	}
	if _, err := session.ptmx.Write(data); err != nil {
		return nil, err
	}
	return map[string]any{}, nil
}

// PtyResize changes a live PTY's window size.
func (h *Handlers) PtyResize(params map[string]any) (any, error) {
	ptyID := stringParam(params, "ptyId")
	cols := uint16(intParam(params, "cols", 80))
	rows := uint16(intParam(params, "rows", 24))
	ptyMu.Lock()
	session := ptySessions[ptyID]
	ptyMu.Unlock()
	if session == nil {
		return nil, fmt.Errorf("unknown ptyId %q", ptyID)
	}
	if err := pty.Setsize(session.ptmx, &pty.Winsize{Cols: cols, Rows: rows}); err != nil {
		return nil, err
	}
	return map[string]any{}, nil
}

// PtyKill terminates a live PTY.
func (h *Handlers) PtyKill(params map[string]any) (any, error) {
	ptyID := stringParam(params, "ptyId")
	ptyMu.Lock()
	session := ptySessions[ptyID]
	ptyMu.Unlock()
	if session == nil {
		return map[string]any{}, nil
	}
	if session.cmd.Process != nil {
		_ = session.cmd.Process.Kill()
	}
	_ = session.ptmx.Close()
	return map[string]any{}, nil
}

// PtySupported reports whether interactive PTYs are available on this platform.
func PtySupported() bool { return true }
