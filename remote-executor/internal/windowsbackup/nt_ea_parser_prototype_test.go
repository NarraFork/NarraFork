package windowsbackup

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"testing"
)

// TEST ONLY. FILE_FULL_EA_INFORMATION keeps opaque value/name bytes; parsing
// never canonicalizes the captured raw representation used for format checks.
type ntEAPrototypeEntry struct {
	Flags       byte
	Name, Value []byte
}

const ntEAPrototypeMaxEntries = EABytes/10 + 1
const (
	ntEAStatusSuccess  uint32 = 0
	ntEAStatusOverflow uint32 = 0x80000005
	ntEAStatusNoMore   uint32 = 0x80000012
	ntEAStatusTooSmall uint32 = 0xc0000023
	ntEAStatusNone     uint32 = 0xc0000052
)

func ntEAPrototypeNameKey(name []byte) string {
	folded := bytes.Clone(name)
	for i, b := range folded {
		if b >= 'a' && b <= 'z' {
			folded[i] = b - ('a' - 'A')
		}
	}
	return string(folded)
}
func ntEAPrototypeNameValid(name []byte) bool {
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
func parseNTPrototypeEA(raw []byte) ([]ntEAPrototypeEntry, error) {
	if len(raw) == 0 || len(raw) > EABytes {
		return nil, fmt.Errorf("EA page byte budget")
	}
	entries := make([]ntEAPrototypeEntry, 0)
	seen := map[string]bool{}
	for offset := 0; ; {
		if len(entries) >= ntEAPrototypeMaxEntries || offset < 0 || offset > len(raw)-8 {
			return nil, fmt.Errorf("EA entry count/header")
		}
		record := raw[offset:]
		next := int(binary.LittleEndian.Uint32(record))
		flags := record[4]
		nameLen := int(record[5])
		valueLen := int(binary.LittleEndian.Uint16(record[6:8]))
		end := 8 + nameLen + 1 + valueLen
		if flags != 0 && flags != 0x80 || nameLen == 0 || end > len(record) {
			return nil, fmt.Errorf("EA flags/name/value bounds")
		}
		name := record[8 : 8+nameLen]
		if !ntEAPrototypeNameValid(name) || record[8+nameLen] != 0 {
			return nil, fmt.Errorf("EA name/terminator")
		}
		key := ntEAPrototypeNameKey(name)
		if seen[key] {
			return nil, fmt.Errorf("EA duplicate name")
		}
		seen[key] = true
		entries = append(entries, ntEAPrototypeEntry{flags, bytes.Clone(name), bytes.Clone(record[8+nameLen+1 : end])})
		if next == 0 {
			if len(record)-end > 3 {
				return nil, fmt.Errorf("EA unparsed tail")
			}
			break
		}
		if next < end || next%4 != 0 || next > len(record)-8 {
			return nil, fmt.Errorf("EA next offset")
		}
		offset += next
	}
	return entries, nil
}
func ntEAPrototypeEncode(entries []ntEAPrototypeEntry) []byte {
	var raw []byte
	for i, entry := range entries {
		n := 8 + len(entry.Name) + 1 + len(entry.Value)
		size := n
		if i < len(entries)-1 {
			size = (n + 3) &^ 3
		}
		record := make([]byte, size)
		if i < len(entries)-1 {
			binary.LittleEndian.PutUint32(record, uint32(size))
		}
		record[4] = entry.Flags
		record[5] = byte(len(entry.Name))
		binary.LittleEndian.PutUint16(record[6:8], uint16(len(entry.Value)))
		copy(record[8:], entry.Name)
		copy(record[8+len(entry.Name)+1:], entry.Value)
		raw = append(raw, record...)
	}
	return raw
}
func ntEAPrototypeEqual(a, b []ntEAPrototypeEntry) bool {
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

// Only these explicit, shape-checked outcomes may control paging. In particular
// ACCESS_DENIED/EAS_NOT_SUPPORTED/malformed replies cannot mean known absence.
func ntEAPrototypeReply(status uint32, used int, haveEntries bool) (string, error) {
	switch status {
	case ntEAStatusOverflow:
		// No complete entry fit: only a bounded restart with a larger buffer is
		// allowed. This is never absence or end-of-enumeration evidence.
		if used == 0 {
			return "grow", nil
		}
		if used < 0 || used > EABytes {
			return "", fmt.Errorf("EA overflow page byte budget")
		}
		return "page", nil
	case ntEAStatusSuccess:
		if used <= 0 || used > EABytes {
			return "", fmt.Errorf("EA success without complete page")
		}
		return "page", nil
	case ntEAStatusTooSmall:
		if used != 0 {
			return "", fmt.Errorf("EA small-buffer reply carried partial data")
		}
		return "grow", nil
	case ntEAStatusNone:
		if used != 0 || haveEntries {
			return "", fmt.Errorf("EA disappearance/inconsistent absence")
		}
		return "absent", nil
	case ntEAStatusNoMore:
		if used != 0 || !haveEntries {
			return "", fmt.Errorf("EA premature/invalid end of scan")
		}
		return "done", nil
	default:
		return "", fmt.Errorf("EA query failed NTSTATUS=0x%08x", status)
	}
}

func TestNTEAPrototypeParserAndStatuses(t *testing.T) {
	valid := []ntEAPrototypeEntry{{0, []byte("NF_ALPHA"), []byte{1, 2, 3, 4}}, {0x80, []byte("NF_BINARY"), []byte{0, 1, 255, 0, 127, 16, 3}}}
	raw := ntEAPrototypeEncode(valid)
	got, err := parseNTPrototypeEA(raw)
	if err != nil || !ntEAPrototypeEqual(got, valid) {
		t.Fatal("valid binary/FILE_NEED_EA list rejected", err)
	}
	for _, kind := range []string{"empty", "short-header", "flags", "empty-name", "nul-name", "separator", "bad-terminator", "value-overrun", "overlap", "unaligned", "outside", "duplicate", "trailing", "budget"} {
		t.Run(kind, func(t *testing.T) {
			input := bytes.Clone(raw)
			switch kind {
			case "empty":
				input = nil
			case "short-header":
				input = input[:7]
			case "flags":
				input[4] = 1
			case "empty-name":
				input[5] = 0
			case "nul-name":
				input[8] = 0
			case "separator":
				input[8] = '/'
			case "bad-terminator":
				input[8+int(input[5])] = 1
			case "value-overrun":
				binary.LittleEndian.PutUint16(input[6:8], 65535)
			case "overlap":
				binary.LittleEndian.PutUint32(input, 4)
			case "unaligned":
				binary.LittleEndian.PutUint32(input, 25)
			case "outside":
				binary.LittleEndian.PutUint32(input, 0xfffffffc)
			case "duplicate":
				input = ntEAPrototypeEncode([]ntEAPrototypeEntry{valid[0], {0, []byte("nf_alpha"), []byte{1}}})
			case "trailing":
				input = append(input, make([]byte, 8)...)
			case "budget":
				input = make([]byte, EABytes+1)
			}
			if _, err := parseNTPrototypeEA(input); err == nil {
				t.Fatal("malformed EA accepted")
			}
		})
	}
	for _, row := range []struct {
		status uint32
		used   int
		seen   bool
		want   string
	}{{0, 12, false, "page"}, {ntEAStatusOverflow, 12, true, "page"}, {ntEAStatusOverflow, 0, false, "grow"}, {ntEAStatusTooSmall, 0, false, "grow"}, {ntEAStatusNone, 0, false, "absent"}, {ntEAStatusNoMore, 0, true, "done"}} {
		if got, err := ntEAPrototypeReply(row.status, row.used, row.seen); err != nil || got != row.want {
			t.Fatal("valid paging outcome refused", err)
		}
	}
	for _, row := range []struct {
		status uint32
		used   int
		seen   bool
	}{{0, 0, false}, {ntEAStatusOverflow, EABytes + 1, false}, {ntEAStatusTooSmall, 2, false}, {ntEAStatusNone, 0, true}, {ntEAStatusNone, 8, false}, {ntEAStatusNoMore, 0, false}, {ntEAStatusNoMore, 8, true}, {0xc0000022, 0, false}, {0xc000004f, 0, false}, {0x80000014, 0, false}, {0xc0000051, 0, false}} {
		if _, err := ntEAPrototypeReply(row.status, row.used, row.seen); err == nil {
			t.Fatalf("failure became absence/end: 0x%08x", row.status)
		}
	}
}
