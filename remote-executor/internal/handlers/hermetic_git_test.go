package handlers

import (
	"context"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/narrafork/remote-executor/internal/testgit"
)

func TestMain(m *testing.M) {
	os.Exit(testgit.Main(m))
}

func canonicalFixturePath(t *testing.T, path string) string {
	t.Helper()
	resolved, err := NewPathGuard(nil).CheckCreate(path)
	if err != nil {
		t.Fatalf("resolve positive fixture identity: %v", err)
	}
	return resolved
}

// Snapshot only the small, disposable repository created by this test, never
// the developer's checkout or HOME. Include .git/index, objects and refs so a
// redirected command cannot pass merely by preserving the working-tree file.
func disposableGitSnapshot(t *testing.T, root string) map[string]string {
	t.Helper()
	files := map[string]string{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		files[path] = string(data)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func TestHermeticGitIgnoresInheritedRepositoryOverrides(t *testing.T) {
	root, _ := newGitFixture(t)
	outside, _ := newGitFixture(t)
	if err := os.WriteFile(filepath.Join(outside, "outside.txt"), []byte("outside sentinel\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitTestRun(t, outside, "add", "outside.txt")
	gitTestRun(t, outside, "commit", "-m", "outside sentinel")
	before := disposableGitSnapshot(t, outside)
	if _, ok := before[filepath.Join(outside, ".git", "index")]; !ok {
		t.Fatal("outside fixture has no seeded index")
	}
	if err := os.WriteFile(filepath.Join(root, "own.txt"), []byte("own fixture\n"), 0600); err != nil {
		t.Fatal(err)
	}
	// Deliberately bypass gitWorkspaceEnv: otherwise production filtering could
	// hide a broken forwarder from this regression test. Poison only child Env,
	// not the process-global environment used by concurrent test fixtures.
	poison := []string{
		"GIT_DIR=" + filepath.Join(outside, ".git"),
		"GIT_WORK_TREE=" + outside,
		"GIT_INDEX_FILE=" + filepath.Join(outside, ".git", "index"),
		"GIT_COMMON_DIR=" + filepath.Join(outside, ".git"),
		"GIT_OBJECT_DIRECTORY=" + filepath.Join(outside, ".git", "objects"),
		"GIT_ALTERNATE_OBJECT_DIRECTORIES=" + filepath.Join(outside, ".git", "objects"),
		"GIT_EXEC_PATH=" + filepath.Join(outside, "nonexistent-helpers"),
		"GIT_EXTERNAL_DIFF=" + filepath.Join(outside, "must-not-execute"),
		"GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=filter.poison.clean", "GIT_CONFIG_VALUE_0=cat",
		"GIT_AUTHOR_NAME=Owned Author", "GIT_AUTHOR_EMAIL=owned-author@example.test",
		"GIT_COMMITTER_NAME=Owned Committer", "GIT_COMMITTER_EMAIL=owned-committer@example.test",
	}
	run := func(args ...string) string {
		t.Helper()
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		cmd := testgit.CommandContext(ctx, args...)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), poison...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("poisoned fixture Git %v failed: %v", args, err)
		}
		return strings.TrimSpace(string(out))
	}
	run("add", "--", "own.txt")
	run("commit", "-m", "own commit")
	if got := run("ls-files"); got != "own.txt" {
		t.Fatalf("Git operation did not use owned fixture index: %q", got)
	}
	if got := run("log", "-1", "--format=%an <%ae> %cn <%ce>"); got != "Owned Author <owned-author@example.test> Owned Committer <owned-committer@example.test>" {
		t.Fatalf("controlled fixture identity lost: %q", got)
	}
	if err := os.WriteFile(filepath.Join(root, "own.txt"), []byte("own fixture\nupdated\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if got := run("diff", "--", "own.txt"); !strings.Contains(got, "+updated") {
		t.Fatal("helper override redirected fixture diff")
	}
	if !maps.Equal(before, disposableGitSnapshot(t, outside)) {
		t.Fatal("inherited overrides changed outside fixture bytes, index, objects or refs")
	}
}

func TestHermeticGitConfigAndStreaming(t *testing.T) {
	root, h := newGitFixture(t)
	if got := gitTestRun(t, root, "config", "--global", "--list"); got != "" {
		t.Fatal("test Git inherited global configuration")
	}
	// stdin remains streamed to the real Git, not captured by the forwarder.
	if got := commitTestInput(t, root, "hello\n", "hash-object", "--stdin"); got != "ce013625030ba8dba906f756967f9e9ca394464a" {
		t.Fatalf("stdin forwarding: %q", got)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := testgit.CommandContext(ctx, "-C", root, "rev-parse", "--verify", "--quiet", "HEAD")
	if err := cmd.Run(); err == nil || cmd.ProcessState.ExitCode() != 1 {
		t.Fatalf("forwarded Git exit status: %v", err)
	}
	// Isolation must not hide repository-local executable configuration from
	// production permission checks. Local attributes remain visible as well.
	gitTestRun(t, root, "config", "filter.fixture.clean", "cat")
	if err := os.WriteFile(filepath.Join(root, ".gitattributes"), []byte("*.txt filter=fixture\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if got := gitTestRun(t, root, "config", "--get", "filter.fixture.clean"); got != "cat" {
		t.Fatal("repository-local filter hidden")
	}
	if _, err := h.GitWorkspace(ctx, map[string]any{"cwd": root, "expectedRoot": root, "operation": "status"}); err == nil {
		t.Fatal("shell-disabled production accepted a repository-local filter")
	}
}
