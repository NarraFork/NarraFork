package updateserver

import (
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	maxMultipartRanges     = 16
	maxMultipartRangeBytes = 64 << 20
)

type byteRange struct {
	start int64
	end   int64
}

func (a *App) downloadRelease(w http.ResponseWriter, r *http.Request) {
	product := r.PathValue("product")
	version := r.PathValue("version")
	filename := r.PathValue("filename")
	if !isSafeIdentifier(product) || !isSafeIdentifier(version) || !validateDownloadFilename(filename) {
		writeError(w, http.StatusBadRequest, "Invalid download path")
		return
	}
	platform := detectPlatformFromFilename(filename)
	if platform == "" {
		writeError(w, http.StatusBadRequest, "Cannot determine platform from filename")
		return
	}
	path := "products/" + product + "/releases/" + version + "/" + platform + "/" + filename
	a.serveFileWithRange(w, r, path, filename, "application/octet-stream")
}

func (a *App) downloadZstdPatch(w http.ResponseWriter, r *http.Request) {
	product := r.PathValue("product")
	version := r.PathValue("version")
	filename := r.PathValue("filename")
	if !isSafeIdentifier(product) || !isSafeIdentifier(version) || !validateDownloadFilename(filename) {
		writeError(w, http.StatusBadRequest, "Invalid download path")
		return
	}
	platform := detectPlatformFromFilename(filename)
	if platform == "" {
		writeError(w, http.StatusBadRequest, "Cannot determine platform from filename")
		return
	}
	path := "products/" + product + "/releases/" + version + "/" + platform + "/" + filename + ".zstd-patch"
	a.serveFile(w, path, filename+".zstd-patch", "application/octet-stream")
}

func (a *App) downloadZstdPatchMeta(w http.ResponseWriter, r *http.Request) {
	product := r.PathValue("product")
	version := r.PathValue("version")
	filename := r.PathValue("filename")
	if !isSafeIdentifier(product) || !isSafeIdentifier(version) || !validateDownloadFilename(filename) {
		writeError(w, http.StatusBadRequest, "Invalid download path")
		return
	}
	platform := detectPlatformFromFilename(filename)
	if platform == "" {
		writeError(w, http.StatusBadRequest, "Cannot determine platform from filename")
		return
	}
	path := "products/" + product + "/releases/" + version + "/" + platform + "/" + filename + ".zstd-patch.meta.json"
	a.serveFile(w, path, filename+".zstd-patch.meta.json", "application/json")
}

func (a *App) downloadTool(w http.ResponseWriter, r *http.Request) {
	filename := r.PathValue("filename")
	if !validateDownloadFilename(filename) {
		writeError(w, http.StatusBadRequest, "Invalid filename")
		return
	}
	a.serveFile(w, "tools/"+filename, filename, "application/octet-stream")
}

func detectPlatformFromFilename(filename string) string {
	patterns := []string{
		"linux-x64-baseline",
		"linux-arm64",
		"linux-x64",
		"darwin-arm64",
		"darwin-x64",
		"macos-arm64",
		"macos-x64",
		"windows-x64-baseline",
		"windows-x64",
		"win-x64-baseline",
		"win-x64",
	}
	for _, pattern := range patterns {
		if strings.Contains(filename, pattern) {
			return strings.ReplaceAll(strings.ReplaceAll(pattern, "macos-", "darwin-"), "windows-", "win-")
		}
	}
	return ""
}

func (a *App) serveFile(w http.ResponseWriter, path, filename, contentType string) {
	file, size, ok, err := a.Storage.Open(path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	if !ok {
		writeError(w, http.StatusNotFound, "File not found")
		return
	}
	defer file.Close()
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", contentDisposition(filename))
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, file)
}

func (a *App) serveFileWithRange(w http.ResponseWriter, r *http.Request, path, filename, contentType string) {
	file, size, ok, err := a.Storage.Open(path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Internal server error")
		return
	}
	if !ok {
		writeError(w, http.StatusNotFound, "File not found")
		return
	}
	defer file.Close()

	rangeHeader := r.Header.Get("Range")
	if rangeHeader == "" {
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Content-Disposition", contentDisposition(filename))
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
		w.Header().Set("Accept-Ranges", "bytes")
		w.WriteHeader(http.StatusOK)
		_, _ = io.Copy(w, file)
		return
	}

	ranges, ok := parseRangeHeader(rangeHeader, size)
	if !ok || len(ranges) == 0 {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", size))
		http.Error(w, "Range Not Satisfiable", http.StatusRequestedRangeNotSatisfiable)
		return
	}
	if len(ranges) == 1 {
		rg := ranges[0]
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", rg.start, rg.end, size))
		w.Header().Set("Content-Length", strconv.FormatInt(rg.end-rg.start+1, 10))
		w.Header().Set("Accept-Ranges", "bytes")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = io.Copy(w, io.NewSectionReader(file, rg.start, rg.end-rg.start+1))
		return
	}
	if totalRangeBytes(ranges) > maxMultipartRangeBytes {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", size))
		http.Error(w, "Range Not Satisfiable", http.StatusRequestedRangeNotSatisfiable)
		return
	}

	boundary := fmt.Sprintf("nfup_%x", time.Now().UnixNano())
	multipartWriter := multipart.NewWriter(w)
	_ = multipartWriter.SetBoundary(boundary)
	w.Header().Set("Content-Type", "multipart/byteranges; boundary="+boundary)
	w.Header().Set("Accept-Ranges", "bytes")
	w.WriteHeader(http.StatusPartialContent)
	for _, rg := range ranges {
		header := textproto.MIMEHeader{}
		header.Set("Content-Type", contentType)
		header.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", rg.start, rg.end, size))
		part, err := multipartWriter.CreatePart(header)
		if err != nil {
			return
		}
		_, _ = io.Copy(part, io.NewSectionReader(file, rg.start, rg.end-rg.start+1))
	}
	_ = multipartWriter.Close()
}

func contentDisposition(filename string) string {
	return mime.FormatMediaType("attachment", map[string]string{"filename": filename})
}

var rangePartPattern = regexp.MustCompile(`^(\d*)-(\d*)$`)

func parseRangeHeader(header string, fileSize int64) ([]byteRange, bool) {
	if !strings.HasPrefix(header, "bytes=") || fileSize <= 0 {
		return nil, false
	}
	parts := strings.Split(strings.TrimPrefix(header, "bytes="), ",")
	if len(parts) > maxMultipartRanges {
		return nil, false
	}
	ranges := make([]byteRange, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		m := rangePartPattern.FindStringSubmatch(part)
		if m == nil {
			return nil, false
		}
		var start, end int64
		if m[1] == "" {
			suffix, err := strconv.ParseInt(m[2], 10, 64)
			if err != nil || suffix <= 0 {
				return nil, false
			}
			start = maxInt64(0, fileSize-suffix)
			end = fileSize - 1
		} else if m[2] == "" {
			parsed, err := strconv.ParseInt(m[1], 10, 64)
			if err != nil {
				return nil, false
			}
			start = parsed
			end = fileSize - 1
		} else {
			var err error
			start, err = strconv.ParseInt(m[1], 10, 64)
			if err != nil {
				return nil, false
			}
			end, err = strconv.ParseInt(m[2], 10, 64)
			if err != nil {
				return nil, false
			}
		}
		if start > end || start >= fileSize || start < 0 {
			return nil, false
		}
		if end >= fileSize {
			end = fileSize - 1
		}
		ranges = append(ranges, byteRange{start: start, end: end})
	}
	return ranges, len(ranges) > 0
}

func totalRangeBytes(ranges []byteRange) int64 {
	var total int64
	for _, rg := range ranges {
		total += rg.end - rg.start + 1
	}
	return total
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
