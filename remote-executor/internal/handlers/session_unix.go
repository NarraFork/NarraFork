//go:build !windows

package handlers

import (
	"errors"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/narrafork/remote-executor/internal/session"
)

// ptyProcess is a session.Process backed by a Unix PTY. pty.Start makes the
// child a session leader, so its process group id equals its pid.
type ptyProcess struct {
	cmd       *exec.Cmd
	ptmx      *os.File
	closeOnce sync.Once
}

// startPtyProcess starts cmdArgs on a new PTY. No context is attached: the
// process lives until it exits or the session is killed.
func startPtyProcess(cmdArgs []string, cwd string, env []string, cols, rows uint16) (session.Process, error) {
	cmd := exec.Command(cmdArgs[0], cmdArgs[1:]...)
	cmd.Dir = cwd
	cmd.Env = env
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, err
	}
	return &ptyProcess{cmd: cmd, ptmx: ptmx}, nil
}

func (p *ptyProcess) Read(b []byte) (int, error)  { return p.ptmx.Read(b) }
func (p *ptyProcess) Write(b []byte) (int, error) { return p.ptmx.Write(b) }

func (p *ptyProcess) Resize(cols, rows uint16) error {
	return pty.Setsize(p.ptmx, &pty.Winsize{Cols: cols, Rows: rows})
}

// Kill stops everything the terminal started. An interactive shell with job
// control puts each job in its own process group, so signalling the shell's
// group alone would leave `cmd &` jobs running; the whole PTY session (whose
// id is the shell's pid, since pty.Start makes it a session leader) is stopped.
func (p *ptyProcess) Kill() error {
	if p.cmd.Process == nil {
		return nil
	}
	killPtySession(p.cmd.Process.Pid)
	// Best effort: the session kill usually reaps the shell first.
	_ = p.cmd.Process.Kill()
	return nil
}

func (p *ptyProcess) Wait() int {
	err := p.cmd.Wait()
	return exitCodeFromError(err, p.cmd)
}

func (p *ptyProcess) Close() error {
	var err error
	p.closeOnce.Do(func() { err = p.ptmx.Close() })
	return err
}

// execProcess is a session.Process for a shell command without a terminal:
// stdout and stderr share one pipe whose write end only the command holds, so
// output survives this executor's readers falling behind or detaching. The
// command is a session leader (setsid), so Kill reaches everything it started,
// including descendants that moved to another process group.
type execProcess struct {
	cmd       *exec.Cmd
	out       *os.File
	closeOnce sync.Once
	deadline  *time.Timer

	mu       sync.Mutex
	reaped   bool
	timedOut bool
}

// startExecProcess starts cmdArgs with stdin from /dev/null. A positive timeout
// kills the command when it expires, whether or not anyone is attached.
func startExecProcess(cmdArgs []string, cwd string, env []string, timeout time.Duration) (session.Process, error) {
	r, w, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(cmdArgs[0], cmdArgs[1:]...)
	cmd.Dir = cwd
	cmd.Env = env
	cmd.Stdout = w
	cmd.Stderr = w
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		_ = r.Close()
		_ = w.Close()
		return nil, err
	}
	// Only the command (and what it starts) may hold the write end, so the read
	// side sees end of output once they have all exited or closed it.
	_ = w.Close()
	p := &execProcess{cmd: cmd, out: r}
	if timeout > 0 {
		p.deadline = time.AfterFunc(timeout, func() {
			p.mu.Lock()
			if !p.reaped {
				p.timedOut = true
			}
			p.mu.Unlock()
			_ = p.Kill()
		})
	}
	return p, nil
}

func (p *execProcess) Read(b []byte) (int, error) { return p.out.Read(b) }

func (p *execProcess) Write([]byte) (int, error) {
	return 0, errors.New("exec sessions take no input")
}

func (p *execProcess) Resize(uint16, uint16) error { return nil }

// Kill stops the command's whole session. After the command has been reaped
// its pid may name an unrelated process, so nothing is signalled then.
func (p *execProcess) Kill() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.reaped || p.cmd.Process == nil {
		return nil
	}
	killPtySession(p.cmd.Process.Pid)
	_ = p.cmd.Process.Kill()
	return nil
}

func (p *execProcess) Wait() int {
	err := p.cmd.Wait()
	p.mu.Lock()
	p.reaped = true
	p.mu.Unlock()
	if p.deadline != nil {
		p.deadline.Stop()
	}
	return exitCodeFromError(err, p.cmd)
}

// TimedOut reports whether the deadline stopped the command (session.DeadlineReporter).
func (p *execProcess) TimedOut() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.timedOut
}

func (p *execProcess) Close() error {
	var err error
	p.closeOnce.Do(func() { err = p.out.Close() })
	return err
}
