package history

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestChunkStageIsPersistentIdempotentAndSourceQualified(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "workspace")
	store := filepath.Join(parent, "private")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	m, err := New(store, func(path string, create bool) (string, error) { return path, nil })
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	b, err := m.Open(context.Background(), root, "real-stage-scope", 1)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	bytes := make([]byte, 3<<20)
	for i := range bytes {
		bytes[i] = byte(i % 251)
	}
	digest := hash(bytes)
	object := Object{SourceInstanceID: b.SourceInstanceID, WorkspaceInstanceID: b.WorkspaceInstanceID, ScopeID: b.ScopeID, Path: "file.txt", Kind: "blob", Algorithm: "sha256", Digest: digest, ObjectID: objectID(b.ScopeID, "blob", "file.txt", digest), SizeBytes: int64(len(bytes))}
	req := ObjectStageRequest{Binding: b, StageID: "stage", RequestDigest: key("stage"), Object: object, Operation: "begin"}
	if _, err := m.StageObject(ctx, req); err != nil {
		t.Fatal(err)
	}
	for offset := 0; offset < len(bytes); offset += int(ChunkBytes) {
		part := bytes[offset : offset+int(ChunkBytes)]
		req.Operation = "append"
		req.Offset = int64(offset)
		req.ContentBase64 = base64.StdEncoding.EncodeToString(part)
		req.ChunkDigest = hash(part)
		r, err := m.StageObject(ctx, req)
		if err != nil || r.Written != int64(offset+len(part)) {
			t.Fatal("append", err)
		}
		if _, err := m.StageObject(ctx, req); err != nil {
			t.Fatal("append retry", err)
		}
	}
	m.Close()
	reopened, err := New(store, func(path string, create bool) (string, error) { return path, nil })
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	req.Operation = "finish"
	req.ContentBase64 = ""
	status, err := reopened.StageObject(ctx, req)
	if err != nil || status.State != "ready" {
		t.Fatal("finish after restart", err)
	}
	objectData, err := reopened.objectBytes(b, object)
	if err != nil || hash(objectData) != digest {
		t.Fatal("actual complete object missing", err)
	}
	req.RequestDigest = key("different")
	if _, err := reopened.StageObject(ctx, req); err == nil {
		t.Fatal("stage ID digest reuse accepted")
	}
}

func TestChunkStageUnknownSuffixIsNotTruncatedOrGCed(t *testing.T) {
	m, b, _, _ := fixture(t)
	ctx := context.Background()
	obj := *desired(b, "one").Object
	req := ObjectStageRequest{Binding: b, StageID: "unknown", RequestDigest: key("unknown"), Object: obj, Operation: "begin"}
	if _, err := m.StageObject(ctx, req); err != nil {
		t.Fatal(err)
	}
	identity := key(b.ScopeID + "\x00" + req.StageID)
	path := filepath.Join(m.dir, "staging", identity+".part")
	os.WriteFile(path, []byte("unacknowledged"), 0600)
	req.Operation = "append"
	req.ContentBase64 = base64.StdEncoding.EncodeToString([]byte("one"))
	req.ChunkDigest = hash([]byte("one"))
	status, err := m.StageObject(ctx, req)
	if err == nil || status.State != "unknown" {
		t.Fatal("unknown suffix was replayed")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "unacknowledged" {
		t.Fatal("unknown evidence deleted/truncated")
	}
}
