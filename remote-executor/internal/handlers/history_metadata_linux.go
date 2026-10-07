//go:build linux

package handlers

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
)

type historyLinuxMetadata struct {
	Version  int               `json:"version"`
	Platform string            `json:"platform"`
	UID      uint32            `json:"uid"`
	GID      uint32            `json:"gid"`
	Mode     uint32            `json:"mode"`
	Attrs    map[string][]byte `json:"attrs"`
}

func captureHistoryMetadata(ctx context.Context, file *os.File) ([]byte, error) {
	native, err := captureConditionalMetadata(file, ctx)
	if err != nil {
		return nil, err
	}
	m := native.(*linuxConditionalMetadata)
	return json.Marshal(historyLinuxMetadata{1, "linux", m.UID, m.GID, uint32(m.Mode), m.Attrs})
}
func decodeHistoryMetadata(ctx context.Context, data []byte) (conditionalMetadata, error) {
	if len(data) > 512<<10 {
		return nil, fmt.Errorf("native metadata budget")
	}
	var m historyLinuxMetadata
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	if m.Version != 1 || m.Platform != "linux" || m.Mode & ^uint32(0777) != 0 || len(m.Attrs) > 256 {
		return nil, fmt.Errorf("invalid native metadata backup")
	}
	total := 0
	for name, value := range m.Attrs {
		total += len(name) + len(value)
		if total > maxConditionalMetadataBytes {
			return nil, fmt.Errorf("native metadata budget")
		}
	}
	return &linuxConditionalMetadata{UID: m.UID, GID: m.GID, Mode: os.FileMode(m.Mode), Attrs: m.Attrs, ctx: ctx}, nil
}
func historyMetadataWithMode(ctx context.Context, data []byte, mode uint32) ([]byte, error) {
	if mode & ^uint32(0777) != 0 {
		return nil, fmt.Errorf("invalid mode")
	}
	if _, err := decodeHistoryMetadata(ctx, data); err != nil {
		return nil, err
	}
	var m historyLinuxMetadata
	json.Unmarshal(data, &m)
	m.Mode = mode
	// POSIX chmod updates the owner/other entries and group-class mask, not named
	// ACL entries. Keep the complete access ACL while applying that exact transform.
	if acl, ok := m.Attrs["system.posix_acl_access"]; ok {
		if len(acl) < 4 || (len(acl)-4)%8 != 0 || binary.LittleEndian.Uint32(acl[:4]) != 2 {
			return nil, fmt.Errorf("invalid POSIX ACL backup")
		}
		mask := false
		for i := 4; i < len(acl); i += 8 {
			if binary.LittleEndian.Uint16(acl[i:]) == 0x10 {
				mask = true
			}
		}
		for i := 4; i < len(acl); i += 8 {
			tag := binary.LittleEndian.Uint16(acl[i:])
			var perm uint16
			change := true
			switch tag {
			case 1:
				perm = uint16(mode>>6) & 7
			case 4:
				if mask {
					change = false
				} else {
					perm = uint16(mode>>3) & 7
				}
			case 0x10:
				perm = uint16(mode>>3) & 7
			case 0x20:
				perm = uint16(mode) & 7
			default:
				change = false
			}
			if change {
				binary.LittleEndian.PutUint16(acl[i+2:], perm)
			}
		}
	}
	return json.Marshal(m)
}
