package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/narrafork/remote-executor/internal/handlers"
	"github.com/narrafork/remote-executor/internal/rpc"
)

// Trusted Host bootstrap only. This branch runs before device config/SCM setup,
// never reads registration credentials, and exposes no shell or general FS RPC.
func runEditorStdio(args []string) error {
	flags := flag.NewFlagSet("editor-stdio", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	root := flags.String("root", "", "Host-authorized execution scope")
	state := flags.String("state-dir", "", "private durable editor directory")
	epoch := flags.String("epoch", "", "trusted Host runtime epoch (local only)")
	hostReceipts := flags.String("host-receipts-dir", "", "trusted Host private receipt directory (stdio only)")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || !filepath.IsAbs(*root) || !filepath.IsAbs(*state) {
		return fmt.Errorf("editor-stdio requires absolute --root and --state-dir")
	}
	canonical, err := filepath.EvalSymlinks(*root)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		// A deleted scope still permits metadata-only historical receipt query.
		// PathGuard drops the unresolved allow (fail closed); no file IO is granted.
		canonical = filepath.Clean(*root)
	}
	if canonical == filepath.Dir(canonical) {
		return fmt.Errorf("editor-stdio execution scope cannot be a filesystem root")
	}
	guard := handlers.NewPathGuard([]string{canonical})
	h := handlers.NewWithOptions(guard, 128*1024, true)
	engine, err := handlers.NewEditorEngine(h, *state)
	if err != nil {
		return err
	}
	if *epoch != "" {
		if err = engine.SetLocalEpoch(*epoch); err != nil {
			return err
		}
	}
	if *hostReceipts != "" {
		if err = engine.ConfigureHostReceipts(*hostReceipts); err != nil {
			return fmt.Errorf("native Host receipt store: %w", err)
		}
	}
	h.SetEditorEngine(engine)
	dispatcher := rpc.NewDispatcher(h)
	defer dispatcher.CloseEditorReads()
	// A helper is a bounded child, not a daemon. Even a blocked stdout consumer
	// cannot keep it alive beyond the session deadline. Host queries after exit.
	watchdog := time.AfterFunc(5*time.Minute, func() { fmt.Fprintln(os.Stderr, "editor-stdio session deadline"); os.Exit(1) })
	defer watchdog.Stop()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	type input struct {
		line []byte
		err  error
	}
	lines := make(chan input, 1)
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 4096), 128*1024)
		for scanner.Scan() {
			line := append([]byte(nil), scanner.Bytes()...)
			select {
			case lines <- input{line: line}:
			case <-ctx.Done():
				return
			}
		}
		select {
		case lines <- input{err: scanner.Err()}:
		case <-ctx.Done():
		}
		close(lines)
	}()
	var inputBytes, outputBytes int64
	for count := 0; count < 2048; count++ {
		timer := time.NewTimer(10 * time.Second)
		var next input
		var ok bool
		select {
		case next, ok = <-lines:
			timer.Stop()
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
			return fmt.Errorf("editor-stdio idle timeout")
		}
		if !ok {
			return nil
		}
		if next.err != nil {
			return next.err
		}
		if next.line == nil {
			return nil
		}
		inputBytes += int64(len(next.line))
		if inputBytes > 128*1024*1024 {
			return fmt.Errorf("editor-stdio input budget exceeded")
		}
		var req rpc.RequestFrame
		if err = json.Unmarshal(next.line, &req); err != nil {
			return fmt.Errorf("invalid editor-stdio JSON frame")
		}
		if req.Type != "rpc" || len(req.ID) == 0 || len(req.ID) > 256 {
			return fmt.Errorf("invalid editor-stdio request envelope")
		}
		allowed := false
		switch req.Method {
		case "editor.capabilities", "fs.stat", "editor.stage.open", "editor.stage.append", "editor.stage.seal", "editor.stage.abort", "editor.apply", "editor.query":
			allowed = true
		}
		var result any
		var callErr error
		switch req.Method {
		case "editor.hostReceipt.put", "editor.hostReceipt.get", "editor.hostReceipt.settle":
			result, callErr = h.EditorHostReceiptDispatch(ctx, req.Method, req.Params)
		default:
			if allowed {
				result, callErr = dispatcher.Dispatch(ctx, req.Method, req.Params, nil)
			} else {
				callErr = fmt.Errorf("method unavailable in editor-stdio")
			}
		}
		response := rpc.ResultFrame{Type: "rpc_result", ID: req.ID, OK: callErr == nil, Result: result}
		if callErr != nil {
			response.Error = callErr.Error()
		}
		encoded, err := json.Marshal(response)
		if err != nil {
			return err
		}
		if len(encoded) > 32*1024 {
			return fmt.Errorf("editor-stdio output frame budget exceeded")
		}
		outputBytes += int64(len(encoded))
		if outputBytes > 8*1024*1024 {
			return fmt.Errorf("editor-stdio output budget exceeded")
		}
		// Inherited stdout pipes need not support SetWriteDeadline. At most one
		// bounded write is outstanding; timeout exits this child, never a daemon.
		written := make(chan error, 1)
		go func() { _, err := io.WriteString(os.Stdout, string(encoded)+"\n"); written <- err }()
		writeTimer := time.NewTimer(10 * time.Second)
		select {
		case err := <-written:
			writeTimer.Stop()
			if err != nil {
				return err
			}
		case <-writeTimer.C:
			return fmt.Errorf("editor-stdio stdout timeout")
		case <-ctx.Done():
			writeTimer.Stop()
			return ctx.Err()
		}
	}
	return fmt.Errorf("editor-stdio request count exceeded")
}
