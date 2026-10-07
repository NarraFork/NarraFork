//go:build !linux && !darwin && !windows

package history

import "fmt"

func rootIdentity(path string) (string, error) {
	return "", fmt.Errorf("unsupported_root_identity: platform has no durable incarnation provider")
}
