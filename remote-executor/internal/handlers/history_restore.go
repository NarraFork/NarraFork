package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/narrafork/remote-executor/internal/history"
	"github.com/narrafork/remote-executor/internal/windowsbackup"
)

// preflightHistoryNative performs read-only, target-specific validation. Checking
// the actual file as well as its parent matters for bind/nested mounts; the
// workspace root's filesystem says nothing about a particular target.
func (h *Handlers) preflightHistoryNative(ctx context.Context, request history.NativeApplyRequest) error {
	release, err := acquireFileMutation(ctx)
	if err != nil {
		return err
	}
	defer release()
	checked, err := h.guard.CheckCreate(request.Path)
	if err != nil || !samePath(checked, request.Path) {
		return fmt.Errorf("history target identity changed")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if request.Before.Kind == "regular" {
		file, err := windowsbackup.OpenMutation(request.Path)
		if err != nil {
			return err
		}
		defer file.Close()
		if err := verifyHistoryBefore(ctx, file, request); err != nil {
			return err
		}
	} else if _, err := os.Lstat(request.Path); !os.IsNotExist(err) {
		return errConditionalMetadataChanged
	}
	if err := validateHistoryFilesystems(request); err != nil {
		return err
	}
	return ctx.Err()
}

func validateHistoryFilesystems(request history.NativeApplyRequest) error {
	if request.Before.Kind != "regular" {
		// New-file staging/publication both use the checked target parent. There
		// is no original inode to move into the private recovery filesystem.
		return nil
	}
	source, err := historyFilesystemIdentity(request.Path)
	if err != nil {
		return err
	}
	parent, err := historyFilesystemIdentity(filepath.Dir(request.Path))
	if err != nil {
		return err
	}
	recovery, err := historyFilesystemIdentity(request.PrivateRecoveryDirectory)
	if err != nil {
		return err
	}
	if source != recovery || parent != recovery {
		return history.ErrUnsupportedCrossFilesystem
	}
	return nil
}

// Full backups are already durable CAS objects before this method is entered.
// The native quarantine is additional recovery material and is never pruned here.
func (h *Handlers) applyHistoryNative(ctx context.Context, request history.NativeApplyRequest) error {
	release, err := acquireFileMutation(ctx)
	if err != nil {
		return err
	}
	defer release()
	checked, err := h.guard.CheckCreate(request.Path)
	if err != nil || !samePath(checked, request.Path) {
		return fmt.Errorf("history target identity changed")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	current, err := windowsbackup.OpenMutation(request.Path)
	if request.Before.Kind == "absent" {
		if err == nil {
			current.Close()
			return errConditionalMetadataChanged
		}
		if !os.IsNotExist(err) {
			return err
		}
	} else {
		if err != nil {
			return err
		}
		defer current.Close()
		if len(request.BeforeMetadata) == 0 {
			return fmt.Errorf("complete native before backup is required")
		}
		if err := verifyHistoryBefore(ctx, current, request); err != nil {
			return err
		}
	}
	if request.Desired.Kind == "absent" && request.Before.Kind == "absent" {
		return nil
	}
	// Recheck even after successful preflight. A mount/source replacement between
	// admission and Apply is NOT converted into a known-no-dispatch receipt.
	if err := validateHistoryFilesystems(request); err != nil {
		return err
	}
	parent := filepath.Dir(request.Path)
	parentBefore, err := os.Stat(parent)
	if err != nil {
		return err
	}
	recovery, err := os.MkdirTemp(request.PrivateRecoveryDirectory, "native-")
	if err != nil {
		return err
	}
	marker, _ := json.Marshal(struct {
		Path    string        `json:"path"`
		Before  history.State `json:"before"`
		Desired history.State `json:"desired"`
	}{request.Path, request.Before, request.Desired})
	markerFile, err := os.OpenFile(filepath.Join(recovery, "intent.json"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if _, err := markerFile.Write(marker); err != nil {
		markerFile.Close()
		return err
	}
	if err := markerFile.Sync(); err != nil {
		markerFile.Close()
		return err
	}
	markerFile.Close()
	var temp *os.File
	var metadata conditionalMetadata
	if request.Desired.Kind == "regular" {
		temp, err = os.CreateTemp(parent, ".nf-history-native-")
		if err != nil {
			return err
		}
		defer temp.Close()
		tempInfo, _ := temp.Stat()
		defer removeConditionalTemporary(temp.Name(), tempInfo)
		for offset := 0; offset < len(request.DesiredBytes); offset += 64 << 10 {
			if err := ctx.Err(); err != nil {
				return err
			}
			end := offset + (64 << 10)
			if end > len(request.DesiredBytes) {
				end = len(request.DesiredBytes)
			}
			if _, err := temp.Write(request.DesiredBytes[offset:end]); err != nil {
				return err
			}
		}
		if len(request.DesiredMetadata) > 0 {
			metadata, err = decodeHistoryMetadata(ctx, request.DesiredMetadata)
			if err != nil {
				return err
			}
			if err := metadata.apply(temp); err != nil {
				return err
			}
			if err := metadata.matches(temp); err != nil {
				return err
			}
		} else if err := temp.Chmod(os.FileMode(request.Desired.Mode)); err != nil {
			return err
		}
		if err := temp.Sync(); err != nil {
			return err
		}
		if err := temp.Close(); err != nil {
			return err
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	checked, err = h.guard.CheckCreate(request.Path)
	if err != nil || !samePath(checked, request.Path) {
		return fmt.Errorf("history target identity changed")
	}
	parentAfter, err := os.Stat(parent)
	if err != nil || !os.SameFile(parentBefore, parentAfter) {
		return fmt.Errorf("history parent identity changed")
	}
	if request.Before.Kind == "regular" {
		if err := verifyHistoryBefore(ctx, current, request); err != nil {
			return err
		}
		named, err := os.Stat(request.Path)
		opened, _ := current.Stat()
		if err != nil || !os.SameFile(named, opened) {
			return errConditionalMetadataChanged
		}
		if err := quarantineHistoryOriginal(current, filepath.Join(recovery, "original")); err != nil {
			return err
		}
		moved, err := windowsbackup.OpenObservation(filepath.Join(recovery, "original"))
		if err != nil {
			return err
		}
		defer moved.Close()
		movedInfo, _ := moved.Stat()
		if !os.SameFile(opened, movedInfo) {
			// A raced entry is never deleted or overwritten. Put it back only into a
			// confirmed absence, otherwise retain the quarantine for explicit recovery.
			if restoreErr := publishHistoryNoReplace(filepath.Join(recovery, "original"), request.Path); restoreErr != nil {
				return fmt.Errorf("foreign quarantine retained; recovery_required")
			}
			return errConditionalMetadataChanged
		}
		if err := verifyHistoryBefore(ctx, moved, request); err != nil {
			return fmt.Errorf("quarantined object changed; recovery_required: %w", err)
		}
	}
	if request.Desired.Kind == "absent" {
		return syncHistoryDirectory(parent)
	}
	// No overwrite: an external editor creating the target after quarantine is a
	// conflict. The old inode and complete private backups remain available.
	if err := publishHistoryNoReplace(temp.Name(), request.Path); err != nil {
		return fmt.Errorf("external target conflict; recovery_required: %w", err)
	}
	if err := syncHistoryDirectory(parent); err != nil {
		return err
	}
	if metadata != nil {
		applied, err := os.Open(request.Path)
		if err != nil {
			return err
		}
		defer applied.Close()
		if err := metadata.matches(applied); err != nil {
			return fmt.Errorf("restored metadata mismatch: %w", err)
		}
	}
	return nil
}

func verifyHistoryBefore(ctx context.Context, file *os.File, request history.NativeApplyRequest) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	info, err := file.Stat()
	if err != nil {
		return err
	}
	named, err := os.Stat(file.Name())
	if err != nil || !os.SameFile(info, named) {
		return errConditionalMetadataChanged
	}
	incarnation, err := history.FileIncarnation(file.Name())
	if err != nil || request.Before.Incarnation == "" || incarnation != request.Before.Incarnation {
		return errConditionalMetadataChanged
	}
	if !info.Mode().IsRegular() || info.Size() != int64(len(request.BeforeBytes)) {
		return errConditionalMetadataChanged
	}
	if _, err := file.Seek(0, 0); err != nil {
		return err
	}
	data, err := io.ReadAll(io.LimitReader(file, int64(len(request.BeforeBytes))+1))
	if err != nil {
		return err
	}
	if !bytes.Equal(data, request.BeforeBytes) {
		return errConditionalMetadataChanged
	}
	current, err := captureHistoryMetadata(ctx, file)
	if err != nil {
		return err
	}
	if !bytes.Equal(current, request.BeforeMetadata) {
		return errConditionalMetadataChanged
	}
	return ctx.Err()
}
