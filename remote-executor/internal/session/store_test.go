package session

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newStoreManager(t *testing.T, dir string, limits Limits) *Manager {
	t.Helper()
	st, err := NewDiskStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	st.segmentBytes = 8
	m := NewManager(limits)
	if err := m.UseStore(st); err != nil {
		t.Fatal(err)
	}
	return m
}

func attachText(t *testing.T, m *Manager, id string, since int64) (string, AttachResult, []map[string]int64) {
	t.Helper()
	var rec recorder
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result, err := m.Attach(ctx, id, since, rec.send)
	if err != nil {
		t.Fatalf("attach %s: %v", id, err)
	}
	return rec.data(), result, rec.gaps()
}

// A restarted executor still serves a finished session's output and exit, and
// reports a session that was running when the old process stopped as lost,
// after the output that reached the disk.
func TestRestoredSessionsKeepOutputAndExitOrReportLost(t *testing.T) {
	dir := t.TempDir()
	before := newStoreManager(t, dir, testLimits())
	done := open(t, before, "done")
	done.emit("build ok\n")
	done.finish(3)
	waitFor(t, func() bool {
		info, _ := before.Info("done")
		return info.State == "exited"
	})
	running := open(t, before, "running")
	running.emit("halfway\n")
	waitFor(t, func() bool { return endSeq(t, before, "running") == 8 })
	// The executor process dies here: nothing else is written.

	after := newStoreManager(t, dir, testLimits())
	text, result, _ := attachText(t, after, "done", 0)
	if text != "build ok\n" || result.ExitCode != 3 || result.Lost {
		t.Fatalf("restored exited session = %q %+v", text, result)
	}
	info, err := after.Info("running")
	if err != nil || info.State != "lost" || info.ExitCode != nil {
		t.Fatalf("restored running session info = %+v, %v", info, err)
	}
	text, result, _ = attachText(t, after, "running", 0)
	if text != "halfway\n" || !result.Lost || result.EndSeq != 8 {
		t.Fatalf("restored running session = %q %+v", text, result)
	}
	// A reader that had seen more than reached the disk is told the end at once.
	text, result, _ = attachText(t, after, "running", 20)
	if text != "" || !result.Lost || result.EndSeq != 8 {
		t.Fatalf("attach beyond the recorded end = %q %+v", text, result)
	}
	if _, err := after.Write("running", []byte("x"), ""); err == nil {
		t.Fatal("a lost session must not take input")
	}

	// The time a lost session was found survives further restarts (its TTL runs
	// from then), and releasing it deletes its record.
	again := newStoreManager(t, dir, testLimits())
	if a, b := mustInfo(t, after, "running").ExitedAt, mustInfo(t, again, "running").ExitedAt; a != b {
		t.Fatalf("lost time changed across restarts: %s -> %s", a, b)
	}
	if err := again.Kill("running", true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "running")); !os.IsNotExist(err) {
		t.Fatalf("released session record still on disk: %v", err)
	}
}

func mustInfo(t *testing.T, m *Manager, id string) Info {
	t.Helper()
	info, err := m.Info(id)
	if err != nil {
		t.Fatal(err)
	}
	return info
}

// Only the retention window is kept on disk; a restored reader that starts
// before it gets the same gap it would have got from the live journal.
func TestStoreKeepsOnlyTheRetentionWindow(t *testing.T) {
	dir := t.TempDir()
	limits := testLimits()
	limits.RetainBytes = 16
	before := newStoreManager(t, dir, limits)
	p := open(t, before, "s1")
	for i := 0; i < 10; i++ {
		p.emit("0123456789")
	}
	p.finish(0)
	waitFor(t, func() bool { return mustInfo(t, before, "s1").State == "exited" })
	segs, err := listSegments(filepath.Join(dir, "s1"))
	if err != nil {
		t.Fatal(err)
	}
	var onDisk int64
	for _, seg := range segs {
		onDisk += seg.size
	}
	// Whole segments are deleted, so at most one segment beyond the window remains.
	if onDisk > 16+8+10 {
		t.Fatalf("%d bytes on disk in %d segments for a 16-byte window", onDisk, len(segs))
	}

	after := newStoreManager(t, dir, limits)
	text, result, gaps := attachText(t, after, "s1", 0)
	if result.EndSeq != 100 || text != strings.Repeat("0123456789", 10)[84:] {
		t.Fatalf("restored = %q %+v", text, result)
	}
	if len(gaps) != 1 || gaps[0]["from"] != 0 || gaps[0]["to"] != 84 {
		t.Fatalf("gaps = %v", gaps)
	}
}

// A disk that stops accepting writes costs the record, never the session.
func TestStorageFailureKeepsTheSessionRunning(t *testing.T) {
	dir := t.TempDir()
	m := newStoreManager(t, dir, testLimits())
	p := open(t, m, "s1")
	p.emit("first!!!")
	waitFor(t, func() bool { return endSeq(t, m, "s1") == 8 })
	if err := os.RemoveAll(filepath.Join(dir, "s1")); err != nil {
		t.Fatal(err)
	}
	p.emit("second!!") // the next segment cannot be created
	waitFor(t, func() bool { return mustInfo(t, m, "s1").StorageError != "" })
	p.emit("third")
	p.finish(0)
	text, result, _ := attachText(t, m, "s1", 0)
	if text != "first!!!second!!third" || result.ExitCode != 0 {
		t.Fatalf("session output = %q %+v", text, result)
	}
}

func TestUnreadableRecordsAreDropped(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "broken"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "broken", "meta.json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	m := newStoreManager(t, dir, testLimits())
	if _, err := m.Info("broken"); err == nil {
		t.Fatal("an unreadable record must not be restored")
	}
	if _, err := os.Stat(filepath.Join(dir, "broken")); !os.IsNotExist(err) {
		t.Fatalf("unreadable record kept: %v", err)
	}
}
