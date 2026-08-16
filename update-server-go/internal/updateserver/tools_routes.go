package updateserver

import (
	"bytes"
	"errors"
	"io"
	"net/http"
)

// maxToolUploadSize bounds a single helper-binary upload. The remote executor is
// a ~8 MB static Go binary; the ceiling leaves room for larger helpers without
// letting an upload token consume unbounded disk.
const maxToolUploadSize = 64 << 20

// uploadTool stores a helper binary or manifest under data/tools/<filename>, the
// same directory served publicly by downloadTool. The body is streamed straight
// to disk (temp file + rename) so a multi-megabyte binary never has to be
// buffered in memory.
func (a *App) uploadTool(w http.ResponseWriter, r *http.Request) {
	filename := r.PathValue("filename")
	if !validateDownloadFilename(filename) {
		writeError(w, http.StatusBadRequest, "Invalid filename")
		return
	}
	if r.Body == nil {
		writeError(w, http.StatusBadRequest, "Missing request body")
		return
	}
	defer r.Body.Close()

	// MaxBytesReader replaces the body with one that fails past the limit, so an
	// oversized upload is rejected without writing the whole payload to disk.
	var body io.Reader = http.MaxBytesReader(w, r.Body, maxToolUploadSize)

	// Peek one byte before touching storage. SaveReaderWithSHA512 renames its
	// temp file over the destination, so an empty body would otherwise replace an
	// already published artifact with a zero-length file that still downloads as
	// if it were valid.
	head := make([]byte, 1)
	read, readErr := io.ReadFull(body, head)
	if read == 0 {
		if readErr == nil || errors.Is(readErr, io.EOF) || errors.Is(readErr, io.ErrUnexpectedEOF) {
			writeError(w, http.StatusBadRequest, "Tool upload is empty")
			return
		}
		writeToolUploadError(w, readErr)
		return
	}
	body = io.MultiReader(bytes.NewReader(head[:read]), body)

	size, sha512Digest, err := a.Storage.SaveReaderWithSHA512("tools/"+filename, body)
	if err != nil {
		writeToolUploadError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"success":  true,
		"filename": filename,
		"size":     size,
		"sha512":   sha512Digest,
	})
}

func writeToolUploadError(w http.ResponseWriter, err error) {
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		writeError(w, http.StatusRequestEntityTooLarge, "Tool upload exceeds size limit")
		return
	}
	writeError(w, http.StatusInternalServerError, "Failed to store tool")
}
