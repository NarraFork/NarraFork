// Package config loads executor configuration from flags, environment
// variables, and an optional JSON config file (flags > env > file > default).
package config

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"unicode"
)

const maxTokenBytes = 4096

// maxPathRules bounds the ordered rule list. Evaluation is linear per path check,
// and an operator-facing guard list this long is a misconfiguration, not a use case.
const maxPathRules = 256

// PathRule is one entry in the ordered path guard list.
type PathRule struct {
	// Action is "allow" or "deny".
	Action string `json:"action"`
	// Path is an absolute directory path.
	Path string `json:"path"`
}

type tokenSourceKind uint8

const (
	tokenSourceLiteral tokenSourceKind = iota + 1
	tokenSourceFile
	tokenSourceStdin
)

type tokenSource struct {
	kind  tokenSourceKind
	value string
}

type Config struct {
	// ServerURL is the NarraFork WebSocket endpoint, e.g.
	// wss://host:7779/ws/device. Required in reverse mode.
	ServerURL string `json:"serverUrl"`
	// DeviceRef is the device slug or id used to look up the record server-side.
	DeviceRef string `json:"deviceRef"`
	// Token is the registration key (rdev_...). Prefer TokenFile/TokenStdin so the
	// plaintext secret is not exposed in process arguments or config JSON.
	Token string `json:"token"`
	// TokenFile is a permission-restricted regular file containing the token. "-"
	// remains a compatibility alias for stdin; TokenStdin is clearer for new uses.
	TokenFile string `json:"tokenFile"`
	// TokenStdin reads the token once from stdin during startup.
	TokenStdin bool `json:"tokenStdin"`
	// AllowRoots restricts structured filesystem, transfer, and search paths plus
	// Git/command working directories. It does not interpret Git arguments or
	// sandbox shell/PTY command text. Empty means unrestricted path RPCs.
	//
	// Superseded by PathRules, which can also deny. Still honored so executors
	// installed before ordered rules keep working across an upgrade.
	AllowRoots []string `json:"allowRoots"`
	// PathRules is an ordered allow/deny list guarding the same surface as
	// AllowRoots. The last rule containing a path decides, so a deny can carve a
	// hole out of an allow and a later allow can re-open an exception inside it.
	// Empty means unrestricted. Mutually exclusive with AllowRoots.
	PathRules []PathRule `json:"pathRules"`
	// DefaultCwd is reported to the server at handshake.
	DefaultCwd string `json:"defaultCwd"`
	// InsecureSkipVerify disables reverse-dial TLS certificate verification.
	InsecureSkipVerify bool `json:"insecureSkipVerify"`
	// CAFile adds PEM trust anchors to the system roots for reverse wss only.
	// JSON-relative paths are resolved against the config file directory.
	CAFile string `json:"caFile"`
	// ReconnectMaxSeconds caps the exponential reconnect backoff.
	ReconnectMaxSeconds int `json:"reconnectMaxSeconds"`
	// ListenAddr enables direct mode: the executor listens on this address
	// (e.g. "127.0.0.1:7900") for the NarraFork server to connect, instead of
	// dialing out. When set, ServerURL is not required.
	ListenAddr string `json:"listenAddr"`
	// TLSCert is the path to the TLS certificate file (PEM). Required when
	// ListenAddr does not use a loopback IP literal.
	TLSCert string `json:"tlsCert"`
	// TLSKey is the path to the TLS private key file (PEM). Required when
	// ListenAddr does not use a loopback IP literal.
	TLSKey string `json:"tlsKey"`
	// DisableShell blocks the general exec.start and pty.open command surfaces.
	// Git and filesystem capabilities remain available; this is not an OS sandbox.
	DisableShell bool `json:"disableShell"`
}

func Load() (*Config, error) {
	cfg := &Config{ReconnectMaxSeconds: 30}

	var configPath string
	fs := flag.NewFlagSet("narrafork-executor", flag.ContinueOnError)
	fs.StringVar(&configPath, "config", os.Getenv("NARRAFORK_EXECUTOR_CONFIG"), "Path to JSON config file")
	serverURL := fs.String("server", "", "NarraFork device WebSocket URL (wss://host:7779/ws/device)")
	deviceRef := fs.String("device", "", "Device slug or id")
	token := fs.String("token", "", "Registration token (rdev_...); prefer --token-file or --token-stdin")
	tokenFile := fs.String("token-file", "", `Read the token from a permission-restricted file ("-" aliases stdin)`)
	tokenStdin := fs.Bool("token-stdin", false, "Read the registration token once from stdin")
	allowRoots := fs.String("allow-root", "", "Comma-separated roots for structured path RPCs and command cwd checks (not a shell sandbox)")
	var pathRuleFlags pathRuleList
	fs.Var(&pathRuleFlags, "path-rule", `Ordered path rule "allow:/dir" or "deny:/dir" (repeatable; last match wins)`)
	defaultCwd := fs.String("cwd", "", "Default working directory reported to the server")
	insecure := fs.Bool("insecure", false, "Skip reverse-dial TLS certificate verification")
	caFile := fs.String("ca-file", "", "Additional trusted CA certificate PEM file for reverse wss (incompatible with --insecure)")
	listenAddr := fs.String("listen", "", "Direct mode: listen on this address (e.g. 127.0.0.1:7900) instead of dialing out")
	tlsCert := fs.String("tls-cert", "", "Path to TLS certificate PEM file (required unless listen uses a loopback IP literal)")
	tlsKey := fs.String("tls-key", "", "Path to TLS private key PEM file (required unless listen uses a loopback IP literal)")
	disableShell := fs.Bool("disable-shell", false, "Disable exec.start and pty.open (git/fs remain; not an OS sandbox)")
	if err := fs.Parse(os.Args[1:]); err != nil {
		return nil, err
	}
	explicitFlags := make(map[string]bool)
	fs.Visit(func(f *flag.Flag) { explicitFlags[f.Name] = true })

	// 1. Config file (lowest precedence).
	if configPath != "" {
		data, err := os.ReadFile(configPath)
		if err != nil {
			return nil, fmt.Errorf("read config file: %w", err)
		}
		if err := json.Unmarshal(data, cfg); err != nil {
			return nil, fmt.Errorf("parse config file: %w", err)
		}
		// The installer keeps its CA next to executor.json. Only this new field
		// uses the config directory; existing token/TLS path semantics stay intact.
		if cfg.CAFile != "" {
			base, err := filepath.Abs(filepath.Dir(configPath))
			if err != nil {
				return nil, fmt.Errorf("resolve config directory: %w", err)
			}
			cfg.CAFile = resolveConfigPath(base, cfg.CAFile)
		}
	}
	tokenChoice, tokenChoiceSet, err := selectTokenSource(
		"config file",
		cfg.Token,
		cfg.TokenFile,
		cfg.TokenStdin,
		cfg.Token != "",
		cfg.TokenFile != "",
		cfg.TokenStdin,
	)
	if err != nil {
		return nil, err
	}

	// 2. Environment variables.
	if v := os.Getenv("NARRAFORK_EXECUTOR_SERVER"); v != "" {
		cfg.ServerURL = v
	}
	if v := os.Getenv("NARRAFORK_EXECUTOR_DEVICE"); v != "" {
		cfg.DeviceRef = v
	}
	if v := os.Getenv("NARRAFORK_EXECUTOR_ALLOW_ROOTS"); v != "" {
		cfg.AllowRoots = splitCsv(v)
	}
	if v := os.Getenv("NARRAFORK_EXECUTOR_PATH_RULES"); v != "" {
		rules := make([]PathRule, 0, 4)
		for _, part := range splitCsv(v) {
			rule, err := parsePathRule(part)
			if err != nil {
				return nil, fmt.Errorf("NARRAFORK_EXECUTOR_PATH_RULES: %w", err)
			}
			rules = append(rules, rule)
		}
		cfg.PathRules = rules
	}
	if v := os.Getenv("NARRAFORK_EXECUTOR_LISTEN"); v != "" {
		cfg.ListenAddr = v
	}
	if v := os.Getenv("NARRAFORK_EXECUTOR_TLS_CERT"); v != "" {
		cfg.TLSCert = v
	}
	if v := os.Getenv("NARRAFORK_EXECUTOR_TLS_KEY"); v != "" {
		cfg.TLSKey = v
	}
	if value, set, boolErr := environmentBool("NARRAFORK_EXECUTOR_DISABLE_SHELL"); boolErr != nil {
		return nil, boolErr
	} else if set {
		cfg.DisableShell = value
	}

	envToken, envTokenSet := nonEmptyEnvironment("NARRAFORK_EXECUTOR_TOKEN")
	envTokenFile, envTokenFileSet := nonEmptyEnvironment("NARRAFORK_EXECUTOR_TOKEN_FILE")
	envTokenStdin, envTokenStdinSet, envErr := environmentBool("NARRAFORK_EXECUTOR_TOKEN_STDIN")
	if envErr != nil {
		return nil, envErr
	}
	envChoice, envChoiceSet, err := selectTokenSource(
		"environment",
		envToken,
		envTokenFile,
		envTokenStdin,
		envTokenSet,
		envTokenFileSet,
		envTokenStdinSet && envTokenStdin,
	)
	if err != nil {
		return nil, err
	}
	if envChoiceSet {
		tokenChoice = envChoice
		tokenChoiceSet = true
	}

	// 3. Flags (highest precedence).
	if *serverURL != "" {
		cfg.ServerURL = *serverURL
	}
	if *deviceRef != "" {
		cfg.DeviceRef = *deviceRef
	}
	if *allowRoots != "" {
		cfg.AllowRoots = splitCsv(*allowRoots)
	}
	if len(pathRuleFlags) > 0 {
		cfg.PathRules = pathRuleFlags
	}
	if *defaultCwd != "" {
		cfg.DefaultCwd = *defaultCwd
	}
	if explicitFlags["insecure"] {
		cfg.InsecureSkipVerify = *insecure
	}
	if explicitFlags["ca-file"] {
		if strings.TrimSpace(*caFile) == "" {
			return nil, fmt.Errorf("--ca-file path must not be empty")
		}
		cfg.CAFile = *caFile
	}
	if *listenAddr != "" {
		cfg.ListenAddr = *listenAddr
	}
	if *tlsCert != "" {
		cfg.TLSCert = *tlsCert
	}
	if *tlsKey != "" {
		cfg.TLSKey = *tlsKey
	}
	if explicitFlags["disable-shell"] {
		cfg.DisableShell = *disableShell
	}
	flagChoice, flagChoiceSet, err := selectTokenSource(
		"command line",
		*token,
		*tokenFile,
		*tokenStdin,
		explicitFlags["token"],
		explicitFlags["token-file"],
		explicitFlags["token-stdin"] && *tokenStdin,
	)
	if err != nil {
		return nil, err
	}
	if flagChoiceSet {
		tokenChoice = flagChoice
		tokenChoiceSet = true
	}

	cfg.Token = ""
	cfg.TokenFile = ""
	cfg.TokenStdin = false
	if tokenChoiceSet {
		if err := materializeToken(cfg, tokenChoice); err != nil {
			return nil, err
		}
	}

	if cfg.DefaultCwd == "" {
		if wd, err := os.Getwd(); err == nil {
			cfg.DefaultCwd = wd
		}
	}
	if cfg.ReconnectMaxSeconds <= 0 {
		cfg.ReconnectMaxSeconds = 30
	}

	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

func resolveConfigPath(base, path string) string {
	path = strings.TrimSpace(path)
	if path == "" || filepath.IsAbs(path) {
		return path
	}
	return filepath.Join(base, path)
}

func selectTokenSource(
	layer string,
	literal string,
	file string,
	stdin bool,
	literalSet bool,
	fileSet bool,
	stdinSet bool,
) (tokenSource, bool, error) {
	count := 0
	if literalSet {
		count++
	}
	if fileSet {
		count++
	}
	if stdinSet && stdin {
		count++
	}
	if count > 1 {
		return tokenSource{}, false, fmt.Errorf(
			"%s specifies multiple token sources; choose exactly one of token, tokenFile, or tokenStdin",
			layer,
		)
	}
	switch {
	case literalSet:
		return tokenSource{kind: tokenSourceLiteral, value: literal}, true, nil
	case fileSet:
		return tokenSource{kind: tokenSourceFile, value: file}, true, nil
	case stdinSet && stdin:
		return tokenSource{kind: tokenSourceStdin}, true, nil
	default:
		return tokenSource{}, false, nil
	}
}

func materializeToken(cfg *Config, source tokenSource) error {
	switch source.kind {
	case tokenSourceLiteral:
		token, err := normalizeToken(source.value, "token")
		if err != nil {
			return err
		}
		cfg.Token = token
	case tokenSourceFile:
		path := strings.TrimSpace(source.value)
		if path == "" {
			return fmt.Errorf("token-file path is empty")
		}
		cfg.TokenFile = path
		token, err := readTokenFile(path)
		if err != nil {
			return fmt.Errorf("token-file: %w", err)
		}
		cfg.Token = token
	case tokenSourceStdin:
		cfg.TokenStdin = true
		token, err := readToken(os.Stdin, "stdin")
		if err != nil {
			return fmt.Errorf("token-stdin: %w", err)
		}
		cfg.Token = token
	default:
		return fmt.Errorf("unknown token source")
	}
	return nil
}

func readTokenFile(path string) (string, error) {
	if path == "-" {
		return readToken(os.Stdin, "stdin")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open %q: %w", path, err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", fmt.Errorf("inspect %q: %w", path, err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("%q is not a regular file (use --token-stdin for pipes)", path)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return "", fmt.Errorf(
			"%q permissions are too open (%#o); run chmod 600 %q",
			path,
			info.Mode().Perm(),
			path,
		)
	}
	return readToken(file, fmt.Sprintf("token file %q", path))
}

func readToken(reader io.Reader, source string) (string, error) {
	data, err := io.ReadAll(io.LimitReader(reader, maxTokenBytes+1))
	if err != nil {
		return "", fmt.Errorf("read %s: %w", source, err)
	}
	if len(data) > maxTokenBytes {
		return "", fmt.Errorf("%s exceeds %d bytes", source, maxTokenBytes)
	}
	return normalizeToken(string(data), source)
}

func normalizeToken(raw string, source string) (string, error) {
	token := strings.TrimSpace(raw)
	if token == "" {
		return "", fmt.Errorf("%s is empty", source)
	}
	if len(token) > maxTokenBytes {
		return "", fmt.Errorf("%s exceeds %d bytes", source, maxTokenBytes)
	}
	if strings.IndexFunc(token, unicode.IsSpace) >= 0 {
		return "", fmt.Errorf("%s contains whitespace", source)
	}
	return token, nil
}

func nonEmptyEnvironment(name string) (string, bool) {
	value, ok := os.LookupEnv(name)
	return value, ok && strings.TrimSpace(value) != ""
}

func environmentBool(name string) (bool, bool, error) {
	raw, ok := os.LookupEnv(name)
	if !ok || strings.TrimSpace(raw) == "" {
		return false, false, nil
	}
	value, err := strconv.ParseBool(strings.TrimSpace(raw))
	if err != nil {
		return false, false, fmt.Errorf("%s must be true or false", name)
	}
	return value, true, nil
}

func splitListenAddress(address string) (host string, port int, err error) {
	value := strings.TrimSpace(address)
	host, rawPort, err := net.SplitHostPort(value)
	if err != nil {
		return "", 0, fmt.Errorf("invalid direct listen address %q: %w", address, err)
	}
	port, err = strconv.Atoi(rawPort)
	if err != nil || port < 0 || port > 65535 {
		return "", 0, fmt.Errorf("invalid direct listen port %q", rawPort)
	}
	return host, port, nil
}

// IsListenLoopback reports whether ListenAddr binds to a loopback IP literal.
// Hostnames (including "localhost") deliberately return false to avoid a DNS or
// hosts-file change between validation and the actual bind.
func (c *Config) IsListenLoopback() bool {
	host, _, err := splitListenAddress(c.ListenAddr)
	if err != nil || host == "" {
		return false
	}
	if zone := strings.LastIndexByte(host, '%'); zone > 0 {
		host = host[:zone]
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// EffectivePathRules returns the ordered rule list the path guard should enforce.
// AllowRoots is translated to one allow rule per root so a pre-rules install keeps
// its exact previous behavior. An empty result means unrestricted.
func (c *Config) EffectivePathRules() []PathRule {
	if len(c.PathRules) > 0 {
		return c.PathRules
	}
	rules := make([]PathRule, 0, len(c.AllowRoots))
	for _, root := range c.AllowRoots {
		rules = append(rules, PathRule{Action: "allow", Path: root})
	}
	return rules
}

// validatePathRules normalizes every rule and refuses ambiguous configurations.
func (c *Config) validatePathRules() error {
	if len(c.PathRules) > 0 && len(c.AllowRoots) > 0 {
		return fmt.Errorf(
			"allowRoots and pathRules are mutually exclusive: keep pathRules and remove allowRoots",
		)
	}
	if len(c.PathRules) > maxPathRules {
		return fmt.Errorf("pathRules has %d entries; the maximum is %d", len(c.PathRules), maxPathRules)
	}
	normalized := make([]PathRule, 0, len(c.PathRules))
	for i, rule := range c.PathRules {
		valid, err := normalizePathRule(rule)
		if err != nil {
			return fmt.Errorf("pathRules[%d]: %w", i, err)
		}
		normalized = append(normalized, valid)
	}
	c.PathRules = normalized

	for i, root := range c.AllowRoots {
		if strings.ContainsRune(root, 0) {
			return fmt.Errorf("allowRoots[%d] contains a NUL byte", i)
		}
		if !isAbsolutePathRule(strings.TrimSpace(root)) {
			return fmt.Errorf("allowRoots[%d] %q must be an absolute path", i, root)
		}
	}
	return nil
}

// Validate enforces mode, credential, address, and TLS invariants. Listener code
// calls it again so programmatically constructed Config values cannot bypass the
// same policy enforced by Load.
func (c *Config) Validate() error {
	if err := c.validatePathRules(); err != nil {
		return err
	}
	c.ServerURL = strings.TrimSpace(c.ServerURL)
	c.DeviceRef = strings.TrimSpace(c.DeviceRef)
	c.ListenAddr = strings.TrimSpace(c.ListenAddr)
	c.TLSCert = strings.TrimSpace(c.TLSCert)
	c.TLSKey = strings.TrimSpace(c.TLSKey)
	c.CAFile = strings.TrimSpace(c.CAFile)
	if c.CAFile != "" && c.InsecureSkipVerify {
		return fmt.Errorf("caFile (--ca-file) and insecureSkipVerify (--insecure) are mutually exclusive")
	}

	if c.ListenAddr != "" {
		if c.CAFile != "" {
			return fmt.Errorf("caFile (--ca-file) applies only to reverse wss clients, not direct listeners")
		}
		if _, _, err := splitListenAddress(c.ListenAddr); err != nil {
			return err
		}
		if c.DeviceRef == "" {
			return fmt.Errorf("device ref is required in direct mode (--device or NARRAFORK_EXECUTOR_DEVICE)")
		}
		if c.Token == "" {
			return fmt.Errorf("token is required in direct mode (--token, --token-file, or --token-stdin)")
		}
		if c.InsecureSkipVerify {
			return fmt.Errorf("--insecure applies only to reverse-dial TLS clients, not direct listeners")
		}
		if (c.TLSCert == "") != (c.TLSKey == "") {
			return fmt.Errorf("--tls-cert and --tls-key must be supplied together")
		}
		if !c.IsListenLoopback() && c.TLSCert == "" {
			return fmt.Errorf(
				"direct listener on %q is not a loopback IP literal: --tls-cert and --tls-key are required "+
					"(use 127.0.0.1 or [::1] for loopback-only plaintext listening)",
				c.ListenAddr,
			)
		}
		return nil
	}

	if c.TLSCert != "" || c.TLSKey != "" {
		return fmt.Errorf("--tls-cert and --tls-key apply only to direct mode (--listen)")
	}
	if c.ServerURL == "" {
		return fmt.Errorf("server URL is required (--server or NARRAFORK_EXECUTOR_SERVER), or use --listen for direct mode")
	}
	parsed, err := url.Parse(c.ServerURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "ws" && parsed.Scheme != "wss") {
		return fmt.Errorf("server URL must be a valid ws:// or wss:// URL")
	}
	if c.DeviceRef == "" {
		return fmt.Errorf("device ref is required (--device or NARRAFORK_EXECUTOR_DEVICE)")
	}
	if c.Token == "" {
		return fmt.Errorf("token is required (--token, --token-file, or --token-stdin)")
	}
	if c.CAFile != "" && parsed.Scheme != "wss" {
		return fmt.Errorf("caFile (--ca-file) requires a wss:// reverse-dial server")
	}
	if c.InsecureSkipVerify && parsed.Scheme != "wss" {
		return fmt.Errorf("--insecure is only meaningful with a wss:// reverse-dial server")
	}
	return nil
}

// pathRuleList collects repeated --path-rule flags while preserving their order,
// which is the whole point of the ordered rule model.
type pathRuleList []PathRule

func (l *pathRuleList) String() string {
	parts := make([]string, 0, len(*l))
	for _, rule := range *l {
		parts = append(parts, rule.Action+":"+rule.Path)
	}
	return strings.Join(parts, ",")
}

func (l *pathRuleList) Set(value string) error {
	rule, err := parsePathRule(value)
	if err != nil {
		return err
	}
	*l = append(*l, rule)
	return nil
}

// parsePathRule accepts "allow:/dir" and "deny:/dir". The action is split on the
// first colon only, so Windows paths like "deny:C:\secrets" keep their drive letter.
func parsePathRule(value string) (PathRule, error) {
	trimmed := strings.TrimSpace(value)
	action, path, found := strings.Cut(trimmed, ":")
	if !found {
		return PathRule{}, fmt.Errorf("path rule %q must be prefixed with allow: or deny:", value)
	}
	return normalizePathRule(PathRule{Action: strings.ToLower(strings.TrimSpace(action)), Path: path})
}

func normalizePathRule(rule PathRule) (PathRule, error) {
	action := strings.ToLower(strings.TrimSpace(rule.Action))
	if action != "allow" && action != "deny" {
		return PathRule{}, fmt.Errorf("path rule action %q must be allow or deny", rule.Action)
	}
	path := strings.TrimSpace(rule.Path)
	if path == "" {
		return PathRule{}, fmt.Errorf("path rule with action %q has an empty path", action)
	}
	if strings.ContainsRune(path, 0) {
		return PathRule{}, fmt.Errorf("path rule %q contains a NUL byte", path)
	}
	if !isAbsolutePathRule(path) {
		return PathRule{}, fmt.Errorf("path rule %q must be an absolute path", path)
	}
	return PathRule{Action: action, Path: path}, nil
}

// isAbsolutePathRule accepts both POSIX and Windows absolute shapes regardless of
// the running OS: a config written for one platform should fail validation with a
// clear message rather than being silently reinterpreted.
func isAbsolutePathRule(path string) bool {
	if strings.HasPrefix(path, "/") {
		return true
	}
	if strings.HasPrefix(path, `\\`) {
		return true
	}
	if len(path) >= 3 {
		drive := path[0]
		isLetter := (drive >= 'A' && drive <= 'Z') || (drive >= 'a' && drive <= 'z')
		if isLetter && path[1] == ':' && (path[2] == '\\' || path[2] == '/') {
			return true
		}
	}
	return false
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
