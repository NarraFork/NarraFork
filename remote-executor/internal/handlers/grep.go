package handlers

import (
	"bytes"
	"context"
	"encoding/base64"
	"os"
	"os/exec"
	"strconv"
	"time"
)

// grepParams is the decoded, normalised view of a grep RPC request.
type grepParams struct {
	pattern         string
	searchPath      string
	cwd             string
	outputMode      string
	glob            string
	fileType        string
	showLineNumbers bool
	caseInsensitive bool
	multiline       bool
	rawBytes        bool
	contextLines    *int
	beforeContext   *int
	afterContext    *int
	maxBytes        int64
	timeoutMs       int64
}

// Grep runs a content search, preferring ripgrep. When rg is not on PATH it
// falls back to the system `grep` so the search still returns a best-effort
// result (with usedFallback=true) instead of hard-failing. Only when neither
// tool exists does it report unavailable. Mirrors the server-side LocalBackend.
func (h *Handlers) Grep(params map[string]any) (any, error) {
	gp, err := h.decodeGrepParams(params)
	if err != nil {
		return nil, err
	}

	// Prefer ripgrep.
	if rgPath, lookErr := exec.LookPath("rg"); lookErr == nil {
		argv := buildRipgrepArgv(rgPath, gp)
		return runSearch(argv, gp, false), nil
	}

	// Fall back to system grep.
	grepPath, lookErr := exec.LookPath("grep")
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

	isDir := true
	if info, statErr := os.Stat(gp.searchPath); statErr == nil {
		isDir = info.IsDir()
	}
	argv := buildGrepFallbackArgv(grepPath, gp, isDir)
	res := runSearch(argv, gp, true)
	// GNU grep -c prints `path:0` for every scanned file, whereas rg -c only
	// lists files with matches. Strip zero-count lines to align output.
	if gp.outputMode == "count" {
		if b64, ok := res["stdoutB64"].(string); ok {
			if raw, decErr := base64.StdEncoding.DecodeString(b64); decErr == nil {
				res["stdoutB64"] = base64.StdEncoding.EncodeToString(stripZeroCountLines(raw))
			}
		}
	}
	return res, nil
}

func (h *Handlers) decodeGrepParams(params map[string]any) (grepParams, error) {
	gp := grepParams{
		pattern:         stringParam(params, "pattern"),
		outputMode:      stringParam(params, "outputMode"),
		glob:            stringParam(params, "glob"),
		fileType:        stringParam(params, "fileType"),
		showLineNumbers: boolParam(params, "showLineNumbers"),
		caseInsensitive: boolParam(params, "caseInsensitive"),
		multiline:       boolParam(params, "multiline"),
		rawBytes:        boolParam(params, "rawBytes"),
		maxBytes:        intParam(params, "maxBytes", 10*1024*1024),
		timeoutMs:       intParam(params, "timeoutMs", 30000),
	}
	if gp.maxBytes > h.maxRpcBytes {
		gp.maxBytes = h.maxRpcBytes
	}
	if c, ok := params["contextLines"].(float64); ok {
		v := int(c)
		gp.contextLines = &v
	}
	if b, ok := params["beforeContext"].(float64); ok {
		v := int(b)
		gp.beforeContext = &v
	}
	if a, ok := params["afterContext"].(float64); ok {
		v := int(a)
		gp.afterContext = &v
	}

	// Validate paths against the allow-root guard.
	sp := stringParam(params, "searchPath")
	if sp != "" {
		p, err := h.guard.CheckExisting(sp)
		if err != nil {
			return gp, err
		}
		gp.searchPath = p
	}
	cwd, err := h.guardedExistingPath(params, "cwd")
	if err != nil {
		return gp, err
	}
	gp.cwd = cwd
	return gp, nil
}

// buildRipgrepArgv mirrors server/lib/agent/execution/local-backend.ts.
func buildRipgrepArgv(rgPath string, gp grepParams) []string {
	args := []string{rgPath, "--hidden", "--no-messages"}
	if gp.rawBytes {
		args = append(args, "--encoding", "none")
	}
	switch gp.outputMode {
	case "files_with_matches":
		args = append(args, "-l")
	case "count":
		args = append(args, "-c")
	default:
		if gp.showLineNumbers {
			args = append(args, "-n")
		}
		if gp.contextLines != nil {
			args = append(args, "-C", strconv.Itoa(*gp.contextLines))
		} else {
			if gp.beforeContext != nil {
				args = append(args, "-B", strconv.Itoa(*gp.beforeContext))
			}
			if gp.afterContext != nil {
				args = append(args, "-A", strconv.Itoa(*gp.afterContext))
			}
		}
	}
	if gp.caseInsensitive {
		args = append(args, "-i")
	}
	if gp.multiline {
		args = append(args, "-U", "--multiline-dotall")
	}
	if gp.fileType != "" {
		args = append(args, "--type", gp.fileType)
	}
	if gp.glob != "" {
		args = append(args, "--glob", gp.glob)
	}
	args = append(args, "--regexp", gp.pattern, gp.searchPath)
	return args
}

// buildGrepFallbackArgv builds a best-effort system-grep argv mirroring the rg
// request. See RG_FALLBACK_NOTE (server side) for fidelity caveats: -E for
// extended regex, -s to suppress errors, -I to skip binary files, -r for dirs.
func buildGrepFallbackArgv(grepPath string, gp grepParams, isDir bool) []string {
	args := []string{grepPath, "-E", "-s", "-I"}
	if isDir {
		args = append(args, "-r")
	}
	switch gp.outputMode {
	case "files_with_matches":
		args = append(args, "-l")
	case "count":
		args = append(args, "-c")
	default:
		if gp.showLineNumbers {
			args = append(args, "-n")
		}
		if gp.contextLines != nil {
			args = append(args, "-C", strconv.Itoa(*gp.contextLines))
		} else {
			if gp.beforeContext != nil {
				args = append(args, "-B", strconv.Itoa(*gp.beforeContext))
			}
			if gp.afterContext != nil {
				args = append(args, "-A", strconv.Itoa(*gp.afterContext))
			}
		}
	}
	if gp.caseInsensitive {
		args = append(args, "-i")
	}
	// grep's --include only applies to recursive directory searches.
	if gp.glob != "" && isDir {
		args = append(args, "--include="+gp.glob)
	}
	args = append(args, "-e", gp.pattern, "--", gp.searchPath)
	return args
}

// runSearch executes an rg/grep-compatible argv with a byte cap + timeout and
// returns the RPC result map.
func runSearch(argv []string, gp grepParams, usedFallback bool) map[string]any {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(gp.timeoutMs)*time.Millisecond)
	defer cancel()

	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = gp.cwd
	stdout, stderr, exitCode, truncated := runCapped(cmd, gp.maxBytes)
	timedOut := ctx.Err() == context.DeadlineExceeded

	return map[string]any{
		"stdoutB64":        base64.StdEncoding.EncodeToString(stdout),
		"stderr":           string(stderr),
		"exitCode":         exitCode,
		"truncatedByBytes": truncated,
		"timedOut":         timedOut,
		"usedFallback":     usedFallback,
	}
}

// stripZeroCountLines removes `path:0` and bare `0` lines from grep -c output so
// it matches rg -c (which only lists files with matches). Mirrors the server.
func stripZeroCountLines(data []byte) []byte {
	var out bytes.Buffer
	start := 0
	for i := 0; i <= len(data); i++ {
		if i == len(data) || data[i] == '\n' {
			if i > start {
				line := data[start:i]
				isBareZero := len(line) == 1 && line[0] == '0'
				isPathZero := len(line) >= 2 && line[len(line)-1] == '0' && line[len(line)-2] == ':'
				if !isBareZero && !isPathZero {
					out.Write(data[start:i])
					if i < len(data) {
						out.WriteByte('\n')
					}
				}
			}
			start = i + 1
		}
	}
	return out.Bytes()
}
