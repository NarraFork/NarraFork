package winpty

import (
	"bufio"
	"bytes"
	"strings"
	"testing"
)

func TestBoundedFrames(t *testing.T) {
	var buffer bytes.Buffer
	data := bytes.Repeat([]byte{0xff}, MaxOutputChunk)
	if err := writeFrame(&buffer, frame{Kind: "output", Data: data}); err != nil {
		t.Fatal(err)
	}
	if buffer.Len() > MaxFrameBytes {
		t.Fatal("output frame exceeded budget")
	}
	f, err := readFrame(bufio.NewReaderSize(&buffer, MaxFrameBytes))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(f.Data, data) {
		t.Fatal("frame bytes changed")
	}
	if writeFrame(&buffer, frame{Kind: "input", Data: bytes.Repeat([]byte{1}, MaxInputChunk)}) == nil {
		t.Fatal("oversized base64 frame accepted")
	}
	_, err = readFrame(bufio.NewReaderSize(strings.NewReader(strings.Repeat("x", MaxFrameBytes+1)), MaxFrameBytes))
	if err == nil {
		t.Fatal("unbounded worker input accepted")
	}
}
func TestWorkerModeRejectedBeforePublicEntry(t *testing.T) {
	if handled, code := RunWorker([]string{WorkerFlag}); !handled || code != 2 {
		t.Fatal("unsupported/malformed private mode fell through to public credential loading")
	}
	if handled, _ := RunWorker([]string{"--version"}); handled {
		t.Fatal("public CLI was captured by worker mode")
	}
}

func TestTerminalDimensions(t *testing.T) {
	if validSize(0, 24) || validSize(80, 0) || validSize(-1, 24) {
		t.Fatal("invalid dimensions accepted")
	}
	if !validSize(80, 24) {
		t.Fatal("valid dimensions rejected")
	}
}
