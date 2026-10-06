package handlers

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"strings"
)

const gitWatchMaxPaths = 2000

func gitWatchFingerprint(value string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(value)))
}

// gitWorkspaceWatch adds four commands to the shared root/helper/HEAD checks,
// regardless of how many files Git reports. It never reads file contents or
// runs per-file diffs. All subprocesses share the request deadline and byte cap.
func (h *Handlers) gitWorkspaceWatch(g *workspaceGit, head string) (any, error) {
	// HEAD and its symbolic name have an independent small metadata budget:
	// large worktree output must never make log identity uncertain.
	budget := g.remaining
	g.remaining = 4096
	branch, code, err := g.run("symbolic-ref", "--quiet", "HEAD")
	if err != nil && code != 1 {
		return nil, err
	}
	if g.truncated {
		return nil, fmt.Errorf("Git symbolic HEAD exceeds metadata budget")
	}
	g.remaining = budget
	status, _, err := g.runNUL("status", "--porcelain=v1", "-z", "--untracked-files=all")
	if err != nil {
		return nil, err
	}
	uncertain := g.truncated
	worktree := sha256.New()
	fmt.Fprintf(worktree, "%s\x00", status)
	records := strings.Split(status, "\x00")
	count := 0
	for i := 0; i < len(records)-1; i++ {
		if err := g.ctx.Err(); err != nil {
			return nil, err
		}
		record := records[i]
		if len(record) < 4 || record[2] != ' ' {
			uncertain = true
			break
		}
		paths := []string{record[3:]}
		if strings.ContainsAny(record[:2], "RC") {
			i++
			if i >= len(records)-1 {
				uncertain = true
				break
			}
			paths = append(paths, records[i])
		}
		for _, path := range paths {
			if count >= gitWatchMaxPaths {
				uncertain = true
				break
			}
			count++
			if err := validateGitFilePath(path); err != nil {
				// Git can report legal host filenames rejected by our stricter
				// write-path policy (e.g. ':' or '\\' on Linux). Do not inspect
				// those entries, but keep sampling other files and categories.
				uncertain = true
				continue
			}
			joined, err := h.checkGitEntryPath(g.root, path)
			if err != nil {
				// A path that cannot be safely inspected is uncertainty, not a
				// reason to discard independently safe HEAD/index/stash samples.
				uncertain = true
				continue
			}
			// Lstat preserves symlink-entry semantics. Directories here come
			// from Git's status (e.g. gitlinks), not caller-controlled pathspecs;
			// no ls-files subprocess is necessary for read-only metadata.
			info, err := os.Lstat(joined)
			if errors.Is(err, os.ErrNotExist) {
				fmt.Fprintf(worktree, "%s\x00missing\x00", path)
				continue
			}
			if err != nil {
				uncertain = true
				continue
			}
			fmt.Fprintf(worktree, "%s\x00%d:%d:%d\x00", path, info.Size(), info.ModTime().UnixNano(), info.Mode())
			// A dirty gitlink's interior is not covered by its directory mtime.
			if info.IsDir() {
				uncertain = true
			}
		}
		if count >= gitWatchMaxPaths && i < len(records)-2 {
			uncertain = true
			break
		}
	}
	index, _, err := g.runNUL("diff", "--cached", "--raw", "--no-abbrev", "--no-ext-diff", "--no-textconv", "-z")
	if err != nil {
		return nil, err
	}
	stash, _, err := g.run("stash", "list", "--format=%H%x00%gs")
	if err != nil {
		return nil, err
	}
	if err := g.ctx.Err(); err != nil {
		return nil, err
	}
	outputs := map[string]string{
		"worktree": fmt.Sprintf("%x", worktree.Sum(nil)),
		"index":    gitWatchFingerprint(index),
		"head":     gitWatchFingerprint(head + "\x00" + branch),
		"stash":    gitWatchFingerprint(stash),
	}
	if uncertain || g.truncated {
		outputs["uncertainWorktree"] = "true"
	}
	return map[string]any{"outputs": outputs, "truncated": g.truncated}, nil
}
