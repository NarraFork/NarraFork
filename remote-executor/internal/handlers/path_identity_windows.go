//go:build windows

package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// File information classes documented by GetFileInformationByHandleEx.
const pathFileIDInfo = 18
const pathFileCaseSensitiveInfo = 23

// API presence is separate from per-root FileId/case capability and ordinary ACLs.
func NativePathV2APIReady() bool {
	version := windows.RtlGetVersion()
	if version.MajorVersion < 10 || version.BuildNumber < 17763 {
		return false
	}
	kernel := windows.NewLazySystemDLL("kernel32.dll")
	return kernel.NewProc("GetFileInformationByHandleEx").Find() == nil &&
		kernel.NewProc("GetFinalPathNameByHandleW").Find() == nil &&
		pathCharUpperBuffW.Find() == nil
}

var pathCharUpperBuffW = windows.NewLazySystemDLL("user32.dll").NewProc("CharUpperBuffW")

type pathFileIDInformation struct {
	VolumeSerial uint64
	FileID       [16]byte
}
type nativePathHandle struct {
	handle        windows.Handle
	path          string
	object        NativePathObjectV2
	directory     bool
	caseSensitive bool
	caseKnown     bool
}

// Plain READ_ATTRIBUTES access only. No backup/security privilege is enabled here.
func nativeHandleVolumeID(handle windows.Handle, serial uint64, normalized string) (string, error) {
	buffer := make([]uint16, nativePathCodeUnitsLimit+1)
	n, err := windows.GetFinalPathNameByHandle(handle, &buffer[0], uint32(len(buffer)), 1) // VOLUME_NAME_GUID
	if err == nil && n > 0 && n < uint32(len(buffer)) {
		name := windows.UTF16ToString(buffer[:n])
		if strings.HasPrefix(name, `\\?\Volume{`) {
			end := strings.Index(name, `}\`)
			if end > 0 {
				return name[:end+2] + fmt.Sprintf("%016x", serial), nil
			}
		}
	}
	// Network providers do not necessarily expose volume GUID names. Retain the
	// actual normalized UNC namespace plus native volume serial; no local-drive guess.
	if strings.HasPrefix(strings.ToUpper(normalized), `\\?\UNC\`) {
		root, _ := windowsNativeRoot(normalized)
		if root != "" {
			return root + fmt.Sprintf("%016x", serial), nil
		}
	}
	return "", fmt.Errorf("NATIVE_PATH_CAPABILITY_NOT_READY: reliable native volume GUID unavailable: %v", err)
}

func openNativePathHandle(path string, noFollow bool) (*nativePathHandle, error) {
	native := path
	if !strings.HasPrefix(native, `\\?\`) {
		if strings.HasPrefix(native, `\\`) {
			native = `\\?\UNC\` + native[2:]
		} else {
			native = `\\?\` + native
		}
	}
	ptr, err := windows.UTF16PtrFromString(native)
	if err != nil {
		return nil, err
	}
	flags := uint32(windows.FILE_FLAG_BACKUP_SEMANTICS)
	if noFollow {
		flags |= windows.FILE_FLAG_OPEN_REPARSE_POINT
	}
	handle, err := windows.CreateFile(ptr, windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, flags, 0)
	if err != nil {
		return nil, err
	}
	success := false
	defer func() {
		if !success {
			windows.CloseHandle(handle)
		}
	}()
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return nil, err
	}
	var identity pathFileIDInformation
	if err := windows.GetFileInformationByHandleEx(handle, pathFileIDInfo, (*byte)(unsafe.Pointer(&identity)), uint32(unsafe.Sizeof(identity))); err != nil {
		return nil, fmt.Errorf("NATIVE_PATH_CAPABILITY_NOT_READY: FileIdInfo unavailable: %w", err)
	}
	var zero [16]byte
	if identity.FileID == zero {
		return nil, fmt.Errorf("NATIVE_PATH_CAPABILITY_NOT_READY: empty native FileId")
	}
	buffer := make([]uint16, nativePathCodeUnitsLimit+1)
	n, err := windows.GetFinalPathNameByHandle(handle, &buffer[0], uint32(len(buffer)), 0)
	if err != nil || n == 0 || n >= uint32(len(buffer)) {
		return nil, fmt.Errorf("NATIVE_PATH_CAPABILITY_NOT_READY: normalized native name unavailable: %v", err)
	}
	final := windows.UTF16ToString(buffer[:n])
	if _, err := validateWindowsNativePath(final); err != nil {
		return nil, err
	}
	volumeID, err := nativeHandleVolumeID(handle, identity.VolumeSerial, final)
	if err != nil {
		return nil, err
	}
	object := NativePathObjectV2{
		VolumeID:     volumeID,
		FileID:       hex.EncodeToString(identity.FileID[:]),
		CreationTime: strconv.FormatUint(uint64(info.CreationTime.HighDateTime)<<32|uint64(info.CreationTime.LowDateTime), 10),
	}
	result := &nativePathHandle{handle: handle, path: final, object: object, directory: info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0}
	if result.directory && !(noFollow && info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0) {
		var caseFlags uint32
		if err := windows.GetFileInformationByHandleEx(handle, pathFileCaseSensitiveInfo, (*byte)(unsafe.Pointer(&caseFlags)), 4); err != nil {
			return nil, fmt.Errorf("NATIVE_PATH_CAPABILITY_NOT_READY: directory case mode unavailable (no NTFS/ReFS/UNC guess): %w", err)
		}
		if caseFlags & ^uint32(windows.FILE_CS_FLAG_CASE_SENSITIVE_DIR) != 0 {
			return nil, fmt.Errorf("NATIVE_PATH_CAPABILITY_NOT_READY: unknown directory case flags")
		}
		result.caseSensitive = caseFlags&windows.FILE_CS_FLAG_CASE_SENSITIVE_DIR != 0
		result.caseKnown = true
	}
	success = true
	return result, nil
}

// Only case-insensitive directory slots use a target Win32 mapping. This is not
// JS/Go Unicode lowercasing, and never changes actual returned native path names.
func nativeComponentKey(component string, sensitive bool) (string, error) {
	if sensitive {
		return component, nil
	}
	buffer, err := windows.UTF16FromString(component)
	if err != nil {
		return "", err
	}
	n, _, callErr := pathCharUpperBuffW.Call(uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)-1))
	if n == 0 && len(buffer) > 1 {
		return "", fmt.Errorf("native case mapping failed: %v", callErr)
	}
	return windows.UTF16ToString(buffer), nil
}
func nativeLegacyPath(path string, extended bool) string {
	if extended {
		return path
	}
	if strings.HasPrefix(strings.ToUpper(path), `\\?\UNC\`) {
		return `\\` + path[8:]
	}
	return strings.TrimPrefix(path, `\\?\`)
}

var nativePathWorkers = make(chan struct{}, 2)
var nativePathQueued atomic.Int32

// Network providers may block a native call beyond cancellation. Never create
// unbounded orphan goroutines: at most two native workers survive a timed-out read.
func resolveNativePathV2(parent context.Context, path, operation string) (*nativePathResultV2, error) {
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	if nativePathQueued.Add(1) > 64 {
		nativePathQueued.Add(-1)
		return nil, fmt.Errorf("NATIVE_PATH_BUSY: native path queue exceeds 64")
	}
	select {
	case nativePathWorkers <- struct{}{}:
		nativePathQueued.Add(-1)
	case <-ctx.Done():
		nativePathQueued.Add(-1)
		return nil, ctx.Err()
	}
	type completion struct {
		result *nativePathResultV2
		err    error
	}
	done := make(chan completion, 1)
	go func() {
		defer func() { <-nativePathWorkers }()
		result, err := resolveNativePathV2Sync(ctx, path, operation)
		done <- completion{result, err}
	}()
	select {
	case result := <-done:
		return result.result, result.err
	case <-ctx.Done():
		if join, _ := ctx.Value(firstCaptureJoinedPathKey{}).(bool); join {
			// A first-capture caller retains its admission/handles until the
			// already-started native resolver really returns. Cancellation is
			// not a hard IO stop or evidence of helper resource termination.
			<-done
		}
		return nil, ctx.Err()
	}
}

func resolveNativePathV2Sync(ctx context.Context, path, operation string) (*nativePathResultV2, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	kind, err := validateWindowsNativePath(path)
	if err != nil || !strings.HasSuffix(kind, "absolute") {
		return nil, fmt.Errorf("INVALID_WINDOWS_PATH: native IO requires a frozen fully qualified path: %v", err)
	}
	extended := strings.HasPrefix(kind, "extended-")
	// Remove identifies the directory entry without following the final reparse point.
	current := path
	missing := []string{}
	var target *nativePathHandle
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		target, err = openNativePathHandle(current, operation == "remove" && len(missing) == 0)
		if err == nil {
			break
		}
		if !errors.Is(err, windows.ERROR_FILE_NOT_FOUND) && !errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
			return nil, err
		}
		if operation != "create" {
			return nil, err
		}
		parent := filepath.Dir(current)
		if parent == current || len(missing) >= nativePathAncestorLimit {
			return nil, fmt.Errorf("PATH_ANCESTOR_LIMIT: no existing native ancestor")
		}
		missing = append([]string{filepath.Base(current)}, missing...)
		current = parent
	}
	defer windows.CloseHandle(target.handle)
	exists := len(missing) == 0
	if !exists && !target.directory {
		return nil, fmt.Errorf("native create ancestor is not a directory")
	}
	canonical := target.path
	for _, part := range missing {
		canonical = filepath.Join(canonical, part)
	}
	parentPath := filepath.Dir(target.path)
	if !exists {
		parentPath = target.path
	}
	root, suffix := windowsNativeRoot(parentPath)
	if root == "" {
		return nil, fmt.Errorf("NATIVE_PATH_CAPABILITY_NOT_READY: native canonical root unavailable")
	}
	paths := []string{root}
	rootWire, _ := json.Marshal(root)
	prefixWireBytes := len(rootWire)
	for _, part := range strings.Split(suffix, `\`) {
		if part != "" {
			if len(paths) >= nativePathAncestorLimit {
				return nil, fmt.Errorf("PATH_ANCESTOR_LIMIT: native chain exceeds 256")
			}
			next := filepath.Join(paths[len(paths)-1], part)
			wire, _ := json.Marshal(next)
			prefixWireBytes += len(wire)
			if prefixWireBytes > nativePathBodyLimit {
				return nil, fmt.Errorf("PATH_BODY_LIMIT: native ancestor names exceed 64 KiB")
			}
			paths = append(paths, next)
		}
	}
	if len(paths) > nativePathAncestorLimit {
		return nil, fmt.Errorf("PATH_ANCESTOR_LIMIT: native chain exceeds 256")
	}
	ancestors := make([]NativePathAncestorV2, 0, len(paths))
	handles := make([]*nativePathHandle, 0, len(paths))
	defer func() {
		for _, handle := range handles {
			windows.CloseHandle(handle.handle)
		}
	}()
	components := []string{}
	// Reserve endpoints, the suffix, component-key bytes, fixed fields and the
	// final parent duplicate before collecting native evidence from the source.
	baseWire, _ := json.Marshal(map[string]any{"lexicalPath": path, "canonicalPath": canonical, "missingSuffix": missing, "componentBudget": canonical})
	evidenceWireBytes := len(baseWire) + 2048
	if evidenceWireBytes > nativePathBodyLimit {
		return nil, fmt.Errorf("PATH_BODY_LIMIT: native endpoint/suffix budget exceeds 64 KiB")
	}
	for i, path := range paths {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		handle, err := openNativePathHandle(path, false)
		if err != nil {
			return nil, err
		}
		handles = append(handles, handle)
		if !handle.directory || handle.object.VolumeID != target.object.VolumeID {
			return nil, fmt.Errorf("NATIVE_PATH_IDENTITY_CHANGED: parent chain crosses volume or non-directory")
		}
		if i == 0 {
			// Bind volume *and* native root incarnation. Mounted-volume aliases cannot grant
			// a different namespace just because a file ID or volume serial matches.
			components = append(components, handle.object.VolumeID+":"+handle.object.FileID+":"+handle.object.CreationTime)
		} else {
			key, err := nativeComponentKey(filepath.Base(handle.path), handles[i-1].caseSensitive)
			if err != nil {
				return nil, err
			}
			components = append(components, key)
		}
		ancestor := NativePathAncestorV2{CanonicalPath: handle.path, Object: handle.object, CaseSensitive: handle.caseSensitive}
		wire, _ := json.Marshal(ancestor)
		evidenceWireBytes += len(wire) + 1
		if evidenceWireBytes+len(wire) > nativePathBodyLimit {
			return nil, fmt.Errorf("PATH_BODY_LIMIT: native descriptor budget exhausted during ancestor capture")
		}
		ancestors = append(ancestors, ancestor)
	}
	parent := ancestors[len(ancestors)-1]
	if exists && target.path != root {
		key, err := nativeComponentKey(filepath.Base(target.path), parent.CaseSensitive)
		if err != nil {
			return nil, err
		}
		components = append(components, key)
	} else if !exists {
		for _, part := range missing {
			key, err := nativeComponentKey(part, parent.CaseSensitive)
			if err != nil {
				return nil, err
			}
			components = append(components, key)
		}
	}
	descriptor := &NativePathDescriptorV2{
		Version: 2, Platform: "windows", ComponentKeys: components, VolumeID: target.object.VolumeID,
		Ancestors: ancestors, Parent: parent, MissingSuffix: missing,
	}
	if exists {
		descriptor.Object = &target.object
		if target.directory && target.caseKnown {
			mode := target.caseSensitive
			descriptor.CaseSensitive = &mode
		}
	}
	keyBody, _ := json.Marshal(components)
	sum := sha256.Sum256(keyBody)
	descriptor.PathSlotKey = hex.EncodeToString(sum[:])
	// Reopen canonical names while all observations remain held; reject ancestor/name
	// races rather than authorize a chain assembled from different incarnations.
	for _, handle := range append(handles, target) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		recheck, err := openNativePathHandle(handle.path, operation == "remove" && handle == target)
		if err != nil {
			return nil, err
		}
		equal := recheck.object == handle.object && recheck.caseSensitive == handle.caseSensitive
		windows.CloseHandle(recheck.handle)
		if !equal {
			return nil, fmt.Errorf("NATIVE_PATH_IDENTITY_CHANGED: native chain changed during resolution")
		}
	}
	if exists {
		original, err := openNativePathHandle(path, operation == "remove")
		if err != nil {
			return nil, err
		}
		equal := original.object == target.object && original.path == target.path
		windows.CloseHandle(original.handle)
		if !equal {
			return nil, fmt.Errorf("NATIVE_PATH_IDENTITY_CHANGED: lexical route changed during resolution")
		}
	}
	result := &nativePathResultV2{LexicalPath: path, CanonicalPath: nativeLegacyPath(canonical, extended), Exists: exists, InputKind: kind, NativeDescriptor: descriptor}
	body, err := json.Marshal(result)
	if err != nil || len(body) > nativePathBodyLimit {
		return nil, fmt.Errorf("PATH_BODY_LIMIT: native descriptor exceeds 64 KiB")
	}
	return result, nil
}

func captureNativeGuardRoot(path string) (*NativePathDescriptorV2, error) {
	result, err := resolveNativePathV2(context.Background(), path, "create")
	if err != nil {
		return nil, err
	}
	return result.NativeDescriptor, nil
}
func nativeGuardRuleContains(ctx context.Context, rule resolvedRule, path, operation string) (bool, error) {
	currentRoot, err := resolveNativePathV2(ctx, rule.root, "create")
	if err != nil {
		return false, err
	}
	root := currentRoot.NativeDescriptor
	if rule.nativeRoot != nil {
		a, _ := json.Marshal(rule.nativeRoot)
		b, _ := json.Marshal(root)
		if string(a) != string(b) {
			return false, fmt.Errorf("NATIVE_PATH_IDENTITY_CHANGED: configured root incarnation or case mode changed")
		}
		root = rule.nativeRoot
	}
	child, err := resolveNativePathV2(ctx, path, operation)
	if err != nil {
		return false, err
	}
	if rule.action == RuleDeny {
		return nativeMissingDenyContains(root, child.NativeDescriptor), nil
	}
	return nativeDescriptorContains(root, child.NativeDescriptor), nil
}

func nativePathWithin(root, path string) (bool, error) {
	a, err := resolveNativePathV2(context.Background(), root, "create")
	if err != nil {
		return false, err
	}
	b, err := resolveNativePathV2(context.Background(), path, "create")
	if err != nil {
		return false, err
	}
	return nativeDescriptorContains(a.NativeDescriptor, b.NativeDescriptor), nil
}
func nativeDenyPathWithin(root, path string) (bool, error) {
	return nativeDenyPathWithinContext(context.Background(), root, path)
}

func nativeDenyPathWithinContext(ctx context.Context, root, path string) (bool, error) {
	a, err := resolveNativePathV2(ctx, root, "create")
	if err != nil {
		return false, err
	}
	b, err := resolveNativePathV2(ctx, path, "create")
	if err != nil {
		return false, err
	}
	return nativeMissingDenyContains(a.NativeDescriptor, b.NativeDescriptor), nil
}

func nativeSamePath(left, right string) bool {
	a, err := resolveNativePathV2(context.Background(), left, "create")
	if err != nil {
		return false
	}
	b, err := resolveNativePathV2(context.Background(), right, "create")
	if err != nil {
		return false
	}
	da, db := a.NativeDescriptor, b.NativeDescriptor
	if da.PathSlotKey != db.PathSlotKey || da.Parent.Object != db.Parent.Object {
		return false
	}
	if da.Object == nil || db.Object == nil {
		return da.Object == nil && db.Object == nil
	}
	return *da.Object == *db.Object
}
func validateNativeAbsolutePath(path string) error {
	kind, err := validateWindowsNativePath(path)
	if err != nil {
		return err
	}
	if !strings.HasSuffix(kind, "absolute") {
		return fmt.Errorf("INVALID_WINDOWS_PATH: IO path must be explicitly frozen with baseCwd")
	}
	return nil
}

// NativePathContainsV2 is shared with history's containment seam without changing
// legacy history canonical strings/hash inputs.
func NativePathContainsV2(root, path string) (bool, error) { return nativePathWithin(root, path) }

// ValidateNativeOpenedFileV2 verifies the actual opened ordinary file, not just a
// fresh path lookup. It is intentionally separate from legacy metadata identity.
func (h *Handlers) ValidateNativeOpenedFileV2(ctx context.Context, params map[string]any, path string, file *os.File) error {
	if err := h.ValidateExpectedNativeDescriptor(ctx, params, path, "existing"); err != nil {
		return err
	}
	value, ok := params["expectedNativeDescriptor"]
	if !ok {
		value, ok = params["expectedDescriptor"]
	}
	if !ok {
		return nil
	}
	body, _ := json.Marshal(value)
	var expected NativePathDescriptorV2
	if err := json.Unmarshal(body, &expected); err != nil || expected.Object == nil {
		return fmt.Errorf("missing expected native object incarnation")
	}
	actual, _, err := h.ResolveNativeOpenedFileV2(ctx, file)
	if err != nil {
		return err
	}
	a, _ := json.Marshal(actual)
	b, _ := json.Marshal(&expected)
	if string(a) != string(b) {
		return fmt.Errorf("NATIVE_PATH_IDENTITY_CHANGED: actual opened object's original native slot or incarnation changed")
	}
	return nil
}

// ResolveNativeOpenedFileV2 obtains the actual handle name and identity before
// rechecking native containment. A caller-supplied path or matching bytes is not proof.
// Shared with the metadata helper, which must still apply its own original scope/ticket.
func (h *Handlers) ResolveNativeOpenedFileV2(ctx context.Context, file *os.File) (*NativePathDescriptorV2, string, error) {
	return h.resolveNativeOpenedEntryV2(ctx, file, "existing")
}

func (h *Handlers) resolveNativeOpenedEntryV2(ctx context.Context, file *os.File, operation string) (*NativePathDescriptorV2, string, error) {
	if err := ctx.Err(); err != nil {
		return nil, "", err
	}
	handle := windows.Handle(file.Fd())
	var id pathFileIDInformation
	if err := windows.GetFileInformationByHandleEx(handle, pathFileIDInfo, (*byte)(unsafe.Pointer(&id)), uint32(unsafe.Sizeof(id))); err != nil {
		return nil, "", err
	}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return nil, "", err
	}
	buffer := make([]uint16, nativePathCodeUnitsLimit+1)
	n, err := windows.GetFinalPathNameByHandle(handle, &buffer[0], uint32(len(buffer)), 0)
	if err != nil || n == 0 || n >= uint32(len(buffer)) {
		return nil, "", fmt.Errorf("NATIVE_PATH_CAPABILITY_NOT_READY: actual handle name unavailable: %v", err)
	}
	name := windows.UTF16ToString(buffer[:n])
	volumeID, err := nativeHandleVolumeID(handle, id.VolumeSerial, name)
	if err != nil {
		return nil, "", err
	}
	actual := NativePathObjectV2{VolumeID: volumeID, FileID: hex.EncodeToString(id.FileID[:]), CreationTime: strconv.FormatUint(uint64(info.CreationTime.HighDateTime)<<32|uint64(info.CreationTime.LowDateTime), 10)}
	var guarded string
	if operation == "remove" {
		guarded, err = h.guard.CheckRemoveContext(ctx, name)
	} else {
		guarded, err = h.guard.CheckExistingContext(ctx, name)
	}
	if err != nil {
		return nil, "", err
	}
	observed, err := resolveNativePathV2(ctx, guarded, operation)
	if err != nil {
		return nil, "", err
	}
	if observed.NativeDescriptor.Object == nil || actual != *observed.NativeDescriptor.Object {
		return nil, "", fmt.Errorf("NATIVE_PATH_IDENTITY_CHANGED: actual handle differs from authorized native path")
	}
	return observed.NativeDescriptor, observed.CanonicalPath, nil
}

// PinNativeDirectoryV2 binds process creation to the original selected native cwd.
// Release immediately after CreateProcess/resume, not after the shell's lifetime.
func (h *Handlers) PinNativeDirectoryV2(ctx context.Context, params map[string]any, path string) (func(), error) {
	if _, supplied := params["expectedNativeDescriptor"]; !supplied {
		return nil, fmt.Errorf("NATIVE_PATH_CAPABILITY_NOT_READY: process cwd lacks original native descriptor")
	}
	if err := h.ValidateExpectedNativeDescriptor(ctx, params, path, "existing"); err != nil {
		return nil, err
	}
	guarded, err := h.guard.CheckExisting(path)
	if err != nil {
		return nil, err
	}
	resolved, err := resolveNativePathV2(ctx, guarded, "existing")
	if err != nil {
		return nil, err
	}
	if resolved.NativeDescriptor.CaseSensitive == nil {
		return nil, fmt.Errorf("native process cwd must be a proved directory")
	}
	paths := []string{}
	for _, ancestor := range resolved.NativeDescriptor.Ancestors {
		paths = append(paths, ancestor.CanonicalPath)
	}
	finalPath := resolved.CanonicalPath
	if !strings.HasPrefix(finalPath, `\\?\`) {
		if strings.HasPrefix(finalPath, `\\`) {
			finalPath = `\\?\UNC\` + finalPath[2:]
		} else {
			finalPath = `\\?\` + finalPath
		}
	}
	if finalPath != paths[len(paths)-1] {
		paths = append(paths, finalPath)
	}
	pinned := make([]windows.Handle, 0, len(paths))
	release := func() {
		for _, handle := range pinned {
			windows.CloseHandle(handle)
		}
		pinned = nil
	}
	for _, path := range paths {
		if err := ctx.Err(); err != nil {
			release()
			return nil, err
		}
		pointer, err := windows.UTF16PtrFromString(path)
		if err != nil {
			release()
			return nil, err
		}
		handle, err := windows.CreateFile(pointer, windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ,
			nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err != nil {
			release()
			return nil, fmt.Errorf("native process cwd pin unavailable: %w", err)
		}
		pinned = append(pinned, handle)
		fileType, err := windows.GetFileType(handle)
		if err != nil || fileType != windows.FILE_TYPE_DISK {
			release()
			return nil, fmt.Errorf("INVALID_WINDOWS_PATH: target is not an ordinary disk namespace: %v", err)
		}
		var info windows.ByHandleFileInformation
		if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
			release()
			return nil, err
		}
		if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			release()
			return nil, fmt.Errorf("native process cwd chain changed to a nonordinary directory")
		}
	}
	if err := h.ValidateExpectedNativeDescriptor(ctx, params, path, "existing"); err != nil {
		release()
		return nil, err
	}
	return release, nil
}

// PinConditionalMissingParentV2 projects ONLY the supplied missing evidence.
// It must not mint a new parent incarnation from a current pathname lookup.
func (h *Handlers) PinConditionalMissingParentV2(ctx context.Context, params map[string]any, path string) (func(), error) {
	value, supplied := params["expectedNativeDescriptor"]
	if !supplied {
		value, supplied = params["expectedDescriptor"]
	}
	if !supplied { // Legacy callers receive no v2 guarantee.
		return func() {}, nil
	}
	if err := h.ValidateExpectedNativeDescriptor(ctx, params, path, "create"); err != nil {
		return nil, err
	}
	body, err := json.Marshal(value)
	var expected NativePathDescriptorV2
	if err != nil || json.Unmarshal(body, &expected) != nil || expected.Object != nil || len(expected.MissingSuffix) != 1 || len(expected.Ancestors) == 0 || len(expected.ComponentKeys) < 2 {
		return nil, fmt.Errorf("NATIVE_PATH_PARENT_NOT_READY: conditional create requires original single missing slot")
	}
	parent := expected.Parent
	expected.Object = &parent.Object
	expected.CaseSensitive = &parent.CaseSensitive
	expected.MissingSuffix = []string{}
	expected.ComponentKeys = append([]string{}, expected.ComponentKeys[:len(expected.ComponentKeys)-1]...)
	if len(expected.Ancestors) > 1 {
		expected.Ancestors = append([]NativePathAncestorV2{}, expected.Ancestors[:len(expected.Ancestors)-1]...)
		expected.Parent = expected.Ancestors[len(expected.Ancestors)-1]
	}
	keyBody, _ := json.Marshal(expected.ComponentKeys)
	sum := sha256.Sum256(keyBody)
	expected.PathSlotKey = hex.EncodeToString(sum[:])
	return h.PinNativeDirectoryV2(ctx, map[string]any{"expectedNativeDescriptor": &expected}, parent.CanonicalPath)
}

// WriteNativeGuardedV2 opens existing files WITHOUT truncation, pins every native
// ancestor against rename/case mutation, and proves the actual handle before bytes
// change. New files are exclusive creates in a proved existing immediate parent.
// It is a plain IO primitive, not complete metadata capture or a privileged helper.
func (h *Handlers) WriteNativeGuardedV2(ctx context.Context, params map[string]any, path string, data []byte) (bool, error) {
	value, supplied := params["expectedNativeDescriptor"]
	if !supplied {
		return false, nil
	}
	if int64(len(data)) > h.maxRpcBytes {
		return true, fmt.Errorf("write exceeds max RPC bytes")
	}
	if err := h.ValidateExpectedNativeDescriptor(ctx, params, path, "create"); err != nil {
		return true, err
	}
	body, _ := json.Marshal(value)
	var expected NativePathDescriptorV2
	if err := json.Unmarshal(body, &expected); err != nil {
		return true, err
	}
	if expected.Object == nil && len(expected.MissingSuffix) != 1 {
		return true, fmt.Errorf("NATIVE_PATH_PARENT_NOT_READY: create the parent directories and obtain a fresh native descriptor before writing")
	}
	pinned := make([]windows.Handle, 0, len(expected.Ancestors))
	defer func() {
		for _, handle := range pinned {
			windows.CloseHandle(handle)
		}
	}()
	for _, ancestor := range expected.Ancestors {
		if err := ctx.Err(); err != nil {
			return true, err
		}
		pointer, err := windows.UTF16PtrFromString(ancestor.CanonicalPath)
		if err != nil {
			return true, err
		}
		handle, err := windows.CreateFile(pointer, windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ,
			nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err != nil {
			return true, fmt.Errorf("native parent pin unavailable before write: %w", err)
		}
		pinned = append(pinned, handle)
	}
	if err := h.ValidateExpectedNativeDescriptor(ctx, params, path, "create"); err != nil {
		return true, err
	}
	if _, err := h.guard.CheckCreate(path); err != nil {
		return true, err
	}
	if err := ctx.Err(); err != nil {
		return true, err
	}
	native := path
	if !strings.HasPrefix(native, `\\?\`) {
		if strings.HasPrefix(native, `\\`) {
			native = `\\?\UNC\` + native[2:]
		} else {
			native = `\\?\` + native
		}
	}
	pointer, err := windows.UTF16PtrFromString(native)
	if err != nil {
		return true, err
	}
	disposition := uint32(windows.OPEN_EXISTING)
	if expected.Object == nil {
		disposition = windows.CREATE_NEW
	}
	handle, err := windows.CreateFile(pointer, windows.GENERIC_WRITE|windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ,
		nil, disposition, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return true, err
	}
	file := os.NewFile(uintptr(handle), path)
	defer file.Close()
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return true, err
	}
	if info.FileAttributes&(windows.FILE_ATTRIBUTE_DIRECTORY|windows.FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
		return true, fmt.Errorf("native write requires an ordinary final file")
	}
	if expected.Object != nil {
		if err := h.ValidateNativeOpenedFileV2(ctx, params, path, file); err != nil {
			return true, err
		}
		if err := ctx.Err(); err != nil {
			return true, err
		}
		if err := file.Truncate(0); err != nil {
			return true, fmt.Errorf("NATIVE_WRITE_UNKNOWN: truncate dispatched: %w", err)
		}
	} else {
		actual, _, err := h.ResolveNativeOpenedFileV2(ctx, file)
		if err != nil {
			return true, fmt.Errorf("NATIVE_WRITE_UNKNOWN: exclusive create dispatched: %w", err)
		}
		// A new incarnation is expected, but the original path slot and all parent
		// incarnations/case flags must still be identical. Never clean up a guessed name.
		if actual.PathSlotKey != expected.PathSlotKey || actual.Parent != expected.Parent || len(actual.Ancestors) != len(expected.Ancestors) {
			return true, fmt.Errorf("NATIVE_WRITE_UNKNOWN: created file lacks its original parent/slot proof")
		}
		for i, ancestor := range actual.Ancestors {
			if ancestor != expected.Ancestors[i] {
				return true, fmt.Errorf("NATIVE_WRITE_UNKNOWN: ancestor changed during create")
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return true, fmt.Errorf("NATIVE_WRITE_UNKNOWN: mutation dispatched before cancellation: %w", err)
	}
	if _, err := file.Write(data); err != nil {
		return true, fmt.Errorf("NATIVE_WRITE_UNKNOWN: content write dispatched: %w", err)
	}
	if err := file.Sync(); err != nil {
		return true, fmt.Errorf("NATIVE_WRITE_UNKNOWN: content sync dispatched: %w", err)
	}
	return true, nil
}

// RemoveNativeGuardedV2 deletes through the proved entry handle, never a second
// pathname lookup after validation. A final reparse entry is opened without follow.
func (h *Handlers) RemoveNativeGuardedV2(ctx context.Context, params map[string]any, path string) (bool, error) {
	value, supplied := params["expectedNativeDescriptor"]
	if !supplied {
		return false, nil
	}
	expected, err := decodeNativeDescriptorV2(value)
	if err != nil {
		return true, err
	}
	if expected.Object == nil {
		return true, fmt.Errorf("NATIVE_PATH_IDENTITY_CHANGED: remove requires the original existing entry")
	}
	if err := h.ValidateExpectedNativeDescriptor(ctx, params, path, "remove"); err != nil {
		return true, err
	}
	pins := []windows.Handle{}
	defer func() {
		for _, pin := range pins {
			windows.CloseHandle(pin)
		}
	}()
	for _, ancestor := range expected.Ancestors {
		if err := ctx.Err(); err != nil {
			return true, err
		}
		pointer, err := windows.UTF16PtrFromString(ancestor.CanonicalPath)
		if err != nil {
			return true, err
		}
		pin, err := windows.CreateFile(pointer, windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err != nil {
			return true, err
		}
		pins = append(pins, pin)
	}
	if err := h.ValidateExpectedNativeDescriptor(ctx, params, path, "remove"); err != nil {
		return true, err
	}
	native := path
	if !strings.HasPrefix(native, `\\?\`) {
		if strings.HasPrefix(native, `\\`) {
			native = `\\?\UNC\` + native[2:]
		} else {
			native = `\\?\` + native
		}
	}
	pointer, err := windows.UTF16PtrFromString(native)
	if err != nil {
		return true, err
	}
	handle, err := windows.CreateFile(pointer, windows.DELETE|windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return true, err
	}
	file := os.NewFile(uintptr(handle), path)
	defer file.Close()
	actual, _, err := h.resolveNativeOpenedEntryV2(ctx, file, "remove")
	if err != nil {
		return true, err
	}
	a, _ := json.Marshal(actual)
	b, _ := json.Marshal(expected)
	if string(a) != string(b) {
		return true, fmt.Errorf("NATIVE_PATH_IDENTITY_CHANGED: opened removal entry is not the original")
	}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return true, err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0 && info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT == 0 {
		return true, fmt.Errorf("refusing to remove an ordinary directory")
	}
	if err := ctx.Err(); err != nil {
		return true, err
	}
	disposition := uint8(1)
	if err := windows.SetFileInformationByHandle(handle, 4, (*byte)(unsafe.Pointer(&disposition)), 1); err != nil {
		return true, fmt.Errorf("NATIVE_REMOVE_UNKNOWN: delete disposition dispatched: %w", err)
	}
	if err := file.Close(); err != nil {
		return true, fmt.Errorf("NATIVE_REMOVE_UNKNOWN: delete disposition dispatched but close unconfirmed: %w", err)
	}
	return true, nil
}
