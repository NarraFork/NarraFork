//go:build !windows

package handlers

import (
	"bytes"
	"context"
	"fmt"
	"os"
)

type attachmentPublicationEvidence struct{}

func (h *Handlers) pinAttachmentPublicationParent(ctx context.Context, parent, root, digest string) (*attachmentPublicationEvidence, func(), error) {
	return &attachmentPublicationEvidence{}, func() {}, nil
}
func (h *Handlers) prepareAttachmentPublication(ctx context.Context, temp *os.File, info os.FileInfo, target string, e *attachmentPublicationEvidence) (*os.File, error) {
	return temp, nil
}
func validateAttachmentPrepared(ctx context.Context, data []byte, e *attachmentPublicationEvidence) error {
	return nil
}
func publishAttachmentPrepared(file *os.File, target string) error {
	if err := file.Close(); err != nil {
		return err
	}
	return publishHistoryNoReplace(file.Name(), target)
}
func verifyAttachmentPrepared(ctx context.Context, a, b []byte, e *attachmentPublicationEvidence) error {
	if !bytes.Equal(a, b) {
		return fmt.Errorf("published prepared metadata changed; unknown retained")
	}
	return nil
}
