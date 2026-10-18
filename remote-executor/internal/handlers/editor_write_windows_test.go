//go:build windows

package handlers

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

// This exercises direct native stage/apply/query, not a Host runtime/IO adapter
// that could hide the native preflight behind its own observed-mode check.
func TestEditorWindowsReadOnlyPreflight(t *testing.T) {
	for _, when := range []string{"initial", "after-preparation"} {
		t.Run(when, func(t *testing.T) {
			f := newEditorFixture(t, []byte("before"))
			req := f.request(t, "readonly", []byte("before"), []byte("after"))
			path, err := windows.UTF16PtrFromString(f.path)
			if err != nil {
				t.Fatal(err)
			}
			attributes, err := windows.GetFileAttributes(path)
			if err != nil {
				t.Fatal(err)
			}
			setReadonly := func() error { return windows.SetFileAttributes(path, attributes|windows.FILE_ATTRIBUTE_READONLY) }
			t.Cleanup(func() { _ = windows.SetFileAttributes(path, attributes) })
			before, err := os.Stat(f.path)
			if err != nil {
				t.Fatal(err)
			}
			if when == "initial" {
				if err = setReadonly(); err != nil {
					t.Fatal(err)
				}
			}
			dispatched := 0
			f.e.fault = func(point string) error {
				if point == "prepared" && when == "after-preparation" {
					return setReadonly()
				}
				if point == "applying" {
					dispatched++
				}
				return nil
			}
			result := f.call(t, "editor.apply", req).(EditorApplyResult)
			if result.Outcome != "rejected" || result.Error == nil || result.Error.Code != "EDITOR_APPLY_REJECTED" || dispatched != 0 {
				t.Fatalf("read-only target crossed native dispatch boundary: %+v applying=%d", result, dispatched)
			}
			if q := f.query(t, req); q.Outcome != "rejected" {
				t.Fatal("known pre-dispatch rejection was not durable", q)
			}
			after, err := os.Stat(f.path)
			if err != nil || !os.SameFile(before, after) {
				t.Fatal("read-only original inode was replaced", err)
			}
			body, err := os.ReadFile(f.path)
			if err != nil || string(body) != "before" {
				t.Fatal("read-only original bytes changed", err)
			}
			files, err := filepath.Glob(filepath.Join(f.root, ".nf-editor-*"))
			if err != nil || len(files) != 0 {
				t.Fatal("pre-dispatch rejection leaked a preparation file", files, err)
			}
		})
	}
}
