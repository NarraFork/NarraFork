package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode/utf16"
)

const nativePathBodyLimit = 64 * 1024
const nativePathCodeUnitsLimit = 32767
const nativePathAncestorLimit = 256

// NativePathObjectV2 identifies an incarnation, not an authorization or a path slot.
type NativePathObjectV2 struct {
	VolumeID     string `json:"volumeId"`
	FileID       string `json:"fileId"`
	CreationTime string `json:"creationTime"`
}
type NativePathAncestorV2 struct {
	CanonicalPath string             `json:"canonicalPath"`
	Object        NativePathObjectV2 `json:"object"`
	CaseSensitive bool               `json:"caseSensitive"`
}
type NativePathDescriptorV2 struct {
	Version       int                    `json:"version"`
	Platform      string                 `json:"platform"`
	PathSlotKey   string                 `json:"pathSlotKey"`
	ComponentKeys []string               `json:"componentKeys"`
	VolumeID      string                 `json:"volumeId"`
	Ancestors     []NativePathAncestorV2 `json:"ancestors"`
	Parent        NativePathAncestorV2   `json:"parent"`
	MissingSuffix []string               `json:"missingSuffix"`
	Object        *NativePathObjectV2    `json:"object,omitempty"`
	CaseSensitive *bool                  `json:"caseSensitive,omitempty"`
}
type nativePathResultV2 struct {
	LexicalPath      string                  `json:"lexicalPath"`
	CanonicalPath    string                  `json:"canonicalPath"`
	Exists           bool                    `json:"exists"`
	InputKind        string                  `json:"inputKind"`
	NativeDescriptor *NativePathDescriptorV2 `json:"nativeDescriptor"`
}

// FsResolvePathV2 never changes the process cwd or consults implicit per-drive cwd.
func (h *Handlers) FsResolvePathV2(parent context.Context, params map[string]any) (any, error) {
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	for key := range params {
		switch key {
		case "inputPath", "baseCwd", "operation", "expectedDescriptor", "expectedRootDescriptor":
		default:
			return nil, fmt.Errorf("invalid native path v2 request field %q", key)
		}
	}
	body, err := json.Marshal(params)
	if err != nil || len(body) > nativePathBodyLimit {
		return nil, fmt.Errorf("PATH_BODY_LIMIT: path request exceeds 64 KiB")
	}
	input, err := requiredPathParam(params, "inputPath")
	if err != nil {
		return nil, err
	}
	base, err := requiredPathParam(params, "baseCwd")
	if err != nil {
		return nil, err
	}
	lexical, kind, err := freezeWindowsPath(base, input)
	if err != nil {
		return nil, err
	}
	op := stringParam(params, "operation")
	if op != "existing" && op != "create" && op != "remove" {
		return nil, fmt.Errorf("invalid native path operation")
	}
	if !NativePathV2APIReady() {
		return nil, fmt.Errorf("NATIVE_PATH_CAPABILITY_NOT_READY: target lacks the Windows native path v2 API")
	}
	var guarded string
	switch op {
	case "existing":
		guarded, err = h.guard.CheckExistingContext(ctx, lexical)
	case "remove":
		guarded, err = h.guard.CheckRemoveContext(ctx, lexical)
	default:
		guarded, err = h.guard.CheckCreateContext(ctx, lexical)
	}
	if err != nil {
		return nil, err
	}
	result, err := resolveNativePathV2(ctx, guarded, op)
	if err != nil {
		return nil, err
	}
	result.LexicalPath, result.InputKind = lexical, kind
	if supplied, ok := params["expectedRootDescriptor"]; ok {
		root, err := decodeNativeDescriptorV2(supplied)
		if err != nil {
			return nil, err
		}
		if root.Object == nil || root.CaseSensitive == nil || !nativeDescriptorContains(root, result.NativeDescriptor) {
			return nil, fmt.Errorf("NATIVE_ROOT_SCOPE_MISMATCH: target is not inside the original native root incarnation/slot/case chain")
		}
	}
	if err := h.ValidateExpectedNativeDescriptor(ctx, params, guarded, op); err != nil {
		return nil, err
	}
	response, err := json.Marshal(result)
	if err != nil || len(response) > nativePathBodyLimit {
		return nil, fmt.Errorf("PATH_BODY_LIMIT: native descriptor exceeds 64 KiB")
	}
	return result, nil
}

func decodeNativeDescriptorV2(value any) (*NativePathDescriptorV2, error) {
	encoded, err := json.Marshal(value)
	if err != nil || len(encoded) > nativePathBodyLimit {
		return nil, fmt.Errorf("invalid expected native descriptor budget")
	}
	var expected NativePathDescriptorV2
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&expected); err != nil || expected.Version != 2 || expected.Platform != "windows" {
		return nil, fmt.Errorf("invalid expected native descriptor v2")
	}
	// Go bool's zero value must never turn an omitted/null native case field into
	// a false (insensitive) assertion. Inspect mandatory wire fields separately.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &raw); err != nil {
		return nil, err
	}
	for key, item := range raw {
		if bytes.Equal(bytes.TrimSpace(item), []byte("null")) {
			return nil, fmt.Errorf("null is not native descriptor evidence for %q", key)
		}
	}
	for _, key := range []string{"version", "platform", "pathSlotKey", "componentKeys", "volumeId", "ancestors", "parent", "missingSuffix"} {
		if item, ok := raw[key]; !ok || bytes.Equal(bytes.TrimSpace(item), []byte("null")) {
			return nil, fmt.Errorf("missing native descriptor field %q", key)
		}
	}
	validateAncestor := func(encoded json.RawMessage) error {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(encoded, &fields); err != nil {
			return err
		}
		for _, key := range []string{"canonicalPath", "object", "caseSensitive"} {
			if field, ok := fields[key]; !ok || bytes.Equal(field, []byte("null")) {
				return fmt.Errorf("missing native ancestor field %q", key)
			}
		}
		return nil
	}
	if err := validateAncestor(raw["parent"]); err != nil {
		return nil, err
	}
	var ancestors []json.RawMessage
	if err := json.Unmarshal(raw["ancestors"], &ancestors); err != nil {
		return nil, err
	}
	for _, entry := range ancestors {
		if err := validateAncestor(entry); err != nil {
			return nil, err
		}
	}
	if expected.VolumeID == "" || len(expected.VolumeID) > 256 || len(expected.PathSlotKey) != 64 || len(expected.Ancestors) == 0 || len(expected.Ancestors) > 256 || len(expected.ComponentKeys) == 0 || len(expected.ComponentKeys) > 512 || len(expected.MissingSuffix) > 256 {
		return nil, fmt.Errorf("invalid native descriptor shape")
	}
	if expected.Parent != expected.Ancestors[len(expected.Ancestors)-1] {
		return nil, fmt.Errorf("native parent is not the last original ancestor")
	}
	for _, entry := range expected.Ancestors {
		if entry.Object.VolumeID != expected.VolumeID {
			return nil, fmt.Errorf("native descriptor crosses volume without proof")
		}
	}
	if expected.Object != nil {
		if expected.Object.VolumeID != expected.VolumeID || len(expected.MissingSuffix) != 0 {
			return nil, fmt.Errorf("inconsistent native object proof")
		}
	} else if len(expected.MissingSuffix) == 0 {
		return nil, fmt.Errorf("missing original native suffix proof")
	}
	if expected.CaseSensitive != nil && expected.Object == nil {
		return nil, fmt.Errorf("missing native directory object proof")
	}
	return &expected, nil
}

// ValidateExpectedNativeDescriptor is the shared actual-IO guard seam. A v2 proof is
// compared in full, including native parent/root incarnations and directory case flags.
// Legacy requests remain legacy; this does not mint a v2 proof for old receipts.
func (h *Handlers) ValidateExpectedNativeDescriptor(ctx context.Context, params map[string]any, path, operation string) error {
	value, supplied := params["expectedNativeDescriptor"]
	if !supplied {
		value, supplied = params["expectedDescriptor"]
	}
	rootValue, rootSupplied := params["expectedRootDescriptor"]
	if !supplied && !rootSupplied {
		return nil
	}
	var expected *NativePathDescriptorV2
	var err error
	if supplied {
		expected, err = decodeNativeDescriptorV2(value)
		if err != nil {
			return err
		}
	}
	actual, err := resolveNativePathV2(ctx, path, operation)
	if err != nil {
		return err
	}
	if rootSupplied {
		root, err := decodeNativeDescriptorV2(rootValue)
		if err != nil {
			return err
		}
		if root.Object == nil || root.CaseSensitive == nil || !nativeDescriptorContains(root, actual.NativeDescriptor) {
			return fmt.Errorf("NATIVE_ROOT_SCOPE_MISMATCH: original native root no longer contains the actual target")
		}
	}
	if !supplied {
		return nil
	}
	a, err := json.Marshal(actual.NativeDescriptor)
	if err != nil {
		return err
	}
	b, err := json.Marshal(&expected)
	if err != nil {
		return err
	}
	if string(a) != string(b) {
		return fmt.Errorf("NATIVE_PATH_IDENTITY_CHANGED: original slot, parent, case mode, or object incarnation changed")
	}
	return nil
}

func nativeDescriptorContains(root, child *NativePathDescriptorV2) bool {
	if root == nil || child == nil || root.VolumeID != child.VolumeID || len(root.ComponentKeys) > len(child.ComponentKeys) {
		return false
	}
	for i, key := range root.ComponentKeys {
		if child.ComponentKeys[i] != key {
			return false
		}
	}
	for i, ancestor := range root.Ancestors {
		if i >= len(child.Ancestors) || ancestor.Object != child.Ancestors[i].Object || ancestor.CaseSensitive != child.Ancestors[i].CaseSensitive {
			return false
		}
	}
	if root.Object != nil && root.CaseSensitive != nil {
		for _, ancestor := range child.Ancestors {
			if ancestor.Object == *root.Object && ancestor.CaseSensitive != *root.CaseSensitive {
				return false
			}
		}
	}
	if root.Object == nil {
		if root.Parent.Object != child.Parent.Object || len(root.MissingSuffix) > len(child.MissingSuffix) {
			return false
		}
		for i, part := range root.MissingSuffix {
			if part != child.MissingSuffix[i] {
				return false
			}
		}
		return true
	}
	if root.PathSlotKey == child.PathSlotKey && child.Object != nil && *root.Object == *child.Object {
		if (root.CaseSensitive == nil) != (child.CaseSensitive == nil) {
			return false
		}
		return root.CaseSensitive == nil || *root.CaseSensitive == *child.CaseSensitive
	}
	for _, parent := range child.Ancestors {
		if parent.Object == *root.Object {
			return true
		}
	}
	return false
}

// Missing deny roots cannot authorize; conservatively cover their first uncreated
// subtree until a real directory exposes its own native case mode.
func nativeMissingDenyContains(root, child *NativePathDescriptorV2) bool {
	if root.Object != nil {
		return nativeDescriptorContains(root, child)
	}
	if root.VolumeID != child.VolumeID || root.Parent.Object != child.Parent.Object || len(root.MissingSuffix) == 0 || len(root.MissingSuffix) > len(child.MissingSuffix) {
		return false
	}
	for i, ancestor := range root.Ancestors {
		if i >= len(child.Ancestors) || ancestor.Object != child.Ancestors[i].Object || ancestor.CaseSensitive != child.Ancestors[i].CaseSensitive {
			return false
		}
	}
	a, b := root.MissingSuffix[0], child.MissingSuffix[0]
	if root.Parent.CaseSensitive {
		return a == b
	}
	if a == b {
		return true
	}
	ascii := func(value string) bool {
		for _, r := range value {
			if r >= 128 {
				return false
			}
		}
		return true
	}
	if !ascii(a) || !ascii(b) {
		return true
	}
	return strings.ToUpper(a) == strings.ToUpper(b)
}

func classifyWindowsNativePath(path string) (string, error) {
	p := strings.ReplaceAll(path, "/", "\\")
	upper := strings.ToUpper(p)
	if strings.HasPrefix(upper, `\\?\UNC\`) {
		if root, _ := windowsNativeRoot(p); root == "" {
			return "", fmt.Errorf("INVALID_WINDOWS_PATH: incomplete extended UNC")
		}
		return "extended-unc-absolute", nil
	}
	if strings.HasPrefix(p, `\\?\`) && len(p) >= 7 && isDriveLetter(p[4]) && p[5] == ':' && p[6] == '\\' {
		return "extended-drive-absolute", nil
	}
	bareNT := false
	for _, namespace := range []string{`\DEVICE`, `\DOSDEVICES`, `\GLOBALROOT`, `\GLOBAL??`} {
		if upper == namespace || strings.HasPrefix(upper, namespace+`\`) {
			bareNT = true
		}
	}
	if strings.HasPrefix(p, `\\?\`) || strings.HasPrefix(p, `\\.\`) || strings.HasPrefix(p, `\??\`) || bareNT {
		return "", fmt.Errorf("INVALID_WINDOWS_PATH: device namespace")
	}
	if strings.HasPrefix(p, `\\`) {
		if root, _ := windowsNativeRoot(p); root == "" {
			return "", fmt.Errorf("INVALID_WINDOWS_PATH: incomplete UNC")
		}
		return "unc-absolute", nil
	}
	if len(p) >= 2 && isDriveLetter(p[0]) && p[1] == ':' {
		if len(p) >= 3 && p[2] == '\\' {
			return "drive-absolute", nil
		}
		return "drive-relative", nil
	}
	if strings.HasPrefix(p, `\`) {
		return "root-relative", nil
	}
	return "relative", nil
}
func isDriveLetter(c byte) bool { return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' }

func windowsNativeRoot(path string) (string, string) {
	p := strings.ReplaceAll(path, "/", "\\")
	offset := 0
	if strings.HasPrefix(strings.ToUpper(p), `\\?\UNC\`) {
		offset = 8
	} else if strings.HasPrefix(p, `\\?\`) {
		offset = 4
	}
	if len(p) >= offset+3 && isDriveLetter(p[offset]) && p[offset+1] == ':' && p[offset+2] == '\\' {
		return p[:offset+3], p[offset+3:]
	}
	if offset == 8 || strings.HasPrefix(p, `\\`) && offset == 0 {
		if offset == 0 {
			offset = 2
		}
		parts := strings.SplitN(p[offset:], `\`, 3)
		if len(parts) < 2 || parts[0] == "" || parts[1] == "" || parts[0] == "." || parts[0] == ".." || parts[1] == "." || parts[1] == ".." {
			return "", ""
		}
		root := p[:offset] + parts[0] + `\` + parts[1] + `\`
		if len(parts) == 3 {
			return root, parts[2]
		}
		return root, ""
	}
	return "", ""
}

func validateWindowsNativePath(path string) (string, error) {
	if path == "" || len(utf16.Encode([]rune(path))) > nativePathCodeUnitsLimit {
		return "", fmt.Errorf("INVALID_WINDOWS_PATH: empty or oversized path")
	}
	for _, r := range path {
		if r < 32 || r == 127 {
			return "", fmt.Errorf("INVALID_WINDOWS_PATH: control character")
		}
	}
	kind, err := classifyWindowsNativePath(path)
	if err != nil {
		return "", err
	}
	extended := strings.HasPrefix(kind, "extended-")
	if extended && strings.Contains(path, "/") {
		return "", fmt.Errorf("INVALID_WINDOWS_PATH: extended separators")
	}
	p := strings.ReplaceAll(path, "/", "\\")
	switch kind {
	case "extended-drive-absolute":
		p = p[7:]
	case "extended-unc-absolute":
		p = p[8:]
	case "drive-relative", "drive-absolute":
		p = p[2:]
	}
	for _, part := range strings.Split(p, `\`) {
		if part == "" {
			continue
		}
		if part == "." || part == ".." {
			if extended {
				return "", fmt.Errorf("INVALID_WINDOWS_PATH: extended literal dot component")
			}
			continue
		}
		if strings.ContainsAny(part, `<>:"|?*`) || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") {
			return "", fmt.Errorf("INVALID_WINDOWS_PATH: ADS, reserved character or trailing alias")
		}
		name := strings.ToUpper(strings.TrimRight(strings.SplitN(part, ".", 2)[0], " "))
		if name == "CON" || name == "PRN" || name == "AUX" || name == "NUL" || name == "CONIN$" || name == "CONOUT$" {
			return "", fmt.Errorf("INVALID_WINDOWS_PATH: reserved device name")
		}
		runes := []rune(name)
		if len(runes) == 4 && (strings.HasPrefix(name, "COM") || strings.HasPrefix(name, "LPT")) && strings.ContainsRune("123456789¹²³", runes[3]) {
			return "", fmt.Errorf("INVALID_WINDOWS_PATH: reserved device name")
		}
	}
	return kind, nil
}

func freezeWindowsPath(base, input string) (string, string, error) {
	kind, err := validateWindowsNativePath(input)
	if err != nil {
		return "", "", err
	}
	baseKind, err := validateWindowsNativePath(base)
	if err != nil || !strings.HasSuffix(baseKind, "absolute") {
		return "", "", fmt.Errorf("INVALID_WINDOWS_PATH: baseCwd must be fully qualified")
	}
	root, suffix := windowsNativeRoot(base)
	p := strings.ReplaceAll(input, "/", "\\")
	switch {
	case strings.HasSuffix(kind, "absolute"):
		root, suffix = windowsNativeRoot(p)
	case kind == "root-relative":
		suffix = strings.TrimLeft(p, `\`)
	case kind == "drive-relative":
		driveRoot := strings.TrimPrefix(root, `\\?\`)
		if len(driveRoot) < 2 || !strings.EqualFold(driveRoot[:2], p[:2]) {
			return "", "", fmt.Errorf("AMBIGUOUS_DRIVE_RELATIVE: use a fully qualified path for another drive")
		}
		suffix += `\` + p[2:]
	default:
		suffix += `\` + p
	}
	parts := []string{}
	for _, part := range strings.Split(suffix, `\`) {
		if part == "" || part == "." {
			continue
		}
		if part == ".." {
			if len(parts) > 0 {
				parts = parts[:len(parts)-1]
			}
			continue
		}
		parts = append(parts, part)
	}
	result := root + strings.Join(parts, `\`)
	if _, err := validateWindowsNativePath(result); err != nil {
		return "", "", err
	}
	return result, kind, nil
}
