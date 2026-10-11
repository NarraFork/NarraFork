//go:build windows

package handlers

import (
	"context"
	"fmt"
	"github.com/narrafork/remote-executor/internal/windowsbackup"
	"os"
)

type attachmentPublicationEvidence struct {
	windowsbackup.AttachmentPublication
}

func (h *Handlers) pinAttachmentPublicationParent(ctx context.Context, parent, root string, digest string) (*attachmentPublicationEvidence, func(), error) {
	p, err := resolveNativePathV2(ctx, parent, "existing")
	if err != nil {
		return nil, nil, err
	}
	release, err := h.PinNativeDirectoryV2(ctx, map[string]any{"expectedNativeDescriptor": p.NativeDescriptor}, parent)
	if err != nil {
		return nil, nil, err
	}
	fail := func(err error) (*attachmentPublicationEvidence, func(), error) { release(); return nil, nil, err }
	r, err := resolveNativePathV2(ctx, root, "existing")
	if err != nil {
		return fail(err)
	}
	rd, err := nativeBackupDescriptor(r.NativeDescriptor)
	if err != nil {
		return fail(err)
	}
	pd, err := nativeBackupDescriptor(p.NativeDescriptor)
	if err != nil {
		return fail(err)
	}
	return &attachmentPublicationEvidence{windowsbackup.AttachmentPublication{Root: rd, Parent: pd, ContentDigest: digest}}, release, nil
}

func (h *Handlers) prepareAttachmentPublication(ctx context.Context, temp *os.File, info os.FileInfo, target string, e *attachmentPublicationEvidence) (*os.File, error) {
	if err := temp.Close(); err != nil {
		return nil, err
	}
	file, err := windowsbackup.OpenMutation(temp.Name())
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*os.File, error) { file.Close(); return nil, err }
	opened, err := file.Stat()
	if err != nil || info == nil || !os.SameFile(info, opened) {
		return fail(fmt.Errorf("attachment prepared incarnation changed"))
	}
	d, _, err := h.ResolveNativeOpenedFileV2(ctx, file)
	if err != nil {
		return fail(err)
	}
	e.Prepared, err = nativeBackupDescriptor(d)
	if err != nil {
		return fail(err)
	}
	missing, err := resolveNativePathV2(ctx, target, "create")
	if err != nil {
		return fail(err)
	}
	m := missing.NativeDescriptor
	if m.Object != nil || len(m.MissingSuffix) != 1 || m.Parent.Object != d.Parent.Object || m.Parent.Object.FileID != e.Parent.FileID || m.Parent.Object.VolumeID != e.Parent.VolumeID || m.Parent.Object.CreationTime != e.Parent.CreationTime {
		return fail(fmt.Errorf("attachment final slot/parent changed"))
	}
	e.Final = e.Prepared
	e.Final.PathKey = m.PathSlotKey
	return file, nil
}
func validateAttachmentPrepared(ctx context.Context, data []byte, e *attachmentPublicationEvidence) error {
	frozen := e.AttachmentPublication
	frozen.Final = frozen.Prepared
	return windowsbackup.VerifyAttachmentPublication(ctx, data, data, frozen)
}
func publishAttachmentPrepared(file *os.File, target string) error {
	return renameConditionalHandle(file, target)
}
func verifyAttachmentPrepared(ctx context.Context, a, b []byte, e *attachmentPublicationEvidence) error {
	return windowsbackup.VerifyAttachmentPublication(ctx, a, b, e.AttachmentPublication)
}
