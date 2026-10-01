//go:build windows

package handlers

import (
	"fmt"
	"os"
)

func captureConditionalMetadata(_ *os.File) (conditionalMetadata, error) {
	// os.Chmod only models the read-only attribute, not Windows security.
	// x/sys/windows offers SetSecurityInfo, but applying a DACL to a new inode
	// can change inheritance/protection semantics. ReplaceFileW preserves some
	// metadata, not a proven complete owner/group/SACL/stream snapshot, and has
	// partial-failure cases. Until a verified native transaction is available,
	// refuse existing-file replacement without changing ANY original DACL.
	return nil, fmt.Errorf("conditional replacement cannot safely preserve complete Windows security metadata; original file retained")
}
