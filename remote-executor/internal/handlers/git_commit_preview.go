package handlers

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"
)

// Keep these argv and wire fields in sync with git-commit-preview-parse.ts.
const (
	commitMetaFormat       = "--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B"
	commitMetaMaxBytes     = 64*1024 + 4096
	commitParentMaxBytes   = 4096
	commitPatchMaxBytes    = 200000
	commitHistoricalMaxLen = 4096
)

func validCommitSHA(sha string) bool {
	if len(sha) != 40 && len(sha) != 64 {
		return false
	}
	for _, c := range sha {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

// A historical entry need not exist now; even its former parent can now be an
// outward symlink. Never inspect the working tree to authorize an object path.
func historicalGitPath(path string) error {
	if !utf8.ValidString(path) {
		return fmt.Errorf("non-UTF-8 historical Git paths are unsupported")
	}
	if path == "" || len(path) > commitHistoricalMaxLen || strings.ContainsAny(path, "\x00\\:") || strings.HasPrefix(path, "/") {
		return fmt.Errorf("invalid historical Git path")
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == "." || part == ".." || strings.EqualFold(part, ".git") {
			return fmt.Errorf("unsafe historical Git path")
		}
	}
	return nil
}

func commitRevisions(sha, base string) []string {
	if base == "" {
		return []string{"--root", sha}
	}
	return []string{base, sha}
}

func commitListArgs(kind, sha, base string) []string {
	args := []string{"diff-tree", "-r", "-M", "-l1000", "-z", "--no-commit-id", "--no-ext-diff", "--no-textconv", "--no-color", "--no-relative", "--submodule=short", "--ignore-submodules=none", "--" + kind}
	return append(append(args, commitRevisions(sha, base)...), "--")
}

func flag(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

// A child command can lower its cap, never replenish the operation's remaining
// bytes. In particular, trimming an incomplete NUL record does not refund it.
func runCommitBounded(g *workspaceGit, limit int64, args ...string) (string, int, error) {
	child := *g
	child.remaining = min(g.remaining, max(0, limit))
	child.truncated, child.lastTruncated = false, false
	before := child.remaining
	out, code, err := child.run(args...)
	g.remaining -= before - child.remaining
	g.lastTruncated = child.lastTruncated
	g.truncated = g.truncated || child.truncated
	return out, code, err
}

// The preview budget includes the entire JSON result (metadata, flags and JSON
// escaping), not just the patch. The outer RPC envelope has its own wire reserve.
func commitPreviewResult(outputs map[string]string, stdout string, truncated bool, maxBytes int64) (map[string]any, error) {
	result := map[string]any{"outputs": outputs, "stdout": stdout, "truncated": truncated}
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	if int64(len(encoded)) > maxBytes {
		return nil, fmt.Errorf("Git commit preview byte budget is too small")
	}
	return result, nil
}

func commitResponseBudget(outputs map[string]string, maxBytes int64) (int64, error) {
	result, err := commitPreviewResult(outputs, "", false, maxBytes)
	if err != nil {
		return 0, err
	}
	encoded, _ := json.Marshal(result)
	return maxBytes - int64(len(encoded)), nil
}

// Return a prefix on a UTF-8 boundary whose encoded JSON string contents fit.
// This matches encoding/json's default HTML/control/U+2028/U+2029 escaping.
func commitJSONPrefix(value string, limit int64) (string, int64, bool) {
	var cost int64
	end := 0
	for end < len(value) {
		r, size := utf8.DecodeRuneInString(value[end:])
		n := int64(size)
		switch {
		case r == utf8.RuneError && size == 1:
			if !utf8.FullRuneInString(value[end:]) {
				return value[:end], cost, true
			}
			n = 6 // invalid input is encoded as \ufffd, not silently undercounted
		case r == '\\' || r == '"' || r == '\n' || r == '\r' || r == '\t' || r == '\b' || r == '\f':
			n = 2
		case r < 0x20 || r == '<' || r == '>' || r == '&' || r == '\u2028' || r == '\u2029':
			n = 6
		}
		if cost+n > limit {
			break
		}
		cost += n
		end += size
	}
	return value[:end], cost, end < len(value)
}

func commitFirstParent(meta, sha string, fields int) (string, error) {
	parts := strings.SplitN(meta, "\x00", fields)
	if len(parts) != fields || !strings.EqualFold(parts[0], sha) {
		return "", fmt.Errorf("Git commit metadata exceeds preview byte budget or is incomplete")
	}
	parentIndex := 1
	if fields == 10 {
		parentIndex = 2
	}
	parents := strings.Fields(parts[parentIndex])
	for _, parent := range parents {
		if !validCommitSHA(parent) {
			return "", fmt.Errorf("Git commit parent metadata is invalid")
		}
	}
	if len(parents) > 0 {
		return parents[0], nil
	}
	return "", nil
}

type commitFileRecord struct {
	path, oldPath, status string
}

// Trim whole records, not just whole NUL fields: R100\0old\0 is still partial.
// Numstat renames similarly need both paths after the empty third column.
func completeCommitList(raw, kind string, truncated bool) (string, []commitFileRecord, bool, error) {
	var records []commitFileRecord
	end, cursor := 0, 0
	token := func() (string, bool) {
		n := strings.IndexByte(raw[cursor:], 0)
		if n < 0 {
			return "", false
		}
		value := raw[cursor : cursor+n]
		cursor += n + 1
		return value, true
	}
	for cursor < len(raw) {
		first, ok := token()
		if !ok {
			break
		}
		var record commitFileRecord
		if kind == "name-status" {
			if first == "" || !strings.ContainsRune("ACDMRTUXB", rune(first[0])) {
				return "", nil, false, fmt.Errorf("invalid Git name-status record")
			}
			record.status = first
			record.path, ok = token()
			if ok && (first[0] == 'R' || first[0] == 'C') {
				record.oldPath = record.path
				record.path, ok = token()
			}
		} else {
			parts := strings.SplitN(first, "\t", 3)
			if len(parts) != 3 {
				return "", nil, false, fmt.Errorf("invalid Git numstat record")
			}
			record.path = parts[2]
			if record.path == "" {
				record.oldPath, ok = token()
				if ok {
					record.path, ok = token()
				}
			}
		}
		if !ok {
			break
		}
		if record.path == "" || !utf8.ValidString(record.path) || !utf8.ValidString(record.oldPath) {
			return "", nil, false, fmt.Errorf("empty or non-UTF-8 historical Git paths are unsupported")
		}
		end = cursor
		records = append(records, record)
	}
	if end < len(raw) && !truncated {
		return "", nil, false, fmt.Errorf("Git commit file list is incomplete")
	}
	return raw[:end], records, truncated || end < len(raw), nil
}

// found=0 is reserved for a missing/non-commit object. A file failure never
// masquerades as an empty successful patch, even when validation was truncated.
func commitFileFailure(status string, maxBytes int64) (any, error) {
	return commitPreviewResult(map[string]string{"found": "1", "fileStatus": status}, "", false, maxBytes)
}

func (h *Handlers) workspaceCommitPreview(g *workspaceGit, op string, params map[string]any, maxBytes int64) (any, error) {
	sha := stringParam(params, "commit")
	if !validCommitSHA(sha) {
		return nil, fmt.Errorf("invalid commit SHA")
	}
	// Validation has a separate, finite budget, itself no larger than the
	// requested/wire budget. It never changes the response collection budget.
	validation := *g
	validation.remaining = min(maxBytes, gitWorkspaceMaxBytes)
	validation.truncated, validation.lastTruncated = false, false
	verified, code, err := runCommitBounded(&validation, 256, "rev-parse", "--verify", "--quiet", sha+"^{commit}")
	if err != nil && code != 1 {
		return nil, err
	}
	if validation.lastTruncated {
		return nil, fmt.Errorf("Git commit identity exceeds preview byte budget")
	}
	if code == 1 || !strings.EqualFold(strings.TrimSpace(verified), sha) {
		return commitPreviewResult(map[string]string{"found": "0"}, "", false, maxBytes)
	}
	if op == "commitDetail" {
		return h.commitDetail(g, sha, maxBytes)
	}
	path, oldPath := stringParam(params, "path"), stringParam(params, "oldPath")
	if err := historicalGitPath(path); err != nil {
		return nil, err
	}
	if oldPath != "" {
		if err := historicalGitPath(oldPath); err != nil {
			return nil, err
		}
	}
	parents, _, err := runCommitBounded(&validation, commitParentMaxBytes, "log", "-1", "--no-show-signature", "--format=%H%x00%P%x00", sha, "--")
	if err != nil {
		return nil, err
	}
	if validation.lastTruncated {
		return commitFileFailure("too_large", maxBytes)
	}
	base, err := commitFirstParent(parents, sha, 3)
	if err != nil {
		return nil, err
	}
	// Reserve the other half for checking the selected pathspec; a truncated
	// global list can still authorize an early, complete record without refilling.
	listing, _, err := runCommitBounded(&validation, validation.remaining/2, commitListArgs("name-status", sha, base)...)
	if err != nil {
		return nil, err
	}
	_, records, cut, err := completeCommitList(listing, "name-status", validation.lastTruncated)
	if err != nil {
		return nil, err
	}
	var selected *commitFileRecord
	for i := range records {
		if records[i].path == path {
			selected = &records[i]
			break
		}
	}
	if selected == nil {
		if cut {
			return commitFileFailure("too_large", maxBytes)
		}
		return commitFileFailure("not_found", maxBytes)
	}
	if oldPath != "" && oldPath != selected.oldPath {
		return commitFileFailure("invalid", maxBytes)
	}
	oldPath = selected.oldPath
	if oldPath != "" {
		if err := historicalGitPath(oldPath); err != nil {
			return nil, err
		}
	}
	paths := []string{path}
	if oldPath != "" && oldPath != path {
		paths = []string{oldPath, path}
	}
	// An old rename source may now be a directory containing another change.
	// Verify the scoped list BEFORE collecting a patch, so truncation cannot hide
	// a second header. Git pathspecs remain recursive even in literal mode.
	scopedArgs := append(commitListArgs("name-status", sha, base), paths...)
	scoped, _, err := validation.run(scopedArgs...)
	if err != nil {
		return nil, err
	}
	_, scopedRecords, scopedCut, err := completeCommitList(scoped, "name-status", validation.lastTruncated)
	if err != nil {
		return nil, err
	}
	if scopedCut {
		return commitFileFailure("too_large", maxBytes)
	}
	if len(scopedRecords) != 1 || scopedRecords[0].path != path || scopedRecords[0].oldPath != oldPath {
		return commitFileFailure("invalid", maxBytes)
	}
	outputs := map[string]string{"found": "1", "fileStatus": "ok"}
	remaining, err := commitResponseBudget(outputs, maxBytes)
	if err != nil {
		return nil, err
	}
	if remaining == 0 {
		return commitFileFailure("too_large", maxBytes)
	}
	args := []string{"-c", "core.quotePath=false", "diff-tree", "-r", "-p", "-M", "-l1000", "--no-commit-id", "--no-ext-diff", "--no-textconv", "--no-color", "--no-relative", "--submodule=short", "--ignore-submodules=none"}
	args = append(append(append(args, commitRevisions(sha, base)...), "--"), paths...)
	output := *g
	output.remaining, output.truncated = remaining, false
	patch, _, err := runCommitBounded(&output, commitPatchMaxBytes, args...)
	if err != nil {
		return nil, err
	}
	patch, _, encodedCut := commitJSONPrefix(patch, remaining)
	truncated := output.lastTruncated || encodedCut
	if strings.Count(patch, "\ndiff --git ") > 0 || !truncated && !strings.HasPrefix(patch, "diff --git ") {
		return commitFileFailure("invalid", maxBytes)
	}
	return commitPreviewResult(outputs, patch, truncated, maxBytes)
}

func (h *Handlers) commitDetail(g *workspaceGit, sha string, maxBytes int64) (any, error) {
	outputs := map[string]string{"found": "1", "meta": "", "metaTruncated": "0", "nameStatus": "", "nameStatusTruncated": "0", "numstat": "", "numstatTruncated": "0"}
	remaining, err := commitResponseBudget(outputs, maxBytes)
	if err != nil {
		return nil, err
	}
	output := *g
	output.remaining, output.truncated = remaining, false
	meta, _, err := runCommitBounded(&output, commitMetaMaxBytes, "log", "-1", "--no-show-signature", commitMetaFormat, sha, "--")
	if err != nil {
		return nil, err
	}
	meta, cost, encodedCut := commitJSONPrefix(meta, remaining)
	base, err := commitFirstParent(meta, sha, 10)
	if err != nil {
		return nil, err
	}
	outputs["meta"], outputs["metaTruncated"] = meta, flag(output.lastTruncated || encodedCut)
	remaining -= cost
	// The authoritative list runs first. Numstat gets only the actual remainder;
	// neither list has a minimum cap that could increase the caller's budget.
	for _, command := range []struct{ kind, key string }{{"name-status", "nameStatus"}, {"numstat", "numstat"}} {
		limit := remaining
		if command.kind == "name-status" {
			limit /= 2
		}
		raw, _, runErr := runCommitBounded(&output, limit, commitListArgs(command.kind, sha, base)...)
		if runErr != nil {
			return nil, runErr
		}
		raw, _, jsonCut := commitJSONPrefix(raw, limit)
		list, _, cut, parseErr := completeCommitList(raw, command.kind, output.lastTruncated || jsonCut)
		if parseErr != nil {
			return nil, parseErr
		}
		_, cost, _ := commitJSONPrefix(list, remaining)
		remaining -= cost
		outputs[command.key], outputs[command.key+"Truncated"] = list, flag(cut)
	}
	return commitPreviewResult(outputs, "", outputs["metaTruncated"] == "1" || outputs["nameStatusTruncated"] == "1" || outputs["numstatTruncated"] == "1", maxBytes)
}
