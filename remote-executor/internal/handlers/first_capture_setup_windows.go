//go:build windows

package handlers

import (
	"context"
	"os"
	"strconv"
	"time"

	"github.com/narrafork/remote-executor/internal/windowsbackup"
	"golang.org/x/sys/windows"
)

type configuredFirstCaptureProvider struct{ handlers *Handlers }

func (p configuredFirstCaptureProvider) PinOrdinary(ctx context.Context, root windowsbackup.NativeDescriptor, file *os.File) (windowsbackup.FirstCapturePinnedOrdinary, error) {
	return p.handlers.PinFirstCaptureOrdinary(ctx, root, file)
}
func (p configuredFirstCaptureProvider) InspectFirstCaptureOrdinary(ctx context.Context, root windowsbackup.NativeDescriptor, file *os.File) (windowsbackup.FirstCapturePinnedOrdinary, error) {
	return p.handlers.InspectFirstCaptureOrdinary(withFirstCaptureJoinedPaths(ctx), root, file)
}

func (h *Handlers) ConfigureWindowsFirstCapture(ctx context.Context, enrollmentFile string) (func(), error) {
	if enrollmentFile == "" {
		return func() {}, nil
	}
	enrollment, pin, err := windowsbackup.LoadFirstCaptureEnrollment(ctx, enrollmentFile)
	if err != nil {
		return nil, err
	}
	created, err := strconv.ParseUint(enrollment.PipePeer.CreationTime, 10, 64)
	if err != nil {
		pin.Close()
		return nil, windowsbackup.ErrFirstCaptureNotReady
	}
	pipe := &windowsbackup.PipeClient{Name: enrollment.PipePeer.Name, ServerPID: enrollment.PipePeer.ProcessID, ServerCreationTime: created, ServerSID: enrollment.PipePeer.SID}
	executor, err := windowsbackup.NewFirstCaptureExecutor(enrollment, configuredFirstCaptureProvider{h}, pipe, pin.Check)
	if err != nil {
		pin.Close()
		return nil, err
	}
	h.SetWindowsFirstCaptureExecutor(executor)
	lifetime, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-lifetime.Done():
				return
			case <-ticker.C:
				_ = executor.Expire()
			}
		}
	}()
	return func() { cancel(); <-done; _ = executor.Disconnect(enrollment.Session.ConnectionID); _ = pin.Close() }, nil
}

// Explicit helper CLI only. All identities/roots/key files are administrator
// preinstalled, and this function never enrolls from hello_ack or generates a key.
func RunConfiguredWindowsBackupHelper(ctx context.Context, configurationPath string) error {
	config, protectedFiles, key, err := windowsbackup.LoadFirstCaptureHelperConfiguration(ctx, configurationPath)
	if err != nil {
		return err
	}
	defer func() {
		for i := len(protectedFiles) - 1; i >= 0; i-- {
			_ = protectedFiles[i].Close()
		}
	}()
	if uint32(os.Getpid()) != config.Enrollment.PipePeer.ProcessID {
		return windowsbackup.ErrFirstCaptureNotReady
	}
	var created, exited, kernel, user windows.Filetime
	if windows.GetProcessTimes(windows.CurrentProcess(), &created, &exited, &kernel, &user) != nil || strconv.FormatUint(uint64(created.HighDateTime)<<32|uint64(created.LowDateTime), 10) != config.Enrollment.PipePeer.CreationTime {
		return windowsbackup.ErrFirstCaptureNotReady
	}
	identity, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil || identity.User.Sid.String() != config.Enrollment.PipePeer.SID {
		return windowsbackup.ErrFirstCaptureNotReady
	}
	// Explicitly require a pre-provisioned store/root; NewProtectedStore may
	// initialize its own ledger but cannot bootstrap an arbitrary missing root.
	info, err := os.Lstat(config.StoreDirectory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return windowsbackup.ErrFirstCaptureNotReady
	}
	store, err := windowsbackup.NewProtectedStore(windowsbackup.StoreConfig{Directory: config.StoreDirectory, HelperInstanceID: config.Enrollment.HelperInstanceID, KeyEpoch: config.Enrollment.HelperKeyEpoch, ServiceSID: config.ServiceSID, SigningKey: key})
	if err != nil {
		return windowsbackup.ErrFirstCaptureNotReady
	}
	defer store.Close()
	guard := NewPathGuardWithRules([]PathRule{{Path: config.RootPath, Action: RuleAllow}})
	h := NewWithOptions(guard, 64<<10, true)
	ops, err := NewWindowsBackupNativeOperations(h, []string{config.RootPath}, nil, store)
	if err != nil {
		return windowsbackup.ErrFirstCaptureNotReady
	}
	roots := ops.ApprovedRoots()
	if len(roots) != 1 || roots[0] != config.Enrollment.Root {
		return windowsbackup.ErrFirstCaptureNotReady
	}
	root, err := resolveNativePathV2(withFirstCaptureJoinedPaths(ctx), config.RootPath, "existing")
	if err != nil {
		return windowsbackup.ErrFirstCaptureNotReady
	}
	if root.NativeDescriptor.Object == nil || root.NativeDescriptor.CaseSensitive == nil {
		return windowsbackup.ErrFirstCaptureNotReady
	}
	// Hold the configured root incarnation for the helper's entire lifetime.
	ancestor := NativePathAncestorV2{CanonicalPath: root.CanonicalPath, Object: *root.NativeDescriptor.Object, CaseSensitive: *root.NativeDescriptor.CaseSensitive}
	rootPin, err := pinFirstCaptureAncestor(ctx, ancestor)
	if err != nil {
		return windowsbackup.ErrFirstCaptureNotReady
	}
	defer rootPin.Close()
	keys, err := windowsbackup.FirstCaptureIssuerPins(config)
	if err != nil {
		return err
	}
	session := windowsbackup.Session{Peer: config.ClientPeer, DeviceID: config.Enrollment.DeviceID, SourceID: config.Enrollment.ExecutorSourceID, HelperInstanceID: config.Enrollment.HelperInstanceID, ConnectionID: config.Enrollment.Session.ConnectionID, SessionID: config.Enrollment.Session.SessionID, Generation: config.Enrollment.Session.RuntimeGeneration}
	verifier := &windowsbackup.Verifier{Keys: keys, Session: session, Roots: roots}
	helper, err := windowsbackup.NewHelper(verifier, store, &WindowsFirstCaptureNativeOperations{ops})
	if err != nil {
		return windowsbackup.ErrFirstCaptureNotReady
	}
	return windowsbackup.ServeBackupHelper(ctx, windowsbackup.PipeConfig{Name: config.Enrollment.PipePeer.Name, ClientServiceSID: config.ClientPeer.ServiceSID, FirstCaptureOnly: true}, helper)
}
