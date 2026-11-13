// Package buildinfo contains metadata for the independently distributed peer.
// Release builds set these variables with -ldflags -X.
package buildinfo

var (
	Version   = "dev"
	Commit    = "unknown"
	BuildTime = "unknown"
)
