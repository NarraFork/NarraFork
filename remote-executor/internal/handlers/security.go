package handlers

import (
	"fmt"
	"path/filepath"
	"strings"
)

// PathGuard restricts filesystem/exec access to a set of allowed root prefixes.
// An empty root list means "unrestricted" (the operator opted out).
type PathGuard struct {
	roots []string
}

func NewPathGuard(roots []string) *PathGuard {
	cleaned := make([]string, 0, len(roots))
	for _, r := range roots {
		abs, err := filepath.Abs(r)
		if err != nil {
			continue
		}
		cleaned = append(cleaned, filepath.Clean(abs))
	}
	return &PathGuard{roots: cleaned}
}

// Check verifies that an absolute path lies within one of the allowed roots.
// Returns the cleaned absolute path on success.
func (g *PathGuard) Check(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("invalid path: %w", err)
	}
	abs = filepath.Clean(abs)
	if len(g.roots) == 0 {
		return abs, nil
	}
	for _, root := range g.roots {
		if abs == root || strings.HasPrefix(abs, root+string(filepath.Separator)) {
			return abs, nil
		}
	}
	return "", fmt.Errorf("path %q is outside the allowed roots", abs)
}

// Unrestricted reports whether the guard permits any path.
func (g *PathGuard) Unrestricted() bool {
	return len(g.roots) == 0
}
