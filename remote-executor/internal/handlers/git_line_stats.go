package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	gitLineStatsUntrackedFiles       = 200
	gitLineStatsFileBytes      int64 = 1_000_000
	gitLineStatsTotalBytes     int64 = 20_000_000
)

// Mirrors shared/git-line-stats.ts. Nil sides are unknown, not measured zero.
type gitLineStatsFile struct {
	Path            string `json:"path"`
	StagedAdded     *int64 `json:"stagedLinesAdded,omitempty"`
	StagedRemoved   *int64 `json:"stagedLinesRemoved,omitempty"`
	UnstagedAdded   *int64 `json:"unstagedLinesAdded,omitempty"`
	UnstagedRemoved *int64 `json:"unstagedLinesRemoved,omitempty"`
	Complete        bool   `json:"complete"`
}

type gitLineStats struct {
	Files    []gitLineStatsFile `json:"files"`
	Added    int64              `json:"linesAdded"`
	Removed  int64              `json:"linesRemoved"`
	Complete bool               `json:"complete"`
}

// Stops rather than draining after the byte/record budget. The caller parses only
// complete NUL records, and discards an incomplete multi-record rename atomically.
type lineStatsOutput struct {
	statusOutput
}

func (s *lineStatsOutput) Write(p []byte) (int, error) {
	for i, b := range p {
		if s.records >= s.maxRecords || int64(s.output.Len()+len(s.pending)) >= s.limit {
			s.truncated = true
			s.stop()
			return i, errGitStatusLimit
		}
		s.pending = append(s.pending, b)
		if b == 0 {
			s.output.Write(s.pending)
			s.pending = s.pending[:0]
			s.records++
		}
	}
	return len(p), nil
}

func (g *workspaceGit) runLineStatsNUL(maxRecords int, args ...string) (string, bool, error) {
	if err := g.ctx.Err(); err != nil {
		return "", false, err
	}
	ctx, stop := context.WithCancel(g.ctx)
	defer stop()
	prefix := []string{"--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false"}
	cmd := exec.CommandContext(ctx, "git", append(prefix, args...)...)
	cmd.Dir, cmd.Env = g.root, g.env
	configureProcAttr(cmd)
	cmd.Cancel = func() error { killProcessGroup(cmd); return nil }
	cmd.WaitDelay = time.Second
	out := &lineStatsOutput{statusOutput: statusOutput{limit: g.remaining, maxRecords: maxRecords, stop: stop}}
	stderr := &cappedBuffer{limit: 4096}
	cmd.Stdout, cmd.Stderr = out, stderr
	err := cmd.Run()
	if g.ctx.Err() != nil {
		return "", false, fmt.Errorf("Git operation cancelled or timed out: %w", g.ctx.Err())
	}
	if err != nil && !out.truncated {
		return "", false, fmt.Errorf("Git line statistics failed: %w: %s", err, stderr.Bytes())
	}
	if len(out.pending) > 0 && !out.truncated {
		return "", false, fmt.Errorf("Git line statistics returned an incomplete record")
	}
	raw := out.output.String()
	g.remaining -= int64(len(raw))
	return raw, out.truncated, nil
}

func parseLineStatsNumstat(raw string, staged, truncated bool, files map[string]*gitLineStatsFile, order *[]string) error {
	records := strings.Split(raw, "\x00")
	for i := 0; i < len(records)-1; i++ {
		fields := strings.SplitN(records[i], "\t", 3)
		if len(fields) != 3 {
			return fmt.Errorf("invalid Git numstat record")
		}
		path := fields[2]
		if path == "" {
			if i+2 >= len(records)-1 {
				if truncated {
					break
				} // discard an incomplete capped rename atomically
				return fmt.Errorf("Git numstat returned an incomplete rename record")
			}
			i += 2
			path = records[i]
		}
		if err := validateGitFilePath(path); err != nil {
			return err
		}
		if !utf8.ValidString(path) {
			return fmt.Errorf("Git line statistics require UTF-8 paths")
		}
		var added, removed int64
		if fields[0] != "-" || fields[1] != "-" {
			var err error
			added, err = strconv.ParseInt(fields[0], 10, 64)
			if err != nil || added < 0 {
				return fmt.Errorf("invalid Git added-line count")
			}
			removed, err = strconv.ParseInt(fields[1], 10, 64)
			if err != nil || removed < 0 {
				return fmt.Errorf("invalid Git removed-line count")
			}
		}
		file := files[path]
		if file == nil {
			file = &gitLineStatsFile{Path: path, Complete: true}
			files[path] = file
			*order = append(*order, path)
		}
		if staged {
			file.StagedAdded, file.StagedRemoved = &added, &removed
		} else {
			file.UnstagedAdded, file.UnstagedRemoved = &added, &removed
		}
	}
	return nil
}

type untrackedLineCacheEntry struct {
	identity string
	lines    int64
}

var untrackedLineCache = struct {
	sync.Mutex
	entries map[string]untrackedLineCacheEntry
}{entries: make(map[string]untrackedLineCacheEntry)}

// Only regular, authorized, identity-bound files are read. No content leaves the
// device. Metadata keys include ctime/change time so restored mtime is not a hit.
func (h *Handlers) untrackedLineCount(g *workspaceGit, path string, remaining *int64) (int64, bool, error) {
	if err := g.ctx.Err(); err != nil {
		return 0, false, err
	}
	if err := validateGitFilePath(path); err != nil {
		return 0, false, err
	}
	full := filepath.Join(g.root, filepath.FromSlash(path))
	info, err := os.Lstat(full)
	if err != nil || !info.Mode().IsRegular() {
		return 0, false, nil
	}
	if info.Size() > gitLineStatsFileBytes || info.Size() > *remaining {
		return 0, false, nil
	}
	resolved, err := h.guard.CheckExisting(full)
	if err != nil || !samePath(resolved, full) {
		return 0, false, nil
	}
	f, _, err := h.openReadFile(map[string]any{"path": full, "expectedResolvedPath": full})
	if err != nil {
		return 0, false, nil
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !opened.Mode().IsRegular() || !os.SameFile(info, opened) || opened.Size() != info.Size() {
		return 0, false, nil
	}
	identity, err := lineStatsFileIdentity(f)
	if err != nil {
		return 0, false, nil
	}
	*remaining -= opened.Size()
	untrackedLineCache.Lock()
	cached, hit := untrackedLineCache.entries[full]
	untrackedLineCache.Unlock()
	if hit && cached.identity == identity {
		return cached.lines, true, g.ctx.Err()
	}
	buf := make([]byte, 32*1024)
	var size, lines int64
	var last byte
	binary := false
	for {
		if err := g.ctx.Err(); err != nil {
			return 0, false, err
		}
		n, readErr := f.Read(buf)
		if n > 0 {
			size += int64(n)
			if size > opened.Size() {
				return 0, false, nil
			}
			sample := n
			if start := size - int64(n); start >= 8000 {
				sample = 0
			} else if int64(sample) > 8000-start {
				sample = int(8000 - start)
			}
			if bytes.IndexByte(buf[:sample], 0) >= 0 {
				binary = true
			}
			lines += int64(bytes.Count(buf[:n], []byte{'\n'}))
			last = buf[n-1]
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return 0, false, nil
		}
	}
	after, err := lineStatsFileIdentity(f)
	if err != nil || after != identity || size != opened.Size() {
		return 0, false, nil
	}
	current, err := os.Lstat(full)
	if err != nil || !current.Mode().IsRegular() || !os.SameFile(opened, current) {
		return 0, false, nil
	}
	resolved, err = h.guard.CheckExisting(full)
	if err != nil || !samePath(resolved, full) {
		return 0, false, nil
	}
	if binary {
		lines = 0
	} else if size > 0 && last != '\n' {
		lines++
	}
	untrackedLineCache.Lock()
	if len(untrackedLineCache.entries) >= 512 {
		clear(untrackedLineCache.entries)
	}
	untrackedLineCache.entries[full] = untrackedLineCacheEntry{identity, lines}
	untrackedLineCache.Unlock()
	return lines, true, g.ctx.Err()
}

func (h *Handlers) gitWorkspaceLineStats(g *workspaceGit, maxBytes int64) (any, error) {
	files := make(map[string]*gitLineStatsFile)
	order := []string{}
	staged, stagedCut, err := g.runLineStatsNUL(30000, "--no-literal-pathspecs", "diff", "--cached", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--", ".", stagingExcludeSpec())
	if err != nil {
		return nil, err
	}
	if err = parseLineStatsNumstat(staged, true, stagedCut, files, &order); err != nil {
		return nil, err
	}
	unstaged, unstagedCut, err := g.runLineStatsNUL(30000, "--no-literal-pathspecs", "diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--", ".", stagingExcludeSpec())
	if err != nil {
		return nil, err
	}
	if err = parseLineStatsNumstat(unstaged, false, unstagedCut, files, &order); err != nil {
		return nil, err
	}
	untracked, untrackedCut, err := g.runLineStatsNUL(gitLineStatsUntrackedFiles, "--no-literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--", ".", stagingExcludeSpec())
	if err != nil {
		return nil, err
	}
	remaining := gitLineStatsTotalBytes
	complete := !stagedCut && !unstagedCut && !untrackedCut
	for _, path := range strings.Split(untracked, "\x00") {
		if path == "" {
			continue
		}
		if !utf8.ValidString(path) {
			return nil, fmt.Errorf("Git line statistics require UTF-8 paths")
		}
		lines, measured, err := h.untrackedLineCount(g, path, &remaining)
		if err != nil {
			return nil, err
		}
		file := files[path]
		if file == nil {
			file = &gitLineStatsFile{Path: path, Complete: true}
			files[path] = file
			order = append(order, path)
		}
		file.Complete = file.Complete && measured
		if measured {
			zero := int64(0)
			file.UnstagedAdded, file.UnstagedRemoved = &lines, &zero
		}
		complete = complete && measured
	}
	stats := gitLineStats{Files: []gitLineStatsFile{}, Complete: complete}
	// Count encoded bytes once per file. Reserve enough for totals and envelope;
	// a long escaped path cannot exceed the request or transport output budget.
	remainingOutput := maxBytes - 128
	for _, path := range order {
		if err := g.ctx.Err(); err != nil {
			return nil, err
		}
		file := files[path]
		zero := int64(0)
		if !stagedCut && file.StagedAdded == nil {
			file.StagedAdded, file.StagedRemoved = &zero, &zero
		}
		// A staged deletion can also be an untracked recreated path. If the
		// untracked listing was capped, absence from its prefix is not zero.
		if !unstagedCut && !untrackedCut && file.Complete && file.UnstagedAdded == nil {
			file.UnstagedAdded, file.UnstagedRemoved = &zero, &zero
		}
		file.Complete = file.Complete && file.StagedAdded != nil && file.UnstagedAdded != nil
		encoded, err := json.Marshal(file)
		if err != nil {
			return nil, err
		}
		if len(stats.Files) >= 10000 || int64(len(encoded)+1) > remainingOutput {
			stats.Complete = false
			break
		}
		remainingOutput -= int64(len(encoded) + 1)
		stats.Files = append(stats.Files, *file)
		stats.Complete = stats.Complete && file.Complete
		for _, value := range []*int64{file.StagedAdded, file.UnstagedAdded} {
			if value != nil {
				stats.Added += *value
			}
		}
		for _, value := range []*int64{file.StagedRemoved, file.UnstagedRemoved} {
			if value != nil {
				stats.Removed += *value
			}
		}
	}
	result := map[string]any{"lineStats": stats}
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	if int64(len(encoded)) > maxBytes {
		return nil, fmt.Errorf("Git line statistics output budget is too small")
	}
	if err := g.ctx.Err(); err != nil {
		return nil, err
	}
	return result, nil
}
