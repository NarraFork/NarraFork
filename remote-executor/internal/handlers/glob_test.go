package handlers

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/bmatcuk/doublestar/v4"
)

func writeGlobFixture(t *testing.T, root string, paths ...string) {
	t.Helper()
	for _, path := range paths {
		abs := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(abs), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func assertGlobMatches(t *testing.T, result any, want []string) {
	t.Helper()
	payload := result.(map[string]any)
	got := payload["matches"].([]string)
	sort.Strings(got)
	sort.Strings(want)
	if !reflect.DeepEqual(got, want) || payload["truncated"] != false {
		t.Fatalf("got %#v, want matches %v without truncation", payload, want)
	}
}

func TestGlobLeadingCurrentDirectoryMatchesGlobWalk(t *testing.T) {
	root := t.TempDir()
	writeGlobFixture(t, root, "main.ts", "other.ts", "main.go", "src/main.go",
		"src/nested/deep.go", "src/.hidden/secret.go", ".hidden/root.go", ".hidden.ts")
	h := New(NewPathGuard([]string{root}), 4096)
	for _, pattern := range []string{"*.ts", "src/*.go", "src/**/*.go", "**/*.go", "missing/*.go", ".hidden/*.go", "{src,missing}/**/*.go"} {
		for _, prefix := range []string{"", "./", "././", "./././"} {
			t.Run(prefix+pattern, func(t *testing.T) {
				for _, dot := range []bool{false, true} {
					want := []string{}
					// Use the former filesystem walker on the canonical relative
					// pattern as the oracle, not Match. GlobWalk with os.DirFS does
					// not consistently accept repeated ./ or ./ before literal dirs.
					err := doublestar.GlobWalk(os.DirFS(root), pattern, func(path string, entry fs.DirEntry) error {
						if !entry.IsDir() && (dot || !hasDotSegment(path)) {
							want = append(want, path)
						}
						return nil
					})
					if err != nil {
						t.Fatal(err)
					}
					for _, candidate := range []string{pattern, prefix + pattern} {
						result, err := h.GlobContext(context.Background(), map[string]any{
							"cwd": root, "pattern": candidate, "dot": dot,
						})
						if err != nil {
							t.Fatal(err)
						}
						assertGlobMatches(t, result, want)
					}
				}
			})
		}
	}
}

func TestGlobLeadingCurrentDirectoryBoundsAndValidation(t *testing.T) {
	root := t.TempDir()
	writeGlobFixture(t, root, "first.go", "second.go", "src/nested/file.go")
	h := New(NewPathGuard([]string{root}), 4096)
	for _, prefix := range []string{"", "./", "././"} {
		for _, limit := range []map[string]any{{"maxResults": 1}, {"maxBytes": 2}} {
			limit["cwd"], limit["pattern"] = root, prefix+"**/*.go"
			result, err := h.GlobContext(context.Background(), limit)
			if err != nil {
				t.Fatal(err)
			}
			payload := result.(map[string]any)
			wantCount := 1
			if limit["maxBytes"] != nil {
				wantCount = 0
			}
			if payload["truncated"] != true || len(payload["matches"].([]string)) != wantCount {
				t.Fatalf("prefix %q: limits not enforced: %#v", prefix, payload)
			}
		}
		ctx := &checkingContext{Context: context.Background(), check: func(n int) error {
			if n >= 6 {
				return context.Canceled
			}
			return nil
		}}
		if _, err := h.GlobContext(ctx, map[string]any{
			"cwd": root, "pattern": prefix + "**/absent.go",
		}); !errors.Is(err, context.Canceled) {
			t.Fatalf("prefix %q: no-match walk ignored cancellation: %v", prefix, err)
		}
		for _, invalid := range []string{"[", "/**/*.go"} {
			if _, err := h.GlobContext(context.Background(), map[string]any{
				"cwd": root, "pattern": prefix + invalid,
			}); err == nil {
				t.Fatalf("accepted invalid pattern %q", prefix+invalid)
			}
		}
		// Parent segments must not be cleaned into an otherwise matching path.
		for _, pattern := range []string{"../*.go", "src/../*.go", "{src/..,src}/../*.go"} {
			result, err := h.GlobContext(context.Background(), map[string]any{
				"cwd": root, "pattern": prefix + pattern,
			})
			if err != nil {
				t.Fatal(err)
			}
			assertGlobMatches(t, result, []string{})
		}
	}
}

func TestGlobPrunesUnrelatedDeepTrees(t *testing.T) {
	root := t.TempDir()
	writeGlobFixture(t, root, "README.md", "main.ts", "src/main.go", "src/lib/util.go")
	for _, prefix := range []string{"node_modules", "src/unrelated", "src/lib/unrelated"} {
		writeGlobFixture(t, root, prefix+strings.Repeat("/deep", 64)+"/file.go")
	}
	h := New(NewPathGuard([]string{root}), 4096)
	for _, tc := range []struct {
		pattern string
		want    []string
	}{
		{"README.md", []string{"README.md"}},
		{"*.ts", []string{"main.ts"}},
		{"./*.ts", []string{"main.ts"}},
		{"././src/*.go", []string{"src/main.go"}},
		{"src/*.go", []string{"src/main.go"}},
		{"s?c/*.go", []string{"src/main.go"}},
		{"src/lib/*.go", []string{"src/lib/util.go"}},
		{"src/missing/*.go", []string{}},
		{"src", []string{"src"}},
	} {
		t.Run(tc.pattern, func(t *testing.T) {
			// Deterministically fail if unrelated descendants are enumerated, even
			// on privileged runners where chmod cannot make a directory unreadable.
			ctx := &checkingContext{Context: context.Background(), check: func(n int) error {
				if n > 40 {
					return context.Canceled
				}
				return nil
			}}
			result, err := h.GlobContext(ctx, map[string]any{
				"cwd": root, "pattern": tc.pattern, "includeDirectories": true,
			})
			if err != nil {
				t.Fatalf("shallow glob entered unrelated tree: %v (checks=%d)", err, ctx.checks)
			}
			assertGlobMatches(t, result, tc.want)
		})
	}
}

func TestGlobPrunesUnrelatedUnreadableDirectories(t *testing.T) {
	root := t.TempDir()
	writeGlobFixture(t, root, "README.md", "main.ts", "src/main.go", "src/lib/util.go")
	for _, path := range []string{"node_modules", "src/unrelated", "src/lib/unrelated"} {
		dir := filepath.Join(root, filepath.FromSlash(path))
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(dir, 0700) })
		if err := os.Chmod(dir, 0); err != nil {
			t.Fatal(err)
		}
		if _, err := os.ReadDir(dir); !errors.Is(err, fs.ErrPermission) {
			t.Skip("runner can read mode-000 directories; deep-tree test still checks pruning")
		}
	}
	h := New(NewPathGuard([]string{root}), 4096)
	for _, tc := range []struct {
		pattern string
		want    []string
	}{
		{"README.md", []string{"README.md"}},
		{"*.ts", []string{"main.ts"}},
		{"./*.ts", []string{"main.ts"}},
		{"././src/*.go", []string{"src/main.go"}},
		{"src/*.go", []string{"src/main.go"}},
		{"src/lib/*.go", []string{"src/lib/util.go"}},
		{"src", []string{"src"}},
	} {
		t.Run(tc.pattern, func(t *testing.T) {
			result, err := h.GlobContext(context.Background(), map[string]any{
				"cwd": root, "pattern": tc.pattern, "includeDirectories": true,
			})
			if err != nil {
				t.Fatalf("unrelated unreadable directory failed glob: %v", err)
			}
			assertGlobMatches(t, result, tc.want)
		})
	}
	// Do not hide genuine I/O errors when the pattern does need the subtree.
	if _, err := h.GlobContext(context.Background(), map[string]any{
		"cwd": root, "pattern": "**/*",
	}); !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("recursive scan should reach unreadable directory: %v", err)
	}
}

func TestGlobComplexPatternsPreserveMatches(t *testing.T) {
	root := t.TempDir()
	writeGlobFixture(t, root,
		"main.go", "src/main.go", "src/other.ts", "src/nested/deep.go",
		"src/nested/deeper/last.go", "src/.hidden/secret.go", ".hidden/root.go",
		".hidden/.nested/secret.go", "pkg/main.go", "tests/main.go",
		"bracket[dir]/main.go", "escaped{dir}/main.go",
	)
	h := New(NewPathGuard([]string{root}), 64*1024)
	for _, pattern := range []string{
		"**", "**/*", "**/*.go", "src/**", "src/**/*.go", "src/**/nested/**/*.go",
		"src/**.go", "[sp]rc/*.go", "{src,{pkg,tests}}/**/*.go",
		"src/{main.go,nested/**/*.go}", "src/{,nested/}*.go", "{**,src}/*.go",
		"src/[!x]*/**/*.go", "src[/]nested/*.go", "src[!x]nested/*.go",
		`src\/nested/*.go`, `bracket\[dir\]/*.go`, `escaped\{dir\}/*.go`,
		".hidden/**/*.go", "src/.hidden/*.go",
	} {
		t.Run(pattern, func(t *testing.T) {
			for _, dot := range []bool{false, true} {
				for _, includeDirs := range []bool{false, true} {
					// Small-fixture oracle uses full-pattern Match, independently of
					// the production pruning logic (never a production full-tree scan).
					want := []string{}
					err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
						if err != nil || path == root {
							return err
						}
						rel, err := filepath.Rel(root, path)
						if err != nil {
							return err
						}
						rel = filepath.ToSlash(rel)
						if !dot && hasDotSegment(rel) {
							return nil
						}
						matched, err := doublestar.Match(pattern, rel)
						if matched && (includeDirs || !entry.IsDir()) {
							want = append(want, rel)
						}
						return err
					})
					if err != nil {
						t.Fatal(err)
					}
					result, err := h.GlobContext(context.Background(), map[string]any{
						"cwd": root, "pattern": pattern, "dot": dot, "includeDirectories": includeDirs,
					})
					if err != nil {
						t.Fatal(err)
					}
					assertGlobMatches(t, result, want)
				}
			}
		})
	}
}

func TestGlobComplexTailKeepsPrefixPruningAndCancellation(t *testing.T) {
	root := t.TempDir()
	writeGlobFixture(t, root, "src/nested/file.go", "node_modules"+strings.Repeat("/deep", 64)+"/file.go")
	h := New(NewPathGuard([]string{root}), 4096)
	for _, pattern := range []string{"src/**/*.go", "src/[a-z]*/*.go", "src/{nested,other}/*.go", `src/\nested/*.go`} {
		t.Run(pattern, func(t *testing.T) {
			ctx := &checkingContext{Context: context.Background(), check: func(n int) error {
				if n > 25 {
					return context.Canceled
				}
				return nil
			}}
			result, err := h.GlobContext(ctx, map[string]any{"cwd": root, "pattern": pattern})
			if err != nil {
				t.Fatalf("complex tail lost safe prefix pruning: %v", err)
			}
			assertGlobMatches(t, result, []string{"src/nested/file.go"})
		})
	}
	ctx := &checkingContext{Context: context.Background(), check: func(n int) error {
		if n >= 12 {
			return context.Canceled
		}
		return nil
	}}
	if _, err := h.GlobContext(ctx, map[string]any{
		"cwd": root, "pattern": "node_modules/**/{missing,absent}.go",
	}); !errors.Is(err, context.Canceled) {
		t.Fatalf("conservative recursive tail ignored cancellation: %v", err)
	}
}

func TestGlobFixedPrefixDoesNotFollowDirectorySymlinks(t *testing.T) {
	root := t.TempDir()
	writeGlobFixture(t, root, "src/nested/file.go")
	requireSymlink(t, filepath.Join(root, "src"), filepath.Join(root, "linked"))
	h := New(NewPathGuard([]string{root}), 4096)
	for _, pattern := range []string{"linked/nested/*.go", "linked/**/*.go", "**/*.go", "./linked/nested/*.go", "././linked/**/*.go", "././**/*.go"} {
		result, err := h.GlobContext(context.Background(), map[string]any{"cwd": root, "pattern": pattern})
		if err != nil {
			t.Fatal(err)
		}
		want := []string{}
		if pattern == "**/*.go" || pattern == "././**/*.go" {
			want = append(want, "src/nested/file.go")
		}
		assertGlobMatches(t, result, want)
	}
}
