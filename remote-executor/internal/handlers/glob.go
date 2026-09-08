package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/bmatcuk/doublestar/v4"
)

// Glob retains the direct-call API; RPC dispatch supplies its cancellable context.
func (h *Handlers) Glob(params map[string]any) (any, error) {
	return h.GlobContext(context.Background(), params)
}

var errGlobLimit = errors.New("glob result limit")

// GlobContext bounds work even when nothing matches: cancellation is checked during
// enumeration, not only in a matching-file callback. ReadDir batches bound memory
// for huge individual directories; symlinked directories are never traversed.
func (h *Handlers) GlobContext(parent context.Context, params map[string]any) (any, error) {
	if err := parent.Err(); err != nil {
		return nil, err
	}
	timeoutMs := intParam(params, "timeoutMs", 10000)
	maxResults := intParam(params, "maxResults", 500)
	maxBytes := intParam(params, "maxBytes", h.maxRpcBytes)
	if timeoutMs <= 0 || maxResults <= 0 || maxBytes <= 0 {
		return nil, fmt.Errorf("glob limits must be positive")
	}
	if timeoutMs > 120000 {
		timeoutMs = 120000
	}
	if maxResults > 10000 {
		maxResults = 10000
	}
	if maxBytes > h.maxRpcBytes {
		maxBytes = h.maxRpcBytes
	}
	ctx, cancel := context.WithTimeout(parent, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	pattern := stringParam(params, "pattern")
	// Walk paths are relative without a leading ./; use the same spelling for
	// validation, matching, and directory pruning. Do not clean the rest: glob
	// alternatives, escapes, and parent segments must retain their semantics.
	for strings.HasPrefix(pattern, "./") {
		pattern = strings.TrimPrefix(pattern, "./")
	}
	if !doublestar.ValidatePattern(pattern) || filepath.IsAbs(pattern) {
		return nil, fmt.Errorf("invalid glob pattern")
	}
	cwd, err := h.guardedExistingPath(params, "cwd")
	if err != nil {
		return nil, err
	}
	dot := boolParam(params, "dot")
	includeDirs := boolParam(params, "includeDirectories")
	query := strings.ToLower(stringParam(params, "query"))
	type match struct {
		path    string
		modTime int64
	}
	matches := make([]match, 0)
	var usedBytes int64 = 2
	check := func() error {
		if err := parent.Err(); err != nil {
			return err
		}
		return ctx.Err()
	}
	canDescend := globDirectoryMatcher(pattern)
	var walk func(string, string, int) error
	walk = func(dir, relative string, depth int) error {
		if err := check(); err != nil {
			return err
		}
		f, err := os.Open(dir)
		if err != nil {
			return err
		}
		defer f.Close()
		for {
			if err := check(); err != nil {
				return err
			}
			entries, readErr := f.ReadDir(128)
			for _, entry := range entries {
				if err := check(); err != nil {
					return err
				}
				if !dot && strings.HasPrefix(entry.Name(), ".") {
					continue
				}
				rel := entry.Name()
				if relative != "" {
					rel = relative + "/" + rel
				}
				abs := filepath.Join(dir, entry.Name())
				// Executor-side deny rules also prune subtrees and candidate metadata.
				if _, err := h.guard.CheckExisting(abs); err != nil {
					continue
				}
				matched, err := doublestar.Match(pattern, rel)
				if err != nil {
					return err
				}
				if matched && (includeDirs || !entry.IsDir()) && (query == "" || strings.Contains(strings.ToLower(rel), query)) {
					encoded, _ := json.Marshal(rel)
					size := int64(len(encoded) + 1)
					if int64(len(matches)) >= maxResults || usedBytes+size > maxBytes {
						return errGlobLimit
					}
					var mt int64
					if info, err := entry.Info(); err == nil {
						mt = info.ModTime().UnixNano()
					}
					matches = append(matches, match{rel, mt})
					usedBytes += size
				}
				if entry.IsDir() && entry.Type()&os.ModeSymlink == 0 && canDescend(entry.Name(), depth) {
					if err := walk(abs, rel, depth+1); err != nil {
						return err
					}
				}
			}
			if readErr != nil {
				if errors.Is(readErr, io.EOF) {
					return nil
				}
				return readErr
			}
		}
	}
	walkErr := walk(cwd, "", 0)
	if walkErr != nil && !errors.Is(walkErr, errGlobLimit) {
		return nil, walkErr
	}
	if err := check(); err != nil {
		return nil, err
	}
	// Only sort the already-bounded subset, never collect the whole tree first.
	sort.SliceStable(matches, func(i, j int) bool { return matches[i].modTime > matches[j].modTime })
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		out = append(out, m.path)
	}
	return map[string]any{"matches": out, "truncated": errors.Is(walkErr, errGlobLimit)}, nil
}

// globDirectoryMatcher only descends through directory segments that can still
// lead to a match. The final segment names a result, not a directory to enumerate:
// README.md and *.ts never recurse; src/*.go only enumerates src.
//
// Match remains the authority for the complete pattern. Stop pruning at syntax
// that can span path segments: **, alternatives, character classes (which Match
// can match against '/'), and escapes. Keeping the preceding simple segments
// still prunes unrelated prefixes without expanding alternatives or guessing at
// doublestar's grammar. Ancestors have already matched, so only the current
// segment needs checking; the conservative tail uses the same cancellable walk.
func globDirectoryMatcher(pattern string) func(string, int) bool {
	segments := strings.Split(pattern, "/")
	recursive := false
	for i, segment := range segments {
		if segment == "**" || strings.ContainsAny(segment, `[{\`) {
			segments = segments[:i]
			recursive = true
			break
		}
	}
	if !recursive {
		segments = segments[:len(segments)-1]
	}
	return func(name string, depth int) bool {
		if depth >= len(segments) {
			return recursive
		}
		matched, _ := doublestar.Match(segments[depth], name)
		return matched
	}
}

func hasDotSegment(path string) bool {
	for _, seg := range strings.Split(path, "/") {
		if strings.HasPrefix(seg, ".") {
			return true
		}
	}
	return false
}
