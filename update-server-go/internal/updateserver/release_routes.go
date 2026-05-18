package updateserver

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	maxUploadMemory      = 32 << 20
	maxUploadRequestSize = 256 << 20
	maxPatchMetaSize     = 1 << 20
)

func (a *App) uploadRelease(w http.ResponseWriter, r *http.Request) {
	product := r.PathValue("product")
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadRequestSize)
	if err := r.ParseMultipartForm(maxUploadMemory); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid multipart form")
		return
	}

	version := strings.TrimSpace(r.FormValue("version"))
	channel := strings.TrimSpace(r.FormValue("channel"))
	platform := strings.TrimSpace(r.FormValue("platform"))
	filename := strings.TrimSpace(r.FormValue("filename"))
	metaSize := strings.TrimSpace(r.FormValue("size"))
	metaSHA512 := strings.TrimSpace(r.FormValue("sha512"))
	if !IsValidChannel(channel) {
		writeError(w, http.StatusBadRequest, "Invalid or missing channel")
		return
	}
	if !IsValidPlatform(platform) {
		writeError(w, http.StatusBadRequest, "Invalid or missing platform")
		return
	}
	if err := validateReleaseIdentifiers(product, version, platform, filename); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if metaSize == "" || metaSHA512 == "" {
		writeError(w, http.StatusBadRequest, "Missing filename metadata")
		return
	}

	releaseNotes := parseReleaseNotes(r.FormValue("releaseNotes"))
	parsedSize, err := strconv.ParseInt(metaSize, 10, 64)
	if err != nil || parsedSize <= 0 {
		writeError(w, http.StatusBadRequest, "Invalid size")
		return
	}

	patchFile, _, patchErr := r.FormFile("zstdPatch")
	patchMetaFile, _, patchMetaErr := r.FormFile("zstdPatchMeta")
	if patchErr != nil || patchMetaErr != nil {
		writeError(w, http.StatusBadRequest, "zstdPatch and zstdPatchMeta are required")
		return
	}
	defer patchFile.Close()
	defer patchMetaFile.Close()

	basePath := filepath.Join(a.Storage.BaseDir(), "products", product, "releases", version, platform)
	if err := os.MkdirAll(basePath, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to prepare release directory")
		return
	}
	patchPath := filepath.Join(basePath, filename+".zstd-patch")
	patchTemp, err := os.CreateTemp(basePath, filename+".zstd-patch-*.tmp")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to create patch temp file")
		return
	}
	patchWritten, copyErr := io.Copy(patchTemp, patchFile)
	closeErr := patchTemp.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(patchTemp.Name())
		if copyErr != nil {
			writeError(w, http.StatusBadRequest, "Invalid zstdPatch")
		} else {
			writeError(w, http.StatusInternalServerError, "Failed to finalize patch file")
		}
		return
	}
	if patchWritten <= 0 {
		_ = os.Remove(patchTemp.Name())
		writeError(w, http.StatusBadRequest, "Invalid zstdPatch")
		return
	}

	metaBuf, err := io.ReadAll(io.LimitReader(patchMetaFile, maxPatchMetaSize+1))
	if err != nil {
		_ = os.Remove(patchTemp.Name())
		writeError(w, http.StatusBadRequest, "Invalid zstdPatchMeta")
		return
	}
	if int64(len(metaBuf)) > maxPatchMetaSize {
		_ = os.Remove(patchTemp.Name())
		writeError(w, http.StatusBadRequest, "zstdPatchMeta too large")
		return
	}
	var pm ZstdPatchMeta
	if err := json.Unmarshal(metaBuf, &pm); err != nil {
		_ = os.Remove(patchTemp.Name())
		writeError(w, http.StatusBadRequest, "Invalid zstdPatchMeta")
		return
	}
	if pm.FromVersion == "" || !isSafeIdentifier(pm.FromVersion) || pm.ToVersion != version || pm.NewFileSize != parsedSize || pm.NewFileSHA512 != metaSHA512 || pm.PatchSize != patchWritten {
		_ = os.Remove(patchTemp.Name())
		writeError(w, http.StatusBadRequest, "zstdPatchMeta does not match release metadata")
		return
	}
	if pm.Mode != "" && pm.Mode != "patch-from" && pm.Mode != "dictionary" {
		_ = os.Remove(patchTemp.Name())
		writeError(w, http.StatusBadRequest, "Unsupported zstd patch mode")
		return
	}
	if err := os.Rename(patchTemp.Name(), patchPath); err != nil {
		_ = os.Remove(patchTemp.Name())
		writeError(w, http.StatusInternalServerError, "Failed to save zstd patch")
		return
	}
	if err := os.WriteFile(filepath.Join(basePath, filename+".zstd-patch.meta.json"), metaBuf, 0o644); err != nil {
		_ = os.Remove(patchPath)
		writeError(w, http.StatusInternalServerError, "Failed to save zstd patch metadata")
		return
	}

	lock := a.versionLock(product, version)
	lock.Lock()
	defer lock.Unlock()
	metaPath := filepath.Join(a.Storage.BaseDir(), "products", product, "releases", version, "meta.json")
	relMetaPath := filepath.ToSlash(filepath.Join("products", product, "releases", version, "meta.json"))
	meta := ReleaseMeta{}
	if existing, ok, _ := a.Storage.GetBytes(relMetaPath); ok {
		_ = json.Unmarshal(existing, &meta)
	}
	if meta.Version == "" {
		meta = ReleaseMeta{Version: version, Channel: channel, ReleaseDate: time.Now().UTC().Format(time.RFC3339), Platforms: map[string]PlatformFileInfo{}}
	}
	meta.Channel = firstNonEmpty(meta.Channel, channel)
	if releaseNotes != nil {
		meta.ReleaseNotes = releaseNotes
	}
	if meta.Platforms == nil {
		meta.Platforms = map[string]PlatformFileInfo{}
	}
	meta.Platforms[platform] = PlatformFileInfo{Filename: filename, Size: parsedSize, SHA512: metaSHA512, HasZstdPatch: true, ZstdPatchFromVersion: pm.FromVersion}
	metaJSON, err := json.MarshalIndent(meta, "", "\t")
	if err != nil {
		_ = os.Remove(patchPath)
		_ = os.Remove(filepath.Join(basePath, filename+".zstd-patch.meta.json"))
		writeError(w, http.StatusInternalServerError, "Failed to encode release metadata")
		return
	}
	if err := os.WriteFile(metaPath, metaJSON, 0o644); err != nil {
		_ = os.Remove(patchPath)
		_ = os.Remove(filepath.Join(basePath, filename+".zstd-patch.meta.json"))
		writeError(w, http.StatusInternalServerError, "Failed to save release metadata")
		return
	}
	a.Cache.Set(product, meta)
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "version": version, "platform": platform, "filename": filename, "size": parsedSize, "sha512": shortSHA(metaSHA512), "hasZstdPatch": true})
}

func parseReleaseNotes(raw string) any {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var parsed any
	if json.Unmarshal([]byte(raw), &parsed) == nil {
		if obj, ok := parsed.(map[string]any); ok {
			return obj
		}
	}
	return raw
}

func shortSHA(value string) string {
	if len(value) <= 16 {
		return value + "..."
	}
	return value[:16] + "..."
}

func (a *App) listReleases(w http.ResponseWriter, r *http.Request) {
	product := r.PathValue("product")
	if !isSafeIdentifier(product) {
		writeError(w, http.StatusBadRequest, "Invalid product")
		return
	}
	all, err := a.Cache.All(product)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	items := make([]ReleaseListItem, 0, len(all))
	for _, meta := range all {
		platforms := make([]string, 0, len(meta.Platforms))
		for platform := range meta.Platforms {
			platforms = append(platforms, platform)
		}
		sort.Strings(platforms)
		items = append(items, ReleaseListItem{Version: meta.Version, Channel: meta.Channel, ReleaseDate: meta.ReleaseDate, ReleaseNotes: meta.ReleaseNotes, Platforms: platforms})
	}
	writeJSON(w, http.StatusOK, map[string]any{"releases": items})
}

func (a *App) promoteRelease(w http.ResponseWriter, r *http.Request) {
	product := r.PathValue("product")
	version := r.PathValue("version")
	if !isSafeIdentifier(product) || !isSafeIdentifier(version) {
		writeError(w, http.StatusBadRequest, "Invalid product or version")
		return
	}
	targetChannel := ChannelStable
	var body map[string]any
	if json.NewDecoder(r.Body).Decode(&body) == nil {
		if ch, ok := body["channel"].(string); ok && ch != "" {
			targetChannel = ch
		}
	}
	if targetChannel != ChannelStable && targetChannel != ChannelBeta {
		writeError(w, http.StatusBadRequest, "Invalid channel (must be 'stable' or 'beta')")
		return
	}
	lock := a.versionLock(product, version)
	lock.Lock()
	defer lock.Unlock()
	metaPath := filepath.Join(a.Storage.BaseDir(), "products", product, "releases", version, "meta.json")
	buf, ok, err := a.Storage.GetBytes(filepath.ToSlash(filepath.Join("products", product, "releases", version, "meta.json")))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	if !ok {
		writeError(w, http.StatusNotFound, "Release not found")
		return
	}
	var meta ReleaseMeta
	if err := json.Unmarshal(buf, &meta); err != nil {
		writeError(w, http.StatusInternalServerError, "Invalid release metadata")
		return
	}
	meta.Channel = targetChannel
	data, _ := json.MarshalIndent(meta, "", "\t")
	if err := os.WriteFile(metaPath, data, 0o644); err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to save release metadata")
		return
	}
	a.Cache.Set(product, meta)
	platforms := make([]string, 0, len(meta.Platforms))
	for platform := range meta.Platforms {
		platforms = append(platforms, platform)
	}
	sort.Strings(platforms)
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "version": version, "channel": targetChannel, "platforms": platforms})
}

func (a *App) deleteRelease(w http.ResponseWriter, r *http.Request) {
	product := r.PathValue("product")
	version := r.PathValue("version")
	if !isSafeIdentifier(product) || !isSafeIdentifier(version) {
		writeError(w, http.StatusBadRequest, "Invalid product or version")
		return
	}
	exists, err := a.Storage.Exists(filepath.ToSlash(filepath.Join("products", product, "releases", version, "meta.json")))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	if !exists {
		writeError(w, http.StatusNotFound, "Release not found")
		return
	}
	if err := a.Storage.DeleteDirectory(filepath.ToSlash(filepath.Join("products", product, "releases", version))); err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to delete release")
		return
	}
	a.Cache.Remove(product, version)
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "version": version})
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
