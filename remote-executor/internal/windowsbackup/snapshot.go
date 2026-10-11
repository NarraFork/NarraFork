// Package windowsbackup implements bounded, identity-bound native metadata IO.
// Metadata is not an authorization token. Privileged helper restoration must use
// its own durable capture record, never a client-supplied Snapshot.
package windowsbackup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
)

const (
	MatrixVersion = 2
	MetadataBytes = 512 << 10
	EABytes       = 64 << 10
	StreamCount   = 64
	StreamBytes   = 32 << 20
	QueueSize     = 64
	Workers       = 2
)

var ErrHelperRequired = errors.New("windows_full_metadata_helper_required")
var ErrIncomplete = errors.New("windows_native_metadata_incomplete")

// BlobStore is a private immutable bounded CAS, not the public workspace.
// Put must fsync before returning; Get must verify digest and enforce size.
type BlobStore interface {
	Put(context.Context, []byte) (string, error)
	Get(context.Context, string, int64) ([]byte, error)
}
type blobKey struct{}

func WithBlobs(ctx context.Context, store BlobStore) context.Context {
	return context.WithValue(ctx, blobKey{}, store)
}
func blobs(ctx context.Context) BlobStore { s, _ := ctx.Value(blobKey{}).(BlobStore); return s }
func Digest(data []byte) string           { h := sha256.Sum256(data); return hex.EncodeToString(h[:]) }

type Stream struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	Digest string `json:"digest"`
}
type Snapshot struct {
	Version    int    `json:"version"`
	Platform   string `json:"platform"`
	Matrix     string `json:"matrix"`
	Security   []byte `json:"security"`
	Attributes uint32 `json:"attributes"`
	Creation   uint64 `json:"creation"`
	LastAccess uint64 `json:"lastAccess"`
	LastWrite  uint64 `json:"lastWrite"`
	// OS-managed ChangeTime is observed for conflict/evidence, never restored.
	ChangeTime uint64 `json:"changeTime"`
	// Read-induced access-time changes are separately observed, never guessed.
	ReadAccessAfter uint64            `json:"readAccessAfter"`
	EA              []byte            `json:"ea"`
	Streams         []Stream          `json:"streams"`
	Manifest        map[string]string `json:"manifest"`
}

var requiredFields = []string{"owner", "group", "dacl", "sacl", "label", "specialSecurity", "times", "attributes", "ea", "streams", "singleLink", "ordinaryFile"}

func (s *Snapshot) Validate() error {
	if s.Version != MatrixVersion || s.Platform != "windows" || s.Matrix != "ordinary-file-v2" || len(s.Security) == 0 || len(s.Security) > MetadataBytes || len(s.EA) > EABytes || len(s.Streams) > StreamCount {
		return ErrIncomplete
	}
	if len(s.Manifest) != len(requiredFields) {
		return ErrIncomplete
	}
	for _, f := range requiredFields {
		if s.Manifest[f] != "captured_exact" && s.Manifest[f] != "known_absent" {
			return fmt.Errorf("%w: %s", ErrIncomplete, f)
		}
	}
	for _, name := range []string{"owner", "group", "dacl", "sacl", "label", "times", "attributes", "singleLink", "ordinaryFile"} {
		if s.Manifest[name] != "captured_exact" {
			return ErrIncomplete
		}
	}
	if s.Manifest["specialSecurity"] != "known_absent" {
		return ErrIncomplete
	}
	var total int64
	names := make(map[string]bool, len(s.Streams))
	for _, stream := range s.Streams {
		if stream.Size < 0 || stream.Size > StreamBytes || len(stream.Digest) != 64 || names[stream.Name] || !validStreamName(stream.Name) {
			return ErrIncomplete
		}
		if _, err := hex.DecodeString(stream.Digest); err != nil {
			return ErrIncomplete
		}
		names[stream.Name] = true
		total += stream.Size
		if total > StreamBytes {
			return ErrIncomplete
		}
	}
	return nil
}
func validStreamName(name string) bool {
	if len(name) < 8 || len(name) > 65536 || name[0] != ':' || name[len(name)-6:] != ":$DATA" || name == "::$DATA" {
		return false
	}
	for _, r := range name[1 : len(name)-6] {
		if r < 32 || r == ':' || r == '/' || r == '\\' || r == 0 {
			return false
		}
	}
	return true
}
func Encode(s *Snapshot) ([]byte, error) {
	if err := s.Validate(); err != nil {
		return nil, err
	}
	data, err := json.Marshal(s)
	if len(data) > MetadataBytes {
		return nil, fmt.Errorf("%w: metadata budget", ErrIncomplete)
	}
	return data, err
}

// SnapshotFingerprint is the exact restorable matrix digest. Native identity,
// observed ChangeTime and read side effects remain separately in the signed
// capture record; they are not claimed to be arbitrary restorable metadata.
func SnapshotFingerprint(s *Snapshot) (string, error) {
	copy := *s
	copy.ChangeTime = 0
	copy.ReadAccessAfter = 0
	data, err := Encode(&copy)
	if err != nil {
		return "", err
	}
	return Digest(data), nil
}
func Decode(data []byte) (*Snapshot, error) {
	if len(data) > MetadataBytes {
		return nil, ErrIncomplete
	}
	var s Snapshot
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, err
	}
	return &s, s.Validate()
}
