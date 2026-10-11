//go:build windows

package winpty

import (
	"bufio"
	"fmt"
	"strconv"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// RunWorker runs before public flags, credentials, helper configuration or RPC.
// This mode never opens a listener, history store or privileged helper channel.
func RunWorker(args []string) (bool, int) {
	if len(args) == 0 || args[0] != WorkerFlag {
		return false, 0
	}
	if len(args) != 4 {
		return true, 2
	}
	handles := make([]windows.Handle, 3)
	for i := range handles {
		raw, err := strconv.ParseUint(args[i+1], 10, 64)
		if err != nil || raw == 0 {
			return true, 2
		}
		handles[i] = windows.Handle(raw)
	}
	if runWorker(handles[0], handles[1], handles[2]) != nil {
		return true, 1
	}
	return true, 0
}

func runWorker(parent, controlRead, controlWrite windows.Handle) error {
	defer windows.CloseHandle(parent)
	for _, handle := range []windows.Handle{parent, controlRead, controlWrite} {
		if err := windows.SetHandleInformation(handle, windows.HANDLE_FLAG_INHERIT, 0); err != nil {
			return err
		}
	}
	// Dedicated IPC is never the worker's standard handles: console clients can
	// inherit redirected standard handles even with inheritHandles=false.
	controlInput := &synchronousPipe{handle: controlRead}
	controlOutput := &synchronousPipe{handle: controlWrite}
	defer controlInput.Close()
	defer controlOutput.Close()
	reader := bufio.NewReaderSize(controlInput, MaxFrameBytes)
	init, err := readFrame(reader)
	if err != nil || init.Kind != "init" || init.Options == nil {
		return fmt.Errorf("missing ConPTY worker initialization")
	}
	opts := init.Options
	if !Supported() || !validSize(opts.Cols, opts.Rows) {
		return fmt.Errorf("ConPTY unavailable or invalid size")
	}
	var inputRead, inputWrite, outputRead, outputWrite windows.Handle
	if err = windows.CreatePipe(&inputRead, &inputWrite, nil, 0); err != nil {
		return err
	}
	defer func() {
		if inputRead != 0 {
			windows.CloseHandle(inputRead)
		}
	}()
	input := &synchronousPipe{handle: inputWrite}
	defer input.Close()
	if err = windows.CreatePipe(&outputRead, &outputWrite, nil, 0); err != nil {
		return err
	}
	defer func() {
		if outputWrite != 0 {
			windows.CloseHandle(outputWrite)
		}
	}()
	output := &synchronousPipe{handle: outputRead}
	defer output.Close()
	var console windows.Handle
	if err = windows.CreatePseudoConsole(windows.Coord{X: opts.Cols, Y: opts.Rows}, inputRead, outputWrite, 0, &console); err != nil {
		return err
	}
	// Only this forceable worker may block in the pre-24H2 native Close call.
	var closeOnce sync.Once
	closeConsole := func() { closeOnce.Do(func() { windows.ClosePseudoConsole(console) }) }
	defer closeConsole()
	attributes, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return err
	}
	defer attributes.Delete()
	// Update expects HPCON itself, not &HPCON; flags=0 avoids cursor handshake.
	if err = attributes.Update(windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, unsafe.Pointer(console), unsafe.Sizeof(console)); err != nil {
		return err
	}
	si := windows.StartupInfoEx{ProcThreadAttributeList: attributes.List()}
	si.Cb = uint32(unsafe.Sizeof(si))
	pi, err := createProcess(opts.Command, opts.Cwd, opts.Env, &si.StartupInfo, false)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(pi.Process)
	defer windows.CloseHandle(pi.Thread)
	var parentShell windows.Handle
	if err = windows.DuplicateHandle(windows.CurrentProcess(), pi.Process, parent, &parentShell,
		windows.SYNCHRONIZE|windows.PROCESS_QUERY_INFORMATION|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, 0); err != nil {
		return err
	}
	var sendMu sync.Mutex
	send := func(f frame) error { sendMu.Lock(); defer sendMu.Unlock(); return writeFrame(controlOutput, f) }
	if err = send(frame{Kind: "prepared", Handle: uintptr(parentShell), PID: pi.ProcessId}); err != nil {
		return err
	}

	// Install drain and process observation BEFORE permitting shell resume.
	outputQueue := newByteQueue(MaxQueueBytes - MaxOutputChunk)
	failed := make(chan error, 1)
	fail := func(err error) {
		select {
		case failed <- err:
		default:
		}
	}
	outputDone := make(chan struct{})
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		for {
			data, ok := outputQueue.pop(nil)
			if !ok {
				return
			}
			if err := send(frame{Kind: "output", Data: data}); err != nil {
				fail(err)
				return
			}
		}
	}()
	go func() {
		defer close(outputDone)
		defer outputQueue.close()
		_ = send(frame{Kind: "diagnostic", Error: "native_output_reader_started"})
		buf := make([]byte, MaxOutputChunk)
		first := true
		for {
			n, err := output.Read(buf)
			if n > 0 {
				if first {
					_ = send(frame{Kind: "diagnostic", Error: "first_native_output_read", Bytes: uint64(n)})
					first = false
				}
				if !outputQueue.push(buf[:n]) {
					fail(fmt.Errorf("ConPTY output_overrun"))
					return
				}
			}
			if err != nil {
				_ = send(frame{Kind: "diagnostic", Error: "native_output_read_error: " + err.Error()})
				status, waitErr := windows.WaitForSingleObject(pi.Process, 0)
				if waitErr != nil || status != windows.WAIT_OBJECT_0 {
					fail(fmt.Errorf("native ConPTY output ended before shell exit: %w", err))
				}
				return
			}
		}
	}()
	wait := make(chan error, 1)
	go func() { _, err := windows.WaitForSingleObject(pi.Process, windows.INFINITE); wait <- err }()
	resume, err := readFrame(reader)
	if err != nil || resume.Kind != "resume" {
		return fmt.Errorf("shell resume was not authorized")
	}
	windows.CloseHandle(inputRead)
	inputRead = 0
	windows.CloseHandle(outputWrite)
	outputWrite = 0
	if _, err = windows.ResumeThread(pi.Thread); err != nil {
		return err
	}
	if err = send(frame{Kind: "ready"}); err != nil {
		return err
	}
	inputQueue := make(chan []byte, MaxQueueBytes/MaxOutputChunk)
	go func() {
		for data := range inputQueue {
			if _, err := input.Write(data); err != nil {
				fail(err)
				return
			}
		}
	}()
	go func() {
		for {
			f, err := readFrame(reader)
			if err != nil {
				fail(err)
				return
			}
			switch f.Kind {
			case "input":
				if len(f.Data) > MaxOutputChunk {
					fail(fmt.Errorf("ConPTY input chunk limit exceeded"))
					return
				}
				select {
				case inputQueue <- f.Data:
				default:
					fail(fmt.Errorf("ConPTY input_overrun"))
					return
				}
			case "resize":
				if !validSize(f.Cols, f.Rows) {
					fail(fmt.Errorf("invalid ConPTY resize"))
					return
				}
				if err := windows.ResizePseudoConsole(console, windows.Coord{X: f.Cols, Y: f.Rows}); err != nil {
					fail(err)
					return
				}
			case "close":
				go closeConsole()
				return
			default:
				fail(fmt.Errorf("invalid ConPTY worker control"))
				return
			}
		}
	}()
	select {
	case err = <-failed:
		// Explicit error precedes termination when the control pipe is available.
		// If delivery itself blocks, the parent's independent watchdog owns cleanup.
		_ = send(frame{Kind: "error", Error: err.Error()})
		return err
	case err = <-wait:
		closeConsole()
		<-outputDone
		outputQueue.close()
		<-writerDone
		return err
	}
}
