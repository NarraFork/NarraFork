package winpty

import "sync"

// byteQueue bounds bytes rather than packet count. ConPTY can emit many tiny VT
// updates; 32 packets is NOT equivalent to the advertised 1MiB byte budget.
type byteQueue struct {
	mu     sync.Mutex
	data   []byte
	head   int
	size   int
	closed bool
	notify chan struct{}
}

func newByteQueue(capacity int) *byteQueue {
	return &byteQueue{data: make([]byte, capacity), notify: make(chan struct{}, 1)}
}
func (q *byteQueue) signal() {
	select {
	case q.notify <- struct{}{}:
	default:
	}
}
func (q *byteQueue) push(data []byte) bool {
	q.mu.Lock()
	if q.closed || len(data) > len(q.data)-q.size {
		q.mu.Unlock()
		return false
	}
	tail := (q.head + q.size) % len(q.data)
	n := copy(q.data[tail:], data)
	copy(q.data, data[n:])
	q.size += len(data)
	q.mu.Unlock()
	q.signal()
	return true
}
func (q *byteQueue) pop(done <-chan struct{}) ([]byte, bool) {
	for {
		q.mu.Lock()
		if q.size > 0 {
			n := q.size
			if n > MaxOutputChunk {
				n = MaxOutputChunk
			}
			out := make([]byte, n)
			copied := copy(out, q.data[q.head:])
			copy(out[copied:], q.data[:n-copied])
			q.head = (q.head + n) % len(q.data)
			q.size -= n
			q.mu.Unlock()
			return out, true
		}
		closed := q.closed
		q.mu.Unlock()
		if closed {
			return nil, false
		}
		select {
		case <-done:
			return nil, false
		case <-q.notify:
		}
	}
}
func (q *byteQueue) close()      { q.mu.Lock(); q.closed = true; q.mu.Unlock(); q.signal() }
func (q *byteQueue) length() int { q.mu.Lock(); defer q.mu.Unlock(); return q.size }
