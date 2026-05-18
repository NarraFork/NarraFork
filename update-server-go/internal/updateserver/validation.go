package updateserver

import (
	"fmt"
	"path/filepath"
	"regexp"
)

var safeIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

func isSafeIdentifier(value string) bool {
	return value != "" && safeIdentifierPattern.MatchString(value) && filepath.Base(value) == value
}

func validateReleaseIdentifiers(product, version, platform, filename string) error {
	if !isSafeIdentifier(product) {
		return fmt.Errorf("invalid product")
	}
	if !isSafeIdentifier(version) {
		return fmt.Errorf("invalid version")
	}
	if !isSafeIdentifier(platform) {
		return fmt.Errorf("invalid platform")
	}
	if !isSafeIdentifier(filename) {
		return fmt.Errorf("invalid filename")
	}
	return nil
}

func validateDownloadFilename(filename string) bool {
	return isSafeIdentifier(filename)
}
