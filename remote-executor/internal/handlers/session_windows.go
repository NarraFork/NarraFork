//go:build windows

package handlers

import (
	"fmt"

	"github.com/narrafork/remote-executor/internal/session"
)

// Durable sessions need ConPTY, which this executor does not implement yet; the
// session manager is not installed on Windows, so this is never reached there.
func startPtyProcess(_ []string, _ string, _ []string, _, _ uint16) (session.Process, error) {
	return nil, fmt.Errorf("interactive PTY is not supported on this executor platform (windows)")
}
