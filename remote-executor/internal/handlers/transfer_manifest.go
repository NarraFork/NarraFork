package handlers

import (
	"encoding/json"
	"os"
	"sort"
)

// transferManifest is the resume state persisted next to an in-progress upload
// receive (.part) file. The fingerprint (chunkSize + fileSize) must match a new
// begin request for the resume to be honoured; otherwise we start fresh.
type transferManifest struct {
	ChunkSize       int64 `json:"chunkSize"`
	FileSize        int64 `json:"fileSize"`
	CompletedChunks []int `json:"completedChunks"`
}

func manifestPath(dst string) string { return dst + ".nfmeta" }

// loadManifest reads a resume manifest for dst. Returns nil when absent or when
// the fingerprint doesn't match (stale — caller starts fresh).
func loadManifest(dst string, chunkSize, fileSize int64) *transferManifest {
	data, err := os.ReadFile(manifestPath(dst))
	if err != nil {
		return nil
	}
	var m transferManifest
	if json.Unmarshal(data, &m) != nil {
		return nil
	}
	if m.ChunkSize != chunkSize || m.FileSize != fileSize {
		return nil
	}
	return &m
}

// saveManifest atomically persists the received-chunk set for dst.
func saveManifest(dst string, chunkSize, fileSize int64, received map[int]bool) {
	completed := make([]int, 0, len(received))
	for i := range received {
		completed = append(completed, i)
	}
	sort.Ints(completed)
	m := transferManifest{ChunkSize: chunkSize, FileSize: fileSize, CompletedChunks: completed}
	data, err := json.Marshal(m)
	if err != nil {
		return
	}
	tmp := manifestPath(dst) + ".tmp"
	if os.WriteFile(tmp, data, 0o644) == nil {
		_ = os.Rename(tmp, manifestPath(dst))
	}
}

func removeManifest(dst string) {
	_ = os.Remove(manifestPath(dst))
}
