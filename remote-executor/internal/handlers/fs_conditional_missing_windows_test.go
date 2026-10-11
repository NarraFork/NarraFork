//go:build windows

package handlers

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestWindowsConditionalMissingRejectsReplacedOriginalParent(t *testing.T) {
	root := nativePathFixture(t)
	parent := filepath.Join(root, "parent")
	if err := os.Mkdir(parent, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(parent, "target")
	h := New(NewPathGuard([]string{root}), 4000000)
	frozen := resolveNativeFixture(t, path)
	p := conditionalParams(path, nil, "new")
	p["expectedNativeDescriptor"] = frozen.NativeDescriptor
	if err := os.Rename(parent, filepath.Join(root, "old-parent")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(parent, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := h.FsWriteConditional(context.Background(), p); err == nil {
		t.Fatal("old missing evidence authorized replacement parent (old implementation created target)")
	}
	for _, dir := range []string{parent, filepath.Join(root, "old-parent")} {
		entries, err := os.ReadDir(dir)
		if err != nil || len(entries) != 0 {
			t.Fatal("target/temp written on rejected parent", err, entries)
		}
	}
}

func TestWindowsConditionalMissingCreatePinsThroughPublication(t *testing.T) {
	for _, mode := range []string{"success", "occupant", "failure", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			root := nativePathFixture(t)
			parent := filepath.Join(root, "parent")
			if err := os.Mkdir(parent, 0700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(parent, "target")
			h := New(NewPathGuard([]string{root}), 4000000)
			frozen := resolveNativeFixture(t, path)
			p := conditionalParams(path, nil, "new")
			p["expectedNativeDescriptor"] = frozen.NativeDescriptor
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			original := conditionalRenameHandle
			defer func() { conditionalRenameHandle = original }()
			calls := 0
			conditionalRenameHandle = func(file *os.File, target string) error {
				calls++
				if err := os.Rename(parent, filepath.Join(root, "moved")); err == nil {
					t.Fatal("parent was not pinned at publication")
				}
				switch mode {
				case "occupant":
					if err := os.WriteFile(path, []byte("foreign"), 0600); err != nil {
						t.Fatal(err)
					}
				case "failure":
					return fmt.Errorf("injected publication failure")
				case "cancel":
					cancel()
					return ctx.Err()
				}
				return original(file, target)
			}
			result, err := h.FsWriteConditional(ctx, p)
			if calls != 1 {
				t.Fatalf("native dispatch count=%d err=%v", calls, err)
			}
			if mode == "success" {
				if err != nil || result.(map[string]any)["applied"] != true {
					t.Fatal(result, err)
				}
			}
			if mode == "occupant" {
				data, e := os.ReadFile(path)
				if e != nil || string(data) != "foreign" {
					t.Fatal("occupant overwritten", e)
				}
				if err == nil && result.(map[string]any)["applied"] == true {
					t.Fatal("occupied create applied")
				}
			}
			if mode == "failure" || mode == "cancel" {
				if err == nil {
					t.Fatal("failure accepted")
				}
				if _, e := os.Lstat(path); !os.IsNotExist(e) {
					t.Fatal("failed create left target", e)
				}
			}
			temps, _ := filepath.Glob(filepath.Join(parent, ".nf-conditional-*"))
			if len(temps) != 0 {
				t.Fatal("temp cleanup failed", temps)
			}
			if err := os.Rename(parent, filepath.Join(root, "released")); err != nil {
				t.Fatal("parent pin leaked", err)
			}
		})
	}
}

func TestWindowsConditionalMissingPinRejectsMalformedAndCancellation(t *testing.T) {
	root := nativePathFixture(t)
	parent := filepath.Join(root, "parent")
	if err := os.Mkdir(parent, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(parent, "target")
	h := New(NewPathGuard([]string{root}), 4000000)
	p := conditionalParams(path, nil, "new")
	p["expectedNativeDescriptor"] = resolveNativeFixture(t, path).NativeDescriptor
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := h.PinConditionalMissingParentV2(ctx, p, path); err == nil {
		t.Fatal("cancelled pin accepted")
	}
	multiple := filepath.Join(parent, "missing", "target")
	p = conditionalParams(multiple, nil, "new")
	p["expectedNativeDescriptor"] = resolveNativeFixture(t, multiple).NativeDescriptor
	if _, err := h.FsWriteConditional(context.Background(), p); err == nil {
		t.Fatal("multiple missing suffix accepted")
	}
	p = conditionalParams(parent, nil, "new")
	p["expectedNativeDescriptor"] = resolveNativeFixture(t, parent).NativeDescriptor
	if _, err := h.FsWriteConditional(context.Background(), p); err == nil {
		t.Fatal("existing object masqueraded as missing")
	}
	entries, err := os.ReadDir(parent)
	if err != nil || len(entries) != 0 {
		t.Fatal("invalid missing shape wrote a target/temp", err, entries)
	}
	if err := os.Rename(parent, filepath.Join(root, "released")); err != nil {
		t.Fatal("failed pin leaked", err)
	}
}
