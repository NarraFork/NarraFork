package updateserver

import (
	"crypto/sha512"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type LocalStorage struct {
	baseDir string
}

func NewLocalStorage(baseDir string) (*LocalStorage, error) {
	abs, err := filepath.Abs(baseDir)
	if err != nil {
		return nil, fmt.Errorf("resolve data directory: %w", err)
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	return &LocalStorage{baseDir: abs}, nil
}

func (s *LocalStorage) BaseDir() string {
	return s.baseDir
}

func (s *LocalStorage) resolve(name string) (string, error) {
	name = filepath.FromSlash(strings.TrimSpace(name))
	if name == "" || filepath.IsAbs(name) {
		return "", fmt.Errorf("invalid storage path")
	}
	clean := filepath.Clean(name)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("invalid storage path")
	}
	full := filepath.Join(s.baseDir, clean)
	rel, err := filepath.Rel(s.baseDir, full)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("invalid storage path")
	}
	return full, nil
}

func (s *LocalStorage) SaveBytes(name string, data []byte) error {
	full, err := s.resolve(name)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return err
	}
	return os.WriteFile(full, data, 0o644)
}

func (s *LocalStorage) SaveReaderWithSHA512(name string, reader io.Reader) (int64, string, error) {
	full, err := s.resolve(name)
	if err != nil {
		return 0, "", err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return 0, "", err
	}
	tmp := fmt.Sprintf("%s.%d.tmp", full, os.Getpid())
	file, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return 0, "", err
	}
	hash := sha512.New()
	n, copyErr := io.Copy(io.MultiWriter(file, hash), reader)
	closeErr := file.Close()
	if copyErr != nil {
		_ = os.Remove(tmp)
		return 0, "", copyErr
	}
	if closeErr != nil {
		_ = os.Remove(tmp)
		return 0, "", closeErr
	}
	if err := os.Rename(tmp, full); err != nil {
		_ = os.Remove(tmp)
		return 0, "", err
	}
	return n, base64.StdEncoding.EncodeToString(hash.Sum(nil)), nil
}

func (s *LocalStorage) GetBytes(name string) ([]byte, bool, error) {
	full, err := s.resolve(name)
	if err != nil {
		return nil, false, err
	}
	data, err := os.ReadFile(full)
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return data, true, nil
}

func (s *LocalStorage) Open(name string) (*os.File, int64, bool, error) {
	full, err := s.resolve(name)
	if err != nil {
		return nil, 0, false, err
	}
	info, err := os.Stat(full)
	if os.IsNotExist(err) {
		return nil, 0, false, nil
	}
	if err != nil {
		return nil, 0, false, err
	}
	if info.IsDir() {
		return nil, 0, false, nil
	}
	file, err := os.Open(full)
	if err != nil {
		return nil, 0, false, err
	}
	return file, info.Size(), true, nil
}

func (s *LocalStorage) FileSize(name string) (int64, bool, error) {
	full, err := s.resolve(name)
	if err != nil {
		return 0, false, err
	}
	info, err := os.Stat(full)
	if os.IsNotExist(err) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	if info.IsDir() {
		return 0, false, nil
	}
	return info.Size(), true, nil
}

func (s *LocalStorage) Exists(name string) (bool, error) {
	full, err := s.resolve(name)
	if err != nil {
		return false, err
	}
	_, err = os.Stat(full)
	if os.IsNotExist(err) {
		return false, nil
	}
	return err == nil, err
}

func (s *LocalStorage) DeleteDirectory(name string) error {
	full, err := s.resolve(name)
	if err != nil {
		return err
	}
	if full == s.baseDir {
		return fmt.Errorf("refusing to delete storage root")
	}
	if err := os.RemoveAll(full); err != nil {
		return err
	}
	return nil
}

func (s *LocalStorage) ListFiles(prefix string) ([]string, error) {
	full, err := s.resolve(prefix)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(full)
	if os.IsNotExist(err) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		rel, err := filepath.Rel(s.baseDir, full)
		if err != nil {
			return nil, err
		}
		return []string{filepath.ToSlash(rel)}, nil
	}
	results := []string{}
	err = filepath.WalkDir(full, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(s.baseDir, path)
		if err != nil {
			return nil
		}
		results = append(results, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return nil, err
	}
	return results, nil
}
