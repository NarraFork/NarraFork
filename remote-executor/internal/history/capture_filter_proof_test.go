package history

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func readCaptureIndex(t *testing.T, m *Manager, b Binding, r *Receipt) treeIndex {
	t.Helper()
	chunk, err := m.ReadObject(context.Background(), b, *r.Tree, 0, ChunkBytes)
	if err != nil {
		t.Fatal(err)
	}
	data, err := base64.StdEncoding.DecodeString(chunk.ContentBase64)
	if err != nil {
		t.Fatal(err)
	}
	var index treeIndex
	if err := json.Unmarshal(data, &index); err != nil {
		t.Fatal(err)
	}
	return index
}
func captureFilterGit(t *testing.T, root string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatal(err, string(output))
	}
}
func filterWrite(t *testing.T, path, value string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(value), 0600); err != nil {
		t.Fatal(err)
	}
}
func captureHasPath(t *testing.T, m *Manager, b Binding, r *Receipt, path string) bool {
	t.Helper()
	for _, entry := range readTreeEntries(t, m, b, r) {
		if entry.Path == path {
			return true
		}
	}
	return false
}

func TestCaptureFilterProofOriginalImmutableAcrossGitInputChanges(t *testing.T) {
	for _, kind := range []string{"info_exclude", "global_excludes", "global_config", "default_global_ignore", "parent_ignore", "parent_config", "nested_ignore", "tracked_index"} {
		t.Run(kind, func(t *testing.T) {
			if _, err := exec.LookPath("git"); err != nil {
				t.Skip("git unavailable")
			}
			home := t.TempDir()
			t.Setenv("HOME", home)
			t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "xdg"))
			m, b, root, _ := fixture(t)
			repo := root
			target := "keep.dat"
			ignorePattern := "keep.dat\n"
			ignorePath := ""
			if kind == "parent_ignore" || kind == "parent_config" {
				repo = filepath.Dir(root)
			}
			captureFilterGit(t, repo, "init", "-q")
			switch kind {
			case "info_exclude", "tracked_index":
				ignorePath = filepath.Join(repo, ".git", "info", "exclude")
			case "parent_ignore":
				ignorePath = filepath.Join(repo, ".gitignore")
			case "nested_ignore":
				if err := os.Mkdir(filepath.Join(root, "nested"), 0700); err != nil {
					t.Fatal(err)
				}
				target = filepath.Join("nested", "keep.dat")
				ignorePath = filepath.Join(root, "nested", ".gitignore")
			case "default_global_ignore":
				dir := filepath.Join(home, "xdg", "git")
				if err := os.MkdirAll(dir, 0700); err != nil {
					t.Fatal(err)
				}
				ignorePath = filepath.Join(dir, "ignore")
			case "global_excludes", "global_config":
				ignorePath = filepath.Join(home, "global.ignore")
				captureFilterGit(t, repo, "config", "--global", "core.excludesFile", ignorePath)
			default:
				ignorePath = filepath.Join(home, "global.ignore")
				captureFilterGit(t, repo, "config", "core.excludesFile", ignorePath)
			}
			filterWrite(t, ignorePath, ignorePattern)
			filterWrite(t, filepath.Join(root, target), "IGNORED_KEEP_BYTES")
			filterWrite(t, filepath.Join(root, "public"), "public")
			oldRequest := treeRequest(b, "old-filter", "warm")
			old, err := m.CaptureTree(context.Background(), oldRequest)
			if err != nil {
				t.Fatal(err)
			}
			oldIndex := readCaptureIndex(t, m, b, old)
			if old.Coverage != "complete" || oldIndex.FilterProof.Version != 1 || oldIndex.FilterProof.Kind != "git" || !oldIndex.FilterProof.Complete || !validDigest(oldIndex.FilterProof.Fingerprint) {
				t.Fatalf("old capture lacks complete actual proof: %+v %+v", old, oldIndex.FilterProof)
			}
			if captureHasPath(t, m, b, old, target) {
				t.Fatal("ignored file bytes captured")
			}
			switch kind {
			case "parent_config":
				replacement := filepath.Join(home, "other.ignore")
				filterWrite(t, replacement, "")
				captureFilterGit(t, repo, "config", "core.excludesFile", replacement)
			case "global_config":
				replacement := filepath.Join(home, "other.ignore")
				filterWrite(t, replacement, "")
				captureFilterGit(t, repo, "config", "--global", "core.excludesFile", replacement)
			case "tracked_index":
				captureFilterGit(t, repo, "add", "-f", "keep.dat")
			default:
				filterWrite(t, ignorePath, "")
			}
			current, err := m.CaptureTree(context.Background(), treeRequest(b, "current-filter", "warm"))
			if err != nil {
				t.Fatal(err)
			}
			currentIndex := readCaptureIndex(t, m, b, current)
			if current.Coverage != "complete" || !currentIndex.FilterProof.Complete {
				t.Fatal("current capture incomplete", current.Reason)
			}
			if currentIndex.FilterProof.Fingerprint == oldIndex.FilterProof.Fingerprint {
				t.Fatal("actual filtering changed but fingerprint stayed the same")
			}
			if !captureHasPath(t, m, b, current, target) {
				t.Fatal("newly unignored path not observed")
			}
			replay, err := m.CaptureTree(context.Background(), oldRequest)
			if err != nil {
				t.Fatal(err)
			}
			if replay.Tree.ObjectID != old.Tree.ObjectID || readCaptureIndex(t, m, b, replay).FilterProof != oldIndex.FilterProof {
				t.Fatal("original snapshot was relabeled to current filters")
			}
			bytes, err := os.ReadFile(filepath.Join(root, target))
			if err != nil || string(bytes) != "IGNORED_KEEP_BYTES" {
				t.Fatal("capture touched ignored/current-only bytes")
			}
		})
	}
}

func TestCaptureFilterProofMidScanChangeCannotClaimComplete(t *testing.T) {
	m, b, root, _ := fixture(t)
	captureFilterGit(t, root, "init", "-q")
	ignorePath := filepath.Join(root, ".git", "info", "exclude")
	filterWrite(t, ignorePath, "keep.dat\n")
	filterWrite(t, filepath.Join(root, "keep.dat"), "KEEP")
	filterWrite(t, filepath.Join(root, "public"), "public")
	m.testFault = func(phase string) error {
		if phase == "tree_before_verify" {
			filterWrite(t, ignorePath, "")
		}
		return nil
	}
	r, err := m.CaptureTree(context.Background(), treeRequest(b, "unstable-filter", "warm"))
	if err != nil {
		t.Fatal(err)
	}
	index := readCaptureIndex(t, m, b, r)
	if r.Coverage != "partial" || r.Consistency != "changed" || index.FilterProof.Complete {
		t.Fatal("unstable filtering mislabeled complete", r, index.FilterProof)
	}
	bytes, err := os.ReadFile(filepath.Join(root, "keep.dat"))
	if err != nil || string(bytes) != "KEEP" {
		t.Fatal("capture modified keep bytes")
	}
}

func TestCaptureFilterProofNonGitAndDeniedFilterSources(t *testing.T) {
	m, b, root, _ := fixture(t)
	r, err := m.CaptureTree(context.Background(), treeRequest(b, "none-filter", "warm"))
	if err != nil {
		t.Fatal(err)
	}
	proof := readCaptureIndex(t, m, b, r).FilterProof
	if proof.Version != 1 || proof.Kind != "none" || !proof.Complete || !validDigest(proof.Fingerprint) {
		t.Fatal("non-git proof missing", proof)
	}
	captureFilterGit(t, root, "init", "-q")
	exclude := filepath.Join(root, ".git", "info", "exclude")
	original := m.guard
	m.guard = func(path string, create bool) (string, error) {
		if path == exclude {
			return "", fmt.Errorf("policy denied")
		}
		return original(path, create)
	}
	r, err = m.CaptureTree(context.Background(), treeRequest(b, "denied-filter", "warm"))
	if err != nil {
		t.Fatal(err)
	}
	proof = readCaptureIndex(t, m, b, r).FilterProof
	if r.Coverage != "partial" || proof.Complete || proof.Kind != "git" {
		t.Fatal("denied source guessed complete", r, proof)
	}
}
