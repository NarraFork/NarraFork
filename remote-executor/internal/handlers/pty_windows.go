//go:build windows

package handlers

import (
	"context"
	"fmt"
)

// Windows interactive PTY (ConPTY) support is not implemented yet. The methods
// return a clear error; callers must not silently fall back to a local terminal.

func (h *Handlers) PtyOpen(_ context.Context, _ map[string]any, _ StreamFunc) (any, error) {
	if h.disableShell {
		return nil, fmt.Errorf("shell/PTY execution is disabled on this executor (--disable-shell)")
	}
	return nil, fmt.Errorf("interactive PTY is not supported on this executor platform (windows)")
}

func (h *Handlers) PtyWrite(_ map[string]any) (any, error) {
	return nil, fmt.Errorf("interactive PTY is not supported on this executor platform (windows)")
}

func (h *Handlers) PtyResize(_ map[string]any) (any, error) {
	return nil, fmt.Errorf("interactive PTY is not supported on this executor platform (windows)")
}

func (h *Handlers) PtyKill(_ map[string]any) (any, error) {
	return map[string]any{}, nil
}

// PtySupported reports whether interactive PTYs are available on this platform.
func PtySupported() bool { return false }
