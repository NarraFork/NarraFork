//go:build darwin

package handlers

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type darwinCaseOutput struct{ bytes.Buffer }

func (b *darwinCaseOutput) Write(p []byte) (int, error) {
	if b.Len()+len(p) > 64*1024 {
		return 0, fmt.Errorf("hdiutil output exceeded fixture budget")
	}
	return b.Buffer.Write(p)
}
func darwinCaseCommand(args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/usr/bin/hdiutil", args...)
	cmd.WaitDelay = time.Second
	var output darwinCaseOutput
	cmd.Stdout = &output
	cmd.Stderr = &output
	err := cmd.Run()
	return output.String(), err
}

// Each case owns its image/mount. These tests require an actual macOS host that
// can attach disk images; missing support FAILS, never silently skips a CI volume.
func darwinCaseVolume(t *testing.T, fs string, caseSensitive bool) string {
	t.Helper()
	base := t.TempDir()
	image := filepath.Join(base, "case-volume.sparseimage")
	mount := filepath.Join(base, "mount")
	if err := os.Mkdir(mount, 0700); err != nil {
		t.Fatal(err)
	}
	if output, err := darwinCaseCommand("create", "-quiet", "-size", "128m", "-type", "SPARSE", "-fs", fs, "-volname", "NFEditorCase", image); err != nil {
		t.Fatalf("create isolated %s volume: %v %s", fs, err, output)
	}
	if output, err := darwinCaseCommand("attach", "-quiet", "-nobrowse", "-mountpoint", mount, image); err != nil {
		t.Fatalf("attach isolated %s volume: %v %s", fs, err, output)
	}
	t.Cleanup(func() {
		if output, err := darwinCaseCommand("detach", "-quiet", "-force", mount); err != nil {
			t.Errorf("detach own fixture mount: %v %s", err, output)
		}
	})
	probe := filepath.Join(mount, "CaseProbe")
	if err := os.WriteFile(probe, []byte("probe"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := os.Stat(filepath.Join(mount, "cASEpROBE"))
	if caseSensitive && !errors.Is(err, os.ErrNotExist) || !caseSensitive && err != nil {
		t.Fatalf("fixture did not provide requested case semantics: %s sensitive=%v err=%v", fs, caseSensitive, err)
	}
	return mount
}

func TestDarwinPrivatePathVolumes(t *testing.T) {
	for _, volume := range []struct {
		fs        string
		sensitive bool
	}{{"APFS", false}, {"APFSX", true}} {
		t.Run(volume.fs, func(t *testing.T) {
			mount := darwinCaseVolume(t, volume.fs, volume.sensitive)
			allowed := filepath.Join(mount, "AllowedScope")
			if err := os.Mkdir(allowed, 0700); err != nil {
				t.Fatal(err)
			}
			state := filepath.Join(allowed, "editor-native")
			h := New(NewPathGuard([]string{allowed}), 128*1024)
			e, err := NewEditorEngine(h, state)
			if err != nil {
				t.Fatal(err)
			}
			h.SetEditorEngine(e)
			marker := filepath.Join(state, "marker.json")
			if err = os.WriteFile(marker, []byte("PRIVATE_CASE_NEEDLE"), 0600); err != nil {
				t.Fatal(err)
			}
			public := filepath.Join(allowed, "public.txt")
			if err = os.WriteFile(public, []byte("PUBLIC_CASE_NEEDLE"), 0600); err != nil {
				t.Fatal(err)
			}
			canonicalAllowed, err := canonicalGuardPath(allowed)
			if err != nil {
				t.Fatal(err)
			}
			wrongAllowed := filepath.Join(mount, "ALLOWEDSCOPE")
			wrongPrivate := filepath.Join(wrongAllowed, "EDITOR-NATIVE")
			if volume.sensitive {
				// A distinct case-sensitive public sibling MUST remain writable,
				// including before it exists; globally lowercasing Darwin is unsafe.
				upper := filepath.Join(allowed, "EDITOR-NATIVE")
				upperFile := filepath.Join(upper, "public.txt")
				if _, err = h.FsWrite(map[string]any{"path": upperFile, "dataB64": base64.StdEncoding.EncodeToString([]byte("PUBLIC_CASE_NEEDLE"))}); err != nil {
					t.Fatal("case-sensitive sibling was hidden", err)
				}
				if got, err := h.FsRead(map[string]any{"path": upperFile}); err != nil || got == nil {
					t.Fatal("case-sensitive sibling read failed", err)
				}
				if canonical, err := canonicalGuardPath(upper); err != nil || canonical != filepath.Join(canonicalAllowed, "EDITOR-NATIVE") {
					t.Fatal("case-sensitive spelling collapsed", canonical, err)
				}
				if err = h.checkGitTree(upper); err != nil {
					t.Fatal("ordinary sibling tree was denied", err)
				}
				wrongAllowed = allowed
				wrongPrivate = state
			} else {
				canonical, err := canonicalGuardPath(filepath.Join(wrongPrivate, "MARKER.JSON"))
				if err != nil || canonical != filepath.Join(canonicalAllowed, "editor-native", "marker.json") {
					t.Fatal("native canonical spelling did not correct ordinary components", canonical, err)
				}
			}
			alias := filepath.Join(allowed, "Alias-Private")
			if err = os.Symlink(state, alias); err != nil {
				t.Fatal(err)
			}
			aliasRequest := alias
			if !volume.sensitive {
				aliasRequest = filepath.Join(wrongAllowed, "ALIAS-PRIVATE")
			}
			for _, path := range []string{wrongPrivate, filepath.Join(wrongPrivate, "MARKER.JSON"), filepath.Join(wrongPrivate, "Missing", "new.json"), aliasRequest, filepath.Join(aliasRequest, "missing", "new.json")} {
				for _, op := range []struct {
					name string
					run  func() (any, error)
				}{
					{"stat", func() (any, error) { return h.FsStat(map[string]any{"path": path}) }},
					{"list", func() (any, error) { return h.FsList(map[string]any{"path": path}) }},
					{"read", func() (any, error) { return h.FsRead(map[string]any{"path": path}) }},
					{"write", func() (any, error) { return h.FsWrite(map[string]any{"path": path, "dataB64": "Zm9yZ2Vk"}) }},
					{"remove", func() (any, error) { return h.FsRemove(map[string]any{"path": path}) }},
				} {
					if _, err := op.run(); !errors.Is(err, errExecutorPrivatePath) {
						t.Fatalf("%s bypassed private volume path %q: %v", op.name, path, err)
					}
				}
			}
			if err = h.checkGitTree(wrongAllowed); !errors.Is(err, errExecutorPrivatePath) {
				t.Fatal("ancestor check ignored native spelling", err)
			}
			listing, err := h.FsList(map[string]any{"path": wrongAllowed})
			if err != nil {
				t.Fatal(err)
			}
			for _, entry := range listing.(map[string]any)["entries"].([]map[string]any) {
				if entry["name"] == "editor-native" {
					t.Fatal("parent list exposed private directory")
				}
			}
			glob, err := h.Glob(map[string]any{"cwd": wrongAllowed, "pattern": "**", "dot": true})
			if err != nil {
				t.Fatal(err)
			}
			for _, path := range glob.(map[string]any)["matches"].([]string) {
				if strings.Contains(path, "marker.json") {
					t.Fatal("parent glob exposed private marker")
				}
			}
			// The builtin fallback is real; a guarded file manifest prevents BSD/GNU
			// recursive-link differences from bypassing native private canonicalization.
			bin := t.TempDir()
			if err = os.Symlink("/usr/bin/grep", filepath.Join(bin, "grep")); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", bin)
			result, err := h.Grep(map[string]any{"cwd": wrongAllowed, "searchPath": wrongAllowed, "pattern": "CASE_NEEDLE"})
			if err != nil {
				t.Fatal(err)
			}
			output, err := base64.StdEncoding.DecodeString(result.(map[string]any)["stdoutB64"].(string))
			if err != nil {
				t.Fatal(err)
			}
			if bytes.Contains(output, []byte("PRIVATE_CASE_NEEDLE")) || !bytes.Contains(output, []byte("PUBLIC_CASE_NEEDLE")) {
				t.Fatal("search did not honor native private spelling", string(output))
			}
			// Reserve a not-yet-created root through a case-variant existing parent.
			reserved := filepath.Join(wrongAllowed, "ReservedNewRoot")
			if err = h.ReserveEditorPrivateRoot(reserved); err != nil {
				t.Fatal(err)
			}
			if _, err = h.FsWrite(map[string]any{"path": filepath.Join(canonicalAllowed, "ReservedNewRoot", "nested.json"), "dataB64": ""}); !errors.Is(err, errExecutorPrivatePath) {
				t.Fatal("missing-root reservation lost nearest native ancestor", err)
			}
			body, err := os.ReadFile(marker)
			if err != nil || string(body) != "PRIVATE_CASE_NEEDLE" {
				t.Fatal("private marker was modified", err)
			}
			// Native case correction must not turn Darwin into a blanket readonly
			// provider. Ordinary stage/apply/query still work on each real volume.
			canonicalRoot, rootIdentity, err := h.EditorRootIdentity(allowed)
			if err != nil {
				t.Fatal(err)
			}
			f := &editorFixture{h: h, e: e, root: canonicalRoot, path: filepath.Join(canonicalRoot, "public.txt"), state: e.root, identity: EditorResourceIdentity{DeviceID: "fixture-device", PathFlavor: EditorPathFlavor(), CanonicalPath: filepath.Join(canonicalRoot, "public.txt"), WorkspaceIdentity: rootIdentity, RuntimeEpoch: EditorRuntimeEpoch(), RuntimeGeneration: 1, FencingToken: 1}}
			req := f.request(t, "normal-case-proof", []byte("PUBLIC_CASE_NEEDLE"), []byte("PUBLIC_CASE_NEXT"))
			if result := f.call(t, "editor.apply", req).(EditorApplyResult); result.Outcome != "committed" {
				t.Fatal("ordinary Darwin writer was disabled", result)
			}
			if result := f.query(t, req); result.Outcome != "committed" {
				t.Fatal("ordinary Darwin receipt query failed", result)
			}
		})
	}
}
