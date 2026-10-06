package handlers

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFileMutationCancelledWhileQueued(t *testing.T) {
	for _, method := range []string{"write", "remove", "conditional"} {
		t.Run(method, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "file")
			if err := os.WriteFile(path, []byte("before"), 0600); err != nil {
				t.Fatal(err)
			}
			h := New(NewPathGuard([]string{root}), 4000000)
			release, err := acquireFileMutation(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			defer release()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			result := make(chan error, 1)
			started := make(chan struct{})
			go func() {
				close(started)
				p := map[string]any{"path": path, "dataB64": base64.StdEncoding.EncodeToString([]byte("after"))}
				var err error
				switch method {
				case "write":
					_, err = h.FsWriteContext(ctx, p)
				case "remove":
					_, err = h.FsRemoveContext(ctx, p)
				case "conditional":
					_, err = h.FsWriteConditional(ctx, conditionalParams(path, "before", "after"))
				}
				result <- err
			}()
			<-started
			cancel()
			select {
			case err := <-result:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("got %v", err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("cancelled mutation remained blocked on gate")
			}
			data, err := os.ReadFile(path)
			if err != nil || string(data) != "before" {
				t.Fatalf("cancelled mutation altered original: %q %v", data, err)
			}
		})
	}
}

func TestAcquireFileMutationAlreadyCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for i := 0; i < 100; i++ {
		release, err := acquireFileMutation(ctx)
		if release != nil {
			release()
			t.Fatal("cancelled context acquired gate")
		}
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("got %v", err)
		}
	}
}

func TestConditionalWriteTimeoutWhileQueued(t *testing.T) {
	release, err := acquireFileMutation(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	root := t.TempDir()
	path := filepath.Join(root, "file")
	h := New(NewPathGuard([]string{root}), 4000000)
	p := conditionalParams(path, nil, "after")
	p["timeoutMs"] = 1
	if _, err := h.FsWriteConditional(context.Background(), p); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("got %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("timed out write created file")
	}
	for _, timeout := range []int{0, -1, 30001} {
		p["timeoutMs"] = timeout
		if _, err := h.FsWriteConditional(context.Background(), p); err == nil {
			t.Fatal("invalid timeout accepted")
		}
	}
}
