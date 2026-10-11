package windowsbackup

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"sort"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

// Native query buffers are not wire claims. Still parse every length/offset and
// refuse unsupported records before they can become a complete capture.
type nativeStreamRecord struct {
	Name string
	Size int64
}
type nativeEARecord struct {
	Flags       byte
	Name, Value []byte
}
type nativeBackupHeader struct {
	ID, Flags, NameBytes uint32
	Size                 uint64
}

const nativeEAMaxEntries = EABytes/10 + 1
const (
	nativeStatusSuccess  uint32 = 0
	nativeStatusOverflow uint32 = 0x80000005
	nativeStatusNoMoreEA uint32 = 0x80000012
	nativeStatusTooSmall uint32 = 0xc0000023
	nativeStatusNoEA     uint32 = 0xc0000052
)

func nativeStreamName(name string) bool {
	if !utf8.ValidString(name) || !validStreamName(name) || strings.ContainsAny(name, "*?\"<>|") {
		return false
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return false
		}
	}
	return len(utf16.Encode([]rune(name)))*2 <= 65534
}
func nativeUTF16Name(raw []byte) (string, error) {
	if len(raw)%2 != 0 || len(raw) > 65534 {
		return "", fmt.Errorf("native stream name byte budget")
	}
	wide := make([]uint16, len(raw)/2)
	for i := range wide {
		wide[i] = binary.LittleEndian.Uint16(raw[i*2:])
	}
	for i := 0; i < len(wide); i++ {
		u := wide[i]
		if u >= 0xd800 && u <= 0xdbff {
			if i+1 >= len(wide) || wide[i+1] < 0xdc00 || wide[i+1] > 0xdfff {
				return "", fmt.Errorf("native stream UTF16")
			}
			i++
		} else if u >= 0xdc00 && u <= 0xdfff {
			return "", fmt.Errorf("native stream UTF16")
		}
	}
	return string(utf16.Decode(wide)), nil
}
func parseNativeStreams(raw []byte, mainSize int64) ([]nativeStreamRecord, error) {
	if len(raw) < 24 || len(raw) > MetadataBytes || mainSize < 0 {
		return nil, fmt.Errorf("native stream information budget")
	}
	var streams []nativeStreamRecord
	mainSeen := false
	var total int64
	for offset, count := 0, 0; ; count++ {
		if count >= StreamCount+1 || offset < 0 || offset > len(raw)-24 {
			return nil, fmt.Errorf("native stream count/offset")
		}
		r := raw[offset:]
		next := int(binary.LittleEndian.Uint32(r))
		nameBytes := int(binary.LittleEndian.Uint32(r[4:]))
		size := int64(binary.LittleEndian.Uint64(r[8:]))
		allocation := int64(binary.LittleEndian.Uint64(r[16:]))
		if nameBytes < 0 || nameBytes%2 != 0 || nameBytes > 65534 || nameBytes > len(r)-24 || size < 0 || allocation < 0 {
			return nil, fmt.Errorf("native stream name/size")
		}
		end := 24 + nameBytes
		if next != 0 && (next%8 != 0 || next < end || next > len(r)-24) {
			return nil, fmt.Errorf("native stream next offset")
		}
		name, err := nativeUTF16Name(r[24:end])
		if err != nil {
			return nil, err
		}
		if name == "::$DATA" || name == "" {
			if mainSeen || size != mainSize {
				return nil, fmt.Errorf("native main stream mismatch")
			}
			mainSeen = true
		} else {
			if !nativeStreamName(name) || size > StreamBytes-total {
				return nil, fmt.Errorf("native stream type/name/budget")
			}
			for _, s := range streams {
				if strings.EqualFold(s.Name, name) {
					return nil, fmt.Errorf("native duplicate stream")
				}
			}
			streams = append(streams, nativeStreamRecord{name, size})
			total += size
		}
		if next == 0 {
			if len(r)-end > 7 {
				return nil, fmt.Errorf("native unparsed stream tail")
			}
			break
		}
		offset += next
	}
	if !mainSeen {
		return nil, fmt.Errorf("native main stream missing")
	}
	sort.Slice(streams, func(i, j int) bool { return streams[i].Name < streams[j].Name })
	return streams, nil
}
func nativeEANameKey(name []byte) string {
	key := bytes.Clone(name)
	for i, b := range key {
		if b >= 'a' && b <= 'z' {
			key[i] = b - ('a' - 'A')
		}
	}
	return string(key)
}
func nativeEANameValid(name []byte) bool {
	if len(name) == 0 || len(name) > 255 {
		return false
	}
	for _, b := range name {
		if b < 32 || b == 127 || bytes.IndexByte([]byte(`\/:*?"<>|,+=[];`), b) >= 0 {
			return false
		}
	}
	return true
}
func parseNativeEA(raw []byte) ([]nativeEARecord, error) {
	if len(raw) == 0 || len(raw) > EABytes {
		return nil, fmt.Errorf("native EA byte budget")
	}
	var entries []nativeEARecord
	seen := map[string]bool{}
	for offset := 0; ; {
		if len(entries) >= nativeEAMaxEntries || offset < 0 || offset > len(raw)-8 {
			return nil, fmt.Errorf("native EA count/header")
		}
		r := raw[offset:]
		next := int(binary.LittleEndian.Uint32(r))
		flags := r[4]
		nameLen := int(r[5])
		valueLen := int(binary.LittleEndian.Uint16(r[6:8]))
		end := 8 + nameLen + 1 + valueLen
		if flags != 0 && flags != 0x80 || nameLen == 0 || end > len(r) {
			return nil, fmt.Errorf("native EA flags/name/value")
		}
		name := r[8 : 8+nameLen]
		if !nativeEANameValid(name) || r[8+nameLen] != 0 {
			return nil, fmt.Errorf("native EA name/terminator")
		}
		key := nativeEANameKey(name)
		if seen[key] {
			return nil, fmt.Errorf("native duplicate EA")
		}
		seen[key] = true
		entries = append(entries, nativeEARecord{flags, bytes.Clone(name), bytes.Clone(r[8+nameLen+1 : end])})
		if next == 0 {
			if len(r)-end > 3 {
				return nil, fmt.Errorf("native unparsed EA tail")
			}
			break
		}
		if next < end || next%4 != 0 || next > len(r)-8 {
			return nil, fmt.Errorf("native EA next offset")
		}
		offset += next
	}
	return entries, nil
}
func nativeEAEqual(a, b []nativeEARecord) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Flags != b[i].Flags || !bytes.Equal(a[i].Name, b[i].Name) || !bytes.Equal(a[i].Value, b[i].Value) {
			return false
		}
	}
	return true
}
func nativeEAReply(status uint32, used int, have bool) (string, error) {
	switch status {
	case nativeStatusOverflow:
		if used == 0 {
			return "grow", nil
		}
		if used < 0 || used > EABytes {
			return "", fmt.Errorf("native EA overflow budget")
		}
		return "page", nil
	case nativeStatusSuccess:
		if used <= 0 || used > EABytes {
			return "", fmt.Errorf("native EA incomplete page")
		}
		return "page", nil
	case nativeStatusTooSmall:
		if used != 0 {
			return "", fmt.Errorf("native EA partial small-buffer reply")
		}
		return "grow", nil
	case nativeStatusNoEA:
		if used != 0 || have {
			return "", fmt.Errorf("native EA inconsistent absence")
		}
		return "absent", nil
	case nativeStatusNoMoreEA:
		if used != 0 || !have {
			return "", fmt.Errorf("native EA premature end")
		}
		return "done", nil
	default:
		return "", fmt.Errorf("native EA query failed NTSTATUS=0x%08x", status)
	}
}
func parseNativeBackupHeader(raw []byte) (nativeBackupHeader, error) {
	var r nativeBackupHeader
	if len(raw) != 20 {
		return r, fmt.Errorf("native backup header length")
	}
	r = nativeBackupHeader{binary.LittleEndian.Uint32(raw), binary.LittleEndian.Uint32(raw[4:]), binary.LittleEndian.Uint32(raw[16:]), binary.LittleEndian.Uint64(raw[8:])}
	if r.NameBytes > 65534 || r.NameBytes%2 != 0 || r.Size > 1<<63-1 {
		return r, fmt.Errorf("native backup header name/size budget")
	}
	if r.ID != 1 && r.ID != 2 && r.ID != 4 {
		return r, fmt.Errorf("unsupported backup record type=%d", r.ID)
	}
	if r.Flags != 0 {
		return r, fmt.Errorf("unsupported backup record flags type=%d flags=%d", r.ID, r.Flags)
	}
	switch r.ID {
	case 1:
		if r.NameBytes != 0 {
			return r, fmt.Errorf("native main backup name")
		}
	case 2:
		if r.NameBytes != 0 || r.Size > EABytes {
			return r, fmt.Errorf("native EA backup name/budget")
		}
	case 4:
		if r.Size > StreamBytes {
			return r, fmt.Errorf("native ADS backup budget")
		}
	default:
		return r, fmt.Errorf("unsupported backup record type=%d", r.ID)
	}
	return r, nil
}
