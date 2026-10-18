package rpc

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/narrafork/remote-executor/internal/handlers"
)

func editorFixture(t *testing.T) (*Dispatcher, EditorRawReadPreflight) {
	t.Helper()
	root := t.TempDir()
	path := filepath.Join(root, "source.txt")
	if err := os.WriteFile(path, []byte("hello\x00world\r\n"), 0600); err != nil {
		t.Fatal(err)
	}
	h := handlers.New(handlers.NewPathGuard([]string{root}), 1024)
	rootPath, rootID, err := h.EditorRootIdentity(root)
	if err != nil {
		t.Fatal(err)
	}
	d := NewDispatcher(h)
	t.Cleanup(d.CloseEditorReads)
	return d, EditorRawReadPreflight{ResourceKey: "authorized", MaxBytes: editorReadMaxBytes, TimeoutMs: 30000,
		Identity: EditorResourceIdentity{DeviceID: "device", PathFlavor: handlers.EditorPathFlavor(), CanonicalPath: filepath.Join(rootPath, filepath.Base(path)), WorkspaceIdentity: rootID, RuntimeEpoch: handlers.EditorRuntimeEpoch(), RuntimeGeneration: 1, FencingToken: 1}}
}

func editorOpen(t *testing.T, d *Dispatcher, req EditorRawReadPreflight) EditorRawReadOpen {
	t.Helper()
	result, err := d.editorReads.open(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	return result.(EditorRawReadOpen)
}

func editorAssertClosed(t *testing.T, d *Dispatcher, r *editorRead) {
	t.Helper()
	d.editorReads.mu.Lock()
	count := len(d.editorReads.reads)
	d.editorReads.mu.Unlock()
	if count != 0 {
		t.Fatalf("%d leaked handles", count)
	}
	if _, err := r.file.Stat(); err == nil {
		t.Fatal("read FD remains open")
	}
}

func editorHandle(d *Dispatcher, id string) *editorRead {
	d.editorReads.mu.Lock()
	defer d.editorReads.mu.Unlock()
	return d.editorReads.reads[id]
}

func TestEditorReadPullAndStableGeneration(t *testing.T) {
	d, req := editorFixture(t)
	a := editorOpen(t, d, req)
	b := editorOpen(t, d, req)
	if a.ReadID == b.ReadID || a.SourceGeneration != b.SourceGeneration {
		t.Fatal("unstable source generation or reused read ID")
	}
	d.editorReads.closeRead(EditorRawReadClose{ReadID: b.ReadID})
	r := editorHandle(d, a.ReadID)
	if pos, _ := r.file.Seek(0, 1); pos != 0 || r.offset != 0 {
		t.Fatal("preflight did not rewind/pull read ahead")
	}
	var got []byte
	for offset := int64(0); ; {
		result, err := d.editorReads.chunk(context.Background(), EditorRawReadChunkRequest{ReadID: a.ReadID, Offset: offset, MaxBytes: 1, TimeoutMs: 1000})
		if err != nil {
			t.Fatal(err)
		}
		chunk := result.(EditorRawReadChunk)
		data, err := base64.StdEncoding.DecodeString(chunk.DataB64)
		if err != nil || len(data) > 1 || chunk.ReadID != a.ReadID || chunk.SourceGeneration != a.SourceGeneration || chunk.Offset != offset {
			t.Fatalf("invalid chunk: %+v", chunk)
		}
		got = append(got, data...)
		offset += chunk.Bytes
		if chunk.EOF {
			break
		}
	}
	want, _ := os.ReadFile(req.Identity.CanonicalPath)
	sum := sha256.Sum256(got)
	if !bytes.Equal(got, want) || hex.EncodeToString(sum[:]) != a.RawDigest || int64(len(got)) != a.TotalBytes {
		t.Fatal("raw bytes/digest mismatch")
	}
	editorAssertClosed(t, d, r)
	d.editorReads.closeRead(EditorRawReadClose{ReadID: a.ReadID})
	d.editorReads.closeRead(EditorRawReadClose{ReadID: a.ReadID, Abort: true})
}

func TestEditorReadUndeliveredAndCancelledPullRelease(t *testing.T) {
	for _, mode := range []string{"open result", "chunk result", "queued cancel", "malformed pull"} {
		t.Run(mode, func(t *testing.T) {
			d, req := editorFixture(t)
			opened := editorOpen(t, d, req)
			r := editorHandle(d, opened.ReadID)
			switch mode {
			case "open result":
				d.DiscardEditorRead(opened)
			case "chunk result":
				chunk, err := d.editorReads.chunk(context.Background(), EditorRawReadChunkRequest{ReadID: opened.ReadID, MaxBytes: 1, TimeoutMs: 1000})
				if err != nil {
					t.Fatal(err)
				}
				d.DiscardEditorRead(chunk)
			case "queued cancel":
				d.CancelEditorRead("editor.read.chunk", map[string]any{"readId": opened.ReadID})
			case "malformed pull":
				_, err := d.Dispatch(context.Background(), "editor.read.chunk", map[string]any{"readId": opened.ReadID, "offset": 0.5, "maxBytes": 1, "timeoutMs": 1000}, nil)
				if err == nil {
					t.Fatal("fractional offset accepted")
				}
			}
			editorAssertClosed(t, d, r)
		})
	}
}

func TestEditorReadRejectsInvalidPullAndReleases(t *testing.T) {
	for _, test := range []struct {
		name                    string
		offset, credit, timeout int64
	}{
		{"offset", 1, 1, 1000}, {"negative offset", -1, 1, 1000}, {"no credit", 0, 0, 1000}, {"excess credit", 0, 65537, 1000}, {"deadline", 0, 1, 30001},
	} {
		t.Run(test.name, func(t *testing.T) {
			d, req := editorFixture(t)
			opened := editorOpen(t, d, req)
			r := editorHandle(d, opened.ReadID)
			_, err := d.editorReads.chunk(context.Background(), EditorRawReadChunkRequest{ReadID: opened.ReadID, Offset: test.offset, MaxBytes: test.credit, TimeoutMs: test.timeout})
			if err == nil {
				t.Fatal("accepted invalid pull")
			}
			editorAssertClosed(t, d, r)
		})
	}
}

func TestEditorReadConnectionOwnershipAndCapacity(t *testing.T) {
	d, req := editorFixture(t)
	other := NewDispatcher(d.h.ConnectionScoped())
	defer other.CloseEditorReads()
	a := editorOpen(t, d, req)
	if _, err := other.editorReads.chunk(context.Background(), EditorRawReadChunkRequest{ReadID: a.ReadID, MaxBytes: 1, TimeoutMs: 1000}); err == nil {
		t.Fatal("cross-connection read succeeded")
	}
	other.editorReads.closeRead(EditorRawReadClose{ReadID: a.ReadID})
	if editorHandle(d, a.ReadID) == nil {
		t.Fatal("cross-connection close removed owner handle")
	}
	for i := 1; i < cap(editorReadSlots); i++ {
		editorOpen(t, d, req)
	}
	if _, err := other.editorReads.open(context.Background(), req); err == nil {
		t.Fatal("global stream capacity not enforced")
	}
	d.CloseEditorReads()
	if len(editorReadSlots) != 0 {
		t.Fatal("permits leaked")
	}
	if _, err := d.editorReads.open(context.Background(), req); err == nil {
		t.Fatal("open after connection closed")
	}
}

func TestEditorReadIdleDeadlineAndCancellation(t *testing.T) {
	for _, mode := range []string{"idle", "deadline", "cancel", "close"} {
		t.Run(mode, func(t *testing.T) {
			d, req := editorFixture(t)
			if mode == "idle" {
				d.editorReads.idle = 15 * time.Millisecond
			}
			if mode == "deadline" {
				req.TimeoutMs = 20
			}
			a := editorOpen(t, d, req)
			r := editorHandle(d, a.ReadID)
			switch mode {
			case "cancel":
				ctx, cancel := context.WithCancel(context.Background())
				cancel()
				if _, err := d.editorReads.chunk(ctx, EditorRawReadChunkRequest{ReadID: a.ReadID, MaxBytes: 1, TimeoutMs: 1000}); err == nil {
					t.Fatal("cancel ignored")
				}
			case "close":
				d.CloseEditorReads()
			default:
				select {
				case <-r.ctx.Done():
				case <-time.After(time.Second):
					t.Fatal("stream timeout did not cancel")
				}
				// Cancellation starts cleanup asynchronously. Synchronize with its once.
				d.editorReads.remove(r)
			}
			editorAssertClosed(t, d, r)
		})
	}
	d, req := editorFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := d.editorReads.open(ctx, req); err == nil {
		t.Fatal("cancelled preflight accepted")
	}
	if len(editorReadSlots) != 0 {
		t.Fatal("cancelled preflight leaked permit")
	}
}

func TestEditorReadDetectsRewriteOfAlreadyDeliveredBytes(t *testing.T) {
	d, req := editorFixture(t)
	opened := editorOpen(t, d, req)
	r := editorHandle(d, opened.ReadID)
	_, err := d.editorReads.chunk(context.Background(), EditorRawReadChunkRequest{ReadID: opened.ReadID, MaxBytes: 1, TimeoutMs: 1000})
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(req.Identity.CanonicalPath, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteAt([]byte("H"), 0); err != nil {
		t.Fatal(err)
	}
	f.Close()
	if err := os.Chtimes(req.Identity.CanonicalPath, r.info.ModTime(), r.info.ModTime()); err != nil {
		t.Fatal(err)
	}
	_, err = d.editorReads.chunk(context.Background(), EditorRawReadChunkRequest{ReadID: opened.ReadID, Offset: 1, MaxBytes: 65536, TimeoutMs: 1000})
	if err == nil {
		t.Fatal("EOF accepted a rewrite of already delivered bytes")
	}
	editorAssertClosed(t, d, r)
}

func TestEditorReadConcurrentPullDoesNotQueue(t *testing.T) {
	d, req := editorFixture(t)
	opened := editorOpen(t, d, req)
	r := editorHandle(d, opened.ReadID)
	r.gate <- struct{}{}
	_, err := d.editorReads.chunk(context.Background(), EditorRawReadChunkRequest{ReadID: opened.ReadID, MaxBytes: 1, TimeoutMs: 1000})
	<-r.gate
	if err == nil || !strings.Contains(err.Error(), "active pull") {
		t.Fatal("concurrent pull queued or succeeded", err)
	}
	editorAssertClosed(t, d, r)
}

func TestEditorReadSourceAndRootReplacement(t *testing.T) {
	for _, mode := range []string{"file", "hidden rewrite", "root"} {
		t.Run(mode, func(t *testing.T) {
			d, req := editorFixture(t)
			a := editorOpen(t, d, req)
			r := editorHandle(d, a.ReadID)
			path := req.Identity.CanonicalPath
			switch mode {
			case "file":
				if err := os.Rename(path, path+".old"); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte("hello\x00world\r\n"), 0600); err != nil {
					t.Fatal(err)
				}
			case "hidden rewrite":
				if err := os.WriteFile(path, []byte("HELLO\x00world\r\n"), 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Chtimes(path, r.info.ModTime(), r.info.ModTime()); err != nil {
					t.Fatal(err)
				}
			case "root":
				root := filepath.Dir(path)
				if err := os.Rename(root, root+".old"); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { os.RemoveAll(root + ".old") })
				if err := os.Mkdir(root, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte("hello\x00world\r\n"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			_, err := d.editorReads.chunk(context.Background(), EditorRawReadChunkRequest{ReadID: a.ReadID, MaxBytes: 65536, TimeoutMs: 1000})
			if err == nil {
				t.Fatal("changed source published EOF")
			}
			editorAssertClosed(t, d, r)
		})
	}
}

func TestEditorReadAllowedFileOutsideExecutionRoot(t *testing.T) {
	d, req := editorFixture(t)
	outside := t.TempDir()
	path := filepath.Join(outside, "authorized")
	if err := os.WriteFile(path, []byte("allowed outside cwd"), 0600); err != nil {
		t.Fatal(err)
	}
	var pair [2]string
	if err := json.Unmarshal([]byte(req.Identity.WorkspaceIdentity), &pair); err != nil {
		t.Fatal(err)
	}
	other := NewDispatcher(handlers.New(handlers.NewPathGuard([]string{pair[0], outside}), 1024))
	defer other.CloseEditorReads()
	req.Identity.CanonicalPath = path
	opened := editorOpen(t, other, req)
	if opened.TotalBytes != 19 {
		t.Fatal("wrong outside-root source size", opened.TotalBytes)
	}
	d.CloseEditorReads()
}

func TestEditorReadMaxFileBudget(t *testing.T) {
	d, req := editorFixture(t)
	if err := os.Truncate(req.Identity.CanonicalPath, editorReadMaxBytes+1); err != nil {
		t.Fatal(err)
	}
	if _, err := d.editorReads.open(context.Background(), req); err == nil {
		t.Fatal("oversized file accepted")
	}
	if len(editorReadSlots) != 0 {
		t.Fatal("oversized file leaked slot")
	}
}

func TestEditorReadBindingAndOpenLimits(t *testing.T) {
	for _, mode := range []string{"epoch", "flavor", "root", "size", "timeout", "missing resource", "relative", "fractional"} {
		t.Run(mode, func(t *testing.T) {
			d, req := editorFixture(t)
			switch mode {
			case "epoch":
				req.Identity.RuntimeEpoch = "stale"
			case "flavor":
				req.Identity.PathFlavor = "other"
			case "root":
				req.Identity.WorkspaceIdentity = "[]"
			case "size":
				req.MaxBytes = 1
			case "timeout":
				req.TimeoutMs = 30001
			case "missing resource":
				req.ResourceKey = ""
			case "relative":
				req.Identity.CanonicalPath = "source.txt"
			}
			var err error
			if mode == "fractional" {
				data, _ := json.Marshal(req)
				var params map[string]any
				json.Unmarshal(data, &params)
				params["maxBytes"] = 1.5
				_, err = d.Dispatch(context.Background(), "editor.read.open", params, nil)
			} else {
				_, err = d.editorReads.open(context.Background(), req)
			}
			if err == nil {
				t.Fatal("invalid preflight accepted")
			}
			if len(editorReadSlots) != 0 {
				t.Fatal("rejected open leaked permit")
			}
		})
	}
	d, req := editorFixture(t)
	editorOpen(t, d, req)
	req.Identity.FencingToken++
	if _, err := d.editorReads.open(context.Background(), req); err == nil || !strings.Contains(err.Error(), "EDITOR_FENCING_REJECTED") {
		t.Fatal("fencing change accepted", err)
	}
}
