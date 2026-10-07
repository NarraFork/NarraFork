package history

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func treeRequest(binding Binding, id, phase string, denied ...string) Request {
	return Request{Binding: binding, OperationID: id, RequestDigest: key(id), CapturePhase: phase, TreePolicy: &TreeCapturePolicy{DeniedDirectories: denied, PolicyDigest: key(strings.Join(denied, "\x00"))}}
}
func readTreeEntries(t *testing.T, m *Manager, b Binding, r *Receipt) []TreeEntry {
	t.Helper()
	root, err := m.ReadObject(context.Background(), b, *r.Tree, 0, ChunkBytes)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := base64.StdEncoding.DecodeString(root.ContentBase64)
	var index treeIndex
	if err := json.Unmarshal(data, &index); err != nil {
		t.Fatal(err)
	}
	if index.Format != "whole_directory_tree_v1" {
		t.Fatal("sparse incorrectly returned as whole tree")
	}
	entries := []TreeEntry{}
	for _, page := range index.Pages {
		raw, err := m.ReadObject(context.Background(), b, page, 0, ChunkBytes)
		if err != nil {
			t.Fatal(err)
		}
		bytes, _ := base64.StdEncoding.DecodeString(raw.ContentBase64)
		var decoded treePage
		if err := json.Unmarshal(bytes, &decoded); err != nil {
			t.Fatal(err)
		}
		entries = append(entries, decoded.Entries...)
	}
	return entries
}
func TestWholeDirectoryCaptureHonorsServerPolicyAndHasRealPrivateObjects(t *testing.T) {
	m, b, root, _ := fixture(t)
	os.Mkdir(filepath.Join(root, "empty"), 0700)
	os.Mkdir(filepath.Join(root, "nested"), 0700)
	os.Mkdir(filepath.Join(root, "secret"), 0700)
	os.WriteFile(filepath.Join(root, "nested", "file.txt"), []byte("whole tree bytes"), 0600)
	os.WriteFile(filepath.Join(root, "secret", "key"), []byte("DENIED_BYTES"), 0600)
	r, err := m.CaptureTree(context.Background(), treeRequest(b, "full", "warm", "secret"))
	if err != nil {
		t.Fatal(err)
	}
	if r.CaptureKind != "whole_directory" || r.Coverage != "complete" || r.Consistency != "stable_double_scan" {
		t.Fatal("incomplete whole tree", r)
	}
	entries := readTreeEntries(t, m, b, r)
	found := false
	for _, entry := range entries {
		if strings.Contains(entry.Path, "secret") {
			t.Fatal("server denied path captured")
		}
		if entry.Path == filepath.Join("nested", "file.txt") {
			bytes, err := m.ReadObject(context.Background(), b, *entry.State.Object, 0, ChunkBytes)
			if err != nil {
				t.Fatal(err)
			}
			data, _ := base64.StdEncoding.DecodeString(bytes.ContentBase64)
			if string(data) != "whole tree bytes" {
				t.Fatal("not actual snapshot bytes")
			}
			found = true
		}
	}
	if !found {
		t.Fatal("whole nested file missing")
	}
	if _, err := os.Stat(filepath.Join(root, ".git")); !os.IsNotExist(err) {
		t.Fatal("capture initialized user repository")
	}
}
func TestWholeTreeUsesGitIgnoreWithoutChangingRepository(t *testing.T) {
	m, b, root, _ := fixture(t)
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git unavailable")
	}
	cmd := exec.Command("git", "init", "-q", root)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatal(err, string(output))
	}
	os.WriteFile(filepath.Join(root, ".gitignore"), []byte("ignored/\n*.secret\n"), 0600)
	os.Mkdir(filepath.Join(root, "ignored"), 0700)
	os.WriteFile(filepath.Join(root, "ignored", "file"), []byte("PRIVATE_IGNORED"), 0600)
	os.WriteFile(filepath.Join(root, "credential.secret"), []byte("PRIVATE_IGNORED"), 0600)
	os.WriteFile(filepath.Join(root, "public"), []byte("public"), 0600)
	r, err := m.CaptureTree(context.Background(), treeRequest(b, "git-full", "warm"))
	if err != nil {
		t.Fatal(err)
	}
	if r.Coverage != "complete" {
		t.Fatal("git capture not complete", r.Reason)
	}
	for _, entry := range readTreeEntries(t, m, b, r) {
		if strings.Contains(entry.Path, "ignored") || strings.Contains(entry.Path, "secret") || strings.HasPrefix(entry.Path, ".git"+string(filepath.Separator)) {
			t.Fatal("ignored/private git path captured", entry.Path)
		}
	}
	if _, err := os.Stat(filepath.Join(root, ".git", "index")); !os.IsNotExist(err) {
		t.Fatal("capture modified user index")
	}
}
func TestWholeTreeSymlinkAndExternalWriterArePartialNotComplete(t *testing.T) {
	m, b, root, _ := fixture(t)
	os.WriteFile(filepath.Join(root, "first"), []byte("first"), 0600)
	if err := os.Symlink(filepath.Join(root, "first"), filepath.Join(root, "link")); err == nil {
		r, err := m.CaptureTree(context.Background(), treeRequest(b, "partial", "warm"))
		if err != nil {
			t.Fatal(err)
		}
		if r.Coverage != "partial" || r.Reason != "unsupported_object" {
			t.Fatal("unsupported entry became full", r)
		}
	}
}
func TestWholeTreeHotWarmUsesOriginalOperationAndRetainsAttempt(t *testing.T) {
	m, b, root, _ := fixture(t)
	for _, name := range []string{"one", "two", "three"} {
		os.WriteFile(filepath.Join(root, name), []byte(name), 0600)
	}
	parent, cancel := context.WithCancel(context.Background())
	calls := 0
	m.testFault = func(phase string) error {
		if phase == "tree_walk_entry" {
			calls++
			if calls == 2 {
				cancel()
			}
		}
		return nil
	}
	hot, err := m.CaptureTree(parent, treeRequest(b, "hot-warm", "hot"))
	if err != nil {
		t.Fatal(err)
	}
	if hot.Coverage != "partial" {
		t.Fatal("hot interruption not partial")
	}
	m.testFault = nil
	warm, err := m.CaptureTree(context.Background(), treeRequest(b, "hot-warm", "warm"))
	if err != nil {
		t.Fatal(err)
	}
	if warm.Coverage != "complete" || warm.OperationID != hot.OperationID || len(warm.CaptureAttempts) != 1 {
		t.Fatal("warm lost intent identity/attempt", warm)
	}
	repeated, err := m.CaptureTree(context.Background(), treeRequest(b, "hot-warm", "warm"))
	if err != nil || repeated.Tree.ObjectID != warm.Tree.ObjectID {
		t.Fatal("warm retry not idempotent", err)
	}
}
func TestWholeTreeExternalWriterCannotBecomeComplete(t *testing.T) {
	m, b, root, _ := fixture(t)
	path := filepath.Join(root, "file.txt")
	os.WriteFile(path, []byte("first"), 0600)
	before, _ := os.Stat(path)
	m.testFault = func(phase string) error {
		if phase == "tree_before_verify" {
			os.WriteFile(path, []byte("other"), 0600)
			os.Chtimes(path, before.ModTime(), before.ModTime())
		}
		return nil
	}
	r, err := m.CaptureTree(context.Background(), treeRequest(b, "writer", "warm"))
	if err != nil {
		t.Fatal(err)
	}
	if r.Coverage != "partial" || r.Consistency != "changed" {
		t.Fatal("external writer was declared consistent", r)
	}
}

func TestWarmCaptureDoesNotHoldMutationOrStatusGate(t *testing.T) {
	m, b, root, _ := fixture(t)
	os.WriteFile(filepath.Join(root, "file.txt"), []byte("before"), 0600)
	entered := make(chan struct{})
	resume := make(chan struct{})
	once := false
	m.testFault = func(phase string) error {
		if phase == "tree_walk_entry" && !once {
			once = true
			close(entered)
			<-resume
		}
		return nil
	}
	done := make(chan error, 1)
	go func() { _, err := m.CaptureTree(context.Background(), treeRequest(b, "parallel", "warm")); done <- err }()
	<-entered
	check, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	status, err := m.Status(check, b, "parallel")
	if err != nil || status.State != "intent" {
		close(resume)
		t.Fatal("status waited on scan gate", err)
	}
	inspect, err := m.Inspect(check, b, []string{"file.txt"}, "")
	if err != nil {
		close(resume)
		t.Fatal("observe waited on scan gate", err)
	}
	before := *inspect.Observations[0].State
	_, err = m.Mutate(check, request(b, "parallel-write", "after", before), "mutate")
	if err != nil {
		close(resume)
		t.Fatal("write waited on warm scan", err)
	}
	close(resume)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestWholeTreeCancelAndScopeReplaceDoNotPublishComplete(t *testing.T) {
	m, b, root, _ := fixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := m.CaptureTree(ctx, treeRequest(b, "cancel-tree", "hot")); err == nil {
		t.Fatal("cancel ignored")
	}
	os.Rename(root, root+"-old")
	os.Mkdir(root, 0700)
	if _, err := m.CaptureTree(context.Background(), treeRequest(b, "wrong-root", "warm")); err == nil {
		t.Fatal("replaced root captured under old source")
	}
}
