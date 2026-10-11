package windowsbackup

import (
	"encoding/binary"
	"errors"
	"fmt"
	"testing"
	"unicode/utf16"
)

// TEST ONLY: same record-type allowlist as production readBackup. No payload is
// interpreted or delivered by this prototype. Unknown records never complete.
type backupHeaderAuditRecord struct {
	ID, Flags, NameBytes uint32
	Size                 uint64
}
type backupHeaderAuditUnsupported struct{ ID uint32 }

func (e *backupHeaderAuditUnsupported) Error() string {
	return fmt.Sprintf("unsupported backup record type=%d", e.ID)
}
func decodeBackupHeaderAudit(raw []byte) (backupHeaderAuditRecord, error) {
	var r backupHeaderAuditRecord
	if len(raw) != 20 {
		return r, fmt.Errorf("backup header length")
	}
	r = backupHeaderAuditRecord{binary.LittleEndian.Uint32(raw[0:4]), binary.LittleEndian.Uint32(raw[4:8]), binary.LittleEndian.Uint32(raw[16:20]), binary.LittleEndian.Uint64(raw[8:16])}
	if r.NameBytes > 65536 || r.NameBytes%2 != 0 || r.Size > 1<<63-1 {
		return r, fmt.Errorf("backup header name/size budget")
	}
	switch r.ID {
	case 1:
		if r.NameBytes != 0 || r.Flags != 0 {
			return r, fmt.Errorf("main backup header flags/name")
		}
	case 2:
		if r.NameBytes != 0 || r.Size > EABytes {
			return r, fmt.Errorf("EA backup header name/budget")
		}
	case 4:
		if r.Flags != 0 || r.Size > StreamBytes {
			return r, fmt.Errorf("ADS backup header flags/budget")
		}
	default:
		return r, &backupHeaderAuditUnsupported{r.ID}
	}
	return r, nil
}
func decodeBackupHeaderAuditName(raw []byte) (string, error) {
	if len(raw)%2 != 0 || len(raw) > 65536 {
		return "", fmt.Errorf("backup name byte budget")
	}
	wide := make([]uint16, len(raw)/2)
	for i := range wide {
		wide[i] = binary.LittleEndian.Uint16(raw[i*2:])
	}
	for i := 0; i < len(wide); i++ {
		u := wide[i]
		if u >= 0xd800 && u <= 0xdbff {
			if i+1 >= len(wide) || wide[i+1] < 0xdc00 || wide[i+1] > 0xdfff {
				return "", fmt.Errorf("backup name UTF16")
			}
			i++
		} else if u >= 0xdc00 && u <= 0xdfff {
			return "", fmt.Errorf("backup name UTF16")
		}
	}
	name := string(utf16.Decode(wide))
	if !validStreamName(name) {
		return "", fmt.Errorf("backup stream name rejected")
	}
	return name, nil
}
func TestBackupHeaderAuditPrototypePolicy(t *testing.T) {
	for _, id := range []uint32{1, 2, 4} {
		var header [20]byte
		binary.LittleEndian.PutUint32(header[:], id)
		if _, err := decodeBackupHeaderAudit(header[:]); err != nil {
			t.Fatal("known record rejected", err)
		}
	}
	for _, id := range []uint32{0, 3, 5, 6, 7, 8, 9, 10, 11, 0xffffffff} {
		var header [20]byte
		binary.LittleEndian.PutUint32(header[:], id)
		_, err := decodeBackupHeaderAudit(header[:])
		var unsupported *backupHeaderAuditUnsupported
		if !errors.As(err, &unsupported) || unsupported.ID != id {
			t.Fatalf("record %d did not explicitly refuse", id)
		}
	}
	for _, kind := range []string{"short", "odd-name", "large-name", "large-size", "main-name", "main-flags", "ea-size", "ads-size", "ads-flags"} {
		t.Run(kind, func(t *testing.T) {
			header := make([]byte, 20)
			binary.LittleEndian.PutUint32(header, 1)
			switch kind {
			case "short":
				header = header[:19]
			case "odd-name":
				binary.LittleEndian.PutUint32(header[16:], 1)
			case "large-name":
				binary.LittleEndian.PutUint32(header[16:], 65538)
			case "large-size":
				binary.LittleEndian.PutUint64(header[8:], 1<<63)
			case "main-name":
				binary.LittleEndian.PutUint32(header[16:], 2)
			case "main-flags":
				binary.LittleEndian.PutUint32(header[4:], 1)
			case "ea-size":
				binary.LittleEndian.PutUint32(header, 2)
				binary.LittleEndian.PutUint64(header[8:], EABytes+1)
			case "ads-size":
				binary.LittleEndian.PutUint32(header, 4)
				binary.LittleEndian.PutUint64(header[8:], StreamBytes+1)
			case "ads-flags":
				binary.LittleEndian.PutUint32(header, 4)
				binary.LittleEndian.PutUint32(header[4:], 1)
			}
			if _, err := decodeBackupHeaderAudit(header); err == nil {
				t.Fatal("malformed header accepted")
			}
		})
	}
	if _, err := decodeBackupHeaderAuditName([]byte{0, 0xd8}); err == nil {
		t.Fatal("unpaired surrogate accepted")
	}
}
