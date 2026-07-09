// Package config loads executor configuration from flags, environment
// variables, and an optional JSON config file (flags > env > file > default).
package config

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
)

type Config struct {
	// ServerURL is the NarraFork WebSocket endpoint, e.g.
	// wss://host:7779/ws/device. Required in reverse mode.
	ServerURL string `json:"serverUrl"`
	// DeviceRef is the device slug or id used to look up the record server-side.
	DeviceRef string `json:"deviceRef"`
	// Token is the registration key (rdev_...).
	Token string `json:"token"`
	// AllowRoots restricts fs/exec operations to these path prefixes. Empty =
	// unrestricted (not recommended for untrusted networks).
	AllowRoots []string `json:"allowRoots"`
	// DefaultCwd is reported to the server at handshake.
	DefaultCwd string `json:"defaultCwd"`
	// InsecureSkipVerify disables TLS certificate verification (self-signed).
	InsecureSkipVerify bool `json:"insecureSkipVerify"`
	// ReconnectMaxSeconds caps the exponential reconnect backoff.
	ReconnectMaxSeconds int `json:"reconnectMaxSeconds"`
	// ListenAddr enables direct mode: the executor listens on this address
	// (e.g. ":7900") for the NarraFork server to connect, instead of dialing out.
	// When set, ServerURL is not required.
	ListenAddr string `json:"listenAddr"`
}

func Load() (*Config, error) {
	cfg := &Config{ReconnectMaxSeconds: 30}

	var configPath string
	fs := flag.NewFlagSet("narrafork-executor", flag.ContinueOnError)
	fs.StringVar(&configPath, "config", os.Getenv("NARRAFORK_EXECUTOR_CONFIG"), "Path to JSON config file")
	serverURL := fs.String("server", "", "NarraFork device WebSocket URL (wss://host:7779/ws/device)")
	deviceRef := fs.String("device", "", "Device slug or id")
	token := fs.String("token", "", "Registration token (rdev_...)")
	allowRoots := fs.String("allow-root", "", "Comma-separated path prefixes the executor may access")
	defaultCwd := fs.String("cwd", "", "Default working directory reported to the server")
	insecure := fs.Bool("insecure", false, "Skip TLS certificate verification")
	listenAddr := fs.String("listen", "", "Direct mode: listen on this address (e.g. :7900) instead of dialing out")
	if err := fs.Parse(os.Args[1:]); err != nil {
		return nil, err
	}

	// 1. Config file (lowest precedence).
	if configPath != "" {
		data, err := os.ReadFile(configPath)
		if err != nil {
			return nil, fmt.Errorf("read config file: %w", err)
		}
		if err := json.Unmarshal(data, cfg); err != nil {
			return nil, fmt.Errorf("parse config file: %w", err)
		}
	}

	// 2. Environment variables.
	if v := os.Getenv("NARRAFORK_EXECUTOR_SERVER"); v != "" {
		cfg.ServerURL = v
	}
	if v := os.Getenv("NARRAFORK_EXECUTOR_DEVICE"); v != "" {
		cfg.DeviceRef = v
	}
	if v := os.Getenv("NARRAFORK_EXECUTOR_TOKEN"); v != "" {
		cfg.Token = v
	}
	if v := os.Getenv("NARRAFORK_EXECUTOR_ALLOW_ROOTS"); v != "" {
		cfg.AllowRoots = splitCsv(v)
	}

	// 3. Flags (highest precedence).
	if *serverURL != "" {
		cfg.ServerURL = *serverURL
	}
	if *deviceRef != "" {
		cfg.DeviceRef = *deviceRef
	}
	if *token != "" {
		cfg.Token = *token
	}
	if *allowRoots != "" {
		cfg.AllowRoots = splitCsv(*allowRoots)
	}
	if *defaultCwd != "" {
		cfg.DefaultCwd = *defaultCwd
	}
	if *insecure {
		cfg.InsecureSkipVerify = true
	}
	if *listenAddr != "" {
		cfg.ListenAddr = *listenAddr
	}
	if v := os.Getenv("NARRAFORK_EXECUTOR_LISTEN"); v != "" && *listenAddr == "" {
		cfg.ListenAddr = v
	}

	if cfg.DefaultCwd == "" {
		if wd, err := os.Getwd(); err == nil {
			cfg.DefaultCwd = wd
		}
	}
	if cfg.ReconnectMaxSeconds <= 0 {
		cfg.ReconnectMaxSeconds = 30
	}

	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

func (c *Config) validate() error {
	// Direct (listen) mode: the NarraFork server dials in and supplies the device
	// identity, so only the listen address is required here.
	if c.ListenAddr != "" {
		return nil
	}
	if c.ServerURL == "" {
		return fmt.Errorf("server URL is required (--server or NARRAFORK_EXECUTOR_SERVER), or use --listen for direct mode")
	}
	if c.DeviceRef == "" {
		return fmt.Errorf("device ref is required (--device or NARRAFORK_EXECUTOR_DEVICE)")
	}
	if c.Token == "" {
		return fmt.Errorf("token is required (--token or NARRAFORK_EXECUTOR_TOKEN)")
	}
	if !strings.HasPrefix(c.ServerURL, "ws://") && !strings.HasPrefix(c.ServerURL, "wss://") {
		return fmt.Errorf("server URL must start with ws:// or wss://")
	}
	return nil
}

func splitCsv(v string) []string {
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}
