package handlers

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func editorPrivateAlias(t *testing.T, target, alias string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		requireWindowsJunction(t, target, alias)
	} else {
		requireSymlink(t, target, alias)
	}
}
func newPrivateEditorFixture(t *testing.T) (*editorFixture, string, string) {
	t.Helper()
	root := t.TempDir()
	h := New(NewPathGuard([]string{root}), 128*1024)
	e, err := NewEditorEngine(h, filepath.Join(root, "editor-native[private]"))
	if err != nil {
		t.Fatal(err)
	}
	if err = e.ConfigureHostReceipts(filepath.Join(root, "editor-native-operations")); err != nil {
		t.Fatal(err)
	}
	h.SetEditorEngine(e)
	// A later, exact operator allow cannot override executor-owned private state.
	h.guard.rules = append(h.guard.rules, resolvedRule{action: RuleAllow, root: e.root}, resolvedRule{action: RuleAllow, root: e.hostReceipts.io.root})
	canonical, identity, err := h.EditorRootIdentity(root)
	if err != nil {
		t.Fatal(err)
	}
	f := &editorFixture{h: h, e: e, root: canonical, path: filepath.Join(canonical, "document"), state: e.root, identity: EditorResourceIdentity{DeviceID: "fixture-device", PathFlavor: EditorPathFlavor(), CanonicalPath: filepath.Join(canonical, "document"), WorkspaceIdentity: identity, RuntimeEpoch: EditorRuntimeEpoch(), RuntimeGeneration: 1, FencingToken: 1}}
	if err = os.WriteFile(f.path, []byte("before"), 0640); err != nil {
		t.Fatal(err)
	}
	stage := f.stage(t, []byte("STATE_NEEDLE private body"))
	record := hostReceiptFixture(f, "private-host-proof")
	record.ResourceKey = "STATE_NEEDLE private association"
	hostReceiptCall(t, f, "editor.hostReceipt.put", map[string]any{"value": record})
	visible := filepath.Join(root, "public", filepath.Base(e.root), "visible.txt")
	if err = os.MkdirAll(filepath.Dir(visible), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(visible, []byte("STATE_NEEDLE visible sibling"), 0600); err != nil {
		t.Fatal(err)
	}
	return f, stage, visible
}
func TestEditorPrivateStateGuard(t *testing.T) {
	f, stage, visible := newPrivateEditorFixture(t)
	engineAlias, hostAlias := filepath.Join(f.root, "engine-alias"), filepath.Join(f.root, "host-alias")
	editorPrivateAlias(t, f.e.root, engineAlias)
	editorPrivateAlias(t, f.e.hostReceipts.io.root, hostAlias)
	paths := []string{f.e.bodyPath(stage), f.e.stagePath(stage), filepath.Join(f.e.root, "engine.lock"), filepath.Join(f.e.hostReceipts.io.root, "private-host-proof.json"), filepath.Join(engineAlias, stage+".body"), filepath.Join(hostAlias, "private-host-proof.json"), filepath.Join(engineAlias, "new", "nested.json")}
	if runtime.GOOS == "windows" {
		paths = append(paths, strings.ToUpper(f.e.bodyPath(stage)), `\\?\`+f.e.bodyPath(stage), f.e.root+":stream", `\\?\`+f.e.root+":stream")
	}
	transfers := NewTransfers(f.h, nil)
	defer transfers.Close()
	for _, path := range paths {
		t.Run(filepath.Base(path), func(t *testing.T) {
			operations := []struct {
				name string
				run  func() (any, error)
			}{
				{"stat", func() (any, error) {
					return f.h.FsStat(map[string]any{"path": path, "editorIdentity": true, "editorRoot": f.root})
				}},
				{"exists", func() (any, error) { return f.h.FsExists(map[string]any{"path": path}) }},
				{"read", func() (any, error) { return f.h.FsRead(map[string]any{"path": path}) }},
				{"write", func() (any, error) {
					return f.h.FsWrite(map[string]any{"path": path, "dataB64": base64.StdEncoding.EncodeToString([]byte("forged"))})
				}},
				{"conditional", func() (any, error) {
					return f.h.FsWriteConditional(context.Background(), map[string]any{"path": path, "expectedResolvedPath": path, "expectedDataB64": nil, "dataB64": ""})
				}},
				{"remove", func() (any, error) { return f.h.FsRemove(map[string]any{"path": path}) }},
				{"mkdir", func() (any, error) { return f.h.FsMkdirp(map[string]any{"path": path}) }},
				{"list", func() (any, error) { return f.h.FsList(map[string]any{"path": path}) }},
				{"glob", func() (any, error) {
					return f.h.Glob(map[string]any{"cwd": path, "pattern": "**", "dot": true})
				}},
				{"grep", func() (any, error) {
					return f.h.Grep(map[string]any{"cwd": f.root, "searchPath": path, "pattern": "STATE_NEEDLE"})
				}},
				{"transfer-stat", func() (any, error) { return f.h.TransferStat(map[string]any{"path": path, "recursive": true}) }},
				{"transfer-upload", func() (any, error) {
					return transfers.Begin(context.Background(), map[string]any{"transferId": "hidden", "direction": "upload", "remotePath": path})
				}},
				{"transfer-download", func() (any, error) {
					return transfers.Begin(context.Background(), map[string]any{"transferId": "hidden", "direction": "download", "remotePath": path})
				}},
				{"git-operand", func() (any, error) {
					return f.h.GitDiff(map[string]any{"cwd": filepath.Dir(visible), "args": []any{"--no-index", path, visible}})
				}},
				{"git-output", func() (any, error) {
					return f.h.GitDiff(map[string]any{"cwd": filepath.Dir(visible), "args": []any{"--output=" + path}})
				}},
			}
			for _, op := range operations {
				if _, err := op.run(); !errors.Is(err, errExecutorPrivatePath) {
					t.Fatalf("%s did not reject private path %q: %v", op.name, path, err)
				}
			}
			if file, _, _, err := f.h.OpenEditorReadFile(path); !errors.Is(err, errExecutorPrivatePath) {
				if file != nil {
					file.Close()
				}
				t.Fatal("raw-read bypassed private guard", err)
			}
		})
	}
	listing, err := f.h.FsList(map[string]any{"path": f.root})
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range listing.(map[string]any)["entries"].([]map[string]any) {
		if entry["name"] == filepath.Base(f.e.root) || entry["name"] == filepath.Base(f.e.hostReceipts.io.root) {
			t.Fatal("parent list exposed private state", entry)
		}
	}
	glob, err := f.h.Glob(map[string]any{"cwd": f.root, "pattern": "**", "dot": true})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, name := range glob.(map[string]any)["matches"].([]string) {
		if filepath.ToSlash(name) == "public/"+filepath.Base(f.e.root)+"/visible.txt" {
			found = true
		}
		if strings.Contains(name, stage) || strings.Contains(name, "private-host-proof") {
			t.Fatal("parent glob exposed private descendant", name)
		}
	}
	if !found {
		t.Fatal("same-name ordinary sibling was hidden")
	}
	manifest, err := f.h.TransferStat(map[string]any{"path": f.root, "recursive": true})
	if err != nil {
		t.Fatal(err)
	}
	found = false
	for _, entry := range manifest.(map[string]any)["entries"].([]map[string]any) {
		name := entry["relPath"].(string)
		if name == "public/"+filepath.Base(f.e.root)+"/visible.txt" {
			found = true
		}
		if strings.Contains(name, stage) || strings.Contains(name, "private-host-proof") {
			t.Fatal("recursive transfer exposed private descendant", name)
		}
	}
	if !found {
		t.Fatal("recursive transfer hid ordinary sibling")
	}
	if _, err = f.h.FsRemove(map[string]any{"path": f.root}); err == nil {
		t.Fatal("private ancestor directory was removed")
	}
	if err = f.h.checkGitTree(f.root); !errors.Is(err, errExecutorPrivatePath) {
		t.Fatal("whole-tree Git operation allowed private ancestor", err)
	}
	if _, err = f.h.GitStatus(map[string]any{"cwd": f.root}); !errors.Is(err, errExecutorPrivatePath) {
		t.Fatal("legacy whole-tree status exposed private ancestor", err)
	}
	// The guard does not gate the editor engine's own private IO.
	req := f.request(t, "still-normal", []byte("before"), []byte("after"))
	if r := f.call(t, "editor.apply", req).(EditorApplyResult); r.Outcome != "committed" {
		t.Fatal(r)
	}
	if f.query(t, req).Outcome != "committed" {
		t.Fatal("query broken by internal deny")
	}
	if got := hostReceiptCall(t, f, "editor.hostReceipt.get", map[string]any{"operationId": "private-host-proof"}); got["value"] == nil {
		t.Fatal("trusted Host store broken by internal deny")
	}
	attack := f.request(t, "attack-private", []byte("STATE_NEEDLE private body"), []byte("forged"))
	attack.Identity.CanonicalPath = f.e.bodyPath(stage)
	if r := f.call(t, "editor.apply", attack).(EditorApplyResult); r.Outcome != "rejected" {
		t.Fatal("editor target overwrote its private evidence", r)
	}
	body, err := os.ReadFile(f.e.bodyPath(stage))
	if err != nil || string(body) != "STATE_NEEDLE private body" {
		t.Fatal("private evidence changed", err)
	}
}
func TestEditorPrivateGuardKeepsOrdinaryGit(t *testing.T) {
	root, h := newGitFixture(t)
	file := filepath.Join(root, "ordinary.txt")
	if err := os.WriteFile(file, []byte("before\n"), 0600); err != nil {
		t.Fatal(err)
	}
	gitTestRun(t, root, "add", "ordinary.txt")
	gitTestRun(t, root, "commit", "-m", "fixture")
	e, err := NewEditorEngine(h, filepath.Join(t.TempDir(), "outside-repo-state"))
	if err != nil {
		t.Fatal(err)
	}
	h.SetEditorEngine(e)
	if err = os.WriteFile(file, []byte("after\n"), 0600); err != nil {
		t.Fatal(err)
	}
	status, err := h.GitStatus(map[string]any{"cwd": root})
	if err != nil || !strings.Contains(status.(map[string]any)["stdout"].(string), "ordinary.txt") {
		t.Fatal("ordinary Git status regressed", status, err)
	}
	diff, err := h.GitDiff(map[string]any{"cwd": root, "args": []any{"HEAD", "--", "ordinary.txt"}})
	if err != nil || !strings.Contains(diff.(map[string]any)["stdout"].(string), "+after") {
		t.Fatal("ordinary Git diff regressed", diff, err)
	}
	if result := gitCall(t, h, root, "status", nil); result["state"] == "access_denied" {
		t.Fatal("ordinary workspace Git was blocked", result)
	}
}

func TestEditorPrivateFailedInitialization(t *testing.T) {
	for _, which := range []string{"engine", "host"} {
		t.Run(which, func(t *testing.T) {
			root := t.TempDir()
			h := New(NewPathGuard(nil), 128*1024)
			weak := filepath.Join(root, "weak-state")
			if err := os.Mkdir(weak, 0755); err != nil {
				t.Fatal(err)
			}
			if runtime.GOOS != "windows" {
				if err := os.Chmod(weak, 0755); err != nil {
					t.Fatal(err)
				}
			}
			marker := filepath.Join(weak, "old-proof.json")
			if err := os.WriteFile(marker, []byte("old sole proof"), 0600); err != nil {
				t.Fatal(err)
			}
			if which == "engine" {
				if _, err := NewEditorEngine(h, weak); err == nil {
					t.Fatal("weak private root unexpectedly initialized")
				}
			} else {
				e, err := NewEditorEngine(h, filepath.Join(root, "good-state"))
				if err != nil {
					t.Fatal(err)
				}
				h.SetEditorEngine(e)
				if err = e.ConfigureHostReceipts(weak); err == nil {
					t.Fatal("weak Host root unexpectedly initialized")
				}
			}
			alias := filepath.Join(root, "alias")
			editorPrivateAlias(t, weak, alias)
			for _, path := range []string{marker, filepath.Join(alias, "old-proof.json")} {
				if _, err := h.FsStat(map[string]any{"path": path}); !errors.Is(err, errExecutorPrivatePath) {
					t.Fatal("failed init exposed metadata", err)
				}
				if _, err := h.FsRead(map[string]any{"path": path}); !errors.Is(err, errExecutorPrivatePath) {
					t.Fatal("failed init exposed proof", err)
				}
				if _, err := h.FsWrite(map[string]any{"path": path, "dataB64": ""}); !errors.Is(err, errExecutorPrivatePath) {
					t.Fatal("failed init allowed proof forgery", err)
				}
			}
			body, err := os.ReadFile(marker)
			if err != nil || string(body) != "old sole proof" {
				t.Fatal("failed initialization lost evidence", err)
			}
		})
	}
}
