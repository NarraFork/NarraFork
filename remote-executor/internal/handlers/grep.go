package handlers

import (
	"context"
	"encoding/base64"
	"os/exec"
	"strconv"
	"time"
)

// Grep runs ripgrep with the same argument construction as the server-side
// LocalBackend, returning raw stdout bytes (base64) plus process status. If rg
// is not on PATH it reports unavailable so the server can surface an install hint.
func (h *Handlers) Grep(params map[string]any) (any, error) {
	rgPath, lookErr := exec.LookPath("rg")
	if lookErr != nil {
		return map[string]any{
			"stdoutB64":        "",
			"stderr":           "",
			"exitCode":         2,
			"truncatedByBytes": false,
			"timedOut":         false,
			"unavailable":      true,
		}, nil
	}

	pattern := stringParam(params, "pattern")
	searchPath := stringParam(params, "searchPath")
	if searchPath != "" {
		if p, err := h.guard.Check(searchPath); err == nil {
			searchPath = p
		} else {
			return nil, err
		}
	}
	cwd, err := h.guardedPath(params, "cwd")
	if err != nil {
		return nil, err
	}

	outputMode := stringParam(params, "outputMode")
	maxBytes := intParam(params, "maxBytes", 10*1024*1024)
	if maxBytes > h.maxRpcBytes {
		maxBytes = h.maxRpcBytes
	}
	timeoutMs := intParam(params, "timeoutMs", 30000)

	args := []string{"--hidden", "--no-messages"}
	if boolParam(params, "rawBytes") {
		args = append(args, "--encoding", "none")
	}
	switch outputMode {
	case "files_with_matches":
		args = append(args, "-l")
	case "count":
		args = append(args, "-c")
	default: // content
		if boolParam(params, "showLineNumbers") {
			args = append(args, "-n")
		}
		if ctxLines, ok := params["contextLines"].(float64); ok {
			args = append(args, "-C", strconv.Itoa(int(ctxLines)))
		} else {
			if b, ok := params["beforeContext"].(float64); ok {
				args = append(args, "-B", strconv.Itoa(int(b)))
			}
			if a, ok := params["afterContext"].(float64); ok {
				args = append(args, "-A", strconv.Itoa(int(a)))
			}
		}
	}
	if boolParam(params, "caseInsensitive") {
		args = append(args, "-i")
	}
	if boolParam(params, "multiline") {
		args = append(args, "-U", "--multiline-dotall")
	}
	if ft := stringParam(params, "fileType"); ft != "" {
		args = append(args, "--type", ft)
	}
	if g := stringParam(params, "glob"); g != "" {
		args = append(args, "--glob", g)
	}
	args = append(args, "--regexp", pattern, searchPath)

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	cmd := exec.CommandContext(ctx, rgPath, args...)
	cmd.Dir = cwd

	stdout, stderr, exitCode, truncated := runCapped(cmd, maxBytes)
	timedOut := ctx.Err() == context.DeadlineExceeded

	return map[string]any{
		"stdoutB64":        base64.StdEncoding.EncodeToString(stdout),
		"stderr":           string(stderr),
		"exitCode":         exitCode,
		"truncatedByBytes": truncated,
		"timedOut":         timedOut,
	}, nil
}
