//go:build !windows

package handlers

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func NativePathV2APIReady() bool { return false }

func resolveNativePathV2(ctx context.Context, path, operation string) (*nativePathResultV2, error) {
	return nil, fmt.Errorf("NATIVE_PATH_CAPABILITY_NOT_READY: Windows path v2 requires a Windows executor")
}
func captureNativeGuardRoot(path string) (*NativePathDescriptorV2, error) { return nil, nil }
func nativeGuardRuleContains(ctx context.Context, rule resolvedRule, path, operation string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	return nativePathWithin(rule.root, path)
}
func nativePathWithin(root, path string) (bool, error) {
	rel, err := filepath.Rel(filepath.Clean(root), filepath.Clean(path))
	if err != nil || filepath.IsAbs(rel) {
		return false, err
	}
	return rel == "." || rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)), nil
}
func nativeDenyPathWithin(root, path string) (bool, error) { return nativePathWithin(root, path) }
func nativeDenyPathWithinContext(ctx context.Context, root, path string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	return nativePathWithin(root, path)
}

func nativeSamePath(left, right string) bool               { return filepath.Clean(left) == filepath.Clean(right) }
func validateNativeAbsolutePath(path string) error         { return nil }
func NativePathContainsV2(root, path string) (bool, error) { return nativePathWithin(root, path) }
func (h *Handlers) PinNativeDirectoryV2(ctx context.Context, params map[string]any, path string) (func(), error) {
	return func() {}, nil
}

func (h *Handlers) PinConditionalMissingParentV2(ctx context.Context, params map[string]any, path string) (func(), error) {
	return func() {}, nil
}

func (h *Handlers) RemoveNativeGuardedV2(ctx context.Context, params map[string]any, path string) (bool, error) {
	return false, nil
}

func (h *Handlers) WriteNativeGuardedV2(ctx context.Context, params map[string]any, path string, data []byte) (bool, error) {
	return false, nil
}

func (h *Handlers) ValidateNativeOpenedFileV2(ctx context.Context, params map[string]any, path string, file *os.File) error {
	return h.ValidateExpectedNativeDescriptor(ctx, params, path, "existing")
}
