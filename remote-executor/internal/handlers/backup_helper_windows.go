//go:build windows

package handlers

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"unsafe"

	"github.com/narrafork/remote-executor/internal/history"
	"github.com/narrafork/remote-executor/internal/windowsbackup"
	"golang.org/x/sys/windows"
)

// WindowsBackupNativeOperations is the concrete production native adapter. Main
// supplies administrator-approved roots and vaults; clients cannot construct it
// through JSON or broaden its guard. Capture/restore never take client SD bytes.
type WindowsBackupNativeOperations struct {
	handlers *Handlers
	roots    map[windowsbackup.NativeDescriptor]string
	vaults   map[string]*windowsbackup.Vault
}

func nativeBackupDescriptor(d *NativePathDescriptorV2) (windowsbackup.NativeDescriptor, error) {
	if d == nil || d.Object == nil {
		return windowsbackup.NativeDescriptor{}, fmt.Errorf("native object descriptor unavailable")
	}
	return windowsbackup.NativeDescriptor{VolumeID: d.Object.VolumeID, FileID: d.Object.FileID, CreationTime: d.Object.CreationTime, PathKey: d.PathSlotKey}, nil
}
func NewWindowsBackupNativeOperations(h *Handlers, approvedRoots []string, vaults map[string]*windowsbackup.Vault, store *windowsbackup.ProtectedStore) (*WindowsBackupNativeOperations, error) {
	if h == nil || store == nil || len(approvedRoots) == 0 || len(approvedRoots) > 64 || len(vaults) > 64 {
		return nil, fmt.Errorf("backup native config not ready")
	}
	ops := &WindowsBackupNativeOperations{handlers: h, roots: make(map[windowsbackup.NativeDescriptor]string), vaults: vaults}
	private := []string{store.Directory()}
	for _, vault := range vaults {
		if vault == nil {
			return nil, fmt.Errorf("vault config")
		}
		private = append(private, vault.PrivatePaths()...)
	}
	if err := h.guard.ExcludePrivateDirectories(private...); err != nil {
		return nil, err
	}
	for _, root := range approvedRoots {
		result, err := resolveNativePathV2(context.Background(), root, "existing")
		if err != nil {
			return nil, err
		}
		descriptor, err := nativeBackupDescriptor(result.NativeDescriptor)
		if err != nil {
			return nil, err
		}
		ops.roots[descriptor] = result.CanonicalPath
	}
	return ops, nil
}
func (o *WindowsBackupNativeOperations) ApprovedRoots() []windowsbackup.NativeDescriptor {
	roots := make([]windowsbackup.NativeDescriptor, 0, len(o.roots))
	for root := range o.roots {
		roots = append(roots, root)
	}
	return roots
}
func (o *WindowsBackupNativeOperations) Observe(ctx context.Context, t windowsbackup.Ticket, file *os.File) (windowsbackup.NativeObservation, error) {
	var observation windowsbackup.NativeObservation
	configuredRoot, ok := o.roots[t.Root]
	if !ok {
		return observation, fmt.Errorf("unconfigured exact native root")
	}
	// Only ancestor/name attributes are queried under this backup scope. The actual
	// target is the client's already ordinarily authorized duplicate handle.
	err := windowsbackup.Privileged(ctx, []string{"SeBackupPrivilege"}, func() error {
		actual, name, err := o.handlers.ResolveNativeOpenedFileV2(ctx, file)
		if err != nil {
			return err
		}
		root, err := resolveNativePathV2(ctx, configuredRoot, "existing")
		if err != nil {
			return err
		}
		if !nativeDescriptorContains(root.NativeDescriptor, actual) {
			return fmt.Errorf("actual ordinary handle outside original native root")
		}
		observation.Root, err = nativeBackupDescriptor(root.NativeDescriptor)
		if err != nil {
			return err
		}
		observation.Target, err = nativeBackupDescriptor(actual)
		if err != nil {
			return err
		}
		parent, err := resolveNativePathV2(ctx, actual.Parent.CanonicalPath, "existing")
		if err != nil {
			return err
		}
		observation.Parent, err = nativeBackupDescriptor(parent.NativeDescriptor)
		if err != nil {
			return err
		}
		observation.RootPath = root.CanonicalPath
		observation.ParentPath = parent.CanonicalPath
		observation.TargetPath = name
		return nil
	})
	if err != nil {
		return observation, err
	}
	snapshot, err := windowsbackup.Capture(ctx, file)
	if err != nil {
		return observation, err
	}
	observation.MetadataHash, err = windowsbackup.SnapshotFingerprint(snapshot)
	if err != nil {
		return observation, err
	}
	budget := history.BlobBytes
	if t.BudgetClass == "attachment" {
		budget = attachmentBytes
	}
	observation.ContentHash, _, err = boundedAttachmentHash(ctx, file, budget)
	return observation, err
}
func (o *WindowsBackupNativeOperations) Capture(ctx context.Context, file *os.File) (*windowsbackup.Snapshot, error) {
	return windowsbackup.Capture(ctx, file)
}
func (o *WindowsBackupNativeOperations) Restore(ctx context.Context, file *os.File, original *windowsbackup.CaptureRecord) error {
	if original == nil || original.Snapshot == nil {
		return fmt.Errorf("helper original record required")
	}
	if err := windowsbackup.ApplyExact(ctx, file, original.Snapshot); err != nil {
		return err
	}
	return windowsbackup.Matches(ctx, file, original.Snapshot)
}
func (o *WindowsBackupNativeOperations) Seal(ctx context.Context, t *windowsbackup.VerifiedTicket, file *os.File, original *windowsbackup.CaptureRecord) (*windowsbackup.VaultReference, error) {
	vault := o.vaults[t.Ticket().Root.VolumeID]
	if vault == nil {
		return nil, fmt.Errorf("original volume private vault not configured")
	}
	return vault.Preserve(ctx, t, file, original)
}
func (o *WindowsBackupNativeOperations) Unseal(ctx context.Context, t *windowsbackup.VerifiedTicket, file *os.File, original *windowsbackup.CaptureRecord) error {
	vault := o.vaults[t.Ticket().Root.VolumeID]
	if vault == nil {
		return fmt.Errorf("original volume vault not configured")
	}
	return vault.Unseal(ctx, t, file, original)
}
func (o *WindowsBackupNativeOperations) Cleanup(ctx context.Context, t *windowsbackup.VerifiedTicket, file *os.File, original *windowsbackup.CaptureRecord) error {
	if original == nil || original.State != "prepared" {
		return fmt.Errorf("helper registered creation object required")
	}
	// POSIX disposition removes the original entry atomically even with open
	// observation handles; it is not reported as a mere delete-on-close success.
	flags := uint32(1 | 2) // FILE_DISPOSITION_FLAG_DELETE | POSIX_SEMANTICS
	return windows.SetFileInformationByHandle(windows.Handle(file.Fd()), 21, (*byte)(unsafe.Pointer(&flags)), 4)
}
func (o *WindowsBackupNativeOperations) VerifyOutcome(ctx context.Context, t *windowsbackup.VerifiedTicket, file *os.File, original *windowsbackup.CaptureRecord) error {
	ticket := t.Ticket()
	switch ticket.Action {
	case "restore_original":
		if err := windowsbackup.Matches(ctx, file, original.Snapshot); err != nil {
			return err
		}
		descriptor, _, err := o.handlers.ResolveNativeOpenedFileV2(ctx, file)
		if err != nil {
			return err
		}
		actual, err := nativeBackupDescriptor(descriptor)
		if err != nil {
			return err
		}
		if actual.VolumeID != ticket.Target.VolumeID || actual.FileID != ticket.Target.FileID || actual.PathKey != ticket.Target.PathKey || actual.CreationTime != strconv.FormatUint(original.Snapshot.Creation, 10) {
			return fmt.Errorf("restored prepared native object changed")
		}
	case "seal_owned":
		vault := o.vaults[ticket.Root.VolumeID]
		if vault == nil {
			return fmt.Errorf("vault missing")
		}
		return vault.VerifySealed(ctx, t, file, original)
	case "unseal_original":
		return windowsbackup.Matches(ctx, file, original.Snapshot)
	case "cleanup_created":
		if original.TargetPath == "" {
			return fmt.Errorf("original creation slot not recorded")
		}
		if _, err := os.Lstat(original.TargetPath); !os.IsNotExist(err) {
			return fmt.Errorf("creation entry removal not proven")
		}
	default:
		return fmt.Errorf("unknown native outcome")
	}
	return nil
}
