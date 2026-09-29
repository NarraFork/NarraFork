package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// Fixture subprocesses are bounded independently of the API deadline; loaded
// Windows CI can take more than five seconds to start an otherwise tiny Git command.
func commitTestGit(t *testing.T, root string, args ...string) string {
	t.Helper()
	return commitTestInput(t, root, "", args...)
}

func commitTestInput(t *testing.T, root, input string, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir, cmd.Env = root, gitWorkspaceEnv(gitTestIdentity())
	cmd.Stdin = strings.NewReader(input)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("fixture git %v: %s (%v)", args, out, err)
	}
	return strings.TrimSpace(string(out))
}

func commitTestWrite(t *testing.T, root, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filepath.Join(root, path)), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, path), []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
}

// Build historical trees directly so even Windows can exercise names which
// Git objects support but Win32 cannot create (LF, TAB and non-UTF-8 bytes).
func commitTestObject(t *testing.T, root string, files map[string]string, parent, message string) string {
	t.Helper()
	var entries strings.Builder
	for path, contents := range files {
		blob := commitTestInput(t, root, contents, "hash-object", "-w", "--stdin")
		fmt.Fprintf(&entries, "100644 blob %s\t%s\x00", blob, path)
	}
	tree := commitTestInput(t, root, entries.String(), "mktree", "-z")
	args := []string{"commit-tree", tree}
	if parent != "" {
		args = append(args, "-p", parent)
	}
	return commitTestInput(t, root, message, append(args, "-F", "-")...)
}

func commitTestRequest(h *Handlers, root string, params map[string]any) (any, error) {
	full := map[string]any{"cwd": root, "expectedRoot": root}
	for key, value := range params {
		full[key] = value
	}
	return h.GitWorkspace(context.Background(), full)
}

func assertCommitFileStatus(t *testing.T, h *Handlers, root, sha, path, oldPath, status string, maxBytes int64) {
	t.Helper()
	result := gitCall(t, h, root, "commitDiff", map[string]any{"commit": sha, "path": path, "oldPath": oldPath, "maxBytes": maxBytes})
	outputs := result["outputs"].(map[string]string)
	if outputs["found"] != "1" || outputs["fileStatus"] != status {
		t.Fatalf("path %q oldPath %q: wanted %s, got %v", path, oldPath, status, outputs)
	}
	if status != "ok" && (result["stdout"] != "" || result["truncated"] != false) {
		t.Fatalf("failed file lookup returned a successful-looking partial patch: %v", result)
	}
}

func TestGitCommitPreviewCanonicalRoot(t *testing.T) {
	root, h := newGitFixture(t)
	probe := gitCall(t, h, root, "probe", nil)
	canonical := probe["rootPath"].(string)
	t.Logf("fixture root=%q canonical probe root=%q", root, canonical)
	sha := commitTestObject(t, root, map[string]string{"a.txt": "a\n"}, "", "canonical root")
	gitCall(t, h, root, "commitDetail", map[string]any{"commit": sha, "expectedRoot": canonical})
}

func TestGitCommitPreviewSHAAndLexicalPaths(t *testing.T) {
	for _, sha := range []string{strings.Repeat("a", 40), strings.Repeat("F", 64)} {
		if !validCommitSHA(sha) {
			t.Errorf("valid SHA rejected: %q", sha)
		}
	}
	for _, sha := range []string{"HEAD", "--all", strings.Repeat("a", 39), strings.Repeat("a", 41), strings.Repeat("a", 63), strings.Repeat("a", 65), strings.Repeat("g", 40), strings.Repeat("a", 40) + "\n"} {
		if validCommitSHA(sha) {
			t.Errorf("invalid SHA accepted: %q", sha)
		}
	}
	for _, path := range []string{"line\nname", "tab\tname", "cr\rname", "中文/文件.txt", "-leading.txt", "space name", "dir/\u2028name"} {
		if err := historicalGitPath(path); err != nil {
			t.Errorf("valid object path %q: %v", path, err)
		}
	}
	for _, path := range []string{"", "/absolute", "C:/absolute", "C:\\absolute", "\\\\server\\share", ".git/config", "dir/.GIT/config", "a/../b", "../b", "a/./b", "a//b", "a\x00b"} {
		if err := historicalGitPath(path); err == nil {
			t.Errorf("unsafe historical path accepted: %q", path)
		}
	}
	if err := historicalGitPath("invalid-\xff"); err == nil || !strings.Contains(err.Error(), "non-UTF-8") {
		t.Fatalf("non-UTF-8 rejection was not explicit: %v", err)
	}
}

func TestGitCommitPreviewCompleteRecordBoundaries(t *testing.T) {
	for kind, records := range map[string][]string{
		"name-status": {"A\x00first\x00", "R087\x00old\nname\x00new\tname\x00", "D\x00last\x00"},
		"numstat":     {"1\t0\tfirst\x00", "2\t3\t\x00old\nname\x00new\tname\x00", "-\t-\tlast\x00"},
	} {
		full := strings.Join(records, "")
		for i := 0; i <= len(full); i++ {
			prefix, parsed, truncated, err := completeCommitList(full[:i], kind, i < len(full))
			if err != nil {
				t.Fatalf("%s cut=%d: %v", kind, i, err)
			}
			want, count := "", 0
			for _, record := range records {
				if len(want)+len(record) > i {
					break
				}
				want += record
				count++
			}
			if prefix != want || len(parsed) != count || truncated != (i < len(full)) {
				t.Fatalf("%s cut=%d: prefix=%q count=%d truncated=%v", kind, i, prefix, len(parsed), truncated)
			}
		}
	}
	if _, _, _, err := completeCommitList("R100\x00old\x00", "name-status", false); err == nil {
		t.Fatal("incomplete non-truncated rename accepted")
	}
	if _, _, _, err := completeCommitList("A\x00invalid-\xff\x00", "name-status", false); err == nil || !strings.Contains(err.Error(), "non-UTF-8") {
		t.Fatalf("invalid UTF-8 was silently replaced: %v", err)
	}
}

func TestGitCommitPreviewJSONBudget(t *testing.T) {
	for _, text := range []string{"plain", "\x00\x01\t\r\n\b\f\\\"<>&\u2028\u2029中文😀", "invalid-\xff-byte"} {
		encoded, _ := json.Marshal(text)
		for budget := int64(0); budget <= int64(len(encoded)); budget++ {
			prefix, cost, truncated := commitJSONPrefix(text, budget)
			actual, _ := json.Marshal(prefix)
			if cost != int64(len(actual)-2) || cost > budget || truncated != (prefix != text) {
				t.Fatalf("budget=%d prefix=%q cost=%d encoded=%q truncated=%v", budget, prefix, cost, actual, truncated)
			}
		}
	}
}

func TestGitCommitPreviewRootNormalRenameMergeAndDeletedPath(t *testing.T) {
	root, h := newGitFixture(t)
	original := strings.Repeat("same content for rename detection\n", 20)
	commitTestWrite(t, root, "dir/old.txt", original)
	commitTestGit(t, root, "add", "-A")
	commitTestGit(t, root, "commit", "-m", "root")
	rootSHA := commitTestGit(t, root, "rev-parse", "HEAD")
	detail := gitCall(t, h, root, "commitDetail", map[string]any{"commit": rootSHA})
	outputs := detail["outputs"].(map[string]string)
	if outputs["found"] != "1" || outputs["nameStatus"] != "A\x00dir/old.txt\x00" {
		t.Fatalf("root must compare with the empty tree: %q", outputs)
	}
	if patch := gitCall(t, h, root, "commitDiff", map[string]any{"commit": rootSHA, "path": "dir/old.txt"})["stdout"].(string); !strings.Contains(patch, "new file mode") || !strings.Contains(patch, "+same content") {
		t.Fatalf("root patch: %q", patch)
	}
	commitTestWrite(t, root, "dir/old.txt", original+"normal edit\n")
	commitTestGit(t, root, "add", "-A")
	commitTestGit(t, root, "commit", "-m", "normal")
	normalSHA := commitTestGit(t, root, "rev-parse", "HEAD")
	if patch := gitCall(t, h, root, "commitDiff", map[string]any{"commit": normalSHA, "path": "dir/old.txt"})["stdout"].(string); !strings.Contains(patch, "+normal edit") {
		t.Fatalf("normal patch: %q", patch)
	}
	commitTestGit(t, root, "mv", "dir/old.txt", "dir/new.txt")
	commitTestWrite(t, root, "dir/new.txt", original+"normal edit\nrename edit\n")
	commitTestGit(t, root, "add", "-A")
	commitTestGit(t, root, "commit", "-m", "rename with modification")
	renameSHA := commitTestGit(t, root, "rev-parse", "HEAD")
	outputs = gitCall(t, h, root, "commitDetail", map[string]any{"commit": renameSHA})["outputs"].(map[string]string)
	if !strings.HasPrefix(outputs["nameStatus"], "R") || !strings.Contains(outputs["nameStatus"], "\x00dir/old.txt\x00dir/new.txt\x00") {
		t.Fatalf("rename record lost its source: %q", outputs["nameStatus"])
	}
	commitTestGit(t, root, "rm", "-q", "dir/new.txt")
	commitTestGit(t, root, "commit", "-m", "delete")
	deleteSHA := commitTestGit(t, root, "rev-parse", "HEAD")
	for _, oldPath := range []string{"", "dir/old.txt"} {
		patch := gitCall(t, h, root, "commitDiff", map[string]any{"commit": renameSHA, "path": "dir/new.txt", "oldPath": oldPath})["stdout"].(string)
		if !strings.Contains(patch, "rename from dir/old.txt") || !strings.Contains(patch, "+rename edit") {
			t.Fatalf("rename patch must infer its source: %q", patch)
		}
	}
	t.Run("deleted parent now symlink", func(t *testing.T) {
		outside := t.TempDir()
		commitTestWrite(t, outside, "new.txt", "must not read current symlink target\n")
		link := filepath.Join(root, "dir")
		if err := os.Symlink(outside, link); err != nil {
			if runtime.GOOS == "windows" {
				t.Skipf("Windows symlink privilege unavailable: %v", err)
			}
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Remove(link) })
		patch := gitCall(t, h, root, "commitDiff", map[string]any{"commit": deleteSHA, "path": "dir/new.txt"})["stdout"].(string)
		if !strings.Contains(patch, "deleted file mode") || !strings.Contains(patch, "-rename edit") || strings.Contains(patch, "symlink target") {
			t.Fatalf("historical deletion read the current filesystem: %q", patch)
		}
	})
	commitTestGit(t, root, "checkout", "-q", "-b", "side")
	commitTestWrite(t, root, "side.txt", "side\n")
	commitTestGit(t, root, "add", "-A")
	commitTestGit(t, root, "commit", "-m", "side")
	commitTestGit(t, root, "checkout", "-q", "main")
	commitTestWrite(t, root, "main.txt", "main\n")
	commitTestGit(t, root, "add", "-A")
	commitTestGit(t, root, "commit", "-m", "main")
	commitTestGit(t, root, "merge", "--no-ff", "-m", "merge", "side")
	merge := commitTestGit(t, root, "rev-parse", "HEAD")
	outputs = gitCall(t, h, root, "commitDetail", map[string]any{"commit": merge})["outputs"].(map[string]string)
	if outputs["nameStatus"] != "A\x00side.txt\x00" || len(strings.Fields(strings.Split(outputs["meta"], "\x00")[2])) != 2 {
		t.Fatalf("merge must compare with its first parent: %q", outputs)
	}
	if patch := gitCall(t, h, root, "commitDiff", map[string]any{"commit": merge, "path": "side.txt"})["stdout"].(string); !strings.Contains(patch, "+side") || strings.Contains(patch, "+main") {
		t.Fatalf("merge patch: %q", patch)
	}
}

func TestGitCommitPreviewObjectNamesAndMetadataOnly(t *testing.T) {
	root, h := newGitFixture(t)
	files := map[string]string{"line\nname.txt": "LF historical\n", "tab\tname.txt": "TAB historical\n", "中文.txt": "Unicode historical\n", "-leading.txt": "option historical\n"}
	sha := commitTestObject(t, root, files, "", "object-only root\n\nbody\n")
	outputs := gitCall(t, h, root, "commitDetail", map[string]any{"commit": sha})["outputs"].(map[string]string)
	for path, contents := range files {
		if !strings.Contains(outputs["nameStatus"], "A\x00"+path+"\x00") {
			t.Errorf("object name lost: %q in %q", path, outputs["nameStatus"])
		}
		patch := gitCall(t, h, root, "commitDiff", map[string]any{"commit": sha, "path": path})["stdout"].(string)
		if !strings.Contains(patch, "+"+strings.TrimSpace(contents)) {
			t.Errorf("object-only path %q patch: %q", path, patch)
		}
	}
	empty := commitTestObject(t, root, files, sha, "metadata only\n\ncomplete body\n")
	outputs = gitCall(t, h, root, "commitDetail", map[string]any{"commit": empty})["outputs"].(map[string]string)
	if outputs["nameStatus"] != "" || outputs["numstat"] != "" || outputs["metaTruncated"] != "0" || outputs["nameStatusTruncated"] != "0" || !strings.Contains(outputs["meta"], "complete body") {
		t.Fatalf("metadata-only commit was misrepresented: %q", outputs)
	}
	assertCommitFileStatus(t, h, root, empty, "中文.txt", "", "not_found", 4096)
	bad := commitTestObject(t, root, map[string]string{"invalid-\xff": "bytes\n"}, "", "invalid UTF-8 path")
	if _, err := commitTestRequest(h, root, map[string]any{"operation": "commitDetail", "commit": bad}); err == nil || !strings.Contains(err.Error(), "non-UTF-8") {
		t.Fatalf("non-UTF-8 tree name was not explicitly rejected: %v", err)
	}
}

func TestGitCommitPreviewExactFileAndRenameSource(t *testing.T) {
	root, h := newGitFixture(t)
	commitTestWrite(t, root, "file.txt", strings.Repeat("large patch\n", 3000))
	commitTestWrite(t, root, "other.txt", "other\n")
	commitTestWrite(t, root, "dir/only.txt", "one child\n")
	commitTestGit(t, root, "add", "-A")
	commitTestGit(t, root, "commit", "-m", "root")
	sha := commitTestGit(t, root, "rev-parse", "HEAD")
	assertCommitFileStatus(t, h, root, sha, "dir", "", "not_found", 512)
	assertCommitFileStatus(t, h, root, sha, "missing", "file.txt", "not_found", 512)
	assertCommitFileStatus(t, h, root, sha, "file.txt", "other.txt", "invalid", 512)
	assertCommitFileStatus(t, h, root, sha, "file.txt", "file.txt", "invalid", 512)
	commitTestWrite(t, root, "other.txt", "other modified\n")
	commitTestGit(t, root, "add", "-A")
	commitTestGit(t, root, "commit", "-m", "only other changed")
	next := commitTestGit(t, root, "rev-parse", "HEAD")
	assertCommitFileStatus(t, h, root, next, "file.txt", "", "not_found", 512)
	// A legitimate rename source may now also be a pathspec for a new subtree.
	commitTestGit(t, root, "mv", "file.txt", "renamed.txt")
	commitTestWrite(t, root, "file.txt/child", "new child, must not leak into the rename\n")
	commitTestGit(t, root, "add", "-A")
	commitTestGit(t, root, "commit", "-m", "rename source becomes directory")
	rename := commitTestGit(t, root, "rev-parse", "HEAD")
	assertCommitFileStatus(t, h, root, rename, "renamed.txt", "", "invalid", 1024)
}

func TestGitCommitPreviewBoundedMetadataListsAndPatch(t *testing.T) {
	root, h := newGitFixture(t)
	sha := commitTestObject(t, root, map[string]string{"a.txt": strings.Repeat("bounded patch\n", 20000)}, "", strings.Repeat("message <&> \u2028😀\n", 12000))
	for _, limit := range []int64{1, 64, 200, 512, 1024, 4096, 70000} {
		result, err := commitTestRequest(h, root, map[string]any{"operation": "commitDetail", "commit": sha, "maxBytes": limit})
		if limit <= 200 {
			if err == nil || !strings.Contains(err.Error(), "budget") {
				t.Fatalf("too-small metadata limit %d: %v, %v", limit, result, err)
			}
			continue
		}
		if err != nil {
			t.Fatalf("metadata limit=%d: %v", limit, err)
		}
		encoded, _ := json.Marshal(result)
		outputs := result.(map[string]any)["outputs"].(map[string]string)
		if int64(len(encoded)) > limit || outputs["metaTruncated"] != "1" || !utf8.ValidString(outputs["meta"]) {
			t.Fatalf("metadata exceeded limit=%d: encoded=%d flags=%q", limit, len(encoded), outputs["metaTruncated"])
		}
	}
	for _, limit := range []int64{512, 1024, 4096, 200000} {
		result := gitCall(t, h, root, "commitDiff", map[string]any{"commit": sha, "path": "a.txt", "maxBytes": limit})
		encoded, _ := json.Marshal(result)
		if int64(len(encoded)) > limit || result["truncated"] != true || result["outputs"].(map[string]string)["fileStatus"] != "ok" {
			t.Fatalf("patch limit=%d bytes=%d truncated=%v", limit, len(encoded), result["truncated"])
		}
	}
	tightWire := NewWithOptions(NewPathGuard([]string{root}), 8192, true)
	for _, op := range []string{"commitDetail", "commitDiff"} {
		result := gitCall(t, tightWire, root, op, map[string]any{"commit": sha, "path": "a.txt", "maxBytes": 200000})
		encoded, _ := json.Marshal(result)
		if len(encoded) > 8192/8 {
			t.Fatalf("%s bypassed wire budget: %d", op, len(encoded))
		}
	}
	files := make(map[string]string)
	for i := 0; i < 30; i++ {
		files[fmt.Sprintf("%02d-%s.txt", i, strings.Repeat("x", 180))] = "one\n"
	}
	many := commitTestObject(t, root, files, "", "small metadata")
	result := gitCall(t, h, root, "commitDetail", map[string]any{"commit": many, "maxBytes": 1024})
	outputs := result["outputs"].(map[string]string)
	encoded, _ := json.Marshal(result)
	if len(encoded) > 1024 || outputs["nameStatusTruncated"] != "1" || outputs["numstatTruncated"] != "1" || result["truncated"] != true {
		t.Fatalf("independent list truncation flags lost: %v", result)
	}
	for _, kind := range []struct{ key, kind string }{{"nameStatus", "name-status"}, {"numstat", "numstat"}} {
		if _, _, _, err := completeCommitList(outputs[kind.key], kind.kind, false); err != nil {
			t.Fatalf("exposed a partial %s record: %v", kind.key, err)
		}
	}
	assertCommitFileStatus(t, h, root, many, "missing", "", "too_large", 1024)
	assertCommitFileStatus(t, h, root, many, fmt.Sprintf("29-%s.txt", strings.Repeat("x", 180)), "", "too_large", 1024)
	assertCommitFileStatus(t, h, root, many, fmt.Sprintf("00-%s.txt", strings.Repeat("x", 180)), "", "ok", 2048)
}

func TestGitCommitPreviewReadOnlyBinaryAndHelpers(t *testing.T) {
	root, h := newGitFixture(t)
	commitTestWrite(t, root, "file.txt", "historical content\n")
	commitTestWrite(t, root, "binary.bin", "\x00\x01binary\x00")
	commitTestWrite(t, root, ".gitattributes", "file.txt diff=custom\n")
	commitTestGit(t, root, "add", "-A")
	commitTestGit(t, root, "commit", "-m", "root")
	sha := commitTestGit(t, root, "rev-parse", "HEAD")
	commitTestWrite(t, root, "file.txt", "staged content\n")
	commitTestGit(t, root, "add", "file.txt")
	commitTestWrite(t, root, "file.txt", "unstaged content\n")
	commitTestWrite(t, root, "untracked.txt", "untracked content\n")
	commitTestGit(t, root, "config", "diff.relative", "true")
	commitTestGit(t, root, "config", "diff.external", "narrafork-must-not-run-external-diff")
	commitTestGit(t, root, "config", "diff.custom.textconv", "narrafork-must-not-run-textconv")
	indexPath := filepath.Join(root, ".git", "index")
	beforeIndex, err := os.ReadFile(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	beforeStat, err := os.Stat(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	beforeRefs := commitTestGit(t, root, "show-ref", "--head")
	outputs := gitCall(t, h, root, "commitDetail", map[string]any{"commit": sha})["outputs"].(map[string]string)
	if !strings.Contains(outputs["numstat"], "-\t-\tbinary.bin\x00") {
		t.Fatalf("binary statistics: %q", outputs["numstat"])
	}
	patch := gitCall(t, h, root, "commitDiff", map[string]any{"commit": sha, "path": "file.txt"})["stdout"].(string)
	if !strings.Contains(patch, "+historical content") || strings.Contains(patch, "staged content") {
		t.Fatalf("read-only preview used current files or index: %q", patch)
	}
	binary := gitCall(t, h, root, "commitDiff", map[string]any{"commit": sha, "path": "binary.bin"})["stdout"].(string)
	if !strings.Contains(binary, "Binary files") {
		t.Fatalf("binary patch: %q", binary)
	}
	afterIndex, err := os.ReadFile(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	afterStat, err := os.Stat(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(beforeIndex, afterIndex) || !beforeStat.ModTime().Equal(afterStat.ModTime()) || beforeRefs != commitTestGit(t, root, "show-ref", "--head") {
		t.Fatal("commit preview changed the index or refs")
	}
	if working, err := os.ReadFile(filepath.Join(root, "file.txt")); err != nil || string(working) != "unstaged content\n" {
		t.Fatalf("commit preview changed working file: %q %v", working, err)
	}
	if _, err := os.Stat(indexPath + ".lock"); !os.IsNotExist(err) {
		t.Fatalf("commit preview left an index lock: %v", err)
	}
}

func TestGitCommitPreviewSubmoduleDoesNotRecurse(t *testing.T) {
	root, h := newGitFixture(t)
	child := filepath.Join(root, "module")
	if err := os.Mkdir(child, 0700); err != nil {
		t.Fatal(err)
	}
	commitTestGit(t, child, "init", "-b", "main")
	commitTestWrite(t, child, "private.txt", "first submodule secret\n")
	commitTestGit(t, child, "add", "-A")
	commitTestGit(t, child, "commit", "-m", "child one")
	first := commitTestGit(t, child, "rev-parse", "HEAD")
	commitTestWrite(t, child, "private.txt", "second submodule secret\n")
	commitTestGit(t, child, "add", "-A")
	commitTestGit(t, child, "commit", "-m", "child two")
	second := commitTestGit(t, child, "rev-parse", "HEAD")
	makeParent := func(childSHA, parent string) string {
		tree := commitTestInput(t, root, "160000 commit "+childSHA+"\tmodule\x00", "mktree", "-z")
		args := []string{"commit-tree", tree, "-m", "gitlink"}
		if parent != "" {
			args = append(args, "-p", parent)
		}
		return commitTestGit(t, root, args...)
	}
	base := makeParent(first, "")
	sha := makeParent(second, base)
	commitTestGit(t, root, "config", "diff.submodule", "diff")
	commitTestGit(t, root, "config", "submodule.recurse", "true")
	patch := gitCall(t, h, root, "commitDiff", map[string]any{"commit": sha, "path": "module"})["stdout"].(string)
	if !strings.Contains(patch, "-Subproject commit "+first) || !strings.Contains(patch, "+Subproject commit "+second) || strings.Contains(patch, "submodule secret") {
		t.Fatalf("submodule preview recursed into current checkout: %q", patch)
	}
}

func TestGitCommitPreviewAuthorizationCancellationAndMissingCommit(t *testing.T) {
	root, h := newGitFixture(t)
	sha := commitTestObject(t, root, map[string]string{"a.txt": "a\n"}, "", "fixture")
	for name, params := range map[string]map[string]any{
		"ref":          {"operation": "commitDetail", "commit": "HEAD"},
		"flag":         {"operation": "commitDetail", "commit": "--all"},
		"dotdot":       {"operation": "commitDiff", "commit": sha, "path": "../a.txt"},
		"absolute":     {"operation": "commitDiff", "commit": sha, "path": "/etc/passwd"},
		"git dir":      {"operation": "commitDiff", "commit": sha, "path": ".git/config"},
		"files":        {"operation": "commitDiff", "commit": sha, "path": "a.txt", "files": []any{"a.txt"}},
		"empty path":   {"operation": "commitDiff", "commit": sha},
		"stale root":   {"operation": "commitDetail", "commit": sha, "expectedRoot": filepath.Join(root, "other")},
		"missing root": {"operation": "commitDetail", "commit": sha, "expectedRoot": ""},
	} {
		if _, err := commitTestRequest(h, root, params); err == nil {
			t.Fatalf("%s: unsafe input was accepted", name)
		}
	}
	for _, op := range []string{"commitDetail", "commitDiff"} {
		missing := gitCall(t, h, root, op, map[string]any{"commit": strings.Repeat("0", 40), "path": "a.txt"})
		if missing["outputs"].(map[string]string)["found"] != "0" {
			t.Fatalf("%s unknown commit must report found=0: %v", op, missing)
		}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, err := h.GitWorkspace(ctx, map[string]any{"operation": op, "commit": sha, "path": "a.txt", "cwd": root, "expectedRoot": root}); !errors.Is(err, context.Canceled) {
			t.Fatalf("%s lost cancellation: %v", op, err)
		}
		ctx, cancel = context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
		_, err := h.GitWorkspace(ctx, map[string]any{"operation": op, "commit": sha, "path": "a.txt", "cwd": root, "expectedRoot": root})
		cancel()
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("%s lost deadline: %v", op, err)
		}
	}
	denied := NewWithOptions(NewPathGuardWithRules([]PathRule{{Action: RuleAllow, Path: root}, {Action: RuleDeny, Path: filepath.Join(root, "private")}}), gitWorkspaceMaxBytes, true)
	if _, err := commitTestRequest(denied, root, map[string]any{"operation": "commitDetail", "commit": sha}); err == nil {
		t.Fatal("preview widened a grant with denied holes")
	}
	linked := filepath.Join(t.TempDir(), "linked")
	commitTestGit(t, root, "worktree", "add", "--detach", linked, sha)
	onlyLinked := NewWithOptions(NewPathGuard([]string{linked}), gitWorkspaceMaxBytes, true)
	if _, err := commitTestRequest(onlyLinked, linked, map[string]any{"operation": "commitDetail", "commit": sha}); err == nil {
		t.Fatal("linked worktree bypassed common Git-directory authorization")
	}
	both := NewWithOptions(NewPathGuard([]string{root, linked}), gitWorkspaceMaxBytes, true)
	gitCall(t, both, linked, "commitDetail", map[string]any{"commit": sha})
	blob := commitTestInput(t, root, "not a commit", "hash-object", "-w", "--stdin")
	if outputs := gitCall(t, h, root, "commitDetail", map[string]any{"commit": blob})["outputs"].(map[string]string); outputs["found"] != "0" {
		t.Fatalf("blob was accepted as a commit: %v", outputs)
	}
	commitTestGit(t, root, "config", "filter.x.clean", "cat")
	for _, op := range []string{"commitDetail", "commitDiff"} {
		if _, err := commitTestRequest(h, root, map[string]any{"operation": op, "commit": sha, "path": "a.txt"}); err == nil || !strings.Contains(err.Error(), "filters") {
			t.Fatalf("%s bypassed --disable-shell helper authorization: %v", op, err)
		}
	}
}
