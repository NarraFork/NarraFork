package updateserver

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

type App struct {
	Config  *ConfigStore
	Storage *LocalStorage
	Cache   *ReleaseCache
	locksMu sync.Mutex
	locks   map[string]*sync.Mutex
}

func NewApp(config *ConfigStore, storage *LocalStorage) *App {
	return &App{
		Config:  config,
		Storage: storage,
		Cache:   NewReleaseCache(storage),
		locks:   map[string]*sync.Mutex{},
	}
}

func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", a.health)
	mux.HandleFunc("GET /api/v2/products/{product}/releases/latest", a.latestRelease)
	mux.HandleFunc("GET /api/v2/products/{product}/releases/{version}/download/{filename}", a.downloadRelease)
	mux.HandleFunc("GET /api/v2/products/{product}/releases/{version}/zstd-patch/{filename}", a.downloadZstdPatch)
	mux.HandleFunc("GET /api/v2/products/{product}/releases/{version}/zstd-patch-meta/{filename}", a.downloadZstdPatchMeta)
	mux.HandleFunc("GET /api/v2/tools/{filename}", a.downloadTool)

	mux.Handle("PUT /api/v2/tools/{filename}", a.requireAuth(TokenRoleUpload, http.HandlerFunc(a.uploadTool)))
	mux.Handle("POST /api/v2/products/{product}/releases", a.requireAuth(TokenRoleUpload, http.HandlerFunc(a.uploadRelease)))
	mux.Handle("GET /api/v2/products/{product}/releases", a.requireAuth(TokenRoleUpload, http.HandlerFunc(a.listReleases)))
	mux.Handle("POST /api/v2/products/{product}/releases/{version}/promote", a.requireAuth(TokenRoleUpload, http.HandlerFunc(a.promoteRelease)))
	mux.Handle("DELETE /api/v2/products/{product}/releases/{version}", a.requireAuth(TokenRoleAdmin, http.HandlerFunc(a.deleteRelease)))
	mux.Handle("POST /api/v2/tokens", a.requireAuth(TokenRoleAdmin, http.HandlerFunc(a.createToken)))
	mux.Handle("GET /api/v2/tokens", a.requireAuth(TokenRoleAdmin, http.HandlerFunc(a.listTokens)))
	mux.Handle("DELETE /api/v2/tokens/{id}", a.requireAuth(TokenRoleAdmin, http.HandlerFunc(a.deleteToken)))

	return a.withCORS(a.withLogging(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mux.ServeHTTP(w, r)
	})))
}

func (a *App) withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rw := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rw, r)
		slog.Debug("request", "method", r.Method, "path", r.URL.Path, "status", rw.status, "duration", time.Since(start).String())
	})
}

func (a *App) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cfg := a.Config.Config()
		if cfg.CORS.Enabled {
			origin := strings.TrimSpace(r.Header.Get("Origin"))
			if origin != "" && corsOriginAllowed(origin, cfg.CORS.Origins) {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
			}
			if origin == "" && originWildcardAllowed(cfg.CORS.Origins) {
				w.Header().Set("Access-Control-Allow-Origin", "*")
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func corsOriginAllowed(origin string, allowed []string) bool {
	for _, item := range allowed {
		if item == "*" || item == origin {
			return true
		}
	}
	return false
}

func originWildcardAllowed(allowed []string) bool {
	for _, item := range allowed {
		if item == "*" {
			return true
		}
	}
	return false
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (a *App) requireAuth(requiredRole string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Missing or invalid Authorization header"})
			return
		}
		record, ok := a.Config.FindToken(strings.TrimPrefix(auth, "Bearer "))
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Invalid token"})
			return
		}
		if requiredRole != "" && record.Role != requiredRole && record.Role != TokenRoleAdmin {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "Insufficient permissions"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": message})
}

func (a *App) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "timestamp": time.Now().UTC().Format(time.RFC3339)})
}

func (a *App) versionLock(product, version string) *sync.Mutex {
	key := product + "/" + version
	a.locksMu.Lock()
	defer a.locksMu.Unlock()
	lock := a.locks[key]
	if lock == nil {
		lock = &sync.Mutex{}
		a.locks[key] = lock
	}
	return lock
}
