package handlers

import (
	"encoding/json"
	"os"
	"sort"
)

const transferManifestVersion = 2

type transferContentIdentity struct {
	Algorithm string `json:"algorithm"`
	Digest    string `json:"digest"`
}

// transferManifest is the v2 resume state persisted next to an in-progress
// upload receive file. Resume is safe only when all content fingerprints match.
type transferManifest struct {
	Version         int                     `json:"version"`
	ChunkSize       int64                   `json:"chunkSize"`
	FileSize        int64                   `json:"fileSize"`
	ContentIdentity transferContentIdentity `json:"contentIdentity"`
	CompletedChunks []int                   `json:"completedChunks"`
}

func contentIdentityParam(params map[string]any) transferContentIdentity {
	raw, ok := params["contentIdentity"].(map[string]any)
	if !ok {
		return transferContentIdentity{}
	}
	algorithm, _ := raw["algorithm"].(string)
	digest, _ := raw["digest"].(string)
	return transferContentIdentity{Algorithm: algorithm, Digest: digest}
}

func (identity transferContentIdentity) valid() bool {
	return identity.Algorithm == "sha256" && len(identity.Digest) == 64
}

// loadManifest accepts only a strict v2 manifest with a matching content identity.
func loadManifest(
	path string,
	chunkSize, fileSize int64,
	identity transferContentIdentity,
) *transferManifest {
	if !identity.valid() {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var m transferManifest
	if json.Unmarshal(data, &m) != nil {
		return nil
	}
	if m.Version != transferManifestVersion ||
		m.ChunkSize != chunkSize ||
		m.FileSize != fileSize ||
		m.ContentIdentity != identity {
		return nil
	}
	return &m
}

// saveManifest atomically persists the received-chunk set to validated paths.
func saveManifest(
	path, tmp string,
	chunkSize, fileSize int64,
	identity transferContentIdentity,
	received map[int]bool,
) {
	if !identity.valid() {
		return
	}
	completed := make([]int, 0, len(received))
	for i := range received {
		completed = append(completed, i)
	}
	sort.Ints(completed)
	m := transferManifest{
		Version:         transferManifestVersion,
		ChunkSize:       chunkSize,
		FileSize:        fileSize,
		ContentIdentity: identity,
		CompletedChunks: completed,
	}
	data, err := json.Marshal(m)
	if err != nil {
		return
	}
	if os.WriteFile(tmp, data, 0o644) == nil {
		_ = os.Rename(tmp, path)
	}
}

func removeManifest(path string) {
	_ = os.Remove(path)
}
