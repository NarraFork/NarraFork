package handlers

import (
	"context"
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func privateFixture(t *testing.T) (string, string, *Handlers) {
	t.Helper()
	parent := t.TempDir()
	private := filepath.Join(parent, ".executor-state")
	if err := os.MkdirAll(filepath.Join(private, "history", "objects"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(private, "history", "objects", "opaque"), []byte("PRIVATE_CAS_MARKER"), 0600); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(parent, "public.txt"), []byte("PUBLIC_MARKER"), 0600)
	guard := NewPathGuard(nil)
	if err := guard.ExcludePrivateDirectories(private); err != nil {
		t.Fatal(err)
	}
	return parent, private, New(guard, 1<<20)
}

func TestPrivateStateIsExcludedWithoutNarrowingAncestors(t *testing.T) {
	parent, private, h := privateFixture(t)
	if _, err := h.guard.CheckExisting(parent); err != nil {
		t.Fatal("ancestor denied", err)
	}
	if _, err := h.guard.CheckCreate(filepath.Join(parent, "normal.txt")); err != nil {
		t.Fatal("public create denied", err)
	}
	for _, path := range []string{private, filepath.Join(private, "history", "objects", "opaque"), filepath.Join(private, "new", "suffix")} {
		if _, err := h.guard.CheckCreate(path); err == nil {
			t.Fatal("private create allowed", path)
		}
		if _, err := h.guard.CheckRemove(path); err == nil {
			t.Fatal("private remove allowed", path)
		}
	}
	if _, err := h.FsReadContext(context.Background(), map[string]any{"path": filepath.Join(private, "history", "objects", "opaque"), "maxBytes": 100}); err == nil {
		t.Fatal("private CAS bytes read")
	}
	if _, err := h.FsList(map[string]any{"path": private}); err == nil {
		t.Fatal("private directory listed")
	}
}

func TestPrivateExclusionCannotBeReopenedAndCoversFutureSuffix(t *testing.T) {
	parent := t.TempDir()
	private := filepath.Join(parent, "future-private")
	guard := NewPathGuardWithRules([]PathRule{{Action: RuleAllow, Path: parent}, {Action: RuleAllow, Path: private}})
	if err := guard.ExcludePrivateDirectories(private); err != nil {
		t.Fatal(err)
	}
	if _, err := guard.CheckCreate(filepath.Join(private, "child", "missing")); err == nil {
		t.Fatal("future suffix bypass")
	}
	os.Mkdir(private, 0700)
	if _, err := guard.CheckExisting(private); err == nil {
		t.Fatal("later allow reopened private")
	}
	if _, err := guard.CheckCreate(filepath.Join(parent, "public", "missing")); err != nil {
		t.Fatal("unrelated create narrowed", err)
	}
}

func TestPrivateAliasAndGlobCannotExposeObjects(t *testing.T) {
	parent, private, h := privateFixture(t)
	alias := filepath.Join(parent, "alias")
	if err := os.Symlink(private, alias); err == nil {
		if _, err := h.guard.CheckExisting(filepath.Join(alias, "history", "objects", "opaque")); err == nil {
			t.Fatal("alias exposed CAS")
		}
		if _, err := h.guard.CheckCreate(filepath.Join(alias, "new")); err == nil {
			t.Fatal("alias create exposed CAS")
		}
	}
	result, err := h.GlobContext(context.Background(), map[string]any{"cwd": parent, "pattern": "**/*", "dot": true, "includeDirectories": true, "maxResults": 100})
	if err != nil {
		t.Fatal(err)
	}
	for _, match := range result.(map[string]any)["matches"].([]string) {
		if strings.Contains(match, "executor-state") || strings.Contains(match, "opaque") || strings.HasPrefix(match, "alias") {
			t.Fatal("private glob entry", match)
		}
	}
}

func TestPrivateGrepNeverScansCASAndReportsNarrowing(t *testing.T) {
	parent, _, h := privateFixture(t)
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("ripgrep unavailable; fallback refusal covered separately")
	}
	result, err := h.Grep(map[string]any{"cwd": parent, "searchPath": parent, "pattern": "MARKER", "outputMode": "content", "glob": "**/*", "timeoutMs": 2000, "maxBytes": 4096})
	if err != nil {
		t.Fatal(err)
	}
	data := result.(map[string]any)
	stdout, _ := base64.StdEncoding.DecodeString(data["stdoutB64"].(string))
	if strings.Contains(string(stdout), "PRIVATE_CAS_MARKER") {
		t.Fatal("private grep leaked bytes", string(stdout))
	}
	if !strings.Contains(string(stdout), "PUBLIC_MARKER") {
		t.Fatal("public content missing", string(stdout))
	}
	if data["policyExcluded"] != true {
		t.Fatal("policy narrowing not declared")
	}
}

func TestPrivateRecursiveFallbackRefusesInsteadOfScanning(t *testing.T) {
	parent, _, h := privateFixture(t)
	t.Setenv("PATH", t.TempDir())
	if _, err := h.Grep(map[string]any{"cwd": parent, "searchPath": parent, "pattern": "PRIVATE_CAS_MARKER"}); err == nil || !strings.Contains(err.Error(), "private_state_exclusion_requires_ripgrep") {
		t.Fatal("fallback scanned private state", err)
	}
}
