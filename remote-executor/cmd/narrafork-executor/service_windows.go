//go:build windows

package main

/*
Windows service support.

The executor used to be installed with `New-Service`, which registers a real
Windows service. The Service Control Manager then expects the process to connect to
the service control dispatcher and report `SERVICE_RUNNING` within its start
timeout. A plain console program never does, so the SCM terminated it and the start
failed with error 1053 — after an otherwise completely successful install.

This file supplies the missing half. The same binary now works in both roles, and
which one it takes is *detected*, never configured:

  - Launched by the SCM  -> hand control to the dispatcher and run as a service.
  - Launched from a shell -> run inline, exactly as before.

Detection matters more than it looks. A flag (`--service`) would mean the installed
command line and the registration have to agree forever; a mismatch in either
direction yields a process that either hangs at startup or dies at 1053, both with
no useful message. `svc.IsWindowsService()` asks the OS instead, so the two cannot
disagree.
*/

import (
	"context"
	"fmt"
	"log"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/debug"
	"golang.org/x/sys/windows/svc/eventlog"
)

/*
serviceName must match the name used at registration by the generated installer
(`server/lib/executor-install-script.ts`). It is only used for the event log
source; the SCM passes the real name to the dispatcher itself.
*/
const serviceName = "NarraForkExecutor"

// executorService adapts `run` to the svc.Handler interface.
type executorService struct {
	run func(context.Context, func()) error
	// Windows has no stderr for a service, so status/errors go to the Application
	// event log. Without this, a service that fails to start is completely silent.
	elog debug.Log
}

/*
Execute is called by the dispatcher on its own goroutine.

The shape is dictated by the SCM's expectations rather than by preference:
StartPending must be reported immediately, Running as soon as work is under way,
and control requests must keep being answered while the work runs. Blocking here
without reporting is precisely the 1053 failure this file exists to fix.
*/
func (s *executorService) Execute(
	args []string,
	requests <-chan svc.ChangeRequest,
	status chan<- svc.Status,
) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown

	status <- svc.Status{State: svc.StartPending}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runErr := make(chan error, 1)
	// `run` closes over the ready callback: reporting Running is what tells the SCM
	// the start succeeded, and it happens once serving is under way rather than when
	// `run` returns (it does not return until shutdown).
	go func() {
		runErr <- s.run(ctx, func() {
			status <- svc.Status{State: svc.Running, Accepts: accepted}
		})
	}()

	for {
		select {
		case err := <-runErr:
			// The work ended on its own. A nil error is an orderly shutdown; anything
			// else is a fatal condition, and the SCM exit code is what makes a failed
			// service visibly failed instead of merely stopped.
			status <- svc.Status{State: svc.StopPending}
			if err != nil {
				s.elog.Error(1, fmt.Sprintf("executor stopped with error: %v", err))
				return false, 1
			}
			return false, 0

		case req := <-requests:
			switch req.Cmd {
			case svc.Interrogate:
				// The SCM polls for current state; echo it back unchanged.
				status <- req.CurrentStatus

			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				cancel()
				// Wait for the run loop to unwind so in-flight RPCs and the PTY layer get
				// their cleanup. Returning immediately would have the process exit while
				// that is still happening.
				if err := <-runErr; err != nil {
					s.elog.Error(1, fmt.Sprintf("executor shutdown error: %v", err))
					return false, 1
				}
				return false, 0

			default:
				// Unexpected controls are ignored rather than treated as fatal: the
				// service only ever declares Stop/Shutdown as accepted, so anything else
				// arriving is not something it agreed to handle.
				s.elog.Warning(1, fmt.Sprintf("unexpected service control request: %d", req.Cmd))
			}
		}
	}
}

/*
runAsServiceIfLaunchedBySCM runs the executor as a Windows service when the process
was started by the SCM.

Returns (false, nil) for an ordinary console launch so the caller proceeds inline.
*/
func runAsServiceIfLaunchedBySCM(runFn func(context.Context, func()) error) (bool, error) {
	isService, err := svc.IsWindowsService()
	if err != nil {
		// Detection itself failed. Refusing to guess: running inline under the SCM
		// ends in a 1053 that points nowhere near this line.
		return false, fmt.Errorf("could not determine whether this is a service session: %w", err)
	}
	if !isService {
		return false, nil
	}

	// Event log registration is best-effort. It needs administrator rights the first
	// time, and a service that cannot log is still a service that works — so a
	// failure here falls back to a no-op logger rather than aborting the start.
	var elog debug.Log
	if opened, err := eventlog.Open(serviceName); err == nil {
		elog = opened
		defer opened.Close()
	} else {
		elog = noopEventLog{}
	}

	// A service has no stderr; leaving the default would send every log line
	// nowhere and make failures unexplainable.
	log.SetOutput(eventLogWriter{elog: elog})

	elog.Info(1, fmt.Sprintf("%s starting", serviceName))
	if err := svc.Run(serviceName, &executorService{run: runFn, elog: elog}); err != nil {
		elog.Error(1, fmt.Sprintf("%s failed: %v", serviceName, err))
		return true, fmt.Errorf("service dispatcher: %w", err)
	}
	elog.Info(1, fmt.Sprintf("%s stopped", serviceName))
	return true, nil
}

// eventLogWriter redirects the standard logger into the Windows event log.
type eventLogWriter struct{ elog debug.Log }

func (w eventLogWriter) Write(p []byte) (int, error) {
	// Errors are swallowed on purpose: logging must never be able to take down the
	// service it is reporting on.
	_ = w.elog.Info(1, string(p))
	return len(p), nil
}

// noopEventLog is used when the event log source cannot be opened.
type noopEventLog struct{}

func (noopEventLog) Close() error                 { return nil }
func (noopEventLog) Info(uint32, string) error    { return nil }
func (noopEventLog) Warning(uint32, string) error { return nil }
func (noopEventLog) Error(uint32, string) error   { return nil }
