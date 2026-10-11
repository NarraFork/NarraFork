//go:build windows

package handlers

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func nativePathFixture(t *testing.T) string {
	t.Helper()
	root := os.Getenv("NARRAFORK_NATIVE_PATH_TEST_ROOT")
	if root == "" {
		t.Skip("native test requires the explicitly allocated private Windows scratch root")
	}
	if err := validateNativeAbsolutePath(root); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		t.Fatalf("invalid allocated scratch root: %v", err)
	}
	fixture, err := os.MkdirTemp(root, "native-path-v2-")
	if err != nil {
		t.Fatal(err)
	}
	// Only this created fixture may be removed, not the operator's parent root.
	t.Cleanup(func() {
		if err := os.RemoveAll(fixture); err != nil {
			t.Error(err)
		}
	})
	return fixture
}

func resolveNativeFixture(t *testing.T, path string) *nativePathResultV2 {
	t.Helper()
	result, err := resolveNativePathV2(context.Background(), path, "create")
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(result)
	if err != nil || len(body) > nativePathBodyLimit || len(result.NativeDescriptor.Ancestors) > nativePathAncestorLimit {
		t.Fatal("descriptor budgets violated")
	}
	return result
}

func TestWindowsNativePathOrdinaryAliasAndIncarnation(t *testing.T) {
	root := nativePathFixture(t)
	dir := filepath.Join(root, "Work Unicode 空格")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "文件.txt")
	if err := os.WriteFile(path, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	canonical := resolveNativeFixture(t, path)
	alias := resolveNativeFixture(t, strings.ToUpper(path))
	if !nativeSamePath(path, strings.ToUpper(path)) || canonical.NativeDescriptor.PathSlotKey != alias.NativeDescriptor.PathSlotKey {
		t.Fatal("ordinary insensitive NTFS alias incorrectly refused")
	}
	guard := NewPathGuardWithRules([]PathRule{{Action: RuleAllow, Path: strings.ToUpper(dir)}})
	if _, err := guard.CheckExisting(path); err != nil {
		t.Fatalf("default directory case alias denied: %v", err)
	}
	h := New(guard, 1<<20)
	params := map[string]any{"expectedNativeDescriptor": canonical.NativeDescriptor}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.ValidateNativeOpenedFileV2(context.Background(), params, path, file); err != nil {
		file.Close()
		t.Fatal(err)
	}
	file.Close()
	replaced := filepath.Join(dir, "replacement.txt")
	if err := os.WriteFile(replaced, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replaced, path); err != nil {
		t.Fatal(err)
	}
	if err := h.ValidateExpectedNativeDescriptor(context.Background(), params, path, "existing"); err == nil {
		t.Fatal("same bytes in a new incarnation accepted as the original object")
	}
}

func TestWindowsNativePathCaseSensitiveDenyHole(t *testing.T) {
	root := nativePathFixture(t)
	dir := filepath.Join(root, "case-sensitive")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	ptr, _ := windows.UTF16PtrFromString(dir)
	handle, err := windows.CreateFile(ptr, windows.GENERIC_WRITE|windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		t.Fatal(err)
	}
	flags := uint32(windows.FILE_CS_FLAG_CASE_SENSITIVE_DIR)
	err = windows.SetFileInformationByHandle(handle, pathFileCaseSensitiveInfo, (*byte)(unsafe.Pointer(&flags)), 4)
	windows.CloseHandle(handle)
	if err != nil {
		t.Fatalf("allocated NTFS fixture cannot enable native case mode: %v", err)
	}
	upper := filepath.Join(dir, "Work")
	lower := filepath.Join(dir, "work")
	for _, path := range []string{upper, lower} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	up := resolveNativeFixture(t, upper)
	down := resolveNativeFixture(t, lower)
	if up.NativeDescriptor.PathSlotKey == down.NativeDescriptor.PathSlotKey || nativeSamePath(upper, lower) {
		t.Fatal("case-sensitive Work/work collapsed")
	}
	guard := NewPathGuardWithRules([]PathRule{{Action: RuleAllow, Path: dir}, {Action: RuleDeny, Path: upper}})
	if _, err := guard.CheckCreate(filepath.Join(upper, "new.txt")); err == nil {
		t.Fatal("deny hole escaped via case folding")
	}
	if _, err := guard.CheckCreate(filepath.Join(lower, "new.txt")); err != nil {
		t.Fatalf("distinct work directory incorrectly denied: %v", err)
	}
	for _, path := range []string{upper, lower} {
		file := filepath.Join(path, "file.txt")
		if err := os.WriteFile(file, []byte("native-case"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := guard.CheckExisting(filepath.Join(upper, "file.txt")); err == nil {
		t.Fatal("existing file bypassed deny hole")
	}
	if _, err := guard.CheckExisting(filepath.Join(lower, "file.txt")); err != nil {
		t.Fatal(err)
	}
}

func TestWindowsNativePathLongExtendedNamesAndMissingSuffix(t *testing.T) {
	root := nativePathFixture(t)
	extended := `\\?\` + root
	dir := extended
	for i := 0; i < 7; i++ {
		dir = filepath.Join(dir, "Unicode 空格"+strings.Repeat("x", 45))
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "长文件名.txt")
	if len(path) <= 260 {
		t.Fatal("fixture does not exceed MAX_PATH")
	}
	if err := os.WriteFile(path, []byte("long-path"), 0600); err != nil {
		t.Fatal(err)
	}
	result := resolveNativeFixture(t, path)
	if !result.Exists || result.NativeDescriptor.Object == nil {
		t.Fatal("existing long-path incarnation missing")
	}
	missing := resolveNativeFixture(t, filepath.Join(dir, "未创建", "文件.txt"))
	if missing.Exists || missing.NativeDescriptor.Object != nil || len(missing.NativeDescriptor.MissingSuffix) != 2 {
		t.Fatal("new path slot confused with an existing object")
	}
	parent := resolveNativeFixture(t, dir)
	if !nativeDescriptorContains(parent.NativeDescriptor, missing.NativeDescriptor) {
		t.Fatal("missing suffix not bound to original native parent")
	}
}

func TestWindowsNativePathActualWriteAndPreTruncateRejection(t *testing.T) {
	root := nativePathFixture(t)
	h := New(NewPathGuard([]string{root}), 1<<20)
	path := filepath.Join(root, "Unicode 空格 file.txt")
	original := []byte("original bytes")
	if err := os.WriteFile(path, original, 0600); err != nil {
		t.Fatal(err)
	}
	identity := resolveNativeFixture(t, path)
	params := map[string]any{"path": path, "expectedNativeDescriptor": identity.NativeDescriptor, "dataB64": base64.StdEncoding.EncodeToString([]byte("updated"))}
	if _, err := h.FsWriteContext(context.Background(), params); err != nil {
		t.Fatal(err)
	}
	bytes, err := os.ReadFile(path)
	if err != nil || string(bytes) != "updated" {
		t.Fatalf("native actual write failed: %q %v", bytes, err)
	}
	params["dataB64"] = base64.StdEncoding.EncodeToString(original)
	replacement := filepath.Join(root, "replacement")
	if err := os.WriteFile(replacement, []byte("replacement bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, path); err != nil {
		t.Fatal(err)
	}
	if _, err := h.FsWriteContext(context.Background(), params); err == nil {
		t.Fatal("stale incarnation dispatched write")
	}
	bytes, err = os.ReadFile(path)
	if err != nil || string(bytes) != "replacement bytes" {
		t.Fatal("rejected write truncated replacement before actual handle proof")
	}
	newPath := filepath.Join(root, "exclusive new file.txt")
	newIdentity := resolveNativeFixture(t, newPath)
	params = map[string]any{"path": newPath, "expectedNativeDescriptor": newIdentity.NativeDescriptor, "dataB64": base64.StdEncoding.EncodeToString(original)}
	if _, err := h.FsWriteContext(context.Background(), params); err != nil {
		t.Fatal(err)
	}
	bytes, err = os.ReadFile(newPath)
	if err != nil || string(bytes) != string(original) {
		t.Fatalf("native exclusive create failed: %q %v", bytes, err)
	}
	if _, err := h.FsWriteContext(context.Background(), params); err == nil {
		t.Fatal("original nonexistent-slot proof overwrote existing object")
	}
	deep := filepath.Join(root, "must-not-create-parent", "file.txt")
	deepIdentity := resolveNativeFixture(t, deep)
	if _, err := h.FsWriteContext(context.Background(), map[string]any{"path": deep, "expectedNativeDescriptor": deepIdentity.NativeDescriptor, "dataB64": ""}); err == nil {
		t.Fatal("unproved final parent accepted")
	}
	if _, err := os.Stat(filepath.Dir(deep)); !os.IsNotExist(err) {
		t.Fatalf("preflight rejection changed the filesystem: %v", err)
	}
}

func TestWindowsNativePathOriginalRootAndActualRemove(t *testing.T) {
	root := nativePathFixture(t)
	h := New(NewPathGuard([]string{root}), 1<<20)
	rootIdentity := resolveNativeFixture(t, root)
	path := filepath.Join(root, "remove 文件.txt")
	if err := os.WriteFile(path, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	identity := resolveNativeFixture(t, path)
	request := map[string]any{"inputPath": path, "baseCwd": root, "operation": "existing", "expectedRootDescriptor": rootIdentity.NativeDescriptor}
	if _, err := h.FsResolvePathV2(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	mismatch := *rootIdentity.NativeDescriptor
	other := *mismatch.Object
	other.CreationTime = "1"
	mismatch.Object = &other
	request["expectedRootDescriptor"] = &mismatch
	if _, err := h.FsResolvePathV2(context.Background(), request); err == nil {
		t.Fatal("original root incarnation replaced with current root")
	}
	params := map[string]any{"path": path, "expectedNativeDescriptor": identity.NativeDescriptor, "expectedRootDescriptor": rootIdentity.NativeDescriptor}
	if _, err := h.FsRemoveContext(context.Background(), params); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("native handle removal not completed: %v", err)
	}
	if err := os.WriteFile(path, []byte("replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := h.FsRemoveContext(context.Background(), params); err == nil {
		t.Fatal("stale original descriptor removed a replacement")
	}
	bytes, err := os.ReadFile(path)
	if err != nil || string(bytes) != "replacement" {
		t.Fatal("rejected removal changed replacement bytes")
	}
}

func TestWindowsNativePathRejectsSpecialTargetsAcrossEntrypoints(t *testing.T) {
	root := nativePathFixture(t)
	h := New(NewPathGuard([]string{root}), 1<<20)
	for _, bad := range []string{filepath.Join(root, "NUL.txt"), filepath.Join(root, "COM¹.log"), filepath.Join(root, "file:stream"), `\\.\pipe\name`, `\\?\GLOBALROOT\Device\HarddiskVolume1\file`} {
		t.Run(bad, func(t *testing.T) {
			params := map[string]any{"path": bad, "dataB64": ""}
			for _, invoke := range []func(map[string]any) (any, error){h.FsStat, h.FsExists, h.FsRead, h.FsWrite, h.FsRemove, h.FsMkdirp} {
				if _, err := invoke(params); err == nil {
					t.Fatalf("entrypoint accepted forbidden path %q", bad)
				}
			}
			if _, err := h.FsResolvePathV2(context.Background(), map[string]any{"inputPath": bad, "baseCwd": root, "operation": "create"}); err == nil {
				t.Fatal("v2 resolver accepted forbidden path")
			}
		})
	}
}

type nativeJunctionOutput struct {
	buffer    bytes.Buffer
	truncated bool
}

func (w *nativeJunctionOutput) Write(data []byte) (int, error) {
	count := len(data)
	remaining := nativePathBodyLimit - w.buffer.Len()
	if len(data) > remaining {
		data = data[:remaining]
		w.truncated = true
	}
	_, _ = w.buffer.Write(data)
	return count, nil
}

func nativeFixtureFilesystem(t *testing.T, root string) string {
	t.Helper()
	handle, err := openNativePathHandle(root, false)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(handle.handle)
	var name [64]uint16
	if err := windows.GetVolumeInformationByHandle(handle.handle, nil, 0, nil, nil, nil, &name[0], uint32(len(name))); err != nil {
		t.Fatal(err)
	}
	return windows.UTF16ToString(name[:])
}

// This is a separate mount-point junction fixture. Keep the existing directory
// symbolic-link and root-replacement assertions below unchanged.
func TestWindowsNativePathActualMountPointJunction(t *testing.T) {
	root := nativePathFixture(t)
	filesystem := nativeFixtureFilesystem(t, root)
	allowed := filepath.Join(root, "junction allowed")
	outside := filepath.Join(root, "junction outside Unicode 空格")
	for _, directory := range []string{allowed, outside} {
		if err := os.Mkdir(directory, 0700); err != nil {
			t.Fatal(err)
		}
	}
	sentinel := filepath.Join(outside, "external 文件.txt")
	original := []byte("external target must survive junction removal")
	if err := os.WriteFile(sentinel, original, 0600); err != nil {
		t.Fatal(err)
	}
	junction := filepath.Join(allowed, "真实 Junction 空格")
	systemDirectory, err := windows.GetSystemDirectory()
	if err != nil {
		t.Fatal(err)
	}
	// cmd's mklink is builtin. Only paths created in this fixture appear in argv,
	// and the child never inherits the machine's System32 working directory.
	ctx, cancel := context.WithTimeout(context.Background(), 9*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, filepath.Join(systemDirectory, "cmd.exe"), "/d", "/c", "mklink", "/J", junction, outside)
	command.Dir = root
	command.WaitDelay = time.Second
	output := &nativeJunctionOutput{}
	command.Stdout, command.Stderr = output, output
	err = command.Run()
	if output.truncated {
		t.Fatal("junction command exceeded its 64 KiB output budget")
	}
	if ctx.Err() != nil {
		t.Fatalf("junction command exceeded bounded creation time: %v", ctx.Err())
	}
	if err != nil {
		if strings.EqualFold(filesystem, "ReFS") {
			t.Skipf("CAPABILITY_NOT_READY: actual ReFS mount-point creation refused; fs=%s exit=%v output=%q (not a passed junction workflow)", filesystem, err, output.buffer.String())
		}
		t.Fatalf("actual %s junction creation failed: %v output=%q", filesystem, err, output.buffer.String())
	}
	pointer, err := windows.UTF16PtrFromString(junction)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(pointer, windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		t.Fatal(err)
	}
	var tag struct {
		Attributes uint32
		Tag        uint32
	}
	err = windows.GetFileInformationByHandleEx(handle, 9, (*byte)(unsafe.Pointer(&tag)), uint32(unsafe.Sizeof(tag))) // FileAttributeTagInfo
	windows.CloseHandle(handle)
	if err != nil {
		t.Fatal(err)
	}
	if tag.Attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT == 0 || tag.Tag != windows.IO_REPARSE_TAG_MOUNT_POINT {
		t.Fatalf("not a mount-point junction: fs=%s attributes=%#x tag=%#x", filesystem, tag.Attributes, tag.Tag)
	}
	t.Logf("REAL_JUNCTION fs=%s tag=%#x commandOutputBytes=%d workingDirectory=explicit-fixture", filesystem, tag.Tag, output.buffer.Len())
	guard := NewPathGuard([]string{allowed})
	if _, err := guard.CheckExisting(filepath.Join(junction, filepath.Base(sentinel))); err == nil {
		t.Fatal("existing junction target escaped the allowed native root")
	}
	if _, err := guard.CheckCreate(filepath.Join(junction, "must-not-create.txt")); err == nil {
		t.Fatal("missing junction target escaped the allowed native root")
	}
	if _, err := guard.CheckRemove(junction); err != nil {
		t.Fatalf("final removal followed the junction target: %v", err)
	}
	identity, err := resolveNativePathV2(context.Background(), junction, "remove")
	if err != nil {
		t.Fatal(err)
	}
	h := New(guard, 1<<20)
	if _, err := h.FsRemoveContext(context.Background(), map[string]any{"path": junction, "expectedNativeDescriptor": identity.NativeDescriptor}); err != nil {
		t.Fatalf("native final-entry junction removal failed: %v", err)
	}
	if _, err := os.Lstat(junction); !os.IsNotExist(err) {
		t.Fatalf("junction entry was not removed: %v", err)
	}
	actual, err := os.ReadFile(sentinel)
	if err != nil || !bytes.Equal(actual, original) {
		t.Fatalf("junction removal changed or followed external target: %q %v", actual, err)
	}
	if _, err := os.Stat(filepath.Join(outside, "must-not-create.txt")); !os.IsNotExist(err) {
		t.Fatalf("rejected escape created an external file: %v", err)
	}
}

func TestWindowsNativePathRootReplacementAndJunctionEscape(t *testing.T) {
	root := nativePathFixture(t)
	allowed, outside := filepath.Join(root, "allowed"), filepath.Join(root, "outside")
	for _, dir := range []string{allowed, outside} {
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	guard := NewPathGuard([]string{allowed})
	link := filepath.Join(allowed, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	if _, err := guard.CheckCreate(filepath.Join(link, "file.txt")); err == nil {
		t.Fatal("junction/symlink escaped configured native root")
	}
	if _, err := guard.CheckRemove(link); err != nil {
		t.Fatalf("removal followed the final reparse instead of checking its entry: %v", err)
	}
	if err := os.Rename(allowed, filepath.Join(root, "old-allowed")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(allowed, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := guard.CheckCreate(filepath.Join(allowed, "file.txt")); err == nil {
		t.Fatal("replacement configured root inherited original authorization")
	}
}
