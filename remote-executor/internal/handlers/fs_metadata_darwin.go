//go:build darwin

package handlers

import (
	"fmt"
	"os"
)

func captureConditionalMetadata(_ *os.File) (conditionalMetadata, error) {
	// Darwin ACLs are not POSIX ACL xattrs. The pinned x/sys exposes xattrs
	// but not acl_get_fd/acl_set_fd or libc fcopyfile. Raw SYS_COPYFILE is not
	// the libc metadata-copy interface. Copying mode/xattrs alone would silently
	// drop ACLs and file flags; spawning cp also cannot prove a bounded, stable
	// fd-based metadata snapshot. Fail closed until a native verifier exists.
	return nil, fmt.Errorf("conditional replacement cannot safely preserve complete macOS ACL metadata; original file retained")
}
