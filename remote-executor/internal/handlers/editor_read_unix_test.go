//go:build !windows

package handlers

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestEditorReadFIFOIsNonblocking(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "fifo")
	if err := syscall.Mkfifo(path, 0600); err != nil {
		t.Fatal(err)
	}
	h := New(NewPathGuard([]string{root}), 1024)
	done := make(chan error, 1)
	go func() {
		f, _, _, err := h.OpenEditorReadFile(path)
		if f != nil {
			f.Close()
		}
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("FIFO accepted")
		}
	case <-time.After(time.Second):
		t.Fatal("FIFO open blocked")
	}
	// Exercise the reused primitive's O_NONBLOCK path directly (the race after
	// regular-file lstat reaches this same open). No FIFO writer is present.
	f, _, err := h.openReadFile(map[string]any{"path": path, "expectedResolvedPath": path})
	if err == nil {
		defer f.Close()
		info, _ := f.Stat()
		if info.Mode()&os.ModeNamedPipe == 0 {
			t.Fatal("fixture is not FIFO")
		}
	}
}
