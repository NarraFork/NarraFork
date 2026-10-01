package handlers

import (
	"errors"
	"os"
)

var errConditionalMetadataChanged = errors.New("conditional file metadata changed or was not preserved")

// Metadata preservation is a prerequisite, not a best-effort side effect. The
// platform implementation must validate the temporary inode before any rename.
// File identity and content are independently rechecked by FsWriteConditional.
type conditionalMetadata interface {
	apply(*os.File) error
	matches(*os.File) error
}
