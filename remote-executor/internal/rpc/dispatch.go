package rpc

import (
	"context"
	"fmt"

	"github.com/narrafork/remote-executor/internal/handlers"
)

// Dispatcher routes an RPC method to the matching handler. Streaming methods
// (exec.start) receive a StreamFunc to push output; non-streaming methods
// ignore it.
type Dispatcher struct {
	h           *handlers.Handlers
	transfers   *handlers.Transfers
	editorReads *editorReads
}

func NewDispatcher(h *handlers.Handlers) *Dispatcher {
	return &Dispatcher{h: h, editorReads: newEditorReads(h)}
}

// CloseEditorReads releases only this connection's read handles.
func (d *Dispatcher) CloseEditorReads() { d.editorReads.close() }

// DiscardEditorRead handles cancellation or transport failure after a read
// returned but before its result was delivered to the consumer.
func (d *Dispatcher) DiscardEditorRead(result any) {
	var id string
	switch read := result.(type) {
	case EditorRawReadOpen:
		id = read.ReadID
	case EditorRawReadChunk:
		id = read.ReadID
	default:
		return
	}
	d.editorReads.closeRead(EditorRawReadClose{ReadID: id, Abort: true})
}

// CancelEditorRead releases a pull cancelled before its handler could start.
func (d *Dispatcher) CancelEditorRead(method string, params map[string]any) {
	if method == "editor.read.chunk" {
		id, _ := params["readId"].(string)
		d.editorReads.closeRead(EditorRawReadClose{ReadID: id, Abort: true})
	}
}

// SetTransfers wires the per-connection transfer manager (with its binary
// sender) into the dispatcher. Called by the transport once the connection and
// its SendBinary capability exist.
func (d *Dispatcher) SetTransfers(tr *handlers.Transfers) {
	d.transfers = tr
}

// Transfers exposes the transfer manager for the transport's binary-frame router.
func (d *Dispatcher) Transfers() *handlers.Transfers {
	return d.transfers
}

// Handlers exposes the shared handlers (for constructing Transfers).
func (d *Dispatcher) Handlers() *handlers.Handlers {
	return d.h
}

// Dispatch executes a request and returns its result payload or an error.
// ctx is cancelled if the server sends rpc_cancel for this request id.
func (d *Dispatcher) Dispatch(
	ctx context.Context,
	method string,
	params map[string]any,
	stream handlers.StreamFunc,
) (any, error) {
	switch method {
	case "system.ping":
		return map[string]any{"ok": true}, nil
	case "editor.capabilities", "editor.stage.open", "editor.stage.append", "editor.stage.seal", "editor.stage.abort", "editor.apply", "editor.query":
		return d.h.EditorDispatch(ctx, method, params)
	case "editor.read.open":
		var req EditorRawReadPreflight
		if err := decodeEditorParams(params, &req); err != nil {
			return nil, err
		}
		return d.editorReads.open(ctx, req)
	case "editor.read.chunk":
		var req EditorRawReadChunkRequest
		if err := decodeEditorParams(params, &req); err != nil {
			id, _ := params["readId"].(string)
			d.editorReads.closeRead(EditorRawReadClose{ReadID: id, Abort: true})
			return nil, err
		}
		return d.editorReads.chunk(ctx, req)
	case "editor.read.close":
		var req EditorRawReadClose
		if err := decodeEditorParams(params, &req); err != nil {
			return nil, err
		}
		return d.editorReads.closeRead(req)
	case "fs.stat":
		return d.h.FsStat(params)
	case "fs.exists":
		return d.h.FsExists(params)
	case "fs.read":
		return d.h.FsReadContext(ctx, params)
	case "fs.write":
		return d.h.FsWriteContext(ctx, params)
	case "fs.writeConditional":
		return d.h.FsWriteConditional(ctx, params)
	case "fs.remove":
		return d.h.FsRemoveContext(ctx, params)
	case "fs.mkdirp":
		return d.h.FsMkdirp(params)
	case "fs.list":
		return d.h.FsList(params)
	case "glob":
		return d.h.GlobContext(ctx, params)
	case "grep":
		return d.h.Grep(params)
	case "exec.start":
		return d.h.ExecStart(ctx, params, stream)
	case "git.status":
		return d.h.GitStatus(params)
	case "git.diff":
		return d.h.GitDiff(params)
	case "git.workspace":
		return d.h.GitWorkspace(ctx, params)
	case "pty.open":
		return d.h.PtyOpen(ctx, params, stream)
	case "pty.write":
		return d.h.PtyWrite(params)
	case "pty.resize":
		return d.h.PtyResize(params)
	case "pty.kill":
		return d.h.PtyKill(params)
	case "transfer.stat":
		return d.h.TransferStat(params)
	case "transfer.begin":
		if d.transfers == nil {
			return nil, fmt.Errorf("transfers not available")
		}
		return d.transfers.Begin(ctx, params)
	case "transfer.ack":
		if d.transfers == nil {
			return nil, fmt.Errorf("transfers not available")
		}
		return d.transfers.Ack(params)
	case "transfer.complete":
		if d.transfers == nil {
			return nil, fmt.Errorf("transfers not available")
		}
		return d.transfers.Complete(params)
	case "transfer.abort":
		if d.transfers == nil {
			return nil, fmt.Errorf("transfers not available")
		}
		return d.transfers.Abort(params)
	default:
		return nil, fmt.Errorf("unknown method: %s", method)
	}
}
