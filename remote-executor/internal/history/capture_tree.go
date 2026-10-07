package history

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const treePaths = 100000
const treeCandidateBytes int64 = 512 << 20
const treeShardEntries = 500

type TreeEntry struct {
	Path  string `json:"path"`
	Kind  string `json:"kind"`
	State *State `json:"state,omitempty"`
	Mode  uint32 `json:"mode,omitempty"`
}
type treePage struct {
	Format  string      `json:"format"`
	Entries []TreeEntry `json:"entries"`
}
type treeIndex struct {
	FilterProof   CaptureFilterProof `json:"filterProof"`
	Format        string             `json:"format"`
	Binding       Binding            `json:"binding"`
	PolicyDigest  string             `json:"policyDigest"`
	Pages         []Object           `json:"pages"`
	EntryCount    int                `json:"entryCount"`
	ExcludedCount int                `json:"excludedCount"`
	Coverage      string             `json:"coverage"`
	Consistency   string             `json:"consistency"`
}
type treeObservation struct {
	Path  string
	Info  os.FileInfo
	Entry TreeEntry
}

type treeCapture struct {
	manager      *Manager
	binding      Binding
	policy       *TreeCapturePolicy
	denied       []string
	observations []treeObservation
	excluded     int
	paths        int
	bytes        int64
	git          bool
	policyFiles  map[string]string
}

func (c *treeCapture) allowed(path string) bool {
	if _, err := c.manager.guard(path, false); err != nil {
		return false
	}
	for _, deny := range c.denied {
		if within(deny, path) {
			return false
		}
	}
	return true
}

// Ignore evaluation is read-only, bounded and uses the executor's Git executable.
// No git init, index write, hooks, fsmonitor or user-repository snapshot objects.
func (c *treeCapture) ignored(ctx context.Context, paths []string) (map[string]bool, error) {
	result := map[string]bool{}
	if !c.git || len(paths) == 0 {
		return result, nil
	}
	var input bytes.Buffer
	for _, path := range paths {
		input.WriteString(filepath.ToSlash(path))
		input.WriteByte(0)
	}
	if input.Len() > 512<<10 {
		return nil, fmt.Errorf("git ignore input budget")
	}
	cmd := exec.CommandContext(ctx, "git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath="+os.DevNull, "check-ignore", "--stdin", "-z")
	cmd.Dir = c.binding.Root
	cmd.Env = []string{}
	for _, item := range os.Environ() {
		if !strings.HasPrefix(item, "GIT_") {
			cmd.Env = append(cmd.Env, item)
		}
	}
	cmd.Env = append(cmd.Env, "GIT_OPTIONAL_LOCKS=0")
	cmd.Stdin = &input
	stdout := &limitedTreeOutput{limit: 512 << 10}
	stderr := &limitedTreeOutput{limit: 8192}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	err := cmd.Run()
	if stdout.exceeded || stderr.exceeded {
		return nil, fmt.Errorf("git ignore output budget")
	}
	if err != nil {
		var status *exec.ExitError
		if !errors.As(err, &status) || status.ExitCode() != 1 {
			return nil, fmt.Errorf("git_ignore_unavailable")
		}
	}
	for _, path := range strings.Split(stdout.String(), "\x00") {
		if path != "" {
			result[filepath.FromSlash(path)] = true
		}
	}
	return result, ctx.Err()
}

type limitedTreeOutput struct {
	bytes.Buffer
	limit    int
	exceeded bool
}

func (o *limitedTreeOutput) Write(data []byte) (int, error) {
	if o.Len()+len(data) > o.limit {
		o.exceeded = true
		return 0, fmt.Errorf("capture subprocess output budget")
	}
	return o.Buffer.Write(data)
}

func (c *treeCapture) scan(ctx context.Context, dir, relative string, capture bool, seen map[string]os.FileInfo) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := c.manager.validateHistorical(c.binding); err != nil {
		return err
	}
	if !c.allowed(dir) {
		c.excluded++
		return nil
	}
	file, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer file.Close()
	pinned, err := file.Stat()
	if err != nil {
		return err
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		entries, readErr := file.ReadDir(128)
		candidates := []string{}
		for _, entry := range entries {
			if entry.Name() == ".gitignore" && c.git && !c.allowed(filepath.Join(dir, entry.Name())) {
				return fmt.Errorf("git_ignore_policy_denied")
			}
			if entry.Name() == ".git" {
				continue
			}
			child := entry.Name()
			if relative != "" {
				child = filepath.Join(relative, child)
			}
			if c.allowed(filepath.Join(c.binding.Root, child)) {
				candidates = append(candidates, child)
			}
		}
		ignored, err := c.ignored(ctx, candidates)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := c.manager.fault("tree_walk_entry"); err != nil {
				return err
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			c.paths++
			if c.paths > treePaths {
				return fmt.Errorf("path_budget_exceeded")
			}
			child := entry.Name()
			if relative != "" {
				child = filepath.Join(relative, child)
			}
			absolute := filepath.Join(c.binding.Root, child)
			if entry.Name() == ".git" || !c.allowed(absolute) || ignored[child] {
				c.excluded++
				continue
			}
			info, err := os.Lstat(absolute)
			if err != nil {
				return err
			}
			if info.Mode()&os.ModeSymlink != 0 || (!info.IsDir() && !info.Mode().IsRegular()) {
				return fmt.Errorf("unsupported_object")
			}
			if capture {
				item := TreeEntry{Path: child, Kind: "directory", Mode: uint32(info.Mode().Perm())}
				if info.Mode().IsRegular() {
					c.bytes += info.Size()
					if c.bytes > treeCandidateBytes {
						return fmt.Errorf("candidate_budget_exceeded")
					}
					state, err := c.manager.observe(ctx, c.binding, child, true)
					if err != nil {
						return err
					}
					item.Kind = "regular"
					item.State = &state
					c.policyFiles[child] = state.Object.Digest
				}
				c.observations = append(c.observations, treeObservation{child, info, item})
			} else {
				previous, ok := seen[child]
				if !ok || !sameTreeInfo(previous, info) {
					return fmt.Errorf("external_writer_detected")
				}
				if info.Mode().IsRegular() {
					current, err := c.manager.observe(ctx, c.binding, child, true)
					if err != nil {
						return err
					}
					original := c.policyFiles[child]
					if current.Object == nil || current.Object.Digest != original {
						return fmt.Errorf("external_writer_detected")
					}
				}
				delete(seen, child)
			}
			if info.IsDir() {
				if err := c.scan(ctx, absolute, child, capture, seen); err != nil {
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
	current, err := os.Stat(dir)
	if err != nil {
		return err
	}
	if !sameTreeInfo(pinned, current) {
		return fmt.Errorf("external_writer_detected")
	}
	return nil
}
func sameTreeInfo(a, b os.FileInfo) bool {
	return os.SameFile(a, b) && a.Size() == b.Size() && a.ModTime() == b.ModTime() && a.Mode() == b.Mode()
}

func (m *Manager) CaptureTree(parent context.Context, request Request) (*Receipt, error) {
	phase := request.CapturePhase
	if phase == "" {
		phase = "hot"
	}
	deadline := 4 * time.Second
	if phase == "warm" {
		deadline = 120 * time.Second
	} else if phase != "hot" {
		return nil, fmt.Errorf("invalid capture phase")
	}
	ctx, cancel := context.WithTimeout(parent, deadline)
	defer cancel()
	stop := context.AfterFunc(m.captureContext, cancel)
	defer stop()
	select {
	case m.captureQueue <- struct{}{}:
	default:
		return nil, fmt.Errorf("capture queue budget")
	}
	defer func() { <-m.captureQueue }()
	select {
	case m.captureSlots <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-m.captureSlots }()
	if err := m.acquire(ctx); err != nil {
		return nil, err
	}
	locked := true
	defer func() {
		if locked {
			m.release()
		}
	}()
	// Deadline/attempt is not an IO intent identity. Warm retries use the original
	// operation ID and retain the durable hot attempt, not an untracked second job.
	request.CapturePhase = ""
	r, exists, err := m.prepareRequest(request, "capture")
	if err != nil {
		return nil, err
	}
	jobKey := request.Binding.ScopeID + "\x00" + request.OperationID
	if exists {
		if m.captureActive[jobKey] {
			return r, nil
		}
		if r.CaptureKind != "whole_directory" {
			return nil, fmt.Errorf("capture form conflict")
		}
		if phase != "warm" || r.CapturePhase != "hot" || r.State != "settled" || r.Coverage != "partial" {
			return r, nil
		}
		r.CaptureAttempts = append(r.CaptureAttempts, CaptureAttempt{r.CapturePhase, r.Tree, r.Coverage, r.Reason})
	}
	if request.TreePolicy == nil || !validDigest(request.TreePolicy.PolicyDigest) || len(request.TreePolicy.DeniedDirectories) > 256 {
		return nil, fmt.Errorf("verified tree policy is required")
	}
	capture := &treeCapture{manager: m, binding: request.Binding, policy: request.TreePolicy, policyFiles: map[string]string{}}
	for _, denied := range request.TreePolicy.DeniedDirectories {
		path := denied
		if !filepath.IsAbs(path) {
			path = filepath.Join(request.Binding.Root, path)
		}
		path = filepath.Clean(path)
		if !within(request.Binding.Root, path) {
			return nil, fmt.Errorf("server deny directory outside capture root")
		}
		capture.denied = append(capture.denied, path)
		if resolved, err := filepath.EvalSymlinks(path); err == nil {
			capture.denied = append(capture.denied, resolved)
		}
	}
	if !capture.allowed(request.Binding.Root) {
		return nil, fmt.Errorf("capture root denied")
	}
	if _, err := os.Lstat(filepath.Join(request.Binding.Root, ".git")); err == nil {
		capture.git = true
		if _, err := m.guard(filepath.Join(request.Binding.Root, ".git"), false); err != nil {
			return nil, fmt.Errorf("git_ignore_policy_denied")
		}
	}
	r.CaptureKind = "whole_directory"
	r.CapturePhase = phase
	r.State = "intent"
	r.Tree = nil
	r.Coverage = "partial"
	r.Reason = "capture_incomplete"
	r.PolicyDigest = request.TreePolicy.PolicyDigest
	if err := m.saveReceipt(r); err != nil {
		return r, err
	}
	m.captureActive[jobKey] = true
	m.captureWG.Add(1)
	m.release()
	locked = false
	defer func() { m.mu.Lock(); delete(m.captureActive, jobKey); m.mu.Unlock(); m.captureWG.Done() }()
	filterProof, scanErr := capture.filterProof(ctx)
	if scanErr == nil {
		scanErr = capture.scan(ctx, request.Binding.Root, "", true, nil)
	}
	consistency := "unknown"
	if scanErr == nil {
		scanErr = m.fault("tree_before_verify")
	}
	if scanErr == nil {
		excludedFirst := capture.excluded
		seen := map[string]os.FileInfo{}
		for _, entry := range capture.observations {
			seen[entry.Path] = entry.Info
		}
		capture.paths = 0
		scanErr = capture.scan(ctx, request.Binding.Root, "", false, seen)
		capture.excluded = excludedFirst
		if scanErr == nil && len(seen) != 0 {
			scanErr = fmt.Errorf("external_writer_detected")
		}
		if scanErr == nil {
			consistency = "stable_double_scan"
		} else {
			consistency = "changed"
		}
	}
	if filterProof.Complete {
		afterProof, err := capture.filterProof(ctx)
		if err != nil || afterProof != filterProof {
			filterProof.Complete = false
			if scanErr == nil {
				scanErr = fmt.Errorf("capture_filter_changed")
			}
			consistency = "changed"
		}
	}
	if filterProof.Version == 0 {
		filterProof.Version = 1
		filterProof.Kind = "none"
		if capture.git {
			filterProof.Kind = "git"
		}
	}
	if err := m.validate(request.Binding); err != nil {
		scanErr = err
		consistency = "changed"
	}
	sort.Slice(capture.observations, func(i, j int) bool { return capture.observations[i].Path < capture.observations[j].Path })
	pages := []Object{}
	for start := 0; start < len(capture.observations); start += treeShardEntries {
		end := start + treeShardEntries
		if end > len(capture.observations) {
			end = len(capture.observations)
		}
		entries := []TreeEntry{}
		for _, entry := range capture.observations[start:end] {
			entries = append(entries, entry.Entry)
		}
		data, _ := json.Marshal(treePage{Format: "full_tree_page_v1", Entries: entries})
		if len(data) > 4<<20 {
			return r, fmt.Errorf("tree page metadata budget")
		}
		object, err := m.putObject(request.Binding, data, "tree", "")
		if err != nil {
			return r, err
		}
		pages = append(pages, *object)
	}
	coverage := "complete"
	reason := ""
	if scanErr != nil {
		coverage = "partial"
		reason = scanErr.Error()
		if ctx.Err() != nil {
			reason = "capture_deadline"
		}
	}
	index := treeIndex{FilterProof: filterProof, Format: "whole_directory_tree_v1", Binding: request.Binding, PolicyDigest: request.TreePolicy.PolicyDigest, Pages: pages, EntryCount: len(capture.observations), ExcludedCount: capture.excluded, Coverage: coverage, Consistency: consistency}
	data, _ := json.Marshal(index)
	if len(data) > 1<<20 {
		return r, fmt.Errorf("tree index metadata budget")
	}
	object, err := m.putObject(request.Binding, data, "tree", "")
	if err != nil {
		return r, err
	}
	r.Tree = object
	r.Coverage = coverage
	r.Reason = reason
	r.Consistency = consistency
	r.TemporalConsistency = "concurrent_observation"
	r.EntryCount = len(capture.observations)
	r.ExcludedCount = capture.excluded
	r.CandidateBytes = capture.bytes
	r.State = "settled"
	r.FinishedAt = now()
	if err := m.saveReceipt(r); err != nil {
		return r, err
	}
	return r, nil
}

func (m *Manager) validateTreeObject(binding Binding, data []byte) error {
	if len(data) == 0 {
		return fmt.Errorf("invalid tree object")
	}
	if data[0] == '[' {
		var entries []Observation
		if err := json.Unmarshal(data, &entries); err != nil {
			return err
		}
		if len(entries) > MaxFiles {
			return fmt.Errorf("tree manifest path budget")
		}
		for _, entry := range entries {
			if _, err := m.target(binding, entry.Path); err != nil {
				return err
			}
		}
		return nil
	}
	var header struct {
		Format string `json:"format"`
	}
	if err := json.Unmarshal(data, &header); err != nil {
		return err
	}
	switch header.Format {
	case "full_tree_page_v1":
		var page treePage
		if err := json.Unmarshal(data, &page); err != nil {
			return err
		}
		if len(page.Entries) > treeShardEntries {
			return fmt.Errorf("tree page budget")
		}
		for _, entry := range page.Entries {
			if _, err := m.target(binding, entry.Path); err != nil {
				return err
			}
		}
	case "whole_directory_tree_v1":
		var index treeIndex
		if err := json.Unmarshal(data, &index); err != nil {
			return err
		}
		if index.Binding.SourceInstanceID != binding.SourceInstanceID || index.Binding.WorkspaceInstanceID != binding.WorkspaceInstanceID || index.Binding.ScopeID != binding.ScopeID || index.Binding.Root != binding.Root || index.Binding.RootIdentity != binding.RootIdentity || len(index.Pages) > treePaths/treeShardEntries {
			return fmt.Errorf("tree index binding/budget mismatch")
		}
		for _, object := range index.Pages {
			if object.SourceInstanceID != binding.SourceInstanceID || object.ScopeID != binding.ScopeID || object.Kind != "tree" {
				return fmt.Errorf("tree page source mismatch")
			}
		}
	default:
		return fmt.Errorf("unsupported tree format")
	}
	return nil
}
