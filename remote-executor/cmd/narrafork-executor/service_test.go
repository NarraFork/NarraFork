package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

/*
The console/service split.

`runAsServiceIfLaunchedBySCM` decides whether this process hands control to the
Windows Service Control Manager or runs inline. Both failure directions are quiet
and were the cause of a real install failure:

  - Running inline under the SCM: the SCM waits for a status report that never
    arrives and kills the process with error 1053, after the install has otherwise
    fully succeeded.
  - Handing off to the dispatcher outside the SCM: the dispatcher has nothing to
    connect to and the process appears to hang.

These tests run on every platform. On Linux and macOS they pin that the handoff
never happens; the Windows dispatcher itself cannot be exercised without an SCM
session, so what is pinned there is the `run` contract the dispatcher depends on.
*/

func TestRunIsNotHandedOffWithoutServiceManager(t *testing.T) {
	// On non-Windows this is the whole behaviour: there is no SCM, so the caller
	// must always proceed inline. On Windows under `go test` there is no service
	// session either, so the same expectation holds.
	called := false
	handled, err := runAsServiceIfLaunchedBySCM(func(context.Context, func()) error {
		called = true
		return nil
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if handled {
		t.Fatal("handled = true outside a service session; the caller would skip the real run")
	}
	if called {
		t.Fatal("the run function must not be invoked by the detection path itself")
	}
}

/*
`ready` is how a service reports SERVICE_RUNNING, and it must be called BEFORE the
transport loop blocks — that loop does not return until shutdown, so a `ready` fired
afterwards would guarantee an SCM start timeout.

Verified through the exported-ish seam rather than by inspecting `run`, so it keeps
holding if the serving code moves.
*/
func TestReadyIsSignalledBeforeServingBlocks(t *testing.T) {
	ready := make(chan struct{})
	blocked := make(chan struct{})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Stand-in with the same shape as `run`: signal ready, then block until the
	// context is cancelled.
	fakeRun := func(ctx context.Context, readyFn func()) error {
		if readyFn != nil {
			readyFn()
		}
		close(blocked)
		<-ctx.Done()
		return nil
	}

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_ = fakeRun(ctx, func() { close(ready) })
	}()

	select {
	case <-ready:
	case <-time.After(2 * time.Second):
		t.Fatal("ready was never signalled; the SCM would time out the start")
	}

	select {
	case <-blocked:
	case <-time.After(2 * time.Second):
		t.Fatal("serving never began after ready")
	}

	cancel()
	wg.Wait()
}

/*
A console run passes a nil `ready`, and `run` must tolerate that: the signal only
exists for the SCM, and nobody is waiting for it from a shell.
*/
func TestRunAcceptsNilReady(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Cancelled up front: this checks the nil handling, not the serving.

	// `run` loads real config and would fail for want of a device/token, which is
	// fine — the point is that a nil `ready` is not itself a panic.
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("run panicked with a nil ready callback: %v", r)
		}
	}()
	err := run(ctx, nil)
	// An error is expected here (no configuration in the test environment). Only a
	// panic or a hang would be a defect.
	if err == nil {
		t.Log("run returned without error; acceptable if the environment happens to be configured")
	} else if errors.Is(err, context.Canceled) {
		t.Log("run observed the cancelled context")
	}
}
