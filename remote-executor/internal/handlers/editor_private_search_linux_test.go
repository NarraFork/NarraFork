//go:build linux

package handlers

import (
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Both subprocess backends are REAL installed binaries. A fallback that cannot
// safely honor recursive exclusions never gets a recursive directory operand:
// its files come from the existing bounded, guarded Glob enumeration.
func TestEditorPrivateSearchBackends(t *testing.T) {
	rg, err := exec.LookPath("rg")
	if err != nil {
		t.Fatal("real ripgrep is required for this fixture", err)
	}
	grep, err := exec.LookPath("grep")
	if err != nil {
		t.Fatal("real fallback grep is required for this fixture", err)
	}
	for _, backend := range []string{"rg", "grep"} {
		t.Run(backend, func(t *testing.T) {
			f, stage, visible := newPrivateEditorFixture(t)
			alias := filepath.Join(f.root, "public", "private-alias")
			editorPrivateAlias(t, f.e.root, alias)
			bin := t.TempDir()
			if err := os.Symlink(grep, filepath.Join(bin, "grep")); err != nil {
				t.Fatal(err)
			}
			if backend == "rg" {
				if err := os.Symlink(rg, filepath.Join(bin, "rg")); err != nil {
					t.Fatal(err)
				}
			}
			t.Setenv("PATH", bin)
			// Try to re-enable symlink following from rg config. Explicit no-follow
			// and the late internal exclusions must win over caller/config inclusion.
			config := filepath.Join(t.TempDir(), "rg-config")
			if err := os.WriteFile(config, []byte("--follow\n"), 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("RIPGREP_CONFIG_PATH", config)
			check := func(cwd, scope, mode string) {
				t.Helper()
				result, err := f.h.Grep(map[string]any{"cwd": cwd, "searchPath": scope, "pattern": "STATE_NEEDLE", "glob": "**", "outputMode": mode, "maxBytes": 128 * 1024})
				if err != nil {
					t.Fatal(err)
				}
				body := result.(map[string]any)
				output, err := base64.StdEncoding.DecodeString(body["stdoutB64"].(string))
				if err != nil {
					t.Fatal(err)
				}
				if !strings.Contains(string(output), "visible.txt") {
					t.Fatalf("%s hid same-name public sibling: %s %+v", backend, output, body)
				}
				if strings.Contains(string(output), stage) || strings.Contains(string(output), "private-host-proof") || strings.Contains(string(output), "private association") || strings.Contains(string(output), "private body") {
					t.Fatalf("%s leaked private state: %s", backend, output)
				}
				if body["usedFallback"] != (backend == "grep") {
					t.Fatal("fixture did not select the requested real backend", body)
				}
			}
			for _, mode := range []string{"content", "files_with_matches", "count"} {
				check(f.root, f.root, mode)
				check(f.root, filepath.Join(f.root, "public"), mode)
			}
			// Absolute child search from a wider cwd tests the exact rg anchor base;
			// excluding a basename would also hide public/editor-native[private].
			parent := filepath.Dir(f.root)
			f.h.guard.rules = append(f.h.guard.rules, resolvedRule{action: RuleAllow, root: parent})
			check(parent, f.root, "content")
			if backend == "rg" {
				// ../ anchors cannot safely express a private exclusion above cwd.
				if _, err := f.h.Grep(map[string]any{"cwd": filepath.Dir(visible), "searchPath": f.root, "pattern": "STATE_NEEDLE"}); !errors.Is(err, errExecutorPrivatePath) {
					t.Fatal("unsafe overlapping rg scope was not refused", err)
				}
			} else {
				check(filepath.Dir(visible), f.root, "content")
			}
		})
	}
}
