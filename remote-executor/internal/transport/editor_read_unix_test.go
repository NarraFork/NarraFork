//go:build !windows

package transport

import (
	"path/filepath"
	"syscall"
	"testing"
)

func TestEditorReadFIFOLoopback(t *testing.T) {
	peer, ctx, params, root := newEditorReadLoopback(t)
	path := filepath.Join(root, "fifo")
	if err := syscall.Mkfifo(path, 0600); err != nil {
		t.Fatal(err)
	}
	params["identity"].(map[string]any)["canonicalPath"] = path
	result, _, err := peer.call(ctx, "fifo", "editor.read.open", params)
	if err != nil || result.OK {
		t.Fatalf("FIFO read did not reject promptly: %v %+v", err, result)
	}
}
