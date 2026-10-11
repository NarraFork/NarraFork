package windowsbackup

import (
	"encoding/binary"
	"fmt"
	"sort"
	"strings"
	"testing"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

// Prototype-only FILE_STREAM_INFORMATION parser. No production capture uses it.
type ntPrototypeStream struct {
	Name string
	Size int64
}

func ntPrototypeStreamName(name string) bool {
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

func parseNTPrototypeStreams(raw []byte, mainSize int64) ([]ntPrototypeStream, error) {
	if len(raw) < 24 || len(raw) > MetadataBytes || mainSize < 0 || mainSize > StreamBytes {
		return nil, fmt.Errorf("stream information budget")
	}
	var streams []ntPrototypeStream
	mainSeen := false
	var total int64
	for offset, count := 0, 0; ; count++ {
		if count >= StreamCount+1 || offset < 0 || offset > len(raw)-24 {
			return nil, fmt.Errorf("stream record count/offset")
		}
		record := raw[offset:]
		next := int(binary.LittleEndian.Uint32(record[0:4]))
		nameBytes := int(binary.LittleEndian.Uint32(record[4:8]))
		size := int64(binary.LittleEndian.Uint64(record[8:16]))
		allocation := int64(binary.LittleEndian.Uint64(record[16:24]))
		if nameBytes < 0 || nameBytes%2 != 0 || nameBytes > 65534 || nameBytes > len(record)-24 || size < 0 || allocation < 0 {
			return nil, fmt.Errorf("stream name/size encoding")
		}
		end := 24 + nameBytes
		if next != 0 && (next%8 != 0 || next < end || next > len(record)-24) {
			return nil, fmt.Errorf("stream next offset")
		}
		wide := make([]uint16, nameBytes/2)
		for i := range wide {
			wide[i] = binary.LittleEndian.Uint16(record[24+i*2:])
		}
		for i := 0; i < len(wide); i++ {
			u := wide[i]
			if u >= 0xd800 && u <= 0xdbff {
				if i+1 >= len(wide) || wide[i+1] < 0xdc00 || wide[i+1] > 0xdfff {
					return nil, fmt.Errorf("invalid stream UTF16")
				}
				i++
			} else if u >= 0xdc00 && u <= 0xdfff {
				return nil, fmt.Errorf("invalid stream UTF16")
			}
		}
		name := string(utf16.Decode(wide))
		// Microsoft permits either empty or ::$DATA for the unnamed main entry.
		// Verify it against the separately observed main size before skipping it.
		if name == "::$DATA" || name == "" {
			if mainSeen || size != mainSize {
				return nil, fmt.Errorf("main stream mismatch/duplicate")
			}
			mainSeen = true
		} else {
			if !ntPrototypeStreamName(name) || size > StreamBytes-total {
				return nil, fmt.Errorf("unknown stream type/name/budget")
			}
			for _, prior := range streams {
				if strings.EqualFold(prior.Name, name) {
					return nil, fmt.Errorf("duplicate stream")
				}
			}
			streams = append(streams, ntPrototypeStream{name, size})
			total += size
		}
		if next == 0 {
			if len(record)-end > 7 {
				return nil, fmt.Errorf("unparsed stream tail")
			}
			break
		}
		offset += next
	}
	if !mainSeen {
		return nil, fmt.Errorf("main stream missing")
	}
	sort.Slice(streams, func(i, j int) bool { return streams[i].Name < streams[j].Name })
	return streams, nil
}

func ntPrototypeStreamBuffer(entries []ntPrototypeStream) []byte {
	var raw []byte
	for index, entry := range entries {
		name := utf16.Encode([]rune(entry.Name))
		size := 24 + len(name)*2
		allocated := (size + 7) &^ 7
		if index == len(entries)-1 {
			allocated = size
		}
		record := make([]byte, allocated)
		if index != len(entries)-1 {
			binary.LittleEndian.PutUint32(record, uint32(allocated))
		}
		binary.LittleEndian.PutUint32(record[4:], uint32(len(name)*2))
		binary.LittleEndian.PutUint64(record[8:], uint64(entry.Size))
		binary.LittleEndian.PutUint64(record[16:], uint64(entry.Size))
		for i, u := range name {
			binary.LittleEndian.PutUint16(record[24+i*2:], u)
		}
		raw = append(raw, record...)
	}
	return raw
}

func TestNTStreamPrototypeParser(t *testing.T) {
	for _, mainName := range []string{"::$DATA", ""} {
		raw := ntPrototypeStreamBuffer([]ntPrototypeStream{{mainName, 3}, {":Zone.Identifier:$DATA", 26}})
		got, err := parseNTPrototypeStreams(raw, 3)
		if err != nil || len(got) != 1 || got[0].Name != ":Zone.Identifier:$DATA" {
			t.Fatal("valid main entry/ADS rejected", err)
		}
	}
	for _, kind := range []string{"truncated", "overlap", "misaligned", "offset-outside", "odd-name", "bad-utf16", "unknown-type", "duplicate", "duplicate-main", "missing-main", "wrong-main-size", "negative-size", "negative-allocation", "too-large", "aggregate", "too-many", "trailing", "traversal", "control", "wildcard"} {
		t.Run(kind, func(t *testing.T) {
			entries := []ntPrototypeStream{{"::$DATA", 3}, {":Zone.Identifier:$DATA", 26}}
			switch kind {
			case "unknown-type":
				entries[1].Name = ":x:$INDEX_ALLOCATION"
			case "duplicate":
				entries = append(entries, ntPrototypeStream{":zone.identifier:$DATA", 1})
			case "duplicate-main":
				entries = append(entries, ntPrototypeStream{"::$DATA", 3})
			case "missing-main":
				entries = entries[1:]
			case "wrong-main-size":
				entries[0].Size = 4
			case "negative-size":
				entries[1].Size = -1
			case "too-large":
				entries[1].Size = StreamBytes + 1
			case "aggregate":
				entries[1].Size = StreamBytes
				entries = append(entries, ntPrototypeStream{":other:$DATA", 1})
			case "too-many":
				for i := 0; i < StreamCount; i++ {
					entries = append(entries, ntPrototypeStream{fmt.Sprintf(":s%d:$DATA", i), 0})
				}
			case "traversal":
				entries[1].Name = ":../escape:$DATA"
			case "control":
				entries[1].Name = ":x\x00:$DATA"
			case "wildcard":
				entries[1].Name = ":*:$DATA"
			}
			raw := ntPrototypeStreamBuffer(entries)
			switch kind {
			case "truncated":
				raw = raw[:20]
			case "overlap":
				binary.LittleEndian.PutUint32(raw, 8)
			case "misaligned":
				binary.LittleEndian.PutUint32(raw, 41)
			case "offset-outside":
				binary.LittleEndian.PutUint32(raw, 0x7ffffff8)
			case "odd-name":
				binary.LittleEndian.PutUint32(raw[4:], 1)
			case "bad-utf16":
				binary.LittleEndian.PutUint16(raw[24:], 0xd800)
			case "negative-allocation":
				binary.LittleEndian.PutUint64(raw[16:], ^uint64(0))
			case "trailing":
				raw = append(raw, make([]byte, 24)...)
			}
			if _, err := parseNTPrototypeStreams(raw, 3); err == nil {
				t.Fatal("malformed enumeration accepted")
			}
		})
	}
}
