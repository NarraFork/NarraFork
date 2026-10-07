package history

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

type CaptureFilterProof struct {
	Version     int    `json:"version"`
	Kind        string `json:"kind"`
	Fingerprint string `json:"fingerprint"`
	Complete    bool   `json:"complete"`
}
type filterFile struct {
	Path   string `json:"path"`
	Digest string `json:"digest"`
	Absent bool   `json:"absent,omitempty"`
}
type filterSource struct {
	SourceInstanceID   string       `json:"sourceInstanceId"`
	RootIdentity       string       `json:"rootIdentity"`
	TrackedPaths       string       `json:"trackedPathsDigest"`
	Root               string       `json:"root"`
	Repository         string       `json:"repository"`
	GitDirectory       string       `json:"gitDirectory"`
	CommonDirectory    string       `json:"commonDirectory"`
	RepositoryIdentity string       `json:"repositoryIdentity"`
	GitIdentity        string       `json:"gitIdentity"`
	CommonIdentity     string       `json:"commonIdentity"`
	Configuration      string       `json:"configurationDigest"`
	Files              []filterFile `json:"files"`
}

func captureGitCommand(ctx context.Context, root string, args ...string) (string, int, error) {
	command := exec.CommandContext(ctx, "git", append([]string{"--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=" + os.DevNull}, args...)...)
	command.Dir = root
	command.Env = []string{}
	for _, item := range os.Environ() {
		if !strings.HasPrefix(item, "GIT_") {
			command.Env = append(command.Env, item)
		}
	}
	command.Env = append(command.Env, "GIT_OPTIONAL_LOCKS=0")
	stdout := &limitedTreeOutput{limit: 512 << 10}
	stderr := &limitedTreeOutput{limit: 8192}
	command.Stdout = stdout
	command.Stderr = stderr
	err := command.Run()
	if stdout.exceeded || stderr.exceeded {
		return "", -1, fmt.Errorf("git filter provenance output budget")
	}
	if err != nil {
		if status, ok := err.(*exec.ExitError); ok {
			return stdout.String(), status.ExitCode(), nil
		}
		return "", -1, err
	}
	return stdout.String(), 0, ctx.Err()
}

// All effective Git filtering inputs are hashed privately, never returned as
// raw config/ignore text. This proof is immutable capture evidence, not a label
// copied from whichever policy happens to be current during restoration.
func (c *treeCapture) filterProof(ctx context.Context) (CaptureFilterProof, error) {
	gitRoot := ""
	for ancestor := c.binding.Root; ; ancestor = filepath.Dir(ancestor) {
		if _, err := os.Lstat(filepath.Join(ancestor, ".git")); err == nil {
			gitRoot = ancestor
			break
		} else if !os.IsNotExist(err) {
			return CaptureFilterProof{}, err
		}
		if filepath.Dir(ancestor) == ancestor {
			break
		}
	}
	if gitRoot == "" {
		c.git = false
		return CaptureFilterProof{Version: 1, Kind: "none", Fingerprint: key("none\x00" + c.binding.SourceInstanceID + "\x00" + c.binding.Root + "\x00" + c.binding.RootIdentity), Complete: true}, nil
	}
	c.git = true
	source := filterSource{Root: c.binding.Root, SourceInstanceID: c.binding.SourceInstanceID, RootIdentity: c.binding.RootIdentity}
	outputs := []*string{&source.Repository, &source.GitDirectory, &source.CommonDirectory}
	commands := [][]string{{"rev-parse", "--show-toplevel"}, {"rev-parse", "--absolute-git-dir"}, {"rev-parse", "--git-common-dir"}}
	for i, args := range commands {
		output, code, err := captureGitCommand(ctx, c.binding.Root, args...)
		if err != nil || code != 0 {
			return CaptureFilterProof{}, fmt.Errorf("git filter repository identity unavailable")
		}
		path := strings.TrimSpace(output)
		if !filepath.IsAbs(path) {
			path = filepath.Join(c.binding.Root, path)
		}
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil {
			return CaptureFilterProof{}, err
		}
		*outputs[i] = resolved
	}
	if !within(source.Repository, c.binding.Root) {
		return CaptureFilterProof{}, fmt.Errorf("git filter repository/root mismatch")
	}
	var err error
	source.RepositoryIdentity, err = rootIdentity(source.Repository)
	if err != nil {
		return CaptureFilterProof{}, err
	}
	source.GitIdentity, err = rootIdentity(source.GitDirectory)
	if err != nil {
		return CaptureFilterProof{}, err
	}
	source.CommonIdentity, err = rootIdentity(source.CommonDirectory)
	if err != nil {
		return CaptureFilterProof{}, err
	}
	config, code, err := captureGitCommand(ctx, c.binding.Root, "config", "--null", "--show-origin", "--list")
	if err != nil || code != 0 {
		return CaptureFilterProof{}, fmt.Errorf("effective git filtering configuration unavailable")
	}
	source.Configuration = hash([]byte(config))
	tracked, status, err := captureGitCommand(ctx, c.binding.Root, "ls-files", "--cached", "--full-name", "-z")
	if err != nil || status != 0 {
		return CaptureFilterProof{}, fmt.Errorf("git tracked filter input unavailable")
	}
	source.TrackedPaths = hash([]byte(tracked))
	paths := map[string]bool{}
	add := func(path string) {
		if path != "" {
			paths[filepath.Clean(path)] = true
		}
	}
	add(filepath.Join(source.GitDirectory, "config"))
	add(filepath.Join(source.GitDirectory, "config.worktree"))
	add(filepath.Join(source.CommonDirectory, "config"))
	add(filepath.Join(source.GitDirectory, "info", "exclude"))
	add(filepath.Join(source.CommonDirectory, "info", "exclude"))
	// show-origin records are NUL-separated source then key/value. Included config
	// paths are hashed too: content changes can preserve the same effective value.
	for _, part := range strings.Split(config, "\x00") {
		if strings.HasPrefix(part, "file:") {
			path := strings.TrimPrefix(part, "file:")
			if !filepath.IsAbs(path) {
				path = filepath.Join(c.binding.Root, path)
			}
			add(path)
		}
	}
	excludes, status, err := captureGitCommand(ctx, c.binding.Root, "config", "--path", "--get", "core.excludesFile")
	if err != nil {
		return CaptureFilterProof{}, err
	}
	if status == 0 {
		path := strings.TrimSpace(excludes)
		if !filepath.IsAbs(path) {
			path = filepath.Join(c.binding.Root, path)
		}
		add(path)
	} else if status != 1 {
		return CaptureFilterProof{}, fmt.Errorf("effective global exclude source unavailable")
	} else {
		base := os.Getenv("XDG_CONFIG_HOME")
		if base == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return CaptureFilterProof{}, err
			}
			base = filepath.Join(home, ".config")
		}
		add(filepath.Join(base, "git", "ignore"))
	}
	for ancestor := c.binding.Root; ; ancestor = filepath.Dir(ancestor) {
		add(filepath.Join(ancestor, ".gitignore"))
		if samePathForFilter(ancestor, source.Repository) {
			break
		}
		if filepath.Dir(ancestor) == ancestor {
			return CaptureFilterProof{}, fmt.Errorf("git ignore ancestor chain mismatch")
		}
	}
	// Nested .gitignore files affect filtering. Enumerate metadata only, in bounded
	// batches; no symlink traversal, no reading denied paths or private CAS bytes.
	count := 0
	var walk func(string) error
	walk = func(dir string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !c.allowed(dir) {
			return nil
		}
		file, err := os.Open(dir)
		if err != nil {
			return err
		}
		defer file.Close()
		for {
			entries, readErr := file.ReadDir(128)
			for _, entry := range entries {
				count++
				if count > treePaths {
					return fmt.Errorf("git filter inventory path budget")
				}
				if entry.Name() == ".git" {
					continue
				}
				path := filepath.Join(dir, entry.Name())
				if entry.Name() == ".gitignore" {
					if !c.allowed(path) {
						return fmt.Errorf("git ignore input is denied")
					}
					add(path)
				}
				if entry.IsDir() && entry.Type()&os.ModeSymlink == 0 && c.allowed(path) {
					if err := walk(path); err != nil {
						return err
					}
				}
			}
			if readErr == io.EOF {
				break
			}
			if readErr != nil {
				return readErr
			}
		}
		return nil
	}
	if err := walk(c.binding.Root); err != nil {
		return CaptureFilterProof{}, err
	}
	ordered := []string{}
	for path := range paths {
		ordered = append(ordered, path)
	}
	sort.Strings(ordered)
	if len(ordered) > treePaths {
		return CaptureFilterProof{}, fmt.Errorf("git filter input budget")
	}
	var total int64
	for _, path := range ordered {
		if err := ctx.Err(); err != nil {
			return CaptureFilterProof{}, err
		}
		info, err := os.Lstat(path)
		if os.IsNotExist(err) {
			source.Files = append(source.Files, filterFile{Path: path, Absent: true})
			continue
		}
		if err != nil {
			return CaptureFilterProof{}, err
		}
		// Metadata/config sources are inspected by Git itself; capture must have read
		// authority too. Otherwise do not claim a complete restore-safe filter proof.
		if _, err := c.manager.guard(path, false); err != nil {
			return CaptureFilterProof{}, fmt.Errorf("git filter input denied")
		}
		if !info.Mode().IsRegular() || info.Size() > 1<<20 {
			return CaptureFilterProof{}, fmt.Errorf("git filter input unsupported/too_large")
		}
		total += info.Size()
		if total > 16<<20 {
			return CaptureFilterProof{}, fmt.Errorf("git filter input byte budget")
		}
		file, err := os.Open(path)
		if err != nil {
			return CaptureFilterProof{}, err
		}
		opened, openErr := file.Stat()
		if openErr != nil || !sameTreeInfo(info, opened) {
			file.Close()
			return CaptureFilterProof{}, fmt.Errorf("git filter input changed before read")
		}
		data, err := io.ReadAll(io.LimitReader(file, (1<<20)+1))
		readInfo, readErr := file.Stat()
		if readErr != nil || !sameTreeInfo(opened, readInfo) {
			file.Close()
			return CaptureFilterProof{}, fmt.Errorf("git filter input changed during read")
		}
		file.Close()
		if err != nil || len(data) > 1<<20 {
			return CaptureFilterProof{}, fmt.Errorf("git filter input read incomplete")
		}
		after, err := os.Stat(path)
		if err != nil || !sameTreeInfo(info, after) {
			return CaptureFilterProof{}, fmt.Errorf("git filter input changed")
		}
		source.Files = append(source.Files, filterFile{Path: path, Digest: hash(data)})
	}
	raw, err := json.Marshal(source)
	if err != nil {
		return CaptureFilterProof{}, err
	}
	return CaptureFilterProof{Version: 1, Kind: "git", Fingerprint: hash(raw), Complete: true}, nil
}
func samePathForFilter(a, b string) bool { return filepath.Clean(a) == filepath.Clean(b) }
