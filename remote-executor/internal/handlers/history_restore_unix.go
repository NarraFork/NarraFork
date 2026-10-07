//go:build !windows

package handlers

import "os"

func quarantineHistoryOriginal(file *os.File, destination string) error {
	return os.Rename(file.Name(), destination)
}
func publishHistoryNoReplace(source, destination string) error {
	// A hard-link publication is an atomic no-overwrite entry creation on the same
	// filesystem. Remove the private/temp link only after that creation succeeded.
	if err := os.Link(source, destination); err != nil {
		return err
	}
	return os.Remove(source)
}
func syncHistoryDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
