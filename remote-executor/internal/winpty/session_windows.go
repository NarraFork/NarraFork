//go:build windows

package winpty

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var activeSessions atomic.Int64

// Session owns the real worker and duplicated shell handles, never PID-only
// evidence. All native ConPTY calls run in the same-executable worker.
type Session struct {
	job                  windows.Handle
	worker               windows.ProcessInformation
	shell                windows.Handle
	input                *os.File
	output               *os.File
	commands             chan frame
	chunks               chan []byte
	outputQueue          *byteQueue
	deliveryDone         chan struct{}
	prepared             chan error
	ready                chan error
	readDone             chan struct{}
	stop                 chan struct{}
	done                 chan struct{}
	closeOnce            sync.Once
	queued               atomic.Int64
	mu                   sync.Mutex
	reason               string
	result               Result
	receivedBytes        atomic.Uint64
	lastWorkerDiagnostic string
	readError            string
}

// Start installs the worker Job, pipe readers and process observer while the
// worker is suspended. Resume must be called only after registry installation.
func Start(ctx context.Context, opts Options) (*Session, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !Supported() {
		return nil, fmt.Errorf("native ConPTY requires Windows build 17763 and available APIs")
	}
	if !validSize(opts.Cols, opts.Rows) {
		return nil, fmt.Errorf("invalid ConPTY size")
	}
	if activeSessions.Add(1) > MaxSessions {
		activeSessions.Add(-1)
		return nil, fmt.Errorf("ConPTY executor session capacity exceeded")
	}
	started := false
	defer func() {
		if !started {
			activeSessions.Add(-1)
		}
	}()
	job, err := newJob()
	if err != nil {
		return nil, err
	}
	var childIn, parentIn, parentOut, childOut windows.Handle
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), InheritHandle: 1}
	if err = windows.CreatePipe(&childIn, &parentIn, &sa, 0); err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	if err = windows.CreatePipe(&parentOut, &childOut, &sa, 0); err != nil {
		windows.CloseHandle(childIn)
		windows.CloseHandle(parentIn)
		windows.CloseHandle(job)
		return nil, err
	}
	closePipes := func() {
		windows.CloseHandle(childIn)
		windows.CloseHandle(parentIn)
		windows.CloseHandle(parentOut)
		windows.CloseHandle(childOut)
	}
	if err = windows.SetHandleInformation(parentIn, windows.HANDLE_FLAG_INHERIT, 0); err != nil {
		closePipes()
		windows.CloseHandle(job)
		return nil, err
	}
	if err = windows.SetHandleInformation(parentOut, windows.HANDLE_FLAG_INHERIT, 0); err != nil {
		closePipes()
		windows.CloseHandle(job)
		return nil, err
	}
	// This restricted process handle allows the worker to transfer a real shell
	// wait handle. No Job, transport, vault, token, or helper handle is inherited.
	var parent windows.Handle
	err = windows.DuplicateHandle(windows.CurrentProcess(), windows.CurrentProcess(), windows.CurrentProcess(), &parent,
		windows.PROCESS_DUP_HANDLE, true, 0)
	if err != nil {
		closePipes()
		windows.CloseHandle(job)
		return nil, err
	}
	defer windows.CloseHandle(parent)
	attributes, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		closePipes()
		windows.CloseHandle(job)
		return nil, err
	}
	defer attributes.Delete()
	inherited := []windows.Handle{childIn, childOut, parent}
	if err = attributes.Update(windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, unsafe.Pointer(&inherited[0]), uintptr(len(inherited))*unsafe.Sizeof(inherited[0])); err != nil {
		closePipes()
		windows.CloseHandle(job)
		return nil, err
	}
	si := windows.StartupInfoEx{ProcThreadAttributeList: attributes.List()}
	si.Cb = uint32(unsafe.Sizeof(si))
	si.Flags = windows.STARTF_USESTDHANDLES
	// Control pipes are private explicit handles, NEVER standard handles. A
	// ConPTY client must not inherit our JSON pipe as redirected stdout/stdin.
	si.StdInput = 0
	si.StdOutput = 0
	si.StdErr = 0
	exe, err := os.Executable()
	if err != nil {
		closePipes()
		windows.CloseHandle(job)
		return nil, err
	}
	// Only worker bootstrap environment, never device bearer/helper credentials.
	bootstrapEnv := []string{"SystemRoot=" + os.Getenv("SystemRoot"), "PATH=" + os.Getenv("PATH"), "TEMP=" + os.Getenv("TEMP"), "TMP=" + os.Getenv("TMP")}
	pi, err := createProcess([]string{exe, WorkerFlag, strconv.FormatUint(uint64(parent), 10), strconv.FormatUint(uint64(childIn), 10), strconv.FormatUint(uint64(childOut), 10)}, opts.Cwd, bootstrapEnv, &si.StartupInfo, true)
	if err != nil {
		closePipes()
		windows.CloseHandle(job)
		return nil, err
	}
	if err = windows.AssignProcessToJobObject(job, pi.Process); err != nil {
		windows.TerminateProcess(pi.Process, 1)
		windows.WaitForSingleObject(pi.Process, 5000)
		windows.CloseHandle(pi.Thread)
		windows.CloseHandle(pi.Process)
		closePipes()
		windows.CloseHandle(job)
		return nil, err
	}
	windows.CloseHandle(childIn)
	windows.CloseHandle(childOut)
	s := &Session{job: job, worker: pi, input: os.NewFile(uintptr(parentIn), "worker-control"), output: os.NewFile(uintptr(parentOut), "worker-events"),
		commands: make(chan frame, 64), chunks: make(chan []byte), outputQueue: newByteQueue(MaxQueueBytes - MaxOutputChunk), deliveryDone: make(chan struct{}), prepared: make(chan error, 1), ready: make(chan error, 1), readDone: make(chan struct{}), stop: make(chan struct{}), done: make(chan struct{}), reason: "exited"}
	started = true
	go s.writeLoop()
	go s.readLoop()
	go s.deliverLoop()
	go s.observe(ctx)
	if err = s.enqueue(frame{Kind: "init", Options: &opts}); err == nil {
		_, err = windows.ResumeThread(pi.Thread)
	}
	windows.CloseHandle(pi.Thread)
	if err != nil {
		s.Close("startup_failed")
		return s, err
	}
	return s, nil
}

func (s *Session) Prepare(ctx context.Context) error {
	select {
	case err := <-s.prepared:
		return err
	case <-s.done:
		return fmt.Errorf("ConPTY worker exited before preparing a shell")
	case <-s.stop:
		return fmt.Errorf("ConPTY closed before preparing a shell")
	case <-ctx.Done():
		s.Close("cancelled")
		return ctx.Err()
	case <-time.After(15 * time.Second):
		s.Close("startup_failed")
		return fmt.Errorf("ConPTY worker ready deadline exceeded")
	}
}

func (s *Session) enqueue(f frame) error {
	size := int64(len(f.Data))
	if s.queued.Add(size) > MaxQueueBytes {
		s.queued.Add(-size)
		s.Close("io_failed")
		return fmt.Errorf("ConPTY input_overrun")
	}
	select {
	case <-s.stop:
		s.queued.Add(-size)
		return fmt.Errorf("ConPTY session closing")
	case s.commands <- f:
		return nil
	default:
		s.queued.Add(-size)
		s.Close("io_failed")
		return fmt.Errorf("ConPTY control queue exceeded")
	}
}
func (s *Session) writeLoop() {
	for {
		select {
		case <-s.done:
			return
		case f := <-s.commands:
			err := writeFrame(s.input, f)
			s.queued.Add(-int64(len(f.Data)))
			if err != nil {
				s.Close("io_failed")
				return
			}
		}
	}
}
func (s *Session) deliverLoop() {
	defer close(s.deliveryDone)
	for {
		data, ok := s.outputQueue.pop(s.done)
		if !ok {
			return
		}
		select {
		case s.chunks <- data:
		case <-s.done:
			return
		}
	}
}

func (s *Session) readLoop() {
	defer close(s.readDone)
	defer s.outputQueue.close()
	defer s.output.Close()
	r := bufio.NewReaderSize(s.output, MaxFrameBytes)
	for {
		f, err := readFrame(r)
		if err != nil {
			s.mu.Lock()
			s.readError = fmt.Sprintf("%T: %v", err, err)
			s.mu.Unlock()
			// EOF after worker exit is normal; malformed/failed live control IO
			// must explicitly terminate instead of silently losing all output.
			if !errors.Is(err, io.EOF) {
				s.Close("io_failed")
			}
			return
		}
		switch f.Kind {
		case "prepared":
			handle := windows.Handle(f.Handle)
			if handle == 0 {
				s.prepared <- fmt.Errorf("missing native shell handle")
				s.Close("startup_failed")
				return
			}
			// The handle was duplicated directly into this process, not opened by PID.
			pid, err := windows.GetProcessId(handle)
			var inJob bool
			if err == nil {
				inJob, err = isProcessInJob(handle, s.job)
			}
			if err != nil || pid != f.PID || !inJob {
				windows.CloseHandle(handle)
				s.prepared <- fmt.Errorf("native shell Job/handle proof failed")
				s.Close("startup_failed")
				return
			}
			s.mu.Lock()
			s.shell = handle
			s.mu.Unlock()
			s.prepared <- nil
		case "ready":
			select {
			case s.ready <- nil:
			default:
			}
		case "diagnostic":
			s.mu.Lock()
			s.lastWorkerDiagnostic = f.Error
			s.mu.Unlock()
		case "output":
			s.receivedBytes.Add(uint64(len(f.Data)))
			if len(f.Data) > MaxOutputChunk {
				s.Close("io_failed")
				return
			}
			if !s.outputQueue.push(f.Data) {
				s.mu.Lock()
				s.lastWorkerDiagnostic = "parent_output_overrun"
				s.mu.Unlock()
				s.Close("io_failed")
				return
			}
		case "error":
			s.mu.Lock()
			s.lastWorkerDiagnostic = f.Error
			s.mu.Unlock()
			s.Close("io_failed")
		default:
			s.Close("io_failed")
			return
		}
	}
}

func (s *Session) Resume(ctx context.Context) error {
	if err := s.enqueue(frame{Kind: "resume"}); err != nil {
		return err
	}
	select {
	case err := <-s.ready:
		return err
	case <-s.stop:
		return fmt.Errorf("ConPTY closed before ready")
	case <-ctx.Done():
		s.Close("cancelled")
		return ctx.Err()
	case <-time.After(15 * time.Second):
		s.Close("startup_failed")
		return fmt.Errorf("ConPTY resume deadline exceeded")
	}
}
func (s *Session) Write(data []byte) error {
	if len(data) > MaxInputChunk {
		return fmt.Errorf("ConPTY input exceeds %d bytes", MaxInputChunk)
	}
	// Base64 in the bounded worker protocol requires smaller internal fragments.
	for len(data) > 0 {
		n := len(data)
		if n > MaxOutputChunk {
			n = MaxOutputChunk
		}
		if err := s.enqueue(frame{Kind: "input", Data: append([]byte(nil), data[:n]...)}); err != nil {
			return err
		}
		data = data[n:]
	}
	return nil
}
func (s *Session) Resize(cols, rows int16) error {
	if !validSize(cols, rows) {
		return fmt.Errorf("invalid ConPTY size")
	}
	return s.enqueue(frame{Kind: "resize", Cols: cols, Rows: rows})
}
func (s *Session) Close(reason string) {
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.reason = reason
		s.mu.Unlock()
		close(s.stop)
		// Priority close is best effort only. The independent Job watchdog below
		// still fires if a full input pipe prevents delivery to the worker.
		select {
		case s.commands <- frame{Kind: "close"}:
		default:
		}
	})
}
func (s *Session) Output() <-chan []byte { return s.chunks }
func (s *Session) Done() <-chan struct{} { return s.done }
func (s *Session) Wait() Result          { <-s.done; s.mu.Lock(); defer s.mu.Unlock(); return s.result }

// DebugState is bounded and contains no command, environment, credentials or
// terminal contents. Native tests use it only when an actual observation fails.
func (s *Session) DebugState() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	workerWait, workerErr := windows.WaitForSingleObject(s.worker.Process, 0)
	var shellWait uint32
	var shellErr error
	if s.shell != 0 {
		shellWait, shellErr = windows.WaitForSingleObject(s.shell, 0)
	}
	active, jobErr := activeProcesses(s.job)
	return map[string]any{"workerWait": workerWait, "workerWaitError": fmt.Sprint(workerErr), "shellWait": shellWait, "shellWaitError": fmt.Sprint(shellErr), "jobActive": active, "jobError": fmt.Sprint(jobErr), "receivedOutputBytes": s.receivedBytes.Load(), "queuedInputBytes": s.queued.Load(), "queuedOutputChunks": len(s.chunks), "queuedOutputBytes": s.outputQueue.length(), "lastWorkerDiagnostic": s.lastWorkerDiagnostic, "readError": s.readError}
}

func (s *Session) observe(ctx context.Context) {
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	var closeStarted time.Time
	workerExited := false
	var exitCode *uint32
	for {
		s.mu.Lock()
		shell := s.shell
		s.mu.Unlock()
		if shell != 0 && exitCode == nil {
			status, err := windows.WaitForSingleObject(shell, 0)
			if err == nil && status == windows.WAIT_OBJECT_0 {
				var code uint32
				if windows.GetExitCodeProcess(shell, &code) == nil {
					exitCode = &code
				}
				s.Close("exited")
			}
		}
		status, err := windows.WaitForSingleObject(s.worker.Process, 0)
		workerExited = err == nil && status == windows.WAIT_OBJECT_0
		if workerExited {
			s.Close("io_failed")
		}
		select {
		case <-ctx.Done():
			s.Close("cancelled")
		default:
		}
		select {
		case <-s.stop:
			if closeStarted.IsZero() {
				closeStarted = time.Now()
			}
		default:
		}
		active, queryErr := activeProcesses(s.job)
		if workerExited && queryErr == nil && active == 0 {
			// Re-read the actual process handle after complete tree termination.
			if shell != 0 && exitCode == nil {
				status, err = windows.WaitForSingleObject(shell, 0)
				if err == nil && status == windows.WAIT_OBJECT_0 {
					var code uint32
					if windows.GetExitCodeProcess(shell, &code) == nil {
						exitCode = &code
					}
				}
			}
			select {
			case <-s.readDone:
				s.mu.Lock()
				overflow := s.reason == "io_failed"
				s.mu.Unlock()
				delivered := false
				select {
				case <-s.deliveryDone:
					delivered = true
				default:
				}
				if overflow || delivered {
					s.complete(exitCode, true)
					return
				}
			default:
				// The worker has exited, but its pipe can still hold final UTF-8/VT
				// bytes. Never close that reader before its independent drain ends.
			}
		}
		if !closeStarted.IsZero() {
			elapsed := time.Since(closeStarted)
			if elapsed >= 2*time.Second {
				_ = windows.TerminateJobObject(s.job, 1)
			}
			if elapsed >= 5*time.Second {
				s.complete(exitCode, workerExited && queryErr == nil && active == 0)
				return
			}
		}
		<-ticker.C
	}
}
func (s *Session) complete(code *uint32, treeStopped bool) {
	drained := false
	select {
	case <-s.readDone:
		drained = true
	default:
	}
	// Job close is the last-resort kill, not evidence of successful termination.
	clean := windows.CloseHandle(s.job) == nil
	if err := s.input.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
		clean = false
	}
	if err := s.output.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
		clean = false
	}
	s.mu.Lock()
	if s.shell != 0 && windows.CloseHandle(s.shell) != nil {
		clean = false
	}
	s.mu.Unlock()
	if windows.CloseHandle(s.worker.Process) != nil {
		clean = false
	}
	s.mu.Lock()
	s.result = Result{ExitCode: code, TreeStopped: treeStopped, CleanupComplete: treeStopped && drained && clean, Reason: s.reason}
	s.mu.Unlock()
	activeSessions.Add(-1)
	close(s.done)
}
