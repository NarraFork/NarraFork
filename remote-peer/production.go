package remotepeer

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"regexp"
	"strings"
	"time"
)

const IPCVersion = 2
const IPCMaxBytes = 64 * 1024

type BackendIdentity struct {
	NFVersion    string   `json:"nfVersion"`
	SourceCommit string   `json:"sourceCommit"`
	Repository   string   `json:"repository"`
	BootstrapABI int      `json:"bootstrapAbi"`
	APIEpoch     int      `json:"apiEpoch"`
	WireVersion  int      `json:"wireVersion"`
	Capabilities []string `json:"capabilities"`
}

var nfVersionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$`)

func validNFVersion(version string) bool {
	match := nfVersionPattern.FindStringSubmatch(version)
	if match == nil {
		return false
	}
	for _, part := range strings.Split(match[4], ".") {
		if len(part) > 1 && part[0] == '0' && strings.Trim(part, "0123456789") == "" {
			return false
		}
	}
	return true
}
func (b BackendIdentity) valid() bool {
	if b.NFVersion == "" || len(b.NFVersion) > 64 || !validNFVersion(b.NFVersion) || !regexp.MustCompile(`^[a-f0-9]{7,40}$`).MatchString(b.SourceCommit) || !regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`).MatchString(b.Repository) || len(b.Repository) > 256 || b.BootstrapABI != 1 || b.APIEpoch != 1 || b.WireVersion != 2 || len(b.Capabilities) > 6 {
		return false
	}
	seen := map[string]bool{}
	for _, c := range b.Capabilities {
		if seen[c] {
			return false
		}
		seen[c] = true
		switch c {
		case "projects", "narrators", "approvals", "sse", "small-attachments", "binary-socket":
		default:
			return false
		}
	}
	return true
}

type RequestRule struct {
	ID            string   `json:"id"`
	Methods       []string `json:"methods"`
	Path          string   `json:"path"`
	Phase         string   `json:"phase"`
	Profile       string   `json:"profile"`
	RequestBytes  int64    `json:"requestBytes"`
	ResponseBytes int64    `json:"responseBytes"`
}

func validatePolicy(rules []RequestRule) error {
	if len(rules) == 0 || len(rules) > 128 {
		return errors.New("request_policy")
	}
	seen := map[string]bool{}
	for _, r := range rules {
		if r.ID == "" || len(r.ID) > 128 || seen[r.ID] || len(r.Path) > 2048 || !strings.HasPrefix(r.Path, "^") || !strings.HasSuffix(r.Path, "$") || (r.Phase != "paired" && r.Phase != "ready") || (r.Profile != "request" && r.Profile != "sse") || r.RequestBytes < 0 || r.RequestBytes > FileBytes || r.ResponseBytes < 0 || r.ResponseBytes > 64*1024*1024 || (r.Profile != "sse" && r.ResponseBytes > FileBytes) || len(r.Methods) == 0 || len(r.Methods) > 6 {
			return errors.New("request_policy")
		}
		if _, err := regexp.Compile(r.Path); err != nil {
			return errors.New("request_policy")
		}
		for _, m := range r.Methods {
			switch m {
			case "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD":
			default:
				return errors.New("request_policy")
			}
		}
		seen[r.ID] = true
	}
	return nil
}
func (r *Runtime) requestRule(method, path string, authorized bool) (RequestRule, error) {
	u, err := url.ParseRequestURI(path)
	if err != nil || len(path) > 8192 || u.IsAbs() || u.Host != "" || (!strings.HasPrefix(path, "/api/") && !strings.HasPrefix(path, "/ws/")) || strings.Contains(strings.SplitN(path, "?", 2)[0], "%") || u.Fragment != "" || strings.ContainsAny(path, "\\\r\n\x00#") || strings.Contains(u.Path, "//") {
		return RequestRule{}, errors.New("path")
	}
	for _, p := range strings.Split(u.Path, "/") {
		if p == "." || p == ".." {
			return RequestRule{}, errors.New("path")
		}
	}
	for key := range u.Query() {
		switch strings.ToLower(key) {
		case "token", "authorization", "pairingsecret", "discoverycapability", "bridgesecret":
			return RequestRule{}, errors.New("path")
		}
	}
	for i, rule := range r.cfg.RequestPolicy {
		if !authorized && rule.Phase != "paired" {
			continue
		}
		for _, m := range rule.Methods {
			if m == method && r.policy[i].MatchString(u.Path) {
				return rule, nil
			}
		}
	}
	return RequestRule{}, errors.New("path_not_allowed")
}

type SessionProjection struct {
	SessionID    string `json:"sessionId"`
	UserID       string `json:"userId"`
	Role         string `json:"role"`
	ExpiresAt    int64  `json:"expiresAt"`
	AuthRevision int64  `json:"authRevision"`
}
type PeerAccept struct {
	PeerID            string          `json:"peerId"`
	ContextID         string          `json:"contextId"`
	ContextCapability string          `json:"contextCapability"`
	BackendIdentity   BackendIdentity `json:"backendIdentity"`
}
type IPCEnvelope struct {
	IPCVersion int             `json:"ipcVersion"`
	Epoch      string          `json:"epoch"`
	RequestID  string          `json:"requestId"`
	Type       string          `json:"type"`
	Payload    json.RawMessage `json:"payload"`
}

func strictJSON(b []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		return e
	}
	var extra any
	if e := d.Decode(&extra); e != io.EOF {
		return errors.New("trailing_json")
	}
	return nil
}
func validIPCID(s string) bool { return regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`).MatchString(s) }
func ParseIPC(b []byte) (IPCEnvelope, error) {
	var e IPCEnvelope
	if len(b) > IPCMaxBytes || strictJSON(b, &e) != nil || e.IPCVersion != 2 || !validIPCID(e.Epoch) || !validIPCID(e.RequestID) || len(e.Payload) == 0 || e.Payload[0] != '{' {
		return e, errors.New("ipc_invalid")
	}
	return e, nil
}
func (r *Runtime) event(kind string, payload any) {
	r.emit(map[string]any{"type": kind, "payload": payload})
}
func (r *Runtime) CreateInvitation() (map[string]any, error) {
	i, secret, cap, err := r.store.Invite(time.Now())
	if err != nil {
		return nil, err
	}
	r.discoveries()
	u, _ := url.Parse(r.cfg.SignalURL)
	u.Path = "/signal/browser"
	return map[string]any{"instanceId": r.id, "publicKey": r.public, "pairId": i.ID, "pairingSecret": secret, "discoveryCapability": cap, "expiresAt": i.ExpiresAt, "signalUrl": u.String()}, nil
}
func (r *Runtime) Command(e IPCEnvelope) (any, error) {
	if e.Epoch != r.cfg.IPCEpoch {
		return nil, errors.New("ipc_epoch")
	}
	var p struct {
		InviteID  string            `json:"inviteId"`
		GrantID   string            `json:"grantId"`
		PeerID    string            `json:"peerId"`
		Reason    string            `json:"reason"`
		SessionID string            `json:"sessionId"`
		Session   SessionProjection `json:"session"`
	}
	if e.Type == "peer.accept" {
		var a PeerAccept
		if strictJSON(e.Payload, &a) != nil {
			return nil, errors.New("ipc_payload")
		}
		r.mu.Lock()
		peer := r.peers[a.PeerID]
		r.mu.Unlock()
		if peer == nil {
			return nil, errors.New("peer_missing")
		}
		return map[string]any{}, peer.accept(a)
	}
	if strictJSON(e.Payload, &p) != nil {
		return nil, errors.New("ipc_payload")
	}
	switch e.Type {
	case "pair.create":
		invitation, err := r.CreateInvitation()
		return map[string]any{"invitation": invitation}, err
	case "pair.cancel":
		if !validIPCID(p.InviteID) {
			return nil, errors.New("invite_invalid")
		}
		err := r.store.CancelInvite(p.InviteID)
		r.discoveries()
		return map[string]any{}, err
	case "grants.list":
		return map[string]any{"grants": r.store.ListGrants()}, nil
	case "grants.revoke":
		if !validIPCID(p.GrantID) {
			return nil, errors.New("grant")
		}
		err := r.Revoke(p.GrantID)
		if err == nil {
			r.event("grant.changed", map[string]any{"grantId": p.GrantID, "revoked": true})
		}
		return map[string]any{}, err
	case "peer.reject":
		r.mu.Lock()
		peer := r.peers[p.PeerID]
		r.mu.Unlock()
		if peer != nil {
			peer.Close()
		}
		return map[string]any{}, nil
	case "session.updated":
		r.mu.Lock()
		peer := r.peers[p.PeerID]
		r.mu.Unlock()
		if peer == nil {
			return map[string]any{}, nil
		}
		return map[string]any{}, peer.updateSession(p.Session)
	case "session.invalidated":
		if !validIPCID(p.SessionID) {
			return nil, errors.New("session_id")
		}
		r.mu.Lock()
		peers := []*Peer{}
		for _, peer := range r.peers {
			peer.mu.Lock()
			if peer.session.SessionID == p.SessionID {
				peer.cancel()
				peers = append(peers, peer)
			}
			peer.mu.Unlock()
		}
		r.mu.Unlock()
		for _, peer := range peers {
			peer.Close()
		}
		return map[string]any{}, nil
	default:
		return nil, errors.New("ipc_command")
	}
}
func (p *Peer) accept(a PeerAccept) error {
	if !validIPCID(a.ContextID) || len(a.ContextCapability) < 32 || len(a.ContextCapability) > 256 || !reflect.DeepEqual(a.BackendIdentity, p.r.cfg.BackendIdentity) {
		return errors.New("peer_context")
	}
	p.mu.Lock()
	if !p.hello || p.accepted || p.ctx.Err() != nil {
		p.mu.Unlock()
		return errors.New("peer_context")
	}
	p.contextID = a.ContextID
	p.contextCapability = a.ContextCapability
	p.accepted = true
	ready := p.helloReady
	p.helloReady = nil
	p.mu.Unlock()
	return p.control(ready)
}
func (p *Peer) updateSession(s SessionProjection) error {
	if !validIPCID(s.SessionID) || !validIPCID(s.UserID) || s.Role != "admin" || s.ExpiresAt <= time.Now().Unix() || s.AuthRevision < 0 {
		return errors.New("session_projection")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.session.SessionID != "" && p.session.SessionID != s.SessionID {
		return errors.New("session_mismatch")
	}
	if s.AuthRevision < p.session.AuthRevision {
		return nil
	}
	p.session = s
	p.authExpires = s.ExpiresAt
	return nil
}
func (p *Peer) bridgeHeaders(h http.Header) error {
	h.Set("X-NarraFork-Bridge", p.r.cfg.BridgeSecret)
	if p.r.cfg.Mode == "narrafork" {
		p.mu.Lock()
		defer p.mu.Unlock()
		if !p.accepted || p.ctx.Err() != nil {
			return errors.New("peer_context")
		}
		h.Set("X-NarraFork-Remote-Epoch", p.r.cfg.IPCEpoch)
		h.Set("X-NarraFork-Remote-Context", p.contextID)
		h.Set("X-NarraFork-Remote-Capability", p.contextCapability)
	}
	return nil
}
