package rpc

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/narrafork/remote-executor/internal/handlers"
)

func TestDispatchFileMutationPassesCancellation(t *testing.T) {
	for _, method := range []string{"fs.write", "fs.remove"} {
		t.Run(method, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "file")
			if err := os.WriteFile(path, []byte("before"), 0600); err != nil {
				t.Fatal(err)
			}
			d := NewDispatcher(handlers.New(handlers.NewPathGuard([]string{root}), 4000000))
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			params := map[string]any{"path": path, "dataB64": base64.StdEncoding.EncodeToString([]byte("after"))}
			if _, err := d.Dispatch(ctx, method, params, nil); !errors.Is(err, context.Canceled) {
				t.Fatalf("dispatch discarded cancellation: %v", err)
			}
			data, err := os.ReadFile(path)
			if err != nil || string(data) != "before" {
				t.Fatal("cancelled dispatch altered original")
			}
		})
	}
}
