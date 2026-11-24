package handlers

import (
	"path/filepath"
	"strings"
)

const stagingProjectRelative = ".narrafork/git-staging"

func stagingExcludeSpec() string {
	if filepath.Separator == '\\' {
		return ":(top,exclude,literal,icase).narrafork/git-staging"
	}
	return ":(top,exclude,literal).narrafork/git-staging"
}

// The leading glob bracket keeps stash's pathspec preparation from selecting
// the ignored directory itself while matching exactly the reserved subtree.
func stagingStashExcludeSpec() string {
	if filepath.Separator == '\\' {
		return ":(top,exclude,glob,icase)[.]narrafork/git-staging/**"
	}
	return ":(top,exclude,glob)[.]narrafork/git-staging/**"
}

func stagingInternalPath(path string) bool {
	path = filepath.ToSlash(filepath.Clean(filepath.FromSlash(path)))
	if filepath.Separator == '\\' {
		path = strings.ToLower(path)
	}
	return path == stagingProjectRelative || strings.HasPrefix(path, stagingProjectRelative+"/")
}
