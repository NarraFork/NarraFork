package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func lineStatsCall(t *testing.T, h *Handlers, root string, extra map[string]any) gitLineStats {
	t.Helper()
	return gitCall(t, h, root, "lineStats", extra)["lineStats"].(gitLineStats)
}

func lineStatsByPath(stats gitLineStats) map[string]gitLineStatsFile {
	files := make(map[string]gitLineStatsFile)
	for _, file := range stats.Files {
		files[file.Path] = file
	}
	return files
}

func TestGitLineStatsExcludesOnlyProjectStagingMetadata(t *testing.T) {
	root, h := newGitFixture(t)
	if err := os.MkdirAll(filepath.Join(root, ".narrafork", "git-staging"), 0700); err != nil {
		t.Fatal(err)
	}
	for path, content := range map[string]string{
		filepath.Join(".narrafork", "git-staging", "private.txt"): "private metadata\nprivate index\n",
		filepath.Join(".narrafork", "keep.txt"):                   "user\ncontent\n",
		".gitignore":                                              "!/.narrafork/git-staging/\n!/.narrafork/git-staging/**\n",
	} {
		if err := os.WriteFile(filepath.Join(root, path), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, tracked := range []bool{false, true} {
		if tracked {
			gitTestRun(t, root, "add", "-f", "--", ".narrafork/git-staging/private.txt")
		}
		before, _ := os.ReadFile(filepath.Join(root, ".git", "index"))
		files := lineStatsByPath(lineStatsCall(t, h, root, nil))
		if _, ok := files[".narrafork/git-staging/private.txt"]; ok {
			t.Fatal("staging metadata entered line statistics")
		}
		if keep, ok := files[".narrafork/keep.txt"]; !ok || keep.UnstagedAdded == nil || *keep.UnstagedAdded != 2 {
			t.Fatalf("other .narrafork files were excluded: %+v", files)
		}
		after, _ := os.ReadFile(filepath.Join(root, ".git", "index"))
		if string(before) != string(after) {
			t.Fatal("line statistics rewrote native index")
		}
	}
}

func TestGitLineStatsRealTrackedStagedUntracked(t *testing.T) {
	root, h := newGitFixture(t)
	write := func(path, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, path), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("tracked", "one\n")
	write("old", "renamed\n")
	gitTestRun(t, root, "add", ".")
	gitTestRun(t, root, "commit", "-m", "initial")
	write("tracked", "one\nstaged\n")
	gitTestRun(t, root, "add", "tracked")
	write("tracked", "one\nstaged\nunstaged\n")
	gitTestRun(t, root, "mv", "old", "renamed")
	if err := os.Mkdir(filepath.Join(root, "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	write("nested/untracked", "line\nlast")
	write("binary", "abc\x00\ndef\n")
	write("empty", "")
	stats := lineStatsCall(t, h, root, nil)
	if !stats.Complete || stats.Added != 4 || stats.Removed != 0 {
		t.Fatalf("totals: %+v", stats)
	}
	files := lineStatsByPath(stats)
	if len(files) != 5 || *files["tracked"].StagedAdded != 1 || *files["tracked"].UnstagedAdded != 1 || *files["nested/untracked"].UnstagedAdded != 2 || *files["binary"].UnstagedAdded != 0 || *files["empty"].UnstagedAdded != 0 || *files["renamed"].StagedAdded != 0 {
		t.Fatalf("files: %+v", files)
	}
	// The separate statistics operation must not restore costly status output.
	outputs := gitCall(t, h, root, "status", nil)["outputs"].(map[string]string)
	if len(outputs) != 3 {
		t.Fatalf("status gained line statistics: %v", outputs)
	}
}

func TestGitLineStatsStagedDeletionAndUntrackedSamePath(t *testing.T) {
	root, h := newGitFixture(t)
	if err := os.WriteFile(filepath.Join(root, "file"), []byte("one\ntwo\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitTestRun(t, root, "add", ".")
	gitTestRun(t, root, "commit", "-m", "initial")
	gitTestRun(t, root, "rm", "--cached", "file")
	stats := lineStatsCall(t, h, root, nil)
	if !stats.Complete || stats.Added != 2 || stats.Removed != 2 || len(stats.Files) != 1 ||
		*stats.Files[0].StagedRemoved != 2 || *stats.Files[0].UnstagedAdded != 2 {
		t.Fatalf("staged deletion lost to untracked same-path entry: %+v", stats)
	}
}

func TestGitLineStatsUntrackedCapDoesNotInventZeroForStagedDeletion(t *testing.T) {
	root, h := newGitFixture(t)
	if err := os.WriteFile(filepath.Join(root, "zzz"), []byte("original\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitTestRun(t, root, "add", ".")
	gitTestRun(t, root, "commit", "-m", "initial")
	gitTestRun(t, root, "rm", "--cached", "zzz")
	for i := 0; i < gitLineStatsUntrackedFiles; i++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("aaa-%03d", i)), []byte("prefix\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	stats := lineStatsCall(t, h, root, nil)
	file, present := lineStatsByPath(stats)["zzz"]
	if !present || stats.Complete || file.Complete || file.UnstagedAdded != nil || file.UnstagedRemoved != nil ||
		file.StagedRemoved == nil || *file.StagedRemoved != 1 {
		t.Fatalf("unmeasured recreated file became measured zero: present=%v complete=%v file=%+v", present, stats.Complete, file)
	}
	if stats.Added != gitLineStatsUntrackedFiles || stats.Removed != 1 || len(stats.Files) != gitLineStatsUntrackedFiles+1 {
		t.Fatalf("measured prefix lost: added=%d removed=%d files=%d", stats.Added, stats.Removed, len(stats.Files))
	}
}

func TestGitLineStatsUnbornBinaryTrackedAndNULRename(t *testing.T) {
	root, h := newGitFixture(t)
	if err := os.WriteFile(filepath.Join(root, "staged"), []byte("one\ntwo"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "binary"), []byte("\x00binary\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitTestRun(t, root, "add", ".")
	stats := lineStatsCall(t, h, root, nil)
	if !stats.Complete || stats.Added != 2 || stats.Removed != 0 || *lineStatsByPath(stats)["binary"].StagedAdded != 0 {
		t.Fatalf("unborn: %+v", stats)
	}
	files, order := map[string]*gitLineStatsFile{}, []string{}
	if err := parseLineStatsNumstat("2\t1\t\x00old\nname\x00new\tname\x000\t0\t\x00unfinished\x00", true, true, files, &order); err != nil {
		t.Fatal(err)
	}
	if len(order) != 1 || order[0] != "new\tname" || *files[order[0]].StagedAdded != 2 {
		t.Fatalf("NUL rename: %+v %v", files, order)
	}
	if err := parseLineStatsNumstat("0\t0\t\x00old\x00", true, false, files, &order); err == nil {
		t.Fatal("uncapped incomplete rename became successful line statistics")
	}
}

func TestGitLineStatsUntrackedCapsAndUnknowns(t *testing.T) {
	t.Run("file count", func(t *testing.T) {
		root, h := newGitFixture(t)
		for i := 0; i < 201; i++ {
			if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("file-%03d", i)), []byte("one\n"), 0600); err != nil {
				t.Fatal(err)
			}
		}
		stats := lineStatsCall(t, h, root, nil)
		if stats.Complete || len(stats.Files) != 200 || stats.Added != 200 {
			t.Fatalf("file cap: %+v", stats)
		}
	})
	t.Run("size and total bytes", func(t *testing.T) {
		root, h := newGitFixture(t)
		for i := 0; i < 21; i++ {
			if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("file-%02d", i)), []byte(strings.Repeat("x", 1_000_000)), 0600); err != nil {
				t.Fatal(err)
			}
		}
		if err := os.WriteFile(filepath.Join(root, "oversized"), []byte(strings.Repeat("x", 1_000_001)), 0600); err != nil {
			t.Fatal(err)
		}
		stats := lineStatsCall(t, h, root, nil)
		files := lineStatsByPath(stats)
		if stats.Complete || stats.Added != 20 || len(files) != 22 || files["file-20"].Complete || files["file-20"].UnstagedAdded != nil || files["oversized"].UnstagedAdded != nil {
			t.Fatalf("byte caps: %+v", stats)
		}
	})
	t.Run("symlink and directory are not content", func(t *testing.T) {
		root, h := newGitFixture(t)
		outside := filepath.Join(t.TempDir(), "outside")
		if err := os.WriteFile(outside, []byte("secret\n"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, filepath.Join(root, "symlink")); err != nil {
			if runtime.GOOS == "windows" {
				t.Skip("symlink privilege unavailable")
			}
			t.Fatal(err)
		}
		stats := lineStatsCall(t, h, root, nil)
		if stats.Complete || stats.Added != 0 || len(stats.Files) != 1 || stats.Files[0].Complete || stats.Files[0].UnstagedAdded != nil {
			t.Fatalf("symlink: %+v", stats)
		}
		g := &workspaceGit{ctx: context.Background(), root: root}
		remaining := gitLineStatsTotalBytes
		if _, complete, err := h.untrackedLineCount(g, ".", &remaining); complete || err != nil {
			t.Fatalf("directory counted: %v %v", complete, err)
		}
	})
	t.Run("encoded response budget", func(t *testing.T) {
		root, h := newGitFixture(t)
		for i := 0; i < 30; i++ {
			if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("long-name-%03d", i)), []byte("x\n"), 0600); err != nil {
				t.Fatal(err)
			}
		}
		result := gitCall(t, h, root, "lineStats", map[string]any{"maxBytes": float64(1024)})
		encoded, err := json.Marshal(result)
		if err != nil {
			t.Fatal(err)
		}
		stats := result["lineStats"].(gitLineStats)
		if len(encoded) > 1024 || stats.Complete || len(stats.Files) == 0 || stats.Added != int64(len(stats.Files)) {
			t.Fatalf("encoded byte cap: %d %+v", len(encoded), stats)
		}
	})
}

func TestGitLineStatsCacheInvalidatesSameSizeRestoredMtime(t *testing.T) {
	root, h := newGitFixture(t)
	path := filepath.Join(root, "untracked")
	if err := os.WriteFile(path, []byte("a\nb\n"), 0600); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if stats := lineStatsCall(t, h, root, nil); !stats.Complete || stats.Added != 2 {
		t.Fatalf("initial: %+v", stats)
	}
	if err := os.WriteFile(path, []byte("abcd"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, before.ModTime(), before.ModTime()); err != nil {
		t.Fatal(err)
	}
	if stats := lineStatsCall(t, h, root, nil); !stats.Complete || stats.Added != 1 {
		t.Fatalf("stale metadata hit: %+v", stats)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("a\nb\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, before.ModTime(), before.ModTime()); err != nil {
		t.Fatal(err)
	}
	if stats := lineStatsCall(t, h, root, nil); !stats.Complete || stats.Added != 2 {
		t.Fatalf("replacement cache hit: %+v", stats)
	}
	untrackedLineCache.Lock()
	defer untrackedLineCache.Unlock()
	if len(untrackedLineCache.entries) > 512 {
		t.Fatalf("unbounded cache: %d", len(untrackedLineCache.entries))
	}
}

func TestGitLineStatsNeverInvokesExternalDiffOrTextconv(t *testing.T) {
	root, h := newGitFixture(t)
	for name, content := range map[string]string{"file": "one\n", ".gitattributes": "file diff=blocked\n"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	gitTestRun(t, root, "add", ".")
	gitTestRun(t, root, "commit", "-m", "initial")
	gitTestRun(t, root, "config", "diff.external", "narrafork-must-not-run-external-diff")
	gitTestRun(t, root, "config", "diff.blocked.textconv", "narrafork-must-not-run-textconv")
	if err := os.WriteFile(filepath.Join(root, "file"), []byte("one\ntwo\n"), 0600); err != nil {
		t.Fatal(err)
	}
	stats := lineStatsCall(t, h, root, nil)
	if !stats.Complete || stats.Added != 1 || stats.Removed != 0 {
		t.Fatalf("external helpers affected line statistics: %+v", stats)
	}
}

func TestGitLineStatsDeniedUntrackedContentRemainsUnknown(t *testing.T) {
	root, _ := newGitFixture(t)
	file := filepath.Join(root, "denied")
	if err := os.WriteFile(file, []byte("secret\n"), 0600); err != nil {
		t.Fatal(err)
	}
	h := NewWithOptions(NewPathGuardWithRules([]PathRule{{Action: RuleAllow, Path: root}, {Action: RuleDeny, Path: file}}), gitWorkspaceMaxBytes, true)
	g := &workspaceGit{ctx: context.Background(), root: root}
	remaining := gitLineStatsTotalBytes
	if _, measured, err := h.untrackedLineCount(g, "denied", &remaining); measured || err != nil {
		t.Fatalf("denied content was measured: complete=%v err=%v", measured, err)
	}
	// Preserve the existing whole-worktree policy, which is stricter still.
	if _, err := h.GitWorkspace(context.Background(), map[string]any{"cwd": root, "expectedRoot": root, "operation": "lineStats"}); err == nil || !strings.Contains(err.Error(), "denied path") {
		t.Fatalf("line statistics bypassed whole-worktree policy: %v", err)
	}
}

func TestGitLineStatsRootAndFileActionsRejected(t *testing.T) {
	root, h := newGitFixture(t)
	for _, extra := range []map[string]any{{"expectedRoot": filepath.Dir(root)}, {"files": []any{"file"}}} {
		params := map[string]any{"cwd": root, "expectedRoot": root, "operation": "lineStats"}
		for key, value := range extra {
			params[key] = value
		}
		if _, err := h.GitWorkspace(context.Background(), params); err == nil {
			t.Fatalf("accepted unsafe request: %v", params)
		}
	}
}

func runGitLineStatsTestHelper() bool {
	mode := os.Getenv("NF_GIT_LINE_STATS_TEST_HELPER")
	if mode == "" {
		return false
	}
	if mode == "records" || mode == "bytes" {
		fmt.Fprint(os.Stdout, strings.Repeat("1\t0\tfile\x00", 30001))
	} else {
		fmt.Fprint(os.Stdout, "1\t0\tfile\x00")
	}
	if mode == "failure" {
		os.Exit(9)
	}
	time.Sleep(30 * time.Second)
	return true
}

func TestGitLineStatsStreamingCancellationFailureAndBudgets(t *testing.T) {
	root := t.TempDir()
	installGitStatusTestHelper(t)
	for _, mode := range []string{"records", "bytes", "timeout", "cancel", "failure"} {
		t.Run(mode, func(t *testing.T) {
			budget := gitWorkspaceMaxBytes
			if mode == "bytes" {
				budget = 10
			}
			duration := 3 * time.Second
			if mode == "timeout" {
				duration = 100 * time.Millisecond
			}
			ctx, cancel := context.WithTimeout(context.Background(), duration)
			defer cancel()
			if mode == "cancel" {
				timer := time.AfterFunc(100*time.Millisecond, cancel)
				defer timer.Stop()
			}
			g := &workspaceGit{ctx: ctx, root: root, remaining: budget, env: append(gitWorkspaceEnv(nil), "NF_GIT_LINE_STATS_TEST_HELPER="+mode)}
			out, cut, err := g.runLineStatsNUL(30000, "diff", "--numstat", "-z")
			if mode == "records" || mode == "bytes" {
				want := 30000
				if mode == "bytes" {
					want = 1
				}
				if err != nil || !cut || strings.Count(out, "\x00") != want {
					t.Fatalf("did not stop at cap: records=%d cut=%v err=%v", strings.Count(out, "\x00"), cut, err)
				}
			} else if err == nil {
				t.Fatalf("%s became complete success", mode)
			}
			if (mode == "timeout" || mode == "cancel") && !errors.Is(err, ctx.Err()) {
				t.Fatalf("context error lost: %v", err)
			}
		})
	}
}

func TestGitLineStatsSharesStatusAdmissionAndRootSerialization(t *testing.T) {
	root, h := newGitFixture(t)
	originalPath := os.Getenv("PATH")
	installGitStatusTestHelper(t)
	marker := filepath.Join(t.TempDir(), "git-started")
	t.Setenv("NF_GIT_STATUS_TEST_HELPER", "probe-marker")
	t.Setenv("NF_GIT_STATUS_TEST_MARKER", marker)
	var releases []func()
	for i := 0; i < 4; i++ {
		release, err := gitStatusAdmissions.admit(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		defer release()
		releases = append(releases, release)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := h.GitWorkspace(ctx, map[string]any{"cwd": root, "expectedRoot": root, "operation": "lineStats"})
		done <- err
	}()
	waitStatusSchedulerQueue(t, gitStatusAdmissions, 1)
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("queued line statistics started a Git probe before admission: %v", err)
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("admission cancel: %v", err)
	}
	for _, release := range releases {
		release()
	}
	assertStatusAdmissionActive(t, 0)
	t.Setenv("PATH", originalPath)
	t.Setenv("NF_GIT_STATUS_TEST_HELPER", "")
	release, err := gitStatusQueries.acquire(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_, err := h.GitWorkspace(ctx, map[string]any{"cwd": root, "expectedRoot": root, "operation": "lineStats"})
		done <- err
	}()
	waitStatusSchedulerQueue(t, gitStatusQueries, 1)
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("root queue cancel: %v", err)
	}
	waitStatusSchedulerQueue(t, gitStatusQueries, 0)
	assertStatusAdmissionActive(t, 0)
	release()
	lineStatsCall(t, h, root, nil)
}
