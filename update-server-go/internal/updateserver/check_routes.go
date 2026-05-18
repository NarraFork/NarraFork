package updateserver

import (
	"encoding/json"
	"net/http"
	"sort"
)

func (a *App) latestRelease(w http.ResponseWriter, r *http.Request) {
	product := r.PathValue("product")
	channel := r.URL.Query().Get("channel")
	if channel == "" {
		channel = ChannelStable
	}
	platform := r.URL.Query().Get("platform")
	currentVersion := r.URL.Query().Get("version")

	if !isSafeIdentifier(product) {
		writeError(w, http.StatusBadRequest, "Invalid product parameter")
		return
	}
	if platform == "" || !IsValidPlatform(platform) {
		writeError(w, http.StatusBadRequest, "Invalid or missing platform parameter")
		return
	}
	if !IsValidChannel(channel) {
		writeError(w, http.StatusBadRequest, "Invalid channel parameter")
		return
	}
	if currentVersion != "" && !isSafeIdentifier(currentVersion) {
		writeError(w, http.StatusBadRequest, "Invalid version parameter")
		return
	}

	latest, err := a.Cache.Latest(product, channel, platform)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	if latest == nil {
		writeJSON(w, http.StatusOK, CheckUpdateResponse{UpdateAvailable: false, CurrentVersion: currentVersion})
		return
	}
	if currentVersion != "" && !IsNewerVersion(latest.Version, currentVersion) {
		writeJSON(w, http.StatusOK, CheckUpdateResponse{UpdateAvailable: false, CurrentVersion: currentVersion, Version: latest.Version})
		return
	}
	platformInfo, ok := latest.Platforms[platform]
	if !ok {
		writeJSON(w, http.StatusOK, CheckUpdateResponse{UpdateAvailable: false, CurrentVersion: currentVersion, Version: latest.Version})
		return
	}

	resp := CheckUpdateResponse{
		CurrentVersion: currentVersion,
		Version:        latest.Version,
		ReleaseDate:    latest.ReleaseDate,
		ReleaseNotes:   latest.ReleaseNotes,
		Platform:       platform,
		File: &CheckUpdateFile{
			Filename: platformInfo.Filename,
			Size:     platformInfo.Size,
			SHA512:   platformInfo.SHA512,
		},
	}

	if currentVersion != "" {
		if patch, ok := a.directPatchInfo(product, latest.Version, platform, currentVersion, platformInfo); ok {
			resp.UpdateAvailable = true
			resp.ZstdPatch = patch
			writeJSON(w, http.StatusOK, resp)
			return
		}
		if chain, notes, ok := a.patchChain(product, platform, currentVersion, *latest); ok {
			resp.UpdateAvailable = true
			resp.PatchChain = chain
			resp.ReleaseNotesPerVersion = notes
			writeJSON(w, http.StatusOK, resp)
			return
		}
	}

	resp.UpdateAvailable = false
	writeJSON(w, http.StatusOK, resp)
}

func (a *App) directPatchInfo(product, releaseVersion, platform, currentVersion string, platformInfo PlatformFileInfo) (*CheckUpdatePatch, bool) {
	if !validateDownloadFilename(platformInfo.Filename) {
		return nil, false
	}
	metaPath := "products/" + product + "/releases/" + releaseVersion + "/" + platform + "/" + platformInfo.Filename + ".zstd-patch.meta.json"
	data, ok, err := a.Storage.GetBytes(metaPath)
	if err != nil || !ok {
		return nil, false
	}
	var patchMeta ZstdPatchMeta
	if json.Unmarshal(data, &patchMeta) != nil {
		return nil, false
	}
	if patchMeta.FromVersion != currentVersion || patchMeta.ToVersion != releaseVersion {
		return nil, false
	}
	if patchMeta.NewFileSize != platformInfo.Size || patchMeta.NewFileSHA512 != platformInfo.SHA512 {
		return nil, false
	}
	patchPath := "products/" + product + "/releases/" + releaseVersion + "/" + platform + "/" + platformInfo.Filename + ".zstd-patch"
	size, ok, err := a.Storage.FileSize(patchPath)
	if err != nil || !ok || size != patchMeta.PatchSize {
		return nil, false
	}
	return &CheckUpdatePatch{
		FromVersion: patchMeta.FromVersion,
		PatchSize:   patchMeta.PatchSize,
		URL:         "/api/v2/products/" + product + "/releases/" + releaseVersion + "/zstd-patch/" + platformInfo.Filename,
		MetaURL:     "/api/v2/products/" + product + "/releases/" + releaseVersion + "/zstd-patch-meta/" + platformInfo.Filename,
	}, true
}

func (a *App) patchChain(product, platform, currentVersion string, latest ReleaseMeta) ([]CheckUpdatePatchChainStep, []ReleaseNotesVersion, bool) {
	all, err := a.Cache.All(product)
	if err != nil {
		return nil, nil, false
	}
	candidates := []ReleaseMeta{}
	for _, release := range all {
		if _, ok := release.Platforms[platform]; !ok {
			continue
		}
		if CompareVersions(release.Version, currentVersion) > 0 && CompareVersions(release.Version, latest.Version) <= 0 {
			candidates = append(candidates, release)
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		return CompareVersions(candidates[i].Version, candidates[j].Version) < 0
	})

	chain := []CheckUpdatePatchChainStep{}
	notes := []ReleaseNotesVersion{}
	prevVersion := currentVersion
	for _, release := range candidates {
		pi := release.Platforms[platform]
		if !pi.HasZstdPatch || !validateDownloadFilename(pi.Filename) {
			break
		}
		patchMetaPath := "products/" + product + "/releases/" + release.Version + "/" + platform + "/" + pi.Filename + ".zstd-patch.meta.json"
		buf, ok, err := a.Storage.GetBytes(patchMetaPath)
		if err != nil || !ok {
			break
		}
		var pm ZstdPatchMeta
		if json.Unmarshal(buf, &pm) != nil || pm.FromVersion != prevVersion || pm.ToVersion != release.Version {
			break
		}
		if pm.NewFileSize != pi.Size || pm.NewFileSHA512 != pi.SHA512 {
			break
		}
		patchPath := "products/" + product + "/releases/" + release.Version + "/" + platform + "/" + pi.Filename + ".zstd-patch"
		size, ok, err := a.Storage.FileSize(patchPath)
		if err != nil || !ok || size != pm.PatchSize {
			break
		}
		releaseURL := "/api/v2/products/" + product + "/releases/" + release.Version
		chain = append(chain, CheckUpdatePatchChainStep{
			FromVersion: pm.FromVersion,
			ToVersion:   pm.ToVersion,
			PatchSize:   pm.PatchSize,
			URL:         releaseURL + "/zstd-patch/" + pi.Filename,
			MetaURL:     releaseURL + "/zstd-patch-meta/" + pi.Filename,
		})
		notes = append(notes, ReleaseNotesVersion{Version: release.Version, ReleaseDate: release.ReleaseDate, ReleaseNotes: release.ReleaseNotes})
		prevVersion = release.Version
	}
	if len(chain) == 0 || chain[len(chain)-1].ToVersion != latest.Version {
		return nil, nil, false
	}
	return chain, notes, true
}
