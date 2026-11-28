package handlers

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sync"
	"testing"
	"time"
)

func TestGitWorkspaceWatchKeepsInternalFilesSeparate(t *testing.T) {
	root, h := newGitFixture(t)
	before := gitCall(t, h, root, "watch", nil)["outputs"].(map[string]string)
	directory := filepath.Join(root, ".narrafork", "git-staging", "write.lock")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "owner.json"), []byte("preserved"), 0600); err != nil {
		t.Fatal(err)
	}
	after := gitCall(t, h, root, "watch", nil)["outputs"].(map[string]string)
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("internal metadata changed ordinary Git observations: %v %v", before, after)
	}
	if _, present := after["stagingListsFingerprint"]; present {
		t.Fatal("remote watch exposed a ChangeList observation")
	}
}

func TestGitWorkspaceOrdinaryWritesPreserveInternalData(t *testing.T) {
	root, h := newGitFixture(t)
	directory := filepath.Join(root, ".narrafork", "git-staging", "write.lock")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	owner := filepath.Join(directory, "owner.json")
	if err := os.WriteFile(owner, []byte("preserved owner"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "file"), []byte("content\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitCall(t, h, root, "stage", map[string]any{"all": true})
	if files := gitTestRun(t, root, "ls-files"); files != "file" {
		t.Fatalf("internal data entered native index: %q", files)
	}
	gitCall(t, h, root, "unstage", map[string]any{"all": true})
	gitCall(t, h, root, "stage", map[string]any{"files": []any{"file"}})
	gitCall(t, h, root, "commit", map[string]any{"message": "Ordinary", "identity": gitTestIdentity()})
	gitTestRun(t, root, "update-ref", "refs/narrafork/staging-files/retained", "HEAD")
	ref := gitTestRun(t, root, "rev-parse", "refs/narrafork/staging-files/retained")
	if err := os.WriteFile(filepath.Join(root, "file"), []byte("changed\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitCall(t, h, root, "stashPush", map[string]any{"identity": gitTestIdentity()})
	if contents, err := os.ReadFile(owner); err != nil || string(contents) != "preserved owner" {
		t.Fatalf("internal data changed: %s %v", contents, err)
	}
	if after := gitTestRun(t, root, "rev-parse", "refs/narrafork/staging-files/retained"); ref != after {
		t.Fatal("old private ref changed")
	}
	lock := filepath.Join(root, ".git", "index.lock")
	if err := os.WriteFile(lock, []byte("native writer"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := h.GitWorkspace(context.Background(), map[string]any{"cwd": root, "expectedRoot": root, "operation": "stage", "files": []any{"file"}}); err == nil {
		t.Fatal("native index lock was ignored")
	}
	if contents, err := os.ReadFile(lock); err != nil || string(contents) != "native writer" {
		t.Fatalf("native lock changed: %s %v", contents, err)
	}
	for _, operation := range []string{"stagingProbe", "stagingPrepare", "stagingStorage", "stagingMetadata"} {
		if _, err := h.GitWorkspace(context.Background(), map[string]any{"cwd": root, "expectedRoot": root, "operation": operation}); err == nil {
			t.Fatalf("unexpected ChangeList operation %q", operation)
		}
	}
}

func TestGitWorkspaceWatchReportsUnavailableGitFacts(t *testing.T) {
	root, h := newGitFixture(t)
	if err := os.WriteFile(filepath.Join(root, ".git", "index"), []byte("broken index"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := h.GitWorkspace(context.Background(), map[string]any{"cwd": root, "expectedRoot": root, "operation": "watch"}); err == nil {
		t.Fatal("damaged native index must fail watch")
	}
}

func TestGitWorkspaceWatchDirtyMetadata(t *testing.T) {
	root, h := newGitFixture(t)
	path := filepath.Join(root, "file.txt")
	write := func(content string, stamp int64) {
		t.Helper()
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
		tm := time.Unix(1700000000, stamp)
		if err := os.Chtimes(path, tm, tm); err != nil {
			t.Fatal(err)
		}
	}
	watch := func() map[string]string { return gitCall(t, h, root, "watch", nil)["outputs"].(map[string]string) }
	// Unborn HEAD is valid, including a staged index without a first commit.
	write("base\n", 1000000)
	gitCall(t, h, root, "stage", map[string]any{"all": true})
	write("edit\n", 2000000)
	first := watch()
	if !reflect.DeepEqual(first, watch()) {
		t.Fatal("stationary watch changed")
	}
	write("next\n", 3000000)
	second := watch()
	if first["worktree"] == second["worktree"] {
		t.Fatal("same-size same-line dirty edit was missed")
	}
	for _, key := range []string{"index", "head", "stash"} {
		if first[key] != second[key] {
			t.Fatalf("unrelated %s changed", key)
		}
	}
	if second["uncertainWorktree"] != "" {
		t.Fatal("ordinary dirty file should be certain")
	}
	if !reflect.DeepEqual(second, watch()) {
		t.Fatal("stationary dirty watch changed")
	}
}

func TestGitWorkspaceWatchSkipsUnsupportedFilenames(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("colon and backslash are not ordinary Windows filename characters")
	}
	for _, name := range []string{"a:Zone.Identifier", `a\file`} {
		t.Run(name, func(t *testing.T) {
			root, h := newGitFixture(t)
			path := filepath.Join(root, "z-normal.txt")
			write := func(content string, stamp int64) {
				t.Helper()
				if err := os.WriteFile(path, []byte(content), 0600); err != nil {
					t.Fatal(err)
				}
				// Whole-second changes also work with Git builds that ignore
				// sub-second timestamps when comparing against the clean index.
				tm := time.Unix(1700000000+stamp/1000000, stamp)
				if err := os.Chtimes(path, tm, tm); err != nil {
					t.Fatal(err)
				}
			}
			write("base\n", 1000000)
			gitTestRun(t, root, "add", "z-normal.txt")
			gitTestRun(t, root, "commit", "-m", "base")
			if err := os.WriteFile(filepath.Join(root, name), []byte("uninspectable\n"), 0600); err != nil {
				t.Fatal(err)
			}
			watch := func() map[string]string {
				t.Helper()
				result := gitCall(t, h, root, "watch", nil)
				outputs := result["outputs"].(map[string]string)
				if outputs["uncertainWorktree"] != "true" || result["truncated"] != false {
					t.Fatalf("skipped path must mark uncertainty, not fail or exhaust the budget: %v", result)
				}
				for _, key := range []string{"worktree", "index", "head", "stash"} {
					if len(outputs[key]) != 64 {
						t.Fatalf("missing %s fingerprint: %v", key, outputs)
					}
				}
				return outputs
			}
			write("edit\n", 2000000)
			first := watch()
			write("next\n", 3000000)
			second := watch()
			if first["worktree"] == second["worktree"] {
				t.Fatalf("special filename prevented metadata sampling of another dirty file: first=%v second=%v status=%q", first, second, gitTestRun(t, root, "status", "--porcelain=v1", "-z"))
			}
			for _, key := range []string{"index", "head", "stash"} {
				if first[key] != second[key] {
					t.Fatalf("ordinary edit changed unrelated %s", key)
				}
			}
			gitTestRun(t, root, "add", "z-normal.txt")
			staged := watch()
			if staged["index"] == second["index"] {
				t.Fatal("special filename prevented index change detection")
			}
			gitTestRun(t, root, "commit", "-m", "next")
			committed := watch()
			if committed["head"] == staged["head"] {
				t.Fatal("special filename prevented HEAD change detection")
			}
			write("stash\n", 4000000)
			gitTestRun(t, root, "stash", "push", "-m", "watch fixture", "--", "z-normal.txt")
			stashed := watch()
			if stashed["stash"] == committed["stash"] || stashed["head"] != committed["head"] {
				t.Fatal("special filename prevented independent stash/HEAD sampling")
			}
		})
	}
}

func TestGitWorkspaceWatchSkipsUnsafeParent(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink fixture requires Unix semantics")
	}
	root, h := newGitFixture(t)
	parent := filepath.Join(root, "parent")
	if err := os.Mkdir(parent, 0700); err != nil {
		t.Fatal(err)
	}
	inside := filepath.Join(parent, "file.txt")
	if err := os.WriteFile(inside, []byte("tracked\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitTestRun(t, root, "add", "parent/file.txt")
	gitTestRun(t, root, "commit", "-m", "base")
	if err := os.Remove(inside); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(parent); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "file.txt"), []byte("outside\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, parent); err != nil {
		t.Fatal(err)
	}
	first := gitCall(t, h, root, "watch", nil)["outputs"].(map[string]string)
	if first["uncertainWorktree"] != "true" || len(first["head"]) != 64 || len(first["stash"]) != 64 {
		t.Fatalf("unsafe parent must be skipped without losing safe categories: %v", first)
	}
	if err := os.WriteFile(filepath.Join(outside, "file.txt"), []byte("outside edit with different size\n"), 0600); err != nil {
		t.Fatal(err)
	}
	second := gitCall(t, h, root, "watch", nil)["outputs"].(map[string]string)
	if !reflect.DeepEqual(first, second) {
		t.Fatal("watch followed an unsafe parent symlink to inspect outside metadata")
	}
}

func TestGitWorkspaceWatchBounds(t *testing.T) {
	root, h := newGitFixture(t)
	for i := 0; i <= gitWatchMaxPaths; i++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("file-%04d", i)), []byte("x"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	result := gitCall(t, h, root, "watch", nil)
	outputs := result["outputs"].(map[string]string)
	if outputs["uncertainWorktree"] != "true" {
		t.Fatal("path cap must mark uncertainty")
	}
	for _, key := range []string{"worktree", "index", "head", "stash"} {
		if len(outputs[key]) != 64 {
			t.Fatalf("unbounded or absent %s", key)
		}
	}
	truncated := gitCall(t, h, root, "watch", map[string]any{"maxBytes": float64(16)})
	if truncated["truncated"] != true || truncated["outputs"].(map[string]string)["uncertainWorktree"] != "true" {
		t.Fatal("output truncation must mark uncertainty")
	}
	_, err := h.GitWorkspace(context.Background(), map[string]any{"cwd": root, "expectedRoot": root, "operation": "watch", "files": []any{"file-0000"}})
	if err == nil {
		t.Fatal("watch must reject supplied pathspecs")
	}
}

func TestGitWorkspaceWatchConcurrentCancellation(t *testing.T) {
	root, h := newGitFixture(t)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(cancelled bool) {
			defer wg.Done()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if cancelled {
				cancel()
			}
			_, err := h.GitWorkspace(ctx, map[string]any{"cwd": root, "expectedRoot": root, "operation": "watch"})
			if cancelled && err == nil {
				t.Error("cancelled watch succeeded")
			}
			if !cancelled && err != nil {
				t.Error(err)
			}
		}(i%2 == 0)
	}
	wg.Wait()
}
