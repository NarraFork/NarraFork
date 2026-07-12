package handlers

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/bmatcuk/doublestar/v4"
)

// Glob scans for files matching a pattern under cwd, mirroring Bun.Glob output
// (forward-slash relative paths). Honours the dot flag and a result cap.
func (h *Handlers) Glob(params map[string]any) (any, error) {
	pattern := stringParam(params, "pattern")
	cwd, err := h.guardedExistingPath(params, "cwd")
	if err != nil {
		return nil, err
	}
	dot := boolParam(params, "dot")
	maxResults := int(intParam(params, "maxResults", 500))
	if maxResults <= 0 {
		maxResults = 500
	}

	type match struct {
		path    string
		modTime int64
	}
	matches := make([]match, 0, 64)

	fsys := os.DirFS(cwd)
	walkErr := doublestar.GlobWalk(fsys, pattern, func(path string, d fs.DirEntry) error {
		if d.IsDir() {
			return nil
		}
		if !dot && hasDotSegment(path) {
			return nil
		}
		var mt int64
		if info, err := d.Info(); err == nil {
			mt = info.ModTime().UnixNano()
		}
		matches = append(matches, match{path: filepath.ToSlash(path), modTime: mt})
		return nil
	}, doublestar.WithNoFollow())
	if walkErr != nil {
		return nil, walkErr
	}

	// Sort by modification time descending (newest first), matching the tool's
	// "sorted by modification time" contract.
	sort.Slice(matches, func(i, j int) bool { return matches[i].modTime > matches[j].modTime })

	out := make([]string, 0, len(matches))
	for _, m := range matches {
		out = append(out, m.path)
		if len(out) >= maxResults {
			break
		}
	}
	return map[string]any{"matches": out}, nil
}

func hasDotSegment(path string) bool {
	for _, seg := range strings.Split(path, "/") {
		if strings.HasPrefix(seg, ".") {
			return true
		}
	}
	return false
}
