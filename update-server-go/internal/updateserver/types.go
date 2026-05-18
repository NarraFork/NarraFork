package updateserver

// Platform identifiers accepted by the update server.
const (
	PlatformDarwinARM64    = "darwin-arm64"
	PlatformDarwinX64      = "darwin-x64"
	PlatformLinuxX64       = "linux-x64"
	PlatformLinuxX64Base   = "linux-x64-baseline"
	PlatformLinuxARM64     = "linux-arm64"
	PlatformWindowsX64     = "win-x64"
	PlatformWindowsX64Base = "win-x64-baseline"
	ChannelStable          = "stable"
	ChannelBeta            = "beta"
	TokenRoleAdmin         = "admin"
	TokenRoleUpload        = "upload"
)

var validPlatforms = map[string]bool{
	PlatformDarwinARM64:    true,
	PlatformDarwinX64:      true,
	PlatformLinuxX64:       true,
	PlatformLinuxX64Base:   true,
	PlatformLinuxARM64:     true,
	PlatformWindowsX64:     true,
	PlatformWindowsX64Base: true,
}

func IsValidPlatform(value string) bool {
	return validPlatforms[value]
}

func IsValidChannel(value string) bool {
	return value == ChannelStable || value == ChannelBeta
}

type TokenRecord struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	TokenHash string `json:"tokenHash"`
	Role      string `json:"role"`
	CreatedAt string `json:"createdAt"`
}

type ServerConfig struct {
	Port    int           `json:"port"`
	Host    string        `json:"host"`
	DataDir string        `json:"dataDir"`
	Tokens  []TokenRecord `json:"tokens"`
	Storage struct {
		Type string `json:"type"`
	} `json:"storage"`
	CORS struct {
		Enabled bool     `json:"enabled"`
		Origins []string `json:"origins"`
	} `json:"cors"`
}

type PlatformFileInfo struct {
	Filename             string `json:"filename"`
	Size                 int64  `json:"size"`
	SHA512               string `json:"sha512"`
	HasZstdPatch         bool   `json:"hasZstdPatch"`
	ZstdPatchFromVersion string `json:"zstdPatchFromVersion,omitempty"`
}

type ReleaseMeta struct {
	Version      string                      `json:"version"`
	Channel      string                      `json:"channel"`
	ReleaseDate  string                      `json:"releaseDate"`
	ReleaseNotes any                         `json:"releaseNotes,omitempty"`
	Platforms    map[string]PlatformFileInfo `json:"platforms"`
}

type CheckUpdateResponse struct {
	UpdateAvailable        bool                        `json:"updateAvailable"`
	CurrentVersion         string                      `json:"currentVersion,omitempty"`
	Version                string                      `json:"version,omitempty"`
	ReleaseDate            string                      `json:"releaseDate,omitempty"`
	ReleaseNotes           any                         `json:"releaseNotes,omitempty"`
	Platform               string                      `json:"platform,omitempty"`
	File                   *CheckUpdateFile            `json:"file,omitempty"`
	ZstdPatch              *CheckUpdatePatch           `json:"zstdPatch"`
	PatchChain             []CheckUpdatePatchChainStep `json:"patchChain,omitempty"`
	ReleaseNotesPerVersion []ReleaseNotesVersion       `json:"releaseNotesPerVersion,omitempty"`
}

type CheckUpdateFile struct {
	Filename string `json:"filename"`
	Size     int64  `json:"size"`
	SHA512   string `json:"sha512"`
}

type CheckUpdatePatch struct {
	FromVersion string `json:"fromVersion"`
	PatchSize   int64  `json:"patchSize"`
	URL         string `json:"url"`
	MetaURL     string `json:"metaUrl"`
}

type CheckUpdatePatchChainStep struct {
	FromVersion string `json:"fromVersion"`
	ToVersion   string `json:"toVersion"`
	PatchSize   int64  `json:"patchSize"`
	URL         string `json:"url"`
	MetaURL     string `json:"metaUrl"`
}

type ReleaseNotesVersion struct {
	Version      string `json:"version"`
	ReleaseDate  string `json:"releaseDate"`
	ReleaseNotes any    `json:"releaseNotes,omitempty"`
}

type ZstdPatchMeta struct {
	FromVersion   string `json:"fromVersion"`
	ToVersion     string `json:"toVersion"`
	StableEnd     int64  `json:"stableEnd"`
	NewTailSize   int64  `json:"newTailSize"`
	PatchSize     int64  `json:"patchSize"`
	NewFileSize   int64  `json:"newFileSize"`
	NewFileSHA512 string `json:"newFileSha512"`
	Mode          string `json:"mode,omitempty"`
}

type ReleaseListItem struct {
	Version      string   `json:"version"`
	Channel      string   `json:"channel"`
	ReleaseDate  string   `json:"releaseDate"`
	ReleaseNotes any      `json:"releaseNotes,omitempty"`
	Platforms    []string `json:"platforms"`
}
