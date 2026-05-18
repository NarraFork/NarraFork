package updateserver

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type ConfigStore struct {
	mu       sync.RWMutex
	path     string
	config   ServerConfig
	tokenMap map[string]TokenRecord
}

type configFile struct {
	Port    *int          `json:"port"`
	Host    *string       `json:"host"`
	DataDir *string       `json:"dataDir"`
	Tokens  []TokenRecord `json:"tokens"`
	Storage struct {
		Type *string `json:"type"`
	} `json:"storage"`
	CORS struct {
		Enabled *bool    `json:"enabled"`
		Origins []string `json:"origins"`
	} `json:"cors"`
}

func defaultConfig() ServerConfig {
	var cfg ServerConfig
	cfg.Port = 7780
	cfg.Host = "localhost"
	cfg.DataDir = "./data"
	cfg.Tokens = []TokenRecord{}
	cfg.Storage.Type = "local"
	cfg.CORS.Enabled = true
	cfg.CORS.Origins = []string{"*"}
	return cfg
}

func InitConfig(path string) (*ConfigStore, string, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return nil, "", fmt.Errorf("resolve config path: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(absPath), 0o755); err != nil {
		return nil, "", fmt.Errorf("create config directory: %w", err)
	}

	store := &ConfigStore{path: absPath, config: defaultConfig(), tokenMap: map[string]TokenRecord{}}
	if data, err := os.ReadFile(absPath); err == nil {
		if len(data) > 0 {
			var parsed configFile
			if err := json.Unmarshal(data, &parsed); err != nil {
				return nil, "", fmt.Errorf("parse config: %w", err)
			}
			store.config = mergeConfig(defaultConfig(), parsed)
		}
		store.rebuildTokenMapLocked()
		return store, "", nil
	} else if !os.IsNotExist(err) {
		return nil, "", fmt.Errorf("read config: %w", err)
	}

	plain := generateTokenString()
	record := TokenRecord{
		ID:        "tok_" + randomID(12),
		Name:      "admin",
		TokenHash: hashToken(plain),
		Role:      TokenRoleAdmin,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	store.config.Tokens = []TokenRecord{record}
	store.rebuildTokenMapLocked()
	if err := store.saveLocked(); err != nil {
		return nil, "", err
	}
	return store, plain, nil
}

func mergeConfig(base ServerConfig, parsed configFile) ServerConfig {
	if parsed.Port != nil {
		base.Port = *parsed.Port
	}
	if parsed.Host != nil && *parsed.Host != "" {
		base.Host = *parsed.Host
	}
	if parsed.DataDir != nil && *parsed.DataDir != "" {
		base.DataDir = *parsed.DataDir
	}
	if parsed.Tokens != nil {
		base.Tokens = parsed.Tokens
	}
	if parsed.Storage.Type != nil && *parsed.Storage.Type != "" {
		base.Storage.Type = *parsed.Storage.Type
	}
	if parsed.CORS.Enabled != nil {
		base.CORS.Enabled = *parsed.CORS.Enabled
	}
	if parsed.CORS.Origins != nil {
		base.CORS.Origins = parsed.CORS.Origins
	}
	return base
}

func generateTokenString() string {
	return "nfup_" + randomID(32)
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (s *ConfigStore) saveLocked() error {
	data, err := json.MarshalIndent(s.config, "", "\t")
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	return os.WriteFile(s.path, data, 0o600)
}

func (s *ConfigStore) rebuildTokenMapLocked() {
	s.tokenMap = map[string]TokenRecord{}
	for _, record := range s.config.Tokens {
		s.tokenMap[record.TokenHash] = record
	}
}

func (s *ConfigStore) Config() ServerConfig {
	s.mu.RLock()
	defer s.mu.RUnlock()
	cfg := s.config
	cfg.Tokens = append([]TokenRecord(nil), s.config.Tokens...)
	cfg.CORS.Origins = append([]string(nil), s.config.CORS.Origins...)
	return cfg
}

func (s *ConfigStore) ConfigPath() string {
	return s.path
}

func (s *ConfigStore) DataDir() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	dataDir := s.config.DataDir
	if filepath.IsAbs(dataDir) {
		return dataDir
	}
	return filepath.Join(filepath.Dir(s.path), dataDir)
}

func (s *ConfigStore) FindToken(plain string) (TokenRecord, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.tokenMap[hashToken(plain)]
	return record, ok
}

func (s *ConfigStore) AddToken(name, role string) (string, TokenRecord, error) {
	if role != TokenRoleAdmin {
		role = TokenRoleUpload
	}
	plain := generateTokenString()
	record := TokenRecord{
		ID:        "tok_" + randomID(12),
		Name:      name,
		TokenHash: hashToken(plain),
		Role:      role,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.config.Tokens = append(s.config.Tokens, record)
	s.rebuildTokenMapLocked()
	if err := s.saveLocked(); err != nil {
		return "", TokenRecord{}, err
	}
	return plain, record, nil
}

func (s *ConfigStore) RemoveToken(tokenID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	before := len(s.config.Tokens)
	filtered := s.config.Tokens[:0]
	for _, record := range s.config.Tokens {
		if record.ID != tokenID {
			filtered = append(filtered, record)
		}
	}
	s.config.Tokens = filtered
	if len(s.config.Tokens) == before {
		return false
	}
	s.rebuildTokenMapLocked()
	_ = s.saveLocked()
	return true
}
