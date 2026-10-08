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

type exclusiveFixture struct {
	h                            *Handlers
	parent, saved, outside, path string
}

func newExclusiveFixture(t *testing.T) exclusiveFixture {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	work := filepath.Join(base, "workspace")
	parent := filepath.Join(work, "parent")
	outside := filepath.Join(base, "outside")
	if err := os.MkdirAll(parent, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(outside, 0700); err != nil {
		t.Fatal(err)
	}
	return exclusiveFixture{New(NewPathGuard([]string{work}), 4000000), parent, filepath.Join(work, "saved"), outside, filepath.Join(parent, "entry")}
}

func (f exclusiveFixture) params() map[string]any {
	return map[string]any{"path": f.path, "expectedResolvedPath": f.path, "exclusive": true, "dataB64": base64.StdEncoding.EncodeToString([]byte("safe"))}
}
func (f exclusiveFixture) swap(t *testing.T) {
	t.Helper()
	if err := os.Rename(f.parent, f.saved); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		requireWindowsJunction(t, f.outside, f.parent)
	} else {
		requireSymlink(t, f.outside, f.parent)
	}
}
func requireEmptyExclusiveDir(t *testing.T, path string) {
	t.Helper()
	entries, err := os.ReadDir(path)
	if err != nil || len(entries) != 0 {
		t.Fatalf("unexpected entries outside authorized directory: %v %v", entries, err)
	}
}

// The positive control proves this fixture actually exposes the former bug:
// full-path mkdir/open follows the swapped parent despite a prior guard/O_EXCL.
func TestExclusiveCheckedFullPathRegressionControl(t *testing.T) {
	for _, operation := range []string{"mkdir", "write"} {
		t.Run(operation, func(t *testing.T) {
			f := newExclusiveFixture(t)
			path, err := f.h.exclusiveCreatePath(f.params())
			if err != nil {
				t.Fatal(err)
			}
			f.swap(t)
			if operation == "mkdir" {
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			} else {
				file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := file.Write([]byte("escaped")); err != nil {
					t.Fatal(err)
				}
				file.Close()
			}
			if _, err := os.Stat(filepath.Join(f.outside, "entry")); err != nil {
				t.Fatal("control did not reproduce escape", err)
			}
		})
	}
}

func TestExclusiveParentSwapAfterCheckAndAfterBinding(t *testing.T) {
	for _, operation := range []string{"mkdir", "write"} {
		for _, stage := range []string{"after-check", "after-bind"} {
			t.Run(operation+"/"+stage, func(t *testing.T) {
				f := newExclusiveFixture(t)
				called := false
				bind := func(ctx context.Context, path string) (*os.Root, string, error) {
					called = true
					if stage == "after-check" {
						f.swap(t)
					}
					root, leaf, err := openExclusiveParent(ctx, path)
					if err == nil && stage == "after-bind" {
						f.swap(t)
					}
					return root, leaf, err
				}
				var err error
				if operation == "mkdir" {
					_, err = f.h.fsMkdirExclusiveWithParent(context.Background(), f.params(), bind)
				} else {
					_, err = f.h.fsWriteExclusiveWithParent(context.Background(), f.params(), bind)
				}
				if !called {
					t.Fatal("race did not run after canonical check")
				}
				requireEmptyExclusiveDir(t, f.outside)
				if stage == "after-check" {
					if err == nil {
						t.Fatal("swapped canonical parent accepted")
					}
					requireEmptyExclusiveDir(t, f.saved)
				} else {
					if err != nil {
						t.Fatal(err)
					}
					if _, err := os.Stat(filepath.Join(f.saved, "entry")); err != nil {
						t.Fatal("creation did not use bound parent", err)
					}
					if operation == "write" {
						bytes, err := os.ReadFile(filepath.Join(f.saved, "entry"))
						if err != nil || string(bytes) != "safe" {
							t.Fatalf("wrong bound content: %q %v", bytes, err)
						}
					}
				}
			})
		}
	}
}

func TestExclusiveInputAndBudgetGuards(t *testing.T) {
	f := newExclusiveFixture(t)
	for _, timeout := range []any{0, -1, 30001, 0.5, "1000"} {
		p := f.params()
		p["timeoutMs"] = timeout
		if _, err := f.h.FsMkdirExclusive(context.Background(), p); err == nil {
			t.Fatal("invalid timeout accepted", timeout)
		}
		if _, err := f.h.FsWriteContext(context.Background(), p); err == nil {
			t.Fatal("invalid write timeout accepted", timeout)
		}
	}
	for _, key := range []string{"path", "expectedResolvedPath"} {
		for _, path := range []any{nil, "", "a\x00b", strings.Repeat("x", exclusiveCreateMaxPathBytes+1), string(filepath.Separator) + strings.Repeat("x"+string(filepath.Separator), exclusiveCreateMaxDepth+1)} {
			p := f.params()
			p[key] = path
			if _, err := f.h.FsMkdirExclusive(context.Background(), p); err == nil {
				t.Fatal("invalid path accepted", key)
			}
			if _, err := f.h.FsWriteContext(context.Background(), p); err == nil {
				t.Fatal("invalid write path accepted", key)
			}
		}
	}
	for _, content := range []any{nil, 123, "not-base64", strings.Repeat("A", base64.StdEncoding.EncodedLen(exclusiveCreateMaxBytes)+4)} {
		p := f.params()
		p["dataB64"] = content
		if _, err := f.h.FsWriteContext(context.Background(), p); err == nil {
			t.Fatal("invalid content accepted")
		}
	}
	p := f.params()
	p["exclusive"] = "true"
	if _, err := f.h.FsWriteContext(context.Background(), p); err == nil {
		t.Fatal("nonboolean exclusive silently downgraded to ordinary write")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := f.h.FsWriteContext(ctx, f.params()); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	requireEmptyExclusiveDir(t, f.parent)
}

func TestExclusiveWriteBudgetIncludesMutationQueue(t *testing.T) {
	f := newExclusiveFixture(t)
	release, err := acquireFileMutation(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	p := f.params()
	p["timeoutMs"] = 1
	if _, err := f.h.FsWriteContext(context.Background(), p); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	requireEmptyExclusiveDir(t, f.parent)
}

func TestExclusiveMissingParentAndFinalSymlinkCannotMutateOutside(t *testing.T) {
	f := newExclusiveFixture(t)
	p := f.params()
	p["path"] = filepath.Join(f.path, "nested")
	p["expectedResolvedPath"] = p["path"]
	if _, err := f.h.FsWriteContext(context.Background(), p); err == nil {
		t.Fatal("exclusive write implicitly created parent")
	}
	requireEmptyExclusiveDir(t, f.parent)
	victim := filepath.Join(f.outside, "victim")
	if err := os.WriteFile(victim, []byte("untouched"), 0600); err != nil {
		t.Fatal(err)
	}
	requireSymlink(t, victim, f.path)
	if _, err := f.h.FsWriteContext(context.Background(), f.params()); err == nil {
		t.Fatal("final symlink accepted")
	}
	bytes, err := os.ReadFile(victim)
	if err != nil || string(bytes) != "untouched" {
		t.Fatal("victim changed", err)
	}
}

func TestExclusiveGuardHonorsDeniedMissingLeafAndLegacyWrite(t *testing.T) {
	f := newExclusiveFixture(t)
	h := New(NewPathGuardWithRules([]PathRule{{RuleAllow, filepath.Dir(f.parent)}, {RuleDeny, f.path}}), 4000000)
	if _, err := h.FsMkdirExclusive(context.Background(), f.params()); err == nil {
		t.Fatal("denied leaf accepted")
	}
	if _, err := h.FsWriteContext(context.Background(), f.params()); err == nil {
		t.Fatal("denied file accepted")
	}
	p := f.params()
	delete(p, "exclusive")
	p["path"] = filepath.Join(f.path, "nested")
	p["expectedResolvedPath"] = p["path"]
	if _, err := f.h.FsWriteContext(context.Background(), p); err != nil {
		t.Fatal("legacy mkdirp lost", err)
	}
	p["dataB64"] = base64.StdEncoding.EncodeToString([]byte("replacement"))
	if _, err := f.h.FsWriteContext(context.Background(), p); err != nil {
		t.Fatal("legacy overwrite lost", err)
	}
	bytes, err := os.ReadFile(p["path"].(string))
	if err != nil || string(bytes) != "replacement" {
		t.Fatal("legacy content mismatch", err)
	}
}
