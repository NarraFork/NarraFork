// Package session owns long-lived executor sessions (an interactive PTY today)
// independently of any transport connection. A connection only attaches to a
// session's output journal; closing it never stops the session.
package session

import "sync"

// Journal is a bounded, append-only record of a session's output. Every byte
// has a sequence number equal to its offset since the session started, so a
// reader can resume from the last byte it consumed. Only the most recent
// retain bytes are kept; a reader that falls behind them is told exactly which
// range it missed instead of silently skipping it.
//
// Writers never wait for readers: Append only copies into memory, so a slow
// or absent consumer can never stall the process producing output.
type Journal struct {
	mu       sync.Mutex
	retain   int
	buf      []byte // bytes [firstSeq, endSeq)
	firstSeq int64
	endSeq   int64
	closed   bool
	changed  chan struct{} // closed and replaced whenever buf or closed changes
}

// NewJournal returns a journal keeping the most recent retain bytes (minimum 1).
func NewJournal(retain int) *Journal {
	if retain < 1 {
		retain = 1
	}
	return &Journal{retain: retain, changed: make(chan struct{})}
}

func (j *Journal) notifyLocked() {
	close(j.changed)
	j.changed = make(chan struct{})
}

// Append records p and returns the sequence number of its first byte. It is a
// no-op after Close.
func (j *Journal) Append(p []byte) int64 {
	j.mu.Lock()
	defer j.mu.Unlock()
	start := j.endSeq
	if len(p) == 0 || j.closed {
		return start
	}
	j.buf = append(j.buf, p...)
	j.endSeq += int64(len(p))
	// Trim lazily (at 1.5x) so the copy cost is amortized over many appends,
	// while memory stays bounded by 1.5x retain.
	if len(j.buf) > j.retain+j.retain/2 {
		drop := len(j.buf) - j.retain
		kept := make([]byte, j.retain, j.retain+j.retain/2)
		copy(kept, j.buf[drop:])
		j.buf = kept
		j.firstSeq += int64(drop)
	}
	j.notifyLocked()
	return start
}

// restoredJournal is a closed journal holding output read back from disk:
// data are the bytes [first, first+len(data)).
func restoredJournal(retain int, first int64, data []byte) *Journal {
	j := NewJournal(retain)
	j.buf = data
	j.firstSeq = first
	j.endSeq = first + int64(len(data))
	j.closed = true
	return j
}

// Close marks the end of output. Readers drain what is retained, then see EOF.
func (j *Journal) Close() {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed {
		return
	}
	j.closed = true
	j.notifyLocked()
}

// Bounds reports the retained range [first, end) and whether output has ended.
func (j *Journal) Bounds() (first, end int64, closed bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.firstSeq, j.endSeq, j.closed
}

// ReadResult is one step of reading the journal from a sequence number.
type ReadResult struct {
	// GapTo > the requested seq means [seq, GapTo) is no longer retained.
	GapTo int64
	// Data are the bytes starting at the requested seq (or at GapTo after a gap).
	Data []byte
	// EOF is true when everything up to the end has been read and output ended.
	EOF bool
	// Wait is closed when more data arrives or output ends; set only when the
	// caller has caught up and should block.
	Wait <-chan struct{}
}

// Read returns up to max bytes starting at seq. seq must not exceed the end.
func (j *Journal) Read(seq int64, max int) (ReadResult, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if seq > j.endSeq || seq < 0 {
		return ReadResult{}, false
	}
	if seq < j.firstSeq {
		return ReadResult{GapTo: j.firstSeq}, true
	}
	if seq < j.endSeq {
		start := int(seq - j.firstSeq)
		end := len(j.buf)
		if max > 0 && end-start > max {
			end = start + max
		}
		data := make([]byte, end-start)
		copy(data, j.buf[start:end])
		return ReadResult{GapTo: seq, Data: data}, true
	}
	if j.closed {
		return ReadResult{GapTo: seq, EOF: true}, true
	}
	return ReadResult{GapTo: seq, Wait: j.changed}, true
}
