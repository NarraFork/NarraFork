//go:build windows

package windowsbackup

import (
	"context"
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

// Raw preauthorization open. No OpenObservation, sentinel, payload hash, SD,
// privileged worker, Capture or mutation is permitted here. Native descriptors
// are only ordinary metadata; the helper independently describes/authorizes.
type firstCaptureRawFile struct {
	file     *os.File
	granted  uint32
	ordinary stableReadState
}

func (r *firstCaptureRawFile) Close() error { return r.file.Close() }
func openFirstCaptureRaw(ctx context.Context, path string) (resource *firstCaptureRawFile, resultErr error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	file, err := openOrdinary(path, nativeStreamReadAccess|windows.READ_CONTROL)
	if err != nil {
		return nil, err
	}
	resource = &firstCaptureRawFile{file: file}
	// Error paths either prove close or return the still-owned object to the
	// reserved registry. A failed close cannot drop its resource reference.
	defer func() {
		if resultErr != nil {
			closeErr := file.Close()
			if closeErr == nil {
				resource = nil
			} else {
				resultErr = errors.Join(resultErr, fmt.Errorf("raw ordinary capture close unknown: %w", closeErr))
			}
		}
	}()
	resource.granted, err = nativeGrantedAccess(windows.Handle(file.Fd()), ctx)
	if err != nil {
		return resource, err
	}
	if resource.granted&nativeStreamReadAccess != nativeStreamReadAccess {
		return resource, fmt.Errorf("raw ordinary capture rights unavailable: %w", windows.ERROR_ACCESS_DENIED)
	}
	resource.ordinary, err = inspectStableRead(windows.Handle(file.Fd()), ctx)
	if err != nil {
		return resource, err
	}
	if err := verifyStablePhysical(windows.Handle(file.Fd()), resource.ordinary.stableReadObjectState, ctx); err != nil {
		return resource, err
	}
	if err := ctx.Err(); err != nil {
		return resource, err
	}
	return resource, nil
}
