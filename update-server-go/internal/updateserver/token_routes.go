package updateserver

import (
	"encoding/json"
	"net/http"
)

func (a *App) createToken(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
		Role string `json:"role"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	name := body.Name
	if name == "" {
		name = "unnamed"
	}
	role := TokenRoleUpload
	if body.Role == TokenRoleAdmin {
		role = TokenRoleAdmin
	}
	plain, record, err := a.Config.AddToken(name, role)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to create token")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": record.ID, "name": record.Name, "role": record.Role, "token": plain})
}

func (a *App) listTokens(w http.ResponseWriter, _ *http.Request) {
	cfg := a.Config.Config()
	items := make([]map[string]any, 0, len(cfg.Tokens))
	for _, token := range cfg.Tokens {
		items = append(items, map[string]any{"id": token.ID, "name": token.Name, "role": token.Role, "createdAt": token.CreatedAt})
	}
	writeJSON(w, http.StatusOK, map[string]any{"tokens": items})
}

func (a *App) deleteToken(w http.ResponseWriter, r *http.Request) {
	tokenID := r.PathValue("id")
	if tokenID == "" {
		writeError(w, http.StatusBadRequest, "Missing token ID")
		return
	}
	if !a.Config.RemoveToken(tokenID) {
		writeError(w, http.StatusNotFound, "Token not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true, "id": tokenID})
}
