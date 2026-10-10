//go:build windows

package handlers

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestWindowsStreamInfoBufferContract(t *testing.T) {
	var backing [65536 / 8]uint64
	buffer := windowsStreamInfoBytes(&backing)
	if len(buffer) != 65536 || cap(buffer) != 65536 {
		t.Fatalf("stream budget changed: len=%d cap=%d", len(buffer), cap(buffer))
	}
	if address := uintptr(unsafe.Pointer(&buffer[0])); address%8 != 0 {
		t.Fatalf("FILE_STREAM_INFO buffer is not 8-byte aligned: %#x", address)
	}
	if unsafe.Pointer(&buffer[0]) != unsafe.Pointer(&backing[0]) {
		t.Fatal("stream view does not use caller-owned backing")
	}
	if !bytes.Equal(buffer, make([]byte, 65536)) {
		t.Fatal("fresh stream buffer is not zeroed")
	}
	buffer[0], buffer[len(buffer)-1] = 1, 2
	if backing[0] != 1 || backing[len(backing)-1] != uint64(2)<<56 {
		t.Fatal("stream view copied or exceeded its fixed backing")
	}
	backing[1] = 3
	if buffer[8] != 3 {
		t.Fatal("stream backing changes are not visible in the view")
	}
}

func TestWindowsStreamInfoNativeAlignedAndLegacy(t *testing.T) {
	target := filepath.Join(t.TempDir(), "ordinary.txt")
	original := []byte("original")
	if err := os.WriteFile(target, original, 0600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(target)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	// These are native Windows checks, not cross-compilation evidence. The
	// production validator below also requires the local NTFS contract; no skip.
	var backing [65536 / 8]uint64
	buffer := windowsStreamInfoBytes(&backing)
	if err := windows.GetFileInformationByHandleEx(windows.Handle(f.Fd()), windows.FileStreamInfo, &buffer[0], uint32(len(buffer))); err != nil {
		t.Fatalf("aligned FileStreamInfo query: %v", err)
	}
	if next, nameBytes := binary.LittleEndian.Uint32(buffer[:4]), binary.LittleEndian.Uint32(buffer[4:8]); next != 0 || nameBytes != 14 {
		t.Fatalf("unexpected ordinary stream header: next=%d nameBytes=%d", next, nameBytes)
	}
	if name := windows.UTF16ToString(unsafe.Slice((*uint16)(unsafe.Pointer(&buffer[24])), 7)); name != "::$DATA" {
		t.Fatalf("unexpected ordinary stream name: %q", name)
	}

	// Reproduce the observed legacy SP+66 / RSP+82 remainder deterministically,
	// without depending on this test function's compiler-specific stack layout.
	// Both slices fit a fixed backing, and Windows receives a read-only handle.
	var legacyBacking [65536/8 + 1]uint64
	legacy := unsafe.Slice((*byte)(unsafe.Pointer(&legacyBacking[0])), 65536+8)[2 : 2+65536 : 2+65536]
	if address := uintptr(unsafe.Pointer(&legacy[0])); address%8 != 2 {
		t.Fatalf("legacy fixture does not reproduce mod8=2: %#x", address)
	}
	legacyErr := windows.GetFileInformationByHandleEx(windows.Handle(f.Fd()), windows.FileStreamInfo, &legacy[0], uint32(len(legacy)))
	// A permissive Windows/filesystem implementation may accept this buffer.
	// Record the result, but do not claim ERROR_NOACCESS is the only cause or
	// weaken the production alignment contract when the legacy call succeeds.
	t.Logf("native FileStreamInfo: aligned=success legacy-mod8=2 error=%v (%T %#v)", legacyErr, legacyErr, legacyErr)
	if err := validateWindowsConditionalFile(f); err != nil {
		t.Fatalf("ordinary local NTFS file rejected: %v", err)
	}
	got, err := os.ReadFile(target)
	if err != nil || !bytes.Equal(got, original) {
		t.Fatalf("native stream queries changed caller data: %q %v", got, err)
	}
}

func TestWindowsStreamInfoRejectsADSWithoutChangingData(t *testing.T) {
	target := filepath.Join(t.TempDir(), "with-stream.txt")
	original, stream := []byte("original"), []byte("alternate")
	if err := os.WriteFile(target, original, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target+":hidden", stream, 0600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(target)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := validateWindowsConditionalFile(f); err == nil || !strings.Contains(err.Error(), "does not support alternate data streams") {
		t.Fatalf("expected ADS-specific rejection, got %v", err)
	}
	for path, want := range map[string][]byte{target: original, target + ":hidden": stream} {
		got, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("rejected file changed: %s %q %v", path, got, err)
		}
	}
}

func TestWindowsStreamInfoCanceledCapturePreservesData(t *testing.T) {
	target := filepath.Join(t.TempDir(), "canceled.txt")
	original := []byte("original")
	if err := os.WriteFile(target, original, 0600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(target)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if metadata, err := captureConditionalMetadata(f, ctx); metadata != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation must win before querying a closed handle: metadata=%v err=%v", metadata, err)
	}
	got, err := os.ReadFile(target)
	if err != nil || !bytes.Equal(got, original) {
		t.Fatalf("canceled capture changed caller data: %q %v", got, err)
	}
}
