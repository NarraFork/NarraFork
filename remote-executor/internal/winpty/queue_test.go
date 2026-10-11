package winpty

import (
	"bytes"
	"sync"
	"testing"
)

func TestByteQueueTinyUpdatesUseByteBudget(t *testing.T) {
	q := newByteQueue(1024)
	for i := 0; i < 1024; i++ {
		if !q.push([]byte{byte(i)}) {
			t.Fatalf("tiny update %d hit a packet-count limit instead of byte budget", i)
		}
	}
	if q.push([]byte{1}) {
		t.Fatal("byte budget exceeded")
	}
	q.close()
	data, ok := q.pop(nil)
	if !ok || len(data) != 1024 {
		t.Fatal(len(data), ok)
	}
	for i, value := range data {
		if value != byte(i) {
			t.Fatal("ordered bytes changed")
		}
	}
	if _, ok = q.pop(nil); ok {
		t.Fatal("closed empty queue did not finish")
	}
}
func TestByteQueueWrapAndChunkLimits(t *testing.T) {
	q := newByteQueue(MaxQueueBytes - MaxOutputChunk)
	expected := bytes.Repeat([]byte("abc"), 10000)
	if !q.push(expected) {
		t.Fatal("push failed")
	}
	first, ok := q.pop(nil)
	if !ok || !bytes.Equal(first, expected) {
		t.Fatal("first bytes changed")
	}
	second := bytes.Repeat([]byte{7}, MaxOutputChunk+17)
	if !q.push(second) {
		t.Fatal("wrap push failed")
	}
	q.close()
	var actual []byte
	for {
		part, ok := q.pop(nil)
		if !ok {
			break
		}
		if len(part) > MaxOutputChunk {
			t.Fatal("chunk limit exceeded")
		}
		actual = append(actual, part...)
	}
	if !bytes.Equal(actual, second) {
		t.Fatal("wrapped bytes changed")
	}
}
func TestByteQueueConcurrentDrain(t *testing.T) {
	q := newByteQueue(4096)
	var group sync.WaitGroup
	group.Add(1)
	received := make(chan int, 1)
	go func() {
		defer group.Done()
		count := 0
		for {
			data, ok := q.pop(nil)
			if !ok {
				break
			}
			count += len(data)
		}
		received <- count
	}()
	if !q.push(bytes.Repeat([]byte{1}, 2048)) {
		t.Fatal("initial push failed")
	}
	q.close()
	group.Wait()
	if <-received != 2048 {
		t.Fatal("concurrent drain lost bytes")
	}
}
