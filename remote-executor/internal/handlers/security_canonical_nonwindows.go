//go:build !windows && !darwin

package handlers

import "path/filepath"

func canonicalGuardPath(path string) (string, error) {
	return filepath.EvalSymlinks(path)
}
