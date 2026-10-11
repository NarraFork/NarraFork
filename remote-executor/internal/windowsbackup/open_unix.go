//go:build !windows

package windowsbackup

import "os"

func OpenObservation(path string) (*os.File, error) { return os.Open(path) }
func OpenMutation(path string) (*os.File, error)    { return os.Open(path) }
