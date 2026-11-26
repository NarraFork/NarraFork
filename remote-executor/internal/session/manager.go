package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"sync"
	"time"
)

// Process is a running session process as the manager sees it: a byte stream
// of output, an input sink, a window size, and an exit status.
type Process interface {
	// Read blocks for output; it returns an error once output has ended.
	Read(p []byte) (int, error)
	Write(p []byte) (int, error)
	Resize(cols, rows uint16) error
	// Kill stops the process (and its children where the platform allows).
	Kill() error
	// Wait blocks until the process exits and returns its exit code.
	Wait() int
	// Close releases the output side so a blocked Read returns.
	Close() error
}

// DeadlineReporter is implemented by a Process that enforces its own deadline;
// TimedOut, read after Wait, reports whether the deadline stopped it.
type DeadlineReporter interface {
	TimedOut() bool
}

// Limits bounds what the manager keeps in memory.
type Limits struct {
	RetainBytes   int           // output kept per session
	MaxSessions   int           // running + exited-but-unreleased sessions
	ExitedTTL     time.Duration // exited sessions are released after this
	MaxWriteBytes int           // largest single input write
	ChunkBytes    int           // largest data frame sent to an attacher
	DedupeWrites  int           // recent writeIds remembered per session
	DrainAfter    time.Duration // output drain window after the process exits
}

// DefaultLimits are the protocol defaults documented in GENERAL_EXECUTOR-DESIGN.md.
func DefaultLimits() Limits {
	return Limits{
		RetainBytes:   4 << 20,
		MaxSessions:   64,
		ExitedTTL:     24 * time.Hour,
		MaxWriteBytes: 1 << 20,
		ChunkBytes:    32 << 10,
		DedupeWrites:  256,
		DrainAfter:    2 * time.Second,
	}
}

var (
	ErrNotFound      = errors.New("session not found")
	ErrExists        = errors.New("session already exists")
	ErrTooMany       = errors.New("too many sessions")
	ErrExited        = errors.New("session has exited")
	ErrInvalidID     = errors.New("invalid session id")
	ErrSeqOutOfRange = errors.New("sequence is beyond the end of output")
	ErrWriteTooLarge = errors.New("write exceeds the size limit")
)

var validID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// Info is a session's externally visible state.
type Info struct {
	SessionID string `json:"sessionId"`
	Kind      string `json:"kind"`
	// "running" | "exited" | "lost" (a previous executor process stopped while
	// it ran: its output up to then is served, its outcome is unknown)
	State     string `json:"state"`
	ExitCode  *int   `json:"exitCode,omitempty"`
	StartedAt string `json:"startedAt"`
	ExitedAt  string `json:"exitedAt,omitempty"`
	// TimedOut: the process's own deadline stopped it (see DeadlineReporter).
	TimedOut bool  `json:"timedOut,omitempty"`
	FirstSeq int64 `json:"firstSeq"`
	// StorageError: the output stopped being recorded on disk (it is still served
	// from memory while this executor runs).
	StorageError string `json:"storageError,omitempty"`
	EndSeq       int64  `json:"endSeq"`
}

// Session is one long-lived process with its output journal.
type Session struct {
	id        string
	kind      string
	proc      Process
	journal   *Journal
	limits    Limits
	startedAt time.Time

	mu            sync.Mutex
	exited        bool
	exitCode      int
	exitedAt      time.Time
	timedOut      bool
	releaseOnExit bool
	// killRequested: a kill arrived while the process was still starting; it is
	// stopped as soon as it exists.
	killRequested bool
	// lost: restored from disk after the executor process that ran it stopped.
	lost       bool
	log        *sessionLog
	storageErr error

	writeMu  sync.Mutex
	seen     map[string]struct{}
	seenList []string
}

func (s *Session) info() Info {
	first, end, _ := s.journal.Bounds()
	s.mu.Lock()
	defer s.mu.Unlock()
	info := Info{
		SessionID: s.id,
		Kind:      s.kind,
		State:     "running",
		StartedAt: s.startedAt.UTC().Format(time.RFC3339Nano),
		FirstSeq:  first,
		EndSeq:    end,
	}
	if s.exited {
		code := s.exitCode
		info.State = "exited"
		info.ExitCode = &code
		info.ExitedAt = s.exitedAt.UTC().Format(time.RFC3339Nano)
		info.TimedOut = s.timedOut
		if s.lost {
			info.State = "lost"
			info.ExitCode = nil
		}
	}
	if s.storageErr != nil {
		info.StorageError = s.storageErr.Error()
	}
	return info
}

func (s *Session) exitState() (bool, int, time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.exited, s.exitCode, s.exitedAt
}

// Manager is the process-wide session registry. It outlives every connection.
type Manager struct {
	limits Limits
	now    func() time.Time

	mu       sync.Mutex
	sessions map[string]*Session
	closed   bool
	store    *DiskStore
}

// NewManager returns an empty manager.
func NewManager(limits Limits) *Manager {
	return &Manager{limits: limits, now: time.Now, sessions: make(map[string]*Session)}
}

// sweepLocked releases exited sessions past their TTL.
func (m *Manager) sweepLocked() {
	cutoff := m.now().Add(-m.limits.ExitedTTL)
	for id, s := range m.sessions {
		if exited, _, at := s.exitState(); exited && at.Before(cutoff) {
			m.dropLocked(id)
		}
	}
}

// dropLocked forgets a session and deletes its record on disk.
func (m *Manager) dropLocked(id string) {
	delete(m.sessions, id)
	if m.store != nil {
		_ = m.store.Remove(id)
	}
}

// UseStore records sessions in st from now on, and restores the ones a previous
// executor process left there: exited sessions keep their output and exit, and
// sessions that were still running come back as lost. Call before serving.
func (m *Manager) UseStore(st *DiskStore) error {
	restored, err := st.Load(m.limits.RetainBytes, m.now())
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.store = st
	for _, r := range restored {
		if _, ok := m.sessions[r.meta.SessionID]; ok {
			continue
		}
		m.sessions[r.meta.SessionID] = &Session{
			id:        r.meta.SessionID,
			kind:      r.meta.Kind,
			proc:      endedProcess{},
			journal:   restoredJournal(m.limits.RetainBytes, r.firstSeq, r.data),
			limits:    m.limits,
			startedAt: r.meta.StartedAt,
			exited:    true,
			exitCode:  r.meta.ExitCode,
			exitedAt:  r.meta.ExitedAt,
			timedOut:  r.meta.TimedOut,
			lost:      r.meta.Lost,
			seen:      make(map[string]struct{}),
		}
		switch {
		case r.storageErr != nil:
			m.sessions[r.meta.SessionID].storageErr = r.storageErr
		case r.meta.OutputIncomplete:
			m.sessions[r.meta.SessionID].storageErr = errors.New("the recorded output is incomplete")
		}
	}
	return nil
}

// endedProcess stands in for the process of a session restored from disk.
type endedProcess struct{}

func (endedProcess) Read([]byte) (int, error)  { return 0, io.EOF }
func (endedProcess) Write([]byte) (int, error) { return 0, ErrExited }
func (endedProcess) Resize(uint16, uint16) error {
	return ErrExited
}
func (endedProcess) Kill() error  { return nil }
func (endedProcess) Wait() int    { return -1 }
func (endedProcess) Close() error { return nil }

// Open registers id, starts its process via start, and returns immediately.
// The process keeps running until it exits or Kill is called; no connection
// or request context governs it.
func (m *Manager) Open(id, kind string, start func() (Process, error)) (Info, error) {
	if !validID.MatchString(id) {
		return Info{}, ErrInvalidID
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return Info{}, errors.New("executor is shutting down")
	}
	m.sweepLocked()
	if _, ok := m.sessions[id]; ok {
		m.mu.Unlock()
		return Info{}, ErrExists
	}
	if len(m.sessions) >= m.limits.MaxSessions {
		m.mu.Unlock()
		return Info{}, ErrTooMany
	}
	// Reserve the id before starting so a concurrent Open cannot start twice.
	s := &Session{
		id:        id,
		kind:      kind,
		journal:   NewJournal(m.limits.RetainBytes),
		limits:    m.limits,
		startedAt: m.now(),
		seen:      make(map[string]struct{}),
	}
	m.sessions[id] = s
	store := m.store
	m.mu.Unlock()

	// Recording is best effort: a full or failing disk costs persistence, never
	// the session.
	if store != nil {
		log, err := store.Create(storedMeta{SessionID: id, Kind: kind, StartedAt: s.startedAt}, m.limits.RetainBytes)
		if err != nil {
			s.storageErr = err
		} else {
			s.log = log
		}
	}

	proc, err := start()
	if err != nil {
		m.mu.Lock()
		if m.sessions[id] == s {
			m.dropLocked(id)
		}
		m.mu.Unlock()
		return Info{}, err
	}
	// Publish under the registry lock: get/List read proc under it. A Shutdown
	// that ran while the process was starting must not leave it unowned.
	m.mu.Lock()
	if m.closed {
		delete(m.sessions, id)
		m.mu.Unlock()
		_ = proc.Kill()
		_ = proc.Close()
		go proc.Wait()
		return Info{}, errors.New("executor is shutting down")
	}
	s.proc = proc
	m.mu.Unlock()
	m.run(s)
	s.mu.Lock()
	killNow := s.killRequested
	s.mu.Unlock()
	if killNow {
		_ = proc.Kill()
	}
	return s.info(), nil
}

// run pumps output into the journal and records the exit once both the
// process has exited and its output has drained (bounded by DrainAfter, since
// a background descendant may hold the terminal open indefinitely).
func (m *Manager) run(s *Session) {
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		buf := make([]byte, 32<<10)
		for {
			n, err := s.proc.Read(buf)
			if n > 0 {
				seq := s.journal.Append(buf[:n])
				if s.log != nil {
					// The log stops recording output after a failure but stays, so the
					// exit is still recorded.
					if werr := s.log.Append(seq, buf[:n]); werr != nil {
						s.mu.Lock()
						s.storageErr = werr
						s.mu.Unlock()
					}
				}
			}
			if err != nil {
				return
			}
		}
	}()
	go func() {
		code := s.proc.Wait()
		select {
		case <-readDone:
		case <-time.After(m.limits.DrainAfter):
			_ = s.proc.Close()
			<-readDone
		}
		_ = s.proc.Close()
		timedOut := false
		if r, ok := s.proc.(DeadlineReporter); ok {
			timedOut = r.TimedOut()
		}
		exitedAt := m.now()
		// The record on disk is final before anyone can observe the exit.
		if s.log != nil {
			if err := s.log.Exit(code, exitedAt, timedOut); err != nil {
				s.mu.Lock()
				s.storageErr = err
				s.mu.Unlock()
			}
		}
		s.mu.Lock()
		s.exited = true
		s.exitCode = code
		s.timedOut = timedOut
		s.exitedAt = exitedAt
		release := s.releaseOnExit
		s.mu.Unlock()
		// Exit facts are visible before attachers observe end of output.
		s.journal.Close()
		if release {
			m.forget(s)
		}
	}()
}

func (m *Manager) get(id string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	if !ok || s.proc == nil {
		return nil, ErrNotFound
	}
	return s, nil
}

// Info returns one session's state.
func (m *Manager) Info(id string) (Info, error) {
	s, err := m.get(id)
	if err != nil {
		return Info{}, err
	}
	return s.info(), nil
}

// List returns every registered session, oldest first.
func (m *Manager) List() []Info {
	m.mu.Lock()
	m.sweepLocked()
	sessions := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		if s.proc != nil {
			sessions = append(sessions, s)
		}
	}
	m.mu.Unlock()
	out := make([]Info, 0, len(sessions))
	for _, s := range sessions {
		out = append(out, s.info())
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].StartedAt != out[j].StartedAt {
			return out[i].StartedAt < out[j].StartedAt
		}
		return out[i].SessionID < out[j].SessionID
	})
	return out
}

// Write sends input. A non-empty writeID already applied to this session is
// acknowledged as a duplicate without writing again, so a caller can retry a
// write whose acknowledgement was lost without running a command twice.
func (m *Manager) Write(id string, data []byte, writeID string) (duplicate bool, err error) {
	s, err := m.get(id)
	if err != nil {
		return false, err
	}
	if len(data) > m.limits.MaxWriteBytes {
		return false, ErrWriteTooLarge
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if writeID != "" {
		if _, ok := s.seen[writeID]; ok {
			return true, nil
		}
	}
	if exited, _, _ := s.exitState(); exited {
		return false, ErrExited
	}
	if _, err := s.proc.Write(data); err != nil {
		return false, err
	}
	if writeID != "" {
		s.seen[writeID] = struct{}{}
		s.seenList = append(s.seenList, writeID)
		if len(s.seenList) > s.limits.DedupeWrites {
			delete(s.seen, s.seenList[0])
			s.seenList = s.seenList[1:]
		}
	}
	return false, nil
}

// Resize changes the window size of a running session.
func (m *Manager) Resize(id string, cols, rows uint16) error {
	s, err := m.get(id)
	if err != nil {
		return err
	}
	if exited, _, _ := s.exitState(); exited {
		return ErrExited
	}
	return s.proc.Resize(cols, rows)
}

// Kill stops a session's process. With release, the session is also forgotten
// as soon as its exit is recorded, so a caller that has already persisted what
// it needs never races the exit with a separate Release. Killing an exited
// session is a no-op (and, with release, releases it now).
func (m *Manager) Kill(id string, release bool) error {
	m.mu.Lock()
	s, ok := m.sessions[id]
	starting := ok && s.proc == nil
	m.mu.Unlock()
	if !ok {
		return ErrNotFound
	}
	if starting {
		// Reserved by an Open still starting the process: answering "not found"
		// would let the caller drop its stop while the process comes up. Open
		// stops it as soon as it exists.
		s.mu.Lock()
		s.killRequested = true
		if release {
			s.releaseOnExit = true
		}
		s.mu.Unlock()
		return nil
	}
	s.mu.Lock()
	exited := s.exited
	if release && !exited {
		s.releaseOnExit = true
	}
	s.mu.Unlock()
	if exited {
		if release {
			m.forget(s)
		}
		return nil
	}
	return s.proc.Kill()
}

// forget removes s from the registry if it is still the registered session.
func (m *Manager) forget(s *Session) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sessions[s.id] == s {
		m.dropLocked(s.id)
	}
}

// Release forgets an exited session and its output. A running session must be
// killed first, so releasing never stops a process implicitly.
func (m *Manager) Release(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	if !ok || s.proc == nil {
		return nil
	}
	if exited, _, _ := s.exitState(); !exited {
		return fmt.Errorf("session %q is still running; kill it before releasing", id)
	}
	m.dropLocked(id)
	return nil
}

// Shutdown kills every running session and refuses new ones. Sessions belong
// to this process: when it exits their terminals close regardless.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	m.closed = true
	sessions := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		if s.proc != nil {
			sessions = append(sessions, s)
		}
	}
	m.mu.Unlock()
	for _, s := range sessions {
		if exited, _, _ := s.exitState(); !exited {
			_ = s.proc.Kill()
		}
	}
}

// Stream channels sent to an attacher.
const (
	ChannelData = "session.data"
	ChannelGap  = "session.gap"
	ChannelExit = "session.exit"
)

// AttachResult is returned when an attached session's output has ended.
type AttachResult struct {
	ExitCode int   `json:"exitCode"`
	EndSeq   int64 `json:"endSeq"`
	TimedOut bool  `json:"timedOut,omitempty"`
	// Lost: the executor process that ran the session stopped while it was
	// running; the output up to EndSeq is all that was recorded and ExitCode is
	// meaningless.
	Lost bool `json:"lost,omitempty"`
}

// Attach streams output from since until the session ends or ctx is done.
// Data frames are contiguous: the receiver derives each byte's sequence number
// from since plus the bytes received, adjusted by any gap frame. Cancelling ctx
// only detaches this reader; the session keeps running.
func (m *Manager) Attach(
	ctx context.Context,
	id string,
	since int64,
	send func(channel string, chunk []byte),
) (AttachResult, error) {
	s, err := m.get(id)
	if err != nil {
		return AttachResult{}, err
	}
	pos := since
	s.mu.Lock()
	lost := s.lost
	s.mu.Unlock()
	if _, end, _ := s.journal.Bounds(); lost && since > end {
		// The reader saw output that never reached the disk before the crash:
		// nothing more is coming, and nothing it has needs replaying.
		result := AttachResult{ExitCode: -1, EndSeq: end, Lost: true}
		payload, _ := json.Marshal(result)
		send(ChannelExit, payload)
		return result, nil
	}
	for {
		res, ok := s.journal.Read(pos, s.limits.ChunkBytes)
		if !ok {
			return AttachResult{}, ErrSeqOutOfRange
		}
		if err := ctx.Err(); err != nil {
			return AttachResult{}, err
		}
		if res.GapTo > pos {
			gap, _ := json.Marshal(map[string]int64{"from": pos, "to": res.GapTo})
			send(ChannelGap, gap)
			pos = res.GapTo
			continue
		}
		if len(res.Data) > 0 {
			send(ChannelData, res.Data)
			pos += int64(len(res.Data))
			continue
		}
		if res.EOF {
			_, code, _ := s.exitState()
			s.mu.Lock()
			timedOut := s.timedOut
			s.mu.Unlock()
			result := AttachResult{ExitCode: code, EndSeq: pos, TimedOut: timedOut, Lost: lost}
			payload, _ := json.Marshal(result)
			send(ChannelExit, payload)
			return result, nil
		}
		select {
		case <-res.Wait:
		case <-ctx.Done():
			return AttachResult{}, ctx.Err()
		}
	}
}
