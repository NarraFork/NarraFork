//go:build !windows

package handlers

import (
	"os"
	"os/exec"
	"sync"
	"syscall"

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

// Kill stops the whole process group, so jobs started from the shell go too.
func (p *ptyProcess) Kill() error {
	if p.cmd.Process == nil {
		return nil
	}
	_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGKILL)
	return p.cmd.Process.Kill()
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
