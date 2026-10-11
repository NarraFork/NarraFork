package windowsbackup

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func TestNativeCaptureProductionParsers(t *testing.T) {
	ea := []ntEAPrototypeEntry{{0, []byte("NF_ALPHA"), []byte{1, 0, 255}}, {0x80, []byte("NF_BINARY"), []byte{3, 4, 0, 5}}}
	raw := ntEAPrototypeEncode(ea)
	parsed, err := parseNativeEA(raw)
	if err != nil || len(parsed) != 2 {
		t.Fatal(err)
	}
	for i := range ea {
		if parsed[i].Flags != ea[i].Flags || !bytes.Equal(parsed[i].Name, ea[i].Name) || !bytes.Equal(parsed[i].Value, ea[i].Value) {
			t.Fatal("EA native data changed")
		}
	}
	streams := ntPrototypeStreamBuffer([]ntPrototypeStream{{"::$DATA", 19}, {":Zone.Identifier:$DATA", 26}})
	listed, err := parseNativeStreams(streams, 19)
	if err != nil || len(listed) != 1 || listed[0].Size != 26 {
		t.Fatal(err)
	}
	for _, kind := range []string{"ea-flags", "ea-next", "ea-nul", "ea-short-value", "ea-duplicate", "stream-next", "stream-name-type", "stream-duplicate", "stream-main-size", "unknown-record", "unknown-ea-header-flags"} {
		t.Run(kind, func(t *testing.T) {
			eaRaw := bytes.Clone(raw)
			streamRaw := bytes.Clone(streams)
			var failure error
			switch kind {
			case "ea-flags":
				eaRaw[4] = 1
				_, failure = parseNativeEA(eaRaw)
			case "ea-next":
				binary.LittleEndian.PutUint32(eaRaw, 4)
				_, failure = parseNativeEA(eaRaw)
			case "ea-nul":
				eaRaw[8+int(eaRaw[5])] = 1
				_, failure = parseNativeEA(eaRaw)
			case "ea-short-value":
				binary.LittleEndian.PutUint16(eaRaw[6:], 65535)
				_, failure = parseNativeEA(eaRaw)
			case "ea-duplicate":
				_, failure = parseNativeEA(ntEAPrototypeEncode([]ntEAPrototypeEntry{ea[0], ea[0]}))
			case "stream-next":
				binary.LittleEndian.PutUint32(streamRaw, 8)
				_, failure = parseNativeStreams(streamRaw, 19)
			case "stream-name-type":
				_, failure = parseNativeStreams(ntPrototypeStreamBuffer([]ntPrototypeStream{{"::$DATA", 19}, {":x:$INDEX_ALLOCATION", 1}}), 19)
			case "stream-duplicate":
				_, failure = parseNativeStreams(ntPrototypeStreamBuffer([]ntPrototypeStream{{"::$DATA", 19}, {":x:$DATA", 1}, {":X:$DATA", 1}}), 19)
			case "stream-main-size":
				_, failure = parseNativeStreams(streamRaw, 20)
			case "unknown-record":
				var h [20]byte
				binary.LittleEndian.PutUint32(h[:], 7)
				_, failure = parseNativeBackupHeader(h[:])
			case "unknown-ea-header-flags":
				var h [20]byte
				binary.LittleEndian.PutUint32(h[:], 2)
				binary.LittleEndian.PutUint32(h[4:], 8)
				_, failure = parseNativeBackupHeader(h[:])
			}
			if failure == nil {
				t.Fatal("production parser accepted malformed/unsupported data")
			}
		})
	}
	for _, id := range []uint32{3, 5, 6, 7, 8, 9, 10, 11, 0xffffffff} {
		var h [20]byte
		binary.LittleEndian.PutUint32(h[:], id)
		if _, err := parseNativeBackupHeader(h[:]); err == nil {
			t.Fatalf("unknown backup type admitted: %d", id)
		}
	}
	for _, status := range []uint32{0xc0000022, 0xc000004f, 0x80000014, 0xc0000051} {
		if _, err := nativeEAReply(status, 0, false); err == nil {
			t.Fatal("native error became absence")
		}
	}
	if _, err := nativeEAReply(nativeStatusNoMoreEA, 0, false); err == nil {
		t.Fatal("premature EA end accepted")
	}
}
