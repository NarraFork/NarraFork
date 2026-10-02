package handlers

import (
	"context"
	"errors"
	"os"
)

var errConditionalMetadataChanged = errors.New("conditional file metadata changed or was not preserved")

// Metadata preservation is a prerequisite, not a best-effort side effect. The
// platform implementation prepares and verifies metadata before committing.
// Windows verifies the DACL merged by ReplaceFileW after the native commit.
// File identity and content are independently rechecked by FsWriteConditional.
type conditionalMetadata interface {
	apply(*os.File) error
	matches(*os.File) error
}

func conditionalMetadataContext(contexts []context.Context) context.Context {
	if len(contexts) > 0 && contexts[0] != nil {
		return contexts[0]
	}
	return context.Background()
}
