package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// One epoch per executor process, not per connection or filesystem path.
var editorRuntimeEpoch = func() string {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}()

func EditorRuntimeEpoch() string { return editorRuntimeEpoch }
func EditorPathFlavor() string {
	if runtime.GOOS == "windows" {
		return "windows"
	}
	return "posix"
}

// EditorRootIdentity binds the requested directory object, not directory contents.
// The serialized pair also lets the reader re-check this root without retaining a FD.
func (h *Handlers) EditorRootIdentity(root string) (string, string, error) {
	canonical, err := h.guard.CheckExisting(root)
	if err != nil {
		return "", "", err
	}
	info, err := os.Stat(canonical)
	if err != nil {
		return "", "", err
	}
	if !info.IsDir() {
		return "", "", fmt.Errorf("editor execution root must be a directory")
	}
	object, err := editorObjectIdentity(canonical, info)
	if err != nil {
		return "", "", err
	}
	encoded, err := json.Marshal([2]string{canonical, object})
	return canonical, string(encoded), err
}

func (h *Handlers) VerifyEditorRoot(identity string) error {
	var pair [2]string
	if err := json.Unmarshal([]byte(identity), &pair); err != nil {
		return fmt.Errorf("EDITOR_IDENTITY_CHANGED: invalid root identity")
	}
	_, current, err := h.EditorRootIdentity(pair[0])
	if err != nil {
		return fmt.Errorf("EDITOR_IDENTITY_CHANGED: %w", err)
	}
	if current != identity {
		return fmt.Errorf("EDITOR_IDENTITY_CHANGED: execution root replaced")
	}
	return nil
}

// OpenEditorReadFile reuses the guarded atomic read primitive, always activating
// its nonblocking FIFO-race protection and requiring an already canonical path.
func (h *Handlers) OpenEditorReadFile(path string) (*os.File, os.FileInfo, string, error) {
	if !filepath.IsAbs(path) {
		return nil, nil, "", fmt.Errorf("editor path must be absolute")
	}
	resolved, err := h.guard.CheckExisting(path)
	if err != nil {
		return nil, nil, "", err
	}
	if !samePath(resolved, path) {
		return nil, nil, "", fmt.Errorf("EDITOR_IDENTITY_CHANGED: editor path is not canonical")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, nil, "", err
	}
	if !info.Mode().IsRegular() {
		return nil, nil, "", fmt.Errorf("editor read requires a regular non-symlink file")
	}
	f, _, err := h.openReadFile(map[string]any{"path": path, "expectedResolvedPath": path})
	if err != nil {
		return nil, nil, "", err
	}
	info, err = f.Stat()
	if err == nil && !info.Mode().IsRegular() {
		err = fmt.Errorf("editor read requires a regular file")
	}
	var object string
	if err == nil {
		object, err = editorFileIdentity(f, info)
	}
	if err != nil {
		f.Close()
		return nil, nil, "", err
	}
	return f, info, object, nil
}

func (h *Handlers) VerifyEditorReadFile(path string, f *os.File, before os.FileInfo) error {
	resolved, err := h.guard.CheckExisting(path)
	if err != nil {
		return fmt.Errorf("EDITOR_IDENTITY_CHANGED: %w", err)
	}
	if !samePath(resolved, path) {
		return fmt.Errorf("EDITOR_IDENTITY_CHANGED: canonical path changed")
	}
	current, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("EDITOR_IDENTITY_CHANGED: %w", err)
	}
	opened, err := f.Stat()
	if err != nil {
		return err
	}
	if !current.Mode().IsRegular() || !os.SameFile(before, current) || !os.SameFile(before, opened) ||
		before.Size() != current.Size() || before.Size() != opened.Size() ||
		!before.ModTime().Equal(current.ModTime()) || !before.ModTime().Equal(opened.ModTime()) {
		return fmt.Errorf("EDITOR_IDENTITY_CHANGED: source changed")
	}
	return nil
}
