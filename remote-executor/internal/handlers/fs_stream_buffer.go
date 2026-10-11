package handlers

import "unsafe"

const conditionalStreamInfoBytes = 65536

// FILE_STREAM_INFO requires an eight-byte (LONGLONG) boundary. A byte array
// has alignment one, including on a Go stack. Overallocate only seven bytes
// and take an explicitly aligned slice; indexing preserves pointer provenance.
// The query's fixed 64KiB budget and fail-closed stream policy are unchanged.
func newConditionalStreamInfoBuffer() []byte {
	storage := make([]byte, conditionalStreamInfoBytes+7)
	offset := int((8 - uintptr(unsafe.Pointer(&storage[0]))%8) % 8)
	return storage[offset : offset+conditionalStreamInfoBytes]
}
