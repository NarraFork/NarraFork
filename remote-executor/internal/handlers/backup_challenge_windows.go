//go:build windows

package handlers

import (
	"context"
	"fmt"
	"os"

	"github.com/narrafork/remote-executor/internal/windowsbackup"
)

// DescribeOrdinary is preauthorization only: it reads native names/IDs/case
// information through the already ordinarily authorized object, no SACL,
// privilege activation, metadata installation or arbitrary path command.
func (o *WindowsBackupNativeOperations) DescribeOrdinary(ctx context.Context, rootKey windowsbackup.NativeDescriptor, file *os.File) (windowsbackup.NativeObservation, error) {
	var observation windowsbackup.NativeObservation
	rootPath, ok := o.roots[rootKey]
	if !ok {
		return observation, fmt.Errorf("exact configured root required")
	}
	target, name, err := o.handlers.ResolveNativeOpenedFileV2(ctx, file)
	if err != nil {
		return observation, err
	}
	root, err := resolveNativePathV2(ctx, rootPath, "existing")
	if err != nil {
		return observation, err
	}
	if !nativeDescriptorContains(root.NativeDescriptor, target) {
		return observation, fmt.Errorf("ordinary target outside native root")
	}
	parent, err := resolveNativePathV2(ctx, target.Parent.CanonicalPath, "existing")
	if err != nil {
		return observation, err
	}
	observation.Root, err = nativeBackupDescriptor(root.NativeDescriptor)
	if err != nil {
		return observation, err
	}
	observation.Parent, err = nativeBackupDescriptor(parent.NativeDescriptor)
	if err != nil {
		return observation, err
	}
	observation.Target, err = nativeBackupDescriptor(target)
	if err != nil {
		return observation, err
	}
	observation.RootPath = root.CanonicalPath
	observation.ParentPath = parent.CanonicalPath
	observation.TargetPath = name
	return observation, nil
}
