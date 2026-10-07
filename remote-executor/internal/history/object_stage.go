package history

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

type ObjectStageRequest struct {
	Binding       Binding `json:"binding"`
	Operation     string  `json:"operation"`
	StageID       string  `json:"stageId"`
	RequestDigest string  `json:"requestDigest"`
	Object        Object  `json:"object"`
	Offset        int64   `json:"offset,omitempty"`
	ContentBase64 string  `json:"contentBase64,omitempty"`
	ChunkDigest   string  `json:"chunkDigest,omitempty"`
}
type ObjectStageStatus struct {
	StageID       string           `json:"stageId"`
	Binding       Binding          `json:"binding"`
	RequestDigest string           `json:"requestDigest"`
	Object        Object           `json:"object"`
	Written       int64            `json:"written"`
	State         string           `json:"state"`
	Chunks        map[int64]string `json:"chunks,omitempty"`
}

func (m *Manager) StageObject(ctx context.Context, request ObjectStageRequest) (*ObjectStageStatus, error) {
	if err := m.acquire(ctx); err != nil {
		return nil, err
	}
	defer m.release()
	if err := m.validate(request.Binding); err != nil {
		return nil, err
	}
	if request.StageID == "" || len(request.StageID) > 256 || !validDigest(request.RequestDigest) {
		return nil, fmt.Errorf("invalid stage identity")
	}
	object := request.Object
	if object.Kind != "blob" || object.SourceInstanceID != request.Binding.SourceInstanceID || object.WorkspaceInstanceID != request.Binding.WorkspaceInstanceID || object.ScopeID != request.Binding.ScopeID || object.ObjectID != objectID(object.ScopeID, object.Kind, object.Path, object.Digest) || !validDigest(object.Digest) || object.SizeBytes < 0 || object.SizeBytes > BlobBytes {
		return nil, fmt.Errorf("stage object source/size mismatch")
	}
	if _, err := m.target(request.Binding, object.Path); err != nil {
		return nil, err
	}
	dir := filepath.Join(m.dir, "staging")
	if err := rejectSymlinkAncestors(dir); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	identity := key(request.Binding.ScopeID + "\x00" + request.StageID)
	recordPath := filepath.Join(dir, identity+".json")
	dataPath := filepath.Join(dir, identity+".part")
	m.objectMu.Lock()
	objectLocked := true
	defer func() {
		if objectLocked {
			m.objectMu.Unlock()
		}
	}()
	var status ObjectStageStatus

	raw, err := readPrivate(recordPath, 64<<10)
	if os.IsNotExist(err) {
		if request.Operation != "begin" {
			return nil, fmt.Errorf("stage not found")
		}
		if err := m.admission(object.SizeBytes); err != nil {
			return nil, err
		}
		file, err := os.OpenFile(dataPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return nil, err
		}
		file.Sync()
		file.Close()
		status = ObjectStageStatus{StageID: request.StageID, Binding: request.Binding, RequestDigest: request.RequestDigest, Object: object, State: "pending", Chunks: map[int64]string{}}
	} else {
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, &status); err != nil {
			return nil, err
		}
		if status.Binding != request.Binding || status.RequestDigest != request.RequestDigest || status.Object != object || status.StageID != request.StageID {
			return nil, fmt.Errorf("stage digest/binding conflict")
		}
	}
	if status.Chunks == nil {
		status.Chunks = map[int64]string{}
	}
	save := func() error {
		data, _ := json.Marshal(status)
		if len(data) > 64<<10 {
			return fmt.Errorf("stage metadata budget")
		}
		return writePrivate(recordPath, data)
	}
	if status.State == "ready" {
		return &status, nil
	}
	switch request.Operation {
	case "begin", "status":
		if request.Operation == "begin" {
			if err := save(); err != nil {
				return nil, err
			}
		}
		return &status, nil
	case "append":
		if status.State != "pending" {
			return &status, fmt.Errorf("stage reconciliation required")
		}
		if len(request.ContentBase64) > int(ChunkBytes+2)/3*4+4 || !validDigest(request.ChunkDigest) {
			return nil, fmt.Errorf("stage chunk budget/digest")
		}
		data, err := base64.StdEncoding.DecodeString(request.ContentBase64)
		if err != nil || int64(len(data)) > ChunkBytes || hash(data) != request.ChunkDigest {
			return nil, fmt.Errorf("stage chunk integrity mismatch")
		}
		if request.Offset < status.Written {
			if status.Chunks[request.Offset] != request.ChunkDigest {
				return nil, fmt.Errorf("stage chunk retry conflict")
			}
			return &status, nil
		}
		if request.Offset != status.Written || status.Written+int64(len(data)) > object.SizeBytes {
			return nil, fmt.Errorf("stage offset/size conflict")
		}
		file, err := os.OpenFile(dataPath, os.O_WRONLY, 0600)
		if err != nil {
			return nil, err
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil {
			return nil, err
		}
		if info.Size() != status.Written {
			status.State = "unknown"
			save()
			return &status, fmt.Errorf("stage disk offset unknown; retained")
		}
		if err := m.admission(int64(len(data))); err != nil {
			return nil, err
		}
		if _, err := file.WriteAt(data, status.Written); err != nil {
			status.State = "unknown"
			save()
			return &status, err
		}
		if err := file.Sync(); err != nil {
			status.State = "unknown"
			save()
			return &status, err
		}
		status.Chunks[status.Written] = request.ChunkDigest
		status.Written += int64(len(data))
		m.bytes += int64(len(data))
		if err := save(); err != nil {
			return &status, err
		}
		return &status, nil
	case "finish":
		if status.State != "pending" || status.Written != object.SizeBytes {
			return &status, fmt.Errorf("stage is incomplete")
		}
		data, err := readPrivate(dataPath, BlobBytes)
		if err != nil {
			return nil, err
		}
		if int64(len(data)) != object.SizeBytes || hash(data) != object.Digest {
			return nil, fmt.Errorf("staged complete digest mismatch")
		}
		m.objectMu.Unlock()
		objectLocked = false
		published, err := m.putObject(request.Binding, data, "blob", object.Path)
		if err != nil {
			return nil, err
		}
		m.objectMu.Lock()
		objectLocked = true
		if *published != object {
			return nil, fmt.Errorf("stage publication mismatch")
		}
		status.State = "ready"
		if err := save(); err != nil {
			return &status, err
		}
		// The completed part can be reclaimed; pending/unknown material is never
		// truncated or deleted. Verify exact bytes before removing this owned file.
		current, err := readPrivate(dataPath, BlobBytes)
		if err == nil && bytes.Equal(current, data) {
			os.Remove(dataPath)
			m.bytes -= int64(len(data))
		}
		return &status, nil
	default:
		return nil, fmt.Errorf("unknown object stage operation")
	}
}
