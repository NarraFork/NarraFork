package session

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// DiskStore keeps each session's output journal and exit facts on disk, so a
// restarted executor can still serve what a session printed and how it ended.
//
//	<dir>/<sessionId>/meta.json           metadata and exit facts (atomic replace)
//	<dir>/<sessionId>/seg-<firstSeq>.log  output, at most SegmentBytes per file
//
// Segments are append-only and are deleted whole once they fall entirely before
// the retention window. Segments are fsynced when they are closed, not on every
// write: output written in the last moments before a power loss may be missing,
// which a reader then sees as the end of what was recorded.
type DiskStore struct {
	dir          string
	segmentBytes int64
}

// DefaultSegmentBytes bounds one output segment file.
const DefaultSegmentBytes = 1 << 20

// NewDiskStore uses dir (created with owner-only permissions) for session state.
func NewDiskStore(dir string) (*DiskStore, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &DiskStore{dir: dir, segmentBytes: DefaultSegmentBytes}, nil
}

// storedMeta is a session's meta.json.
type storedMeta struct {
	Version   int       `json:"version"`
	SessionID string    `json:"sessionId"`
	Kind      string    `json:"kind"`
	StartedAt time.Time `json:"startedAt"`
	Exited    bool      `json:"exited"`
	ExitCode  int       `json:"exitCode"`
	ExitedAt  time.Time `json:"exitedAt,omitempty"`
	TimedOut  bool      `json:"timedOut,omitempty"`
	// Lost: the executor stopped while the process was running, so its outcome
	// was never observed. Written when a restarted executor first finds it.
	Lost bool `json:"lost,omitempty"`
	// OutputIncomplete: recording the output failed at some point (write, sync
	// or close), so the stored output may be missing bytes. The exit is still
	// recorded.
	OutputIncomplete bool `json:"outputIncomplete,omitempty"`
}

const metaVersion = 1

func (st *DiskStore) sessionDir(id string) string { return filepath.Join(st.dir, id) }

func writeMeta(dir string, meta storedMeta) error {
	meta.Version = metaVersion
	data, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	tmp := filepath.Join(dir, "meta.json.tmp")
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, filepath.Join(dir, "meta.json")); err != nil {
		return err
	}
	syncDir(dir)
	return nil
}

// syncDir makes a rename durable where the platform allows it.
func syncDir(dir string) {
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
}

func segmentName(firstSeq int64) string { return fmt.Sprintf("seg-%020d.log", firstSeq) }

type segment struct {
	first int64
	path  string
	size  int64
}

// listSegments returns a session's segments ordered by first sequence number.
func listSegments(dir string) ([]segment, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var segs []segment
	for _, e := range entries {
		name := e.Name()
		if !e.Type().IsRegular() || !strings.HasPrefix(name, "seg-") || !strings.HasSuffix(name, ".log") {
			continue
		}
		var first int64
		if _, err := fmt.Sscanf(name, "seg-%d.log", &first); err != nil || first < 0 {
			continue
		}
		info, err := e.Info()
		if err != nil {
			return nil, err
		}
		segs = append(segs, segment{first: first, path: filepath.Join(dir, name), size: info.Size()})
	}
	sort.Slice(segs, func(i, j int) bool { return segs[i].first < segs[j].first })
	return segs, nil
}

// sessionLog writes one session's output segments and meta. It is used by the
// session's single reader goroutine and, after that has finished, by the exit
// path, so it needs no lock of its own.
type sessionLog struct {
	dir          string
	segmentBytes int64
	retain       int64
	meta         storedMeta
	f            *os.File
	segFirst     int64
	segLen       int64
	// failed: output recording stopped after an error; the exit is still recorded.
	failed bool
}

// Create starts a fresh record for a session, replacing any leftover one.
func (st *DiskStore) Create(meta storedMeta, retain int) (*sessionLog, error) {
	dir := st.sessionDir(meta.SessionID)
	if err := os.RemoveAll(dir); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if err := writeMeta(dir, meta); err != nil {
		return nil, err
	}
	return &sessionLog{dir: dir, segmentBytes: st.segmentBytes, retain: int64(retain), meta: meta}, nil
}

// Append records p, whose first byte has sequence number seq. After the first
// failure the output is no longer recorded (the session itself is unaffected)
// and the error is returned once.
func (l *sessionLog) Append(seq int64, p []byte) error {
	if l.failed {
		return nil
	}
	err := l.append(seq, p)
	if err != nil {
		l.fail()
	}
	return err
}

func (l *sessionLog) append(seq int64, p []byte) error {
	if l.f == nil || l.segLen >= l.segmentBytes {
		if err := l.rotate(seq); err != nil {
			return err
		}
	}
	n, err := l.f.Write(p)
	l.segLen += int64(n)
	return err
}

// fail stops output recording and closes the open segment.
func (l *sessionLog) fail() {
	l.failed = true
	if l.f != nil {
		_ = l.f.Close()
		l.f = nil
	}
}

// closeSegment syncs and closes the open segment, reporting either failure: a
// deferred write error may only surface here.
func (l *sessionLog) closeSegment() error {
	if l.f == nil {
		return nil
	}
	syncErr := l.f.Sync()
	closeErr := l.f.Close()
	l.f = nil
	return errors.Join(syncErr, closeErr)
}

// rotate closes the current segment durably, opens one starting at seq, and
// deletes segments that lie entirely before the retention window.
func (l *sessionLog) rotate(seq int64) error {
	if err := l.closeSegment(); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(l.dir, segmentName(seq)), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	l.f, l.segFirst, l.segLen = f, seq, 0
	segs, err := listSegments(l.dir)
	if err != nil {
		return err
	}
	keepFrom := seq - l.retain
	for i := 0; i+1 < len(segs); i++ {
		if segs[i+1].first <= keepFrom {
			_ = os.Remove(segs[i].path)
		}
	}
	return nil
}

// Exit closes the output durably and records how the session ended. The exit
// is recorded even when the output could not be: that is marked instead, and
// the output error is returned alongside any error writing the exit itself.
func (l *sessionLog) Exit(code int, at time.Time, timedOut bool) error {
	outputErr := l.closeSegment()
	if outputErr != nil {
		l.failed = true
	}
	l.meta.Exited, l.meta.ExitCode, l.meta.ExitedAt, l.meta.TimedOut = true, code, at, timedOut
	l.meta.OutputIncomplete = l.failed
	return errors.Join(outputErr, writeMeta(l.dir, l.meta))
}

// Remove deletes a session's record.
func (st *DiskStore) Remove(id string) error { return os.RemoveAll(st.sessionDir(id)) }

// restoredSession is one session found on disk by Load.
type restoredSession struct {
	meta     storedMeta
	firstSeq int64
	data     []byte // bytes [firstSeq, firstSeq+len(data))
	// storageErr: the record was read but could not be updated (it is restored anyway).
	storageErr error
}

// Load reads every recorded session. Running sessions recorded by an executor
// that is gone are marked lost (and persisted as such, so the time they were
// found is kept across further restarts). At most retain bytes of output are
// read per session. Unreadable records are removed.
func (st *DiskStore) Load(retain int, now time.Time) ([]restoredSession, error) {
	entries, err := os.ReadDir(st.dir)
	if err != nil {
		return nil, err
	}
	var out []restoredSession
	for _, e := range entries {
		if !e.IsDir() || !validID.MatchString(e.Name()) {
			continue
		}
		dir := st.sessionDir(e.Name())
		r, err := loadSession(dir, e.Name(), int64(retain))
		if err != nil {
			_ = os.RemoveAll(dir)
			continue
		}
		if !r.meta.Exited {
			r.meta.Exited, r.meta.Lost, r.meta.ExitCode, r.meta.ExitedAt = true, true, -1, now
			// A store that can no longer be written (read-only, full) still serves what
			// it holds; only the found time may then be renewed by a later restart.
			r.storageErr = writeMeta(dir, r.meta)
		}
		out = append(out, r)
	}
	return out, nil
}

func loadSession(dir, id string, retain int64) (restoredSession, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		return restoredSession{}, err
	}
	var meta storedMeta
	if err := json.Unmarshal(raw, &meta); err != nil {
		return restoredSession{}, err
	}
	if meta.Version != metaVersion || meta.SessionID != id {
		return restoredSession{}, errors.New("unrecognized session record")
	}
	segs, err := listSegments(dir)
	if err != nil {
		return restoredSession{}, err
	}
	if len(segs) == 0 {
		return restoredSession{meta: meta}, nil
	}
	// Only the last contiguous run of segments is used: a hole (a segment lost to
	// a crash) ends what can be served in order.
	start := len(segs) - 1
	for start > 0 && segs[start-1].first+segs[start-1].size == segs[start].first {
		start--
	}
	segs = segs[start:]
	end := segs[len(segs)-1].first + segs[len(segs)-1].size
	first := segs[0].first
	if end-first > retain {
		first = end - retain
	}
	data := make([]byte, 0, end-first)
	for _, seg := range segs {
		segEnd := seg.first + seg.size
		if segEnd <= first {
			continue
		}
		f, err := os.Open(seg.path)
		if err != nil {
			return restoredSession{}, err
		}
		from := int64(0)
		if seg.first < first {
			from = first - seg.first
		}
		if _, err := f.Seek(from, io.SeekStart); err != nil {
			_ = f.Close()
			return restoredSession{}, err
		}
		chunk, err := io.ReadAll(io.LimitReader(f, seg.size-from))
		_ = f.Close()
		if err != nil {
			return restoredSession{}, err
		}
		data = append(data, chunk...)
	}
	// A segment cut short by a crash leaves fewer bytes than its size promised.
	return restoredSession{meta: meta, firstSeq: end - int64(len(data)), data: data}, nil
}
