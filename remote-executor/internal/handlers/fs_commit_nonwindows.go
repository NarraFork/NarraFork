//go:build !windows

package handlers

import (
	"context"
	"os"
)

// The caller has rechecked source identity, bytes and permissions immediately
// before commit. This serializes executor writes, not unrelated external writers.
func commitConditionalReplacement(ctx context.Context, target, replacement string, _ os.FileInfo, _ conditionalMetadata, _ []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return os.Rename(replacement, target)
}

func removeConditionalTemporary(path string, expected os.FileInfo) error {
	current, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !os.SameFile(current, expected) {
		return nil
	}
	// POSIX has no unlink-by-file-ID API. This is an identity guard, not an
	// OS-level CAS against a same-user writer racing the final unlink.
	return os.Remove(path)
}
