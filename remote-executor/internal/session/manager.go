package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	State     string `json:"state"` // "running" | "exited"
	ExitCode  *int   `json:"exitCode,omitempty"`
	StartedAt string `json:"startedAt"`
	ExitedAt  string `json:"exitedAt,omitempty"`
	FirstSeq  int64  `json:"firstSeq"`
	EndSeq    int64  `json:"endSeq"`
}

// Session is one long-lived process with its output journal.
type Session struct {
	id        string
	kind      string
	proc      Process
	journal   *Journal
	limits    Limits
	startedAt time.Time

	mu       sync.Mutex
	exited   bool
	exitCode int
	exitedAt time.Time

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
			delete(m.sessions, id)
		}
	}
}

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
	m.mu.Unlock()

	proc, err := start()
	if err != nil {
		m.mu.Lock()
		if m.sessions[id] == s {
			delete(m.sessions, id)
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
				s.journal.Append(buf[:n])
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
		s.mu.Lock()
		s.exited = true
		s.exitCode = code
		s.exitedAt = m.now()
		s.mu.Unlock()
		// Exit facts are visible before attachers observe end of output.
		s.journal.Close()
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

// Kill stops a session's process. Killing an exited session is a no-op.
func (m *Manager) Kill(id string) error {
	s, err := m.get(id)
	if err != nil {
		return err
	}
	if exited, _, _ := s.exitState(); exited {
		return nil
	}
	return s.proc.Kill()
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
	delete(m.sessions, id)
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
			result := AttachResult{ExitCode: code, EndSeq: pos}
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
