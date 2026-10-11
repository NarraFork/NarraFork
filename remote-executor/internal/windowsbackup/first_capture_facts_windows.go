//go:build windows

package windowsbackup

import (
	"context"
	"golang.org/x/sys/windows"
	"os"
)

// Ordinary metadata/actual granted rights only. No sentinel, hash, SACL,
// privilege, Snapshot/Capture or source payload IO occurs in preauthorization.
func InspectFirstCaptureOrdinaryHandle(ctx context.Context, file *os.File) (uint32, error) {
	if file == nil {
		return 0, ErrFirstCaptureNotReady
	}
	grant, err := nativeGrantedAccess(windows.Handle(file.Fd()), ctx)
	if err != nil {
		return 0, err
	}
	if grant&FirstCaptureOrdinaryAccess != FirstCaptureOrdinaryAccess {
		return 0, ErrFirstCaptureNotReady
	}
	state, err := inspectStableReadObject(windows.Handle(file.Fd()), ctx)
	if err != nil {
		return 0, err
	}
	if err := verifyStablePhysical(windows.Handle(file.Fd()), state, ctx); err != nil {
		return 0, err
	}
	return grant, ctx.Err()
}
