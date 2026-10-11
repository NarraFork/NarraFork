//go:build windows

package windowsbackup

import (
	"os"
	"strconv"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Test-only evidence at the two existing native Capture boundaries. These
// routines never issue an extra Capture, alter timestamps/SD, substitute native
// identity, retry, or affect the helper's strict success/failure decision. They
// retain only the latest observation and emit at most twelve bounded reports.
type preparedCaptureDiagnostic struct {
	t                *testing.T
	file             *os.File
	observation      NativeObservation
	snapshot         *Snapshot
	afterMainRead    basicInformation
	afterMainReadErr error
	count            int
	statusFile       *os.File
	statusExpected   *Snapshot
	statusPhase      string
	statusReports    int
	retryLast        *stableReadObjectState
	retryEvents      int
}

func (d *preparedCaptureDiagnostic) observed(action string, f *os.File, o NativeObservation, s *Snapshot) {
	d.file, d.observation, d.snapshot = f, o, s
	d.afterMainRead = basicInformation{}
	d.afterMainReadErr = windows.GetFileInformationByHandleEx(windows.Handle(f.Fd()), windows.FileBasicInfo, (*byte)(unsafe.Pointer(&d.afterMainRead)), uint32(unsafe.Sizeof(d.afterMainRead)))
	if action == "status_original" && f == d.statusFile && d.statusExpected != nil && d.statusReports < 4 {
		d.statusReports++
		expected, expectedErr := SnapshotFingerprint(d.statusExpected)
		current, currentErr := SnapshotFingerprint(s)
		d.t.Logf("prepared.status phase=%s existingObserveCapture=true expectedFingerprint=%s currentFingerprint=%s observationFingerprint=%s exact=%t expectedValid=%t currentValid=%t", d.statusPhase, expected, current, o.MetadataHash, expected == current, expectedErr == nil, currentErr == nil)
		for _, line := range redactedSnapshotDiagnostic(d.statusExpected, s) {
			d.t.Logf("prepared.status.%s", line)
		}
		for _, line := range redactedSecurityDiagnostic(d.statusExpected, s) {
			d.t.Logf("prepared.status.%s", line)
		}
		d.checkpoint("status-after-existing-Observe", f)
	}
}

// Read metadata attributes only; never run an extra Capture to make a fresh
// digest. The logged cached digest is explicitly the last existing Observe.
func (d *preparedCaptureDiagnostic) retryCheckpoint(phase string, f *os.File, force bool) {
	if d.t == nil || d.retryEvents >= 160 {
		return
	}
	d.retryEvents++
	state, err := inspectStableReadObject(windows.Handle(f.Fd()))
	if err != nil {
		d.t.Logf("prepared.retry event=%d phase=%s nativeQueryFailed=true win32=%d", d.retryEvents, phase, win32Code(err))
		return
	}
	changed := d.retryLast != nil && *d.retryLast != state
	if force || changed {
		d.t.Logf("prepared.retry event=%d phase=%s changedSincePreviousBoundary=%t observedAtUnixNano=%d creation=%d access=%d write=%d change=%d attributes=0x%08x", d.retryEvents, phase, changed, time.Now().UnixNano(), state.Basic.Creation, state.Basic.Access, state.Basic.Write, state.Basic.Change, state.Basic.Attributes)
	}
	d.retryLast = &state
}

func (d *preparedCaptureDiagnostic) checkpoint(phase string, f *os.File) {
	if d.t == nil {
		return
	}
	state, err := inspectStableReadObject(windows.Handle(f.Fd()))
	if err != nil {
		d.t.Logf("prepared.storeCheckpoint phase=%s nativeQueryFailed=true win32=%d", phase, win32Code(err))
		return
	}
	cached := "unavailable"
	if d.file == f && d.snapshot != nil {
		cached, _ = SnapshotFingerprint(d.snapshot)
	}
	expected := "unavailable"
	if d.statusExpected != nil {
		expected, _ = SnapshotFingerprint(d.statusExpected)
	}
	d.t.Logf("prepared.storeCheckpoint phase=%s volume=%016x fileID128=%x creation=%d access=%d write=%d change=%d attributes=0x%08x lastExistingObserveFingerprint=%s historicalFingerprint=%s cachedDigestNotRecaptured=true", phase, state.ID.Volume, state.ID.ID, state.Basic.Creation, state.Basic.Access, state.Basic.Write, state.Basic.Change, state.Basic.Attributes, cached, expected)
}

func (d *preparedCaptureDiagnostic) captured(f *os.File, s *Snapshot) {
	if d.t == nil || d.file != f || d.snapshot == nil || s == nil || d.count >= 12 {
		return
	}
	beforeFingerprint, beforeErr := SnapshotFingerprint(d.snapshot)
	afterFingerprint, afterErr := SnapshotFingerprint(s)
	matches := beforeErr == nil && afterErr == nil && beforeFingerprint == afterFingerprint && d.observation.MetadataHash == afterFingerprint && d.observation.Target.CreationTime == strconv.FormatUint(s.Creation, 10)
	// Also report the first three stable comparisons; a successful multi-capture
	// run must provide explicit stability evidence, not merely suppress failures.
	if matches && d.count >= 3 {
		return
	}
	d.count++
	d.t.Logf("prepared.capture[%d]: strictMatrixAndCreationEqual=%t observedFingerprint=%s observedSnapshotFingerprint=%s capturedSnapshotFingerprint=%s observedFingerprintValid=%t capturedFingerprintValid=%t", d.count, matches, d.observation.MetadataHash, beforeFingerprint, afterFingerprint, beforeErr == nil, afterErr == nil)
	d.t.Logf("prepared.capture[%d].creation: observedNative=%s observedSnapshot=%d capturedSnapshot=%d", d.count, d.observation.Target.CreationTime, d.snapshot.Creation, s.Creation)
	for _, line := range redactedSnapshotDiagnostic(d.snapshot, s) {
		d.t.Logf("prepared.capture[%d].%s", d.count, line)
	}
	for _, line := range redactedSecurityDiagnostic(d.snapshot, s) {
		d.t.Logf("prepared.capture[%d].%s", d.count, line)
	}
	if d.afterMainReadErr == nil {
		b := d.afterMainRead
		d.t.Logf("prepared.capture[%d].afterMainStreamRead: Creation=%d LastAccess=%d LastWrite=%d ChangeTime=%d Attributes=0x%08x", d.count, b.Creation, b.Access, b.Write, b.Change, b.Attributes)
	} else {
		d.t.Logf("prepared.capture[%d].afterMainStreamRead: nativeBasicQueryFailed=true", d.count)
	}
	d.tuple("observedRoot", d.observation.Root)
	d.tuple("observedParent", d.observation.Parent)
	d.tuple("observedTarget", d.observation.Target)
	actual, err := preparedNativeDescriptor(f)
	if err != nil {
		d.t.Logf("prepared.capture[%d].actualOrdinaryTarget: nativeTupleQueryFailed=true", d.count)
	} else {
		d.tuple("actualOrdinaryTarget", actual)
		d.t.Logf("prepared.capture[%d].actualOrdinaryTargetEqualsObserved=%t", d.count, actual == d.observation.Target)
	}
}
func (d *preparedCaptureDiagnostic) tuple(label string, native NativeDescriptor) {
	// Native volume/file ID and creation are comparison evidence. Do not emit
	// any actual path, SD, ACE, stream name/data, proof, nonce or key material.
	d.t.Logf("prepared.capture[%d].%s: volume=%s fileID128=%s creation=%s pathSlotSHA256=%s", d.count, label, native.VolumeID, native.FileID, native.CreationTime, Digest([]byte(native.PathKey)))
}
