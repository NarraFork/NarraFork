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
	h         *handlers.Handlers
	transfers *handlers.Transfers
}

func NewDispatcher(h *handlers.Handlers) *Dispatcher {
	return &Dispatcher{h: h}
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
