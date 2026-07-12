package handlers

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// PathGuard restricts structured filesystem, transfer, and search paths plus
// Git/command working directories to a set of allowed roots. Roots and requested
// paths are resolved through symlinks and Windows junctions before containment
// checks.
//
// PathGuard is a request-path guard, not an OS sandbox: shell/PTY command text is
// intentionally opaque, and a hostile local process can still race filesystem
// names after validation. Use --disable-shell plus OS-level isolation when the
// executor must run across a hard trust boundary.
type PathGuard struct {
	roots      []string
	restricted bool
}

func NewPathGuard(roots []string) *PathGuard {
	guard := &PathGuard{
		roots:      make([]string, 0, len(roots)),
		restricted: len(roots) > 0,
	}
	for _, root := range roots {
		abs, err := absolutePath(root)
		if err != nil {
			continue
		}
		resolved, err := filepath.EvalSymlinks(abs)
		if err != nil {
			continue
		}
		resolved = filepath.Clean(resolved)
		duplicate := false
		for _, existing := range guard.roots {
			if samePath(existing, resolved) {
				duplicate = true
				break
			}
		}
		if !duplicate {
			guard.roots = append(guard.roots, resolved)
		}
	}
	return guard
}

// CheckExisting resolves all symlinks and supported Windows reparse points
// (including junctions) in an existing path, then verifies that the resulting
// path remains within an allowed root.
func (g *PathGuard) CheckExisting(path string) (string, error) {
	abs, err := absolutePath(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", fmt.Errorf("resolve path %q: %w", abs, err)
	}
	return g.checkResolved(filepath.Clean(resolved))
}

// CheckCreate validates a path that may not exist yet. It resolves the nearest
// existing ancestor through symlinks/junctions, verifies that ancestor is still
// inside an allowed root, then rebuilds the missing suffix below the ancestor's
// canonical path.
func (g *PathGuard) CheckCreate(path string) (string, error) {
	abs, err := absolutePath(path)
	if err != nil {
		return "", err
	}

	if resolved, evalErr := filepath.EvalSymlinks(abs); evalErr == nil {
		return g.checkResolved(filepath.Clean(resolved))
	} else if !errors.Is(evalErr, fs.ErrNotExist) {
		return "", fmt.Errorf("resolve path %q: %w", abs, evalErr)
	}

	ancestor := abs
	missing := make([]string, 0, 4)
	for {
		if _, statErr := os.Lstat(ancestor); statErr == nil {
			resolved, resolveErr := filepath.EvalSymlinks(ancestor)
			if resolveErr != nil {
				return "", fmt.Errorf("resolve path ancestor %q: %w", ancestor, resolveErr)
			}
			resolved, resolveErr = g.checkResolved(filepath.Clean(resolved))
			if resolveErr != nil {
				return "", resolveErr
			}
			for i := len(missing) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, missing[i])
			}
			return filepath.Clean(resolved), nil
		} else if !errors.Is(statErr, fs.ErrNotExist) {
			return "", fmt.Errorf("inspect path ancestor %q: %w", ancestor, statErr)
		}

		parent := filepath.Dir(ancestor)
		if parent == ancestor {
			return "", fmt.Errorf("path %q has no existing ancestor", abs)
		}
		missing = append(missing, filepath.Base(ancestor))
		ancestor = parent
	}
}

// CheckRemove validates the directory entry that will be removed without
// following a final symlink. The parent is canonicalized and checked first, so a
// swapped symlink is unlinked rather than deleting its target.
func (g *PathGuard) CheckRemove(path string) (string, error) {
	abs, err := absolutePath(path)
	if err != nil {
		return "", err
	}
	parent, err := g.CheckExisting(filepath.Dir(abs))
	if err != nil {
		return "", err
	}
	return g.checkResolved(filepath.Clean(filepath.Join(parent, filepath.Base(abs))))
}

// Check retains the original API and applies the stricter existing-path check.
func (g *PathGuard) Check(path string) (string, error) {
	return g.CheckExisting(path)
}

func (g *PathGuard) checkResolved(path string) (string, error) {
	if !g.restricted {
		return path, nil
	}
	for _, root := range g.roots {
		if pathWithin(root, path) {
			return path, nil
		}
	}
	return "", fmt.Errorf("path %q is outside the allowed roots", path)
}

func absolutePath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("invalid path: %w", err)
	}
	return filepath.Clean(abs), nil
}

func pathWithin(root, path string) bool {
	comparisonRoot := filepath.Clean(root)
	comparisonPath := filepath.Clean(path)
	if runtime.GOOS == "windows" {
		comparisonRoot = strings.ToLower(comparisonRoot)
		comparisonPath = strings.ToLower(comparisonPath)
	}
	rel, err := filepath.Rel(comparisonRoot, comparisonPath)
	if err != nil || filepath.IsAbs(rel) {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

func samePath(left, right string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
	}
	return filepath.Clean(left) == filepath.Clean(right)
}

// Unrestricted reports whether the operator supplied no allow roots.
func (g *PathGuard) Unrestricted() bool {
	return !g.restricted
}
