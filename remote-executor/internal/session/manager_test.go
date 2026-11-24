package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"testing"
	"time"
)

// fakeProcess is a scripted Process: the test writes output, observes input,
// and decides when (and with which code) the process exits.
type fakeProcess struct {
	out    *io.PipeReader
	outW   *io.PipeWriter
	mu     sync.Mutex
	input  bytes.Buffer
	size   [2]uint16
	exit   chan int
	once   sync.Once
	killed bool
}

func newFake() *fakeProcess {
	r, w := io.Pipe()
	return &fakeProcess{out: r, outW: w, exit: make(chan int, 1)}
}

func (f *fakeProcess) Read(p []byte) (int, error) { return f.out.Read(p) }
func (f *fakeProcess) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.input.Write(p)
}
func (f *fakeProcess) Resize(c, r uint16) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.size = [2]uint16{c, r}
	return nil
}
func (f *fakeProcess) Kill() error {
	f.mu.Lock()
	f.killed = true
	f.mu.Unlock()
	f.finish(137)
	return nil
}
func (f *fakeProcess) Wait() int    { return <-f.exit }
func (f *fakeProcess) Close() error { return f.out.Close() }

// emit writes process output; it returns once the session pump consumed it.
func (f *fakeProcess) emit(s string) { _, _ = f.outW.Write([]byte(s)) }

// finish ends output and exits with code.
func (f *fakeProcess) finish(code int) {
	f.once.Do(func() {
		_ = f.outW.Close()
		f.exit <- code
	})
}

func (f *fakeProcess) inputString() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.input.String()
}

func testLimits() Limits {
	l := DefaultLimits()
	l.DrainAfter = 200 * time.Millisecond
	return l
}

func open(t *testing.T, m *Manager, id string) *fakeProcess {
	t.Helper()
	p := newFake()
	if _, err := m.Open(id, "pty", func() (Process, error) { return p, nil }); err != nil {
		t.Fatalf("open %s: %v", id, err)
	}
	return p
}

type frame struct {
	channel string
	data    []byte
}

type recorder struct {
	mu     sync.Mutex
	frames []frame
}

func (r *recorder) send(channel string, chunk []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.frames = append(r.frames, frame{channel, append([]byte(nil), chunk...)})
}

func (r *recorder) data() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var b bytes.Buffer
	for _, f := range r.frames {
		if f.channel == ChannelData {
			b.Write(f.data)
		}
	}
	return b.String()
}

func (r *recorder) gaps() []map[string]int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []map[string]int64
	for _, f := range r.frames {
		if f.channel == ChannelGap {
			var g map[string]int64
			_ = json.Unmarshal(f.data, &g)
			out = append(out, g)
		}
	}
	return out
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not reached")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func endSeq(t *testing.T, m *Manager, id string) int64 {
	t.Helper()
	info, err := m.Info(id)
	if err != nil {
		t.Fatal(err)
	}
	return info.EndSeq
}

func TestJournalSequenceTrimAndGap(t *testing.T) {
	j := NewJournal(4)
	j.Append([]byte("abcd"))
	j.Append([]byte("ef"))
	if first, end, _ := j.Bounds(); first != 0 || end != 6 {
		t.Fatalf("bounds before trim = %d,%d", first, end)
	}
	j.Append([]byte("gh")) // 8 bytes > 1.5x retain: keep the last 4
	first, end, _ := j.Bounds()
	if first != 4 || end != 8 {
		t.Fatalf("bounds after trim = %d,%d", first, end)
	}
	res, ok := j.Read(1, 0)
	if !ok || res.GapTo != 4 || len(res.Data) != 0 {
		t.Fatalf("read before first = %+v", res)
	}
	res, _ = j.Read(5, 2)
	if string(res.Data) != "fg" {
		t.Fatalf("read at 5 = %q", res.Data)
	}
	if _, ok := j.Read(9, 0); ok {
		t.Fatal("read beyond end must fail")
	}
	res, _ = j.Read(8, 0)
	if res.Wait == nil || res.EOF {
		t.Fatalf("caught-up read must wait: %+v", res)
	}
	j.Close()
	select {
	case <-res.Wait:
	default:
		t.Fatal("close must wake waiting readers")
	}
	if res, _ := j.Read(8, 0); !res.EOF {
		t.Fatal("closed journal must report EOF at the end")
	}
	j.Append([]byte("late"))
	if _, end, _ := j.Bounds(); end != 8 {
		t.Fatal("append after close must be ignored")
	}
}

func TestDetachedReaderResumesFromSequence(t *testing.T) {
	m := NewManager(testLimits())
	p := open(t, m, "s1")
	p.emit("hello ")

	// First attacher reads, then detaches (connection lost).
	ctx, cancel := context.WithCancel(context.Background())
	first := &recorder{}
	done := make(chan error, 1)
	go func() {
		_, err := m.Attach(ctx, "s1", 0, first.send)
		done <- err
	}()
	waitFor(t, func() bool { return first.data() == "hello " })
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("detach err = %v", err)
	}

	// Output produced while nobody is attached is kept.
	p.emit("world")
	waitFor(t, func() bool { return endSeq(t, m, "s1") == 11 })
	info, _ := m.Info("s1")
	if info.State != "running" {
		t.Fatalf("detaching must not stop the session: %+v", info)
	}

	// A new attacher resumes exactly where the first stopped.
	second := &recorder{}
	go func() {
		_, _ = m.Attach(context.Background(), "s1", 6, second.send)
	}()
	waitFor(t, func() bool { return second.data() == "world" })
	p.finish(3)
	waitFor(t, func() bool {
		info, _ := m.Info("s1")
		return info.State == "exited"
	})
	result, err := m.Attach(context.Background(), "s1", 11, (&recorder{}).send)
	if err != nil || result.ExitCode != 3 || result.EndSeq != 11 {
		t.Fatalf("attach after exit = %+v, %v", result, err)
	}
}

func TestAttachReportsGapBeyondRetention(t *testing.T) {
	limits := testLimits()
	limits.RetainBytes = 4
	m := NewManager(limits)
	p := open(t, m, "s1")
	p.emit("0123456789")
	waitFor(t, func() bool { return endSeq(t, m, "s1") == 10 })
	p.finish(0)
	rec := &recorder{}
	result, err := m.Attach(context.Background(), "s1", 0, rec.send)
	if err != nil {
		t.Fatal(err)
	}
	gaps := rec.gaps()
	if len(gaps) != 1 || gaps[0]["from"] != 0 || gaps[0]["to"] != 6 {
		t.Fatalf("gaps = %v", gaps)
	}
	if rec.data() != "6789" || result.EndSeq != 10 {
		t.Fatalf("data after gap = %q end=%d", rec.data(), result.EndSeq)
	}
	if _, err := m.Attach(context.Background(), "s1", 11, rec.send); !errors.Is(err, ErrSeqOutOfRange) {
		t.Fatalf("since beyond end err = %v", err)
	}
}

func TestSlowReaderNeverBlocksOutput(t *testing.T) {
	limits := testLimits()
	limits.RetainBytes = 8
	limits.ChunkBytes = 2
	m := NewManager(limits)
	p := open(t, m, "s1")
	release := make(chan struct{})
	rec := &recorder{}
	var once sync.Once
	go func() {
		_, _ = m.Attach(context.Background(), "s1", 0, func(c string, b []byte) {
			rec.send(c, b)
			once.Do(func() { <-release }) // stall after the first frame
		})
	}()
	p.emit("ab")
	waitFor(t, func() bool { return rec.data() == "ab" })
	// The attacher is stalled; output must still be consumed without blocking.
	for i := 0; i < 20; i++ {
		p.emit("xxxxxxxxxx")
	}
	waitFor(t, func() bool { return endSeq(t, m, "s1") == 202 })
	close(release)
	p.finish(0)
	waitFor(t, func() bool { return len(rec.gaps()) == 1 })
}

func TestWriteDedupeResizeKillAndRelease(t *testing.T) {
	m := NewManager(testLimits())
	p := open(t, m, "s1")
	if dup, err := m.Write("s1", []byte("ls\n"), "w1"); err != nil || dup {
		t.Fatalf("first write dup=%v err=%v", dup, err)
	}
	if dup, err := m.Write("s1", []byte("ls\n"), "w1"); err != nil || !dup {
		t.Fatalf("retried write dup=%v err=%v", dup, err)
	}
	if _, err := m.Write("s1", []byte("pwd\n"), ""); err != nil {
		t.Fatal(err)
	}
	if p.inputString() != "ls\npwd\n" {
		t.Fatalf("input = %q", p.inputString())
	}
	if _, err := m.Write("s1", make([]byte, testLimits().MaxWriteBytes+1), ""); !errors.Is(err, ErrWriteTooLarge) {
		t.Fatalf("oversized write err = %v", err)
	}
	if err := m.Resize("s1", 120, 40); err != nil || p.size != [2]uint16{120, 40} {
		t.Fatalf("resize err=%v size=%v", err, p.size)
	}
	if err := m.Release("s1"); err == nil {
		t.Fatal("releasing a running session must fail")
	}
	if err := m.Kill("s1"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		info, _ := m.Info("s1")
		return info.State == "exited" && info.ExitCode != nil && *info.ExitCode == 137
	})
	if _, err := m.Write("s1", []byte("x"), "w2"); !errors.Is(err, ErrExited) {
		t.Fatalf("write after exit err = %v", err)
	}
	if dup, _ := m.Write("s1", []byte("ls\n"), "w1"); !dup {
		t.Fatal("an applied writeId stays a duplicate after exit")
	}
	if err := m.Kill("s1"); err != nil {
		t.Fatal("killing an exited session is a no-op")
	}
	if err := m.Release("s1"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Info("s1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("released session err = %v", err)
	}
}

func TestWriteDedupeWindowIsBounded(t *testing.T) {
	limits := testLimits()
	limits.DedupeWrites = 2
	m := NewManager(limits)
	p := open(t, m, "s1")
	for _, id := range []string{"a", "b", "c"} {
		if _, err := m.Write("s1", []byte(id), id); err != nil {
			t.Fatal(err)
		}
	}
	if dup, _ := m.Write("s1", []byte("a"), "a"); dup {
		t.Fatal("ids beyond the window are forgotten")
	}
	if dup, _ := m.Write("s1", []byte("c"), "c"); !dup {
		t.Fatal("recent ids stay deduplicated")
	}
	if p.inputString() != "abca" {
		t.Fatalf("input = %q", p.inputString())
	}
}

func TestOpenValidationLimitsAndTTL(t *testing.T) {
	limits := testLimits()
	limits.MaxSessions = 2
	limits.ExitedTTL = time.Minute
	m := NewManager(limits)
	clock := time.Now()
	m.now = func() time.Time { return clock }

	if _, err := m.Open("bad id!", "pty", nil); !errors.Is(err, ErrInvalidID) {
		t.Fatalf("invalid id err = %v", err)
	}
	failing := errors.New("spawn failed")
	if _, err := m.Open("s0", "pty", func() (Process, error) { return nil, failing }); !errors.Is(err, failing) {
		t.Fatalf("spawn error = %v", err)
	}
	p1 := open(t, m, "s1")
	open(t, m, "s2")
	if _, err := m.Open("s1", "pty", nil); !errors.Is(err, ErrExists) {
		t.Fatalf("duplicate err = %v", err)
	}
	if _, err := m.Open("s3", "pty", nil); !errors.Is(err, ErrTooMany) {
		t.Fatalf("limit err = %v", err)
	}
	p1.finish(0)
	waitFor(t, func() bool {
		info, _ := m.Info("s1")
		return info.State == "exited"
	})
	// Exited but within TTL: still counts and is still readable.
	if _, err := m.Open("s3", "pty", nil); !errors.Is(err, ErrTooMany) {
		t.Fatalf("limit within ttl err = %v", err)
	}
	clock = clock.Add(2 * time.Minute)
	open(t, m, "s3")
	ids := []string{}
	for _, info := range m.List() {
		ids = append(ids, info.SessionID)
	}
	if len(ids) != 2 || ids[0] != "s2" || ids[1] != "s3" {
		t.Fatalf("list after ttl = %v", ids)
	}
}

func TestDrainIsBoundedWhenOutputOutlivesProcess(t *testing.T) {
	m := NewManager(testLimits())
	p := newFake()
	if _, err := m.Open("s1", "pty", func() (Process, error) { return p, nil }); err != nil {
		t.Fatal(err)
	}
	// The process exits but a descendant keeps the output open.
	p.exit <- 0
	waitFor(t, func() bool {
		info, _ := m.Info("s1")
		return info.State == "exited"
	})
}

func TestShutdownKillsRunningSessionsAndRefusesNew(t *testing.T) {
	m := NewManager(testLimits())
	p := open(t, m, "s1")
	m.Shutdown()
	waitFor(t, func() bool {
		p.mu.Lock()
		defer p.mu.Unlock()
		return p.killed
	})
	if _, err := m.Open("s2", "pty", func() (Process, error) { return newFake(), nil }); err == nil {
		t.Fatal("open after shutdown must fail")
	}
}

func TestMultipleAttachersProgressIndependently(t *testing.T) {
	m := NewManager(testLimits())
	p := open(t, m, "s1")
	a, b := &recorder{}, &recorder{}
	go func() { _, _ = m.Attach(context.Background(), "s1", 0, a.send) }()
	p.emit("one")
	waitFor(t, func() bool { return a.data() == "one" })
	go func() { _, _ = m.Attach(context.Background(), "s1", 0, b.send) }()
	p.emit("two")
	p.finish(0)
	waitFor(t, func() bool { return a.data() == "onetwo" && b.data() == "onetwo" })
}
