// Package winpty isolates native ConPTY calls in an executor child process.
// The parent's non-inheritable Job Object owns every worker and shell descendant.
package winpty

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
)

const (
	WorkerFlag     = "--internal-conpty-worker-v1"
	MaxInputChunk  = 64 * 1024
	MaxQueueBytes  = 1024 * 1024
	MaxOutputChunk = 32 * 1024
	MaxFrameBytes  = 64 * 1024
	MaxSessions    = 64
)

type Options struct {
	Command []string `json:"command"`
	Cwd     string   `json:"cwd"`
	Env     []string `json:"env"`
	Cols    int16    `json:"cols"`
	Rows    int16    `json:"rows"`
}

type frame struct {
	Kind    string   `json:"kind"`
	Options *Options `json:"options,omitempty"`
	Data    []byte   `json:"data,omitempty"`
	Cols    int16    `json:"cols,omitempty"`
	Rows    int16    `json:"rows,omitempty"`
	Handle  uintptr  `json:"handle,omitempty"`
	PID     uint32   `json:"pid,omitempty"`
	Error   string   `json:"error,omitempty"`
	Bytes   uint64   `json:"bytes,omitempty"`
}

// Frames never collect arbitrary worker output before applying their limit.
func readFrame(r *bufio.Reader) (frame, error) {
	var f frame
	line, err := r.ReadSlice('\n')
	if err != nil {
		return f, err
	}
	if len(line) > MaxFrameBytes {
		return f, fmt.Errorf("ConPTY control frame exceeds %d bytes", MaxFrameBytes)
	}
	err = json.Unmarshal(line, &f)
	return f, err
}
func writeFrame(w io.Writer, f frame) error {
	data, err := json.Marshal(f)
	if err != nil {
		return err
	}
	if len(data)+1 > MaxFrameBytes {
		return fmt.Errorf("ConPTY control frame exceeds %d bytes", MaxFrameBytes)
	}
	data = append(data, '\n')
	for len(data) > 0 {
		n, err := w.Write(data)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return nil
}
func validSize(cols, rows int16) bool { return cols > 0 && rows > 0 }

type Result struct {
	ExitCode        *uint32
	TreeStopped     bool
	CleanupComplete bool
	Reason          string
}
