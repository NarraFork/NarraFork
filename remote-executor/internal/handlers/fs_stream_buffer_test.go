package handlers

import (
	"testing"
	"unsafe"
)

func TestConditionalStreamInfoBufferFixedBudgetAndAlignment(t *testing.T) {
	for iteration := 0; iteration < 64; iteration++ {
		buffer := newConditionalStreamInfoBuffer()
		address := uintptr(unsafe.Pointer(&buffer[0]))
		if address%8 != 0 || len(buffer) != 65536 || cap(buffer) < len(buffer) || cap(buffer) > 65543 {
			t.Fatalf("stream query buffer address=%#x alignment=%d len=%d cap=%d", address, address%8, len(buffer), cap(buffer))
		}
		buffer[len(buffer)-1] = 1
	}
}
