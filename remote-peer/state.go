package remotepeer

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/subtle"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Grant struct {
	ID            string `json:"id"`
	PublicKey     string `json:"publicKey"`
	DiscoveryHash string `json:"discoveryHash"`
	ExpiresAt     int64  `json:"expiresAt"`
	Revoked       bool   `json:"revoked"`
}
type Invitation struct {
	ID            string `json:"id"`
	SecretHash    string `json:"secretHash"`
	DiscoveryHash string `json:"discoveryHash"`
	ExpiresAt     int64  `json:"expiresAt"`
	Consumed      bool   `json:"consumed"`
}
type diskState struct {
	PrivateKey string                `json:"privateKey"`
	Invites    map[string]Invitation `json:"invites"`
	Grants     map[string]Grant      `json:"grants"`
}
type Store struct {
	lock      *os.File
	closeOnce sync.Once
	mu        sync.Mutex
	path      string
	state     diskState
	key       *ecdsa.PrivateKey
}

// OpenRuntimeStore holds an OS-released single-writer lock for the full process lifetime.
func OpenRuntimeStore(path string, production bool) (*Store, error) {
	if production {
		if err := privateParent(filepath.Dir(path)); err != nil {
			return nil, err
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	lock, err := lockState(path + ".lock")
	if err != nil {
		return nil, err
	}
	s, err := OpenStore(path)
	if err != nil {
		_ = lock.Close()
		return nil, err
	}
	s.lock = lock
	return s, nil
}
func (s *Store) Close() error {
	var err error
	s.closeOnce.Do(func() {
		if s.lock != nil {
			err = s.lock.Close()
		}
	})
	return err
}
func (s *Store) CancelInvite(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	old, ok := s.state.Invites[id]
	if !ok {
		return nil
	}
	delete(s.state.Invites, id)
	if err := s.saveLocked(); err != nil {
		s.state.Invites[id] = old
		return err
	}
	return nil
}
func (s *Store) ListGrants() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []map[string]any{}
	for _, g := range s.state.Grants {
		out = append(out, map[string]any{"id": g.ID, "publicKey": g.PublicKey, "expiresAt": g.ExpiresAt, "revoked": g.Revoked})
	}
	return out
}
func OpenStore(path string) (*Store, error) {
	if !filepath.IsAbs(path) || filepath.Base(path) == "." {
		return nil, errors.New("state_path")
	}
	parent := filepath.Dir(path)
	if e := os.MkdirAll(parent, 0700); e != nil {
		return nil, e
	}
	s := &Store{path: path, state: diskState{Invites: map[string]Invitation{}, Grants: map[string]Grant{}}}
	fi, e := os.Lstat(path)
	if e == nil {
		if !fi.Mode().IsRegular() || privateFile(path, fi) != nil || fi.Size() > JSONBytes {
			return nil, errors.New("state_permissions")
		}
		f, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		actual, err := f.Stat()
		if err != nil || !os.SameFile(fi, actual) || privateFile(path, actual) != nil {
			_ = f.Close()
			return nil, errors.New("state_changed")
		}
		b, e := io.ReadAll(io.LimitReader(f, JSONBytes+1))
		_ = f.Close()
		if e != nil {
			return nil, e
		}
		if len(b) > JSONBytes {
			return nil, errors.New("state_limit")
		}
		if e = json.Unmarshal(b, &s.state); e != nil {
			return nil, e
		}
		der, e := hex.DecodeString(s.state.PrivateKey)
		if e != nil {
			return nil, e
		}
		s.key, e = x509.ParseECPrivateKey(der)
		if e != nil || s.key.Curve != elliptic.P256() {
			return nil, errors.New("state_key")
		}
	}
	if os.IsNotExist(e) {
		s.key, e = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if e != nil {
			return nil, e
		}
		der, _ := x509.MarshalECPrivateKey(s.key)
		s.state.PrivateKey = hex.EncodeToString(der)
		if e = s.saveLocked(); e != nil {
			return nil, e
		}
	} else if e != nil {
		return nil, e
	}
	if s.state.Invites == nil || s.state.Grants == nil || len(s.state.Invites) > 32 || len(s.state.Grants) > 128 {
		return nil, errors.New("state_shape")
	}
	return s, nil
}
func (s *Store) saveLocked() error {
	b, e := json.Marshal(s.state)
	if e != nil {
		return e
	}
	if len(b) > JSONBytes {
		return errors.New("state_limit")
	}
	f, e := privateTemp(filepath.Dir(s.path))
	if e != nil {
		return e
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	if e = os.Rename(tmp, s.path); e != nil {
		return e
	}
	d, e := os.Open(filepath.Dir(s.path))
	if e == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}
func (s *Store) Invite(now time.Time) (Invitation, string, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, i := range s.state.Invites {
		if i.Consumed || i.ExpiresAt <= now.Unix() {
			delete(s.state.Invites, id)
		}
	}
	if len(s.state.Invites) >= 32 || len(s.state.Grants) >= 128 {
		return Invitation{}, "", "", errors.New("state_limit")
	}
	secret, cap := randomHex(32), randomHex(32)
	i := Invitation{ID: randomHex(16), SecretHash: Hash(secret), DiscoveryHash: Hash(cap), ExpiresAt: now.Add(10 * time.Minute).Unix()}
	s.state.Invites[i.ID] = i
	if e := s.saveLocked(); e != nil {
		delete(s.state.Invites, i.ID)
		return Invitation{}, "", "", e
	}
	return i, secret, cap, nil
}
func (s *Store) Target(kind, id, key string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if kind == "invite" {
		i, ok := s.state.Invites[id]
		return ok && !i.Consumed && i.ExpiresAt > now.Unix()
	}
	if kind == "grant" {
		g, ok := s.state.Grants[id]
		return ok && !g.Revoked && g.ExpiresAt > now.Unix() && g.PublicKey == key
	}
	return false
}
func (s *Store) Consume(id, secret, key string, now time.Time) (Grant, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	i, ok := s.state.Invites[id]
	hash := Hash(secret)
	if !ok || i.Consumed || i.ExpiresAt <= now.Unix() || subtle.ConstantTimeCompare([]byte(i.SecretHash), []byte(hash)) != 1 {
		return Grant{}, "", errors.New("invite_invalid")
	}
	if _, e := ParsePublic(key); e != nil {
		return Grant{}, "", e
	}
	if len(s.state.Grants) >= 128 {
		return Grant{}, "", errors.New("grant_limit")
	}
	cap := randomHex(32)
	g := Grant{ID: randomHex(16), PublicKey: key, DiscoveryHash: Hash(cap), ExpiresAt: now.Add(30 * 24 * time.Hour).Unix()}
	i.Consumed = true
	s.state.Invites[id] = i
	s.state.Grants[g.ID] = g
	if e := s.saveLocked(); e != nil {
		i.Consumed = false
		s.state.Invites[id] = i
		delete(s.state.Grants, g.ID)
		return Grant{}, "", e
	}
	return g, cap, nil
}
func (s *Store) GetGrant(id string) (Grant, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g, ok := s.state.Grants[id]
	return g, ok && !g.Revoked && g.ExpiresAt > time.Now().Unix()
}
func (s *Store) Revoke(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	old := map[string]Grant{}
	for k, g := range s.state.Grants {
		if id == "all" || k == id {
			old[k] = g
			g.Revoked = true
			s.state.Grants[k] = g
		}
	}
	if e := s.saveLocked(); e != nil {
		for k, g := range old {
			s.state.Grants[k] = g
		}
		return e
	}
	return nil
}
func (s *Store) Discoveries() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []map[string]any{}
	now := time.Now().Unix()
	for _, i := range s.state.Invites {
		if !i.Consumed && i.ExpiresAt > now {
			out = append(out, map[string]any{"hash": i.DiscoveryHash, "kind": "invite", "id": i.ID, "expiresAt": i.ExpiresAt})
		}
	}
	for _, g := range s.state.Grants {
		if !g.Revoked && g.ExpiresAt > now {
			out = append(out, map[string]any{"hash": g.DiscoveryHash, "kind": "grant", "id": g.ID, "expiresAt": g.ExpiresAt})
		}
	}
	return out
}
