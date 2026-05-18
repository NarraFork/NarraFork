package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const defaultUpdateServer = "https://narrafork-update.b.domexie.cn"

var versionPattern = regexp.MustCompile(`^\d+\.\d+\.\d+(-[a-zA-Z0-9._-]+)?$`)

type updateConfig struct {
	ServerURL string `json:"serverUrl"`
	Token     string `json:"token"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "❌", err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) < 2 {
		printUsage()
		return errors.New("missing command")
	}
	switch os.Args[1] {
	case "release":
		return release(os.Args[2:])
	case "promote":
		return promote(os.Args[2:])
	case "build-server":
		return buildServer(os.Args[2:])
	default:
		printUsage()
		return fmt.Errorf("unknown command: %s", os.Args[1])
	}
}

func printUsage() {
	fmt.Println("Usage:")
	fmt.Println("  narrafork-updatectl release <version> [--changelog=file] [--platform=target] [--dry-run] [--skip-build] [--upload-only]")
	fmt.Println("  narrafork-updatectl promote <version> [--list]")
	fmt.Println("  narrafork-updatectl promote --list")
	fmt.Println("  narrafork-updatectl build-server [--platform=linux-x64]")
}

func repoRoot() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(cwd, "package.json")); err == nil {
			if _, err := os.Stat(filepath.Join(cwd, "update-server-go")); err == nil {
				return cwd, nil
			}
		}
		parent := filepath.Dir(cwd)
		if parent == cwd {
			break
		}
		cwd = parent
	}
	if _, err := os.Stat(filepath.Join("..", "package.json")); err == nil {
		return filepath.Abs("..")
	}
	return "", errors.New("cannot locate NarraFork repository root")
}

func loadUpdateConfig() updateConfig {
	cfg := updateConfig{ServerURL: defaultUpdateServer}
	if home, err := os.UserHomeDir(); err == nil {
		path := filepath.Join(home, ".narrafork", "update-server.json")
		if data, err := os.ReadFile(path); err == nil {
			_ = json.Unmarshal(data, &cfg)
		}
	}
	if v := strings.TrimSpace(os.Getenv("NF_UPDATE_SERVER")); v != "" {
		cfg.ServerURL = v
	}
	if v := strings.TrimSpace(os.Getenv("NF_UPDATE_TOKEN")); v != "" {
		cfg.Token = v
	}
	cfg.ServerURL = strings.TrimRight(cfg.ServerURL, "/")
	return cfg
}

func release(args []string) error {
	fs := flag.NewFlagSet("release", flag.ExitOnError)
	changelogArg := fs.String("changelog", "", "changelog JSON/text file")
	platformArg := fs.String("platform", "", "build/upload only this platform")
	dryRun := fs.Bool("dry-run", false, "build only, do not upload or tag")
	skipBuild := fs.Bool("skip-build", false, "skip compilation")
	uploadOnly := fs.Bool("upload-only", false, "only upload existing dist artifacts")
	if err := fs.Parse(args); err != nil {
		return err
	}
	version := ""
	if fs.NArg() > 0 {
		version = fs.Arg(0)
	}
	if version == "" || !versionPattern.MatchString(version) {
		return fmt.Errorf("invalid version format: %s (expected x.y.z or x.y.z-prerelease)", version)
	}
	root, err := repoRoot()
	if err != nil {
		return err
	}
	cfg := loadUpdateConfig()
	if !*dryRun && strings.TrimSpace(cfg.Token) == "" {
		return errors.New("update server token not found; set NF_UPDATE_TOKEN or ~/.narrafork/update-server.json")
	}
	changelog, err := loadChangelog(root, version, *changelogArg)
	if err != nil {
		return err
	}
	if !*uploadOnly {
		if err := bumpPackageVersion(root, version); err != nil {
			return err
		}
	}
	if !*uploadOnly && !*dryRun {
		if err := gitCommitAndTag(root, version); err != nil {
			return err
		}
	}
	if !*skipBuild && !*uploadOnly {
		label := "all platforms"
		cmdArgs := []string{"scripts/build-cross-platform.ts"}
		if *platformArg != "" {
			label = "platform " + *platformArg
			cmdArgs = append(cmdArgs, "--platform="+*platformArg)
		}
		fmt.Printf("\n→ Building %s...\n\n", label)
		if err := runCmd(root, "bun", cmdArgs...); err != nil {
			return fmt.Errorf("build failed: %w", err)
		}
	}
	if *dryRun {
		fmt.Println("\n✅ Dry run complete — skipping upload")
		return nil
	}
	return uploadReleaseArtifacts(root, cfg, version, *platformArg, changelog)
}

func loadChangelog(root, version, explicit string) (string, error) {
	path := explicit
	if path == "" {
		path = filepath.Join(root, "changelogs", "v"+version+".json")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if explicit != "" {
			return "", fmt.Errorf("changelog file not found: %s", explicit)
		}
		return "", nil
	}
	fmt.Printf("✓ Loaded changelog from %s\n", path)
	return string(data), nil
}

func bumpPackageVersion(root, version string) error {
	path := filepath.Join(root, "package.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	oldVersion, _ := raw["version"].(string)
	if oldVersion == version {
		fmt.Printf("ℹ Version already %s, skipping bump\n", version)
		return nil
	}
	raw["version"] = version
	encoded, err := json.MarshalIndent(raw, "", "\t")
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	if err := os.WriteFile(path, encoded, 0o644); err != nil {
		return err
	}
	fmt.Printf("✓ Version bumped: %s → %s\n", oldVersion, version)
	return nil
}

func gitCommitAndTag(root, version string) error {
	status, err := commandOutput(root, "git", "status", "--porcelain", "package.json")
	if err != nil {
		return err
	}
	if strings.TrimSpace(status) != "" {
		if err := runCmd(root, "git", "add", "package.json"); err != nil {
			return err
		}
		if err := runCmd(root, "git", "commit", "-m", "release: v"+version); err != nil {
			return err
		}
		fmt.Printf("✓ Committed release: v%s\n", version)
	}
	tags, err := commandOutput(root, "git", "tag", "--list")
	if err != nil {
		return err
	}
	for _, tag := range strings.Fields(tags) {
		if tag == "v"+version {
			fmt.Printf("ℹ Tag v%s already exists, skipping\n", version)
			return nil
		}
	}
	if err := runCmd(root, "git", "tag", "v"+version); err != nil {
		return err
	}
	fmt.Printf("✓ Tagged: v%s\n", version)
	return nil
}

func uploadReleaseArtifacts(root string, cfg updateConfig, version, platformArg, changelog string) error {
	fmt.Println()
	fmt.Println("→ Uploading to update server...")
	fmt.Println()
	entries := filteredUploadEntries(platformArg)
	if len(entries) == 0 {
		return fmt.Errorf("no upload platforms match %q", platformArg)
	}
	prefix := "narrafork-" + version + "-"
	dist := filepath.Join(root, "dist")
	uploaded, failed := 0, 0
	for _, entry := range entries {
		suffix, platform := entry.suffix, entry.platformID
		filename := prefix + suffix
		metaPath := filepath.Join(dist, filename+".zstd-patch.meta.json")
		patchPath := filepath.Join(dist, filename+".zstd-patch")
		if _, err := os.Stat(patchPath); err != nil {
			fmt.Printf("  ⏭ %s: no zstd patch, skipping\n", platform)
			continue
		}
		metaBytes, err := os.ReadFile(metaPath)
		if err != nil {
			fmt.Printf("  ⏭ %s: no zstd patch meta, skipping\n", platform)
			continue
		}
		var meta map[string]any
		if err := json.Unmarshal(metaBytes, &meta); err != nil {
			fmt.Printf("  ⏭ %s: invalid meta, skipping\n", platform)
			continue
		}
		sha, _ := meta["newFileSha512"].(string)
		size := numberString(meta["newFileSize"])
		if sha == "" || size == "" {
			fmt.Printf("  ⏭ %s: incomplete meta, skipping\n", platform)
			continue
		}
		if err := uploadOne(cfg, version, channelForVersion(version), platform, filename, size, sha, changelog, patchPath, metaPath); err != nil {
			fmt.Printf("  ❌ %s: %v\n", platform, err)
			failed++
			continue
		}
		patchSize := "no patch"
		if info, err := os.Stat(patchPath); err == nil {
			patchSize = fmt.Sprintf("%.0fKB patch", float64(info.Size())/1024)
		}
		fmt.Printf("  ✓ %s: %s\n", platform, patchSize)
		uploaded++
	}
	fmt.Printf("\n✅ Release v%s complete: %d uploaded, %d failed\n", version, uploaded, failed)
	if failed > 0 {
		return errors.New("one or more uploads failed")
	}
	if uploaded == 0 {
		return errors.New("no release artifacts were uploaded; expected .zstd-patch and .zstd-patch.meta.json files")
	}
	return nil
}

type uploadEntry struct {
	suffix     string
	platformID string
	aliases    []string
}

func filteredUploadEntries(platformArg string) []uploadEntry {
	all := []uploadEntry{
		{suffix: "linux-x64", platformID: "linux-x64", aliases: []string{"linux-x64", "linux-amd64"}},
		{suffix: "linux-x64-baseline", platformID: "linux-x64-baseline", aliases: []string{"linux-x64-baseline", "linux-amd64-baseline"}},
		{suffix: "linux-arm64", platformID: "linux-arm64", aliases: []string{"linux-arm64"}},
		{suffix: "macos-arm64", platformID: "darwin-arm64", aliases: []string{"darwin-arm64", "macos-arm64"}},
		{suffix: "macos-x64", platformID: "darwin-x64", aliases: []string{"darwin-x64", "darwin-amd64", "macos-x64", "macos-amd64"}},
		{suffix: "windows-x64.exe", platformID: "win-x64", aliases: []string{"win-x64", "windows-x64", "windows-x64.exe", "win-amd64", "windows-amd64"}},
		{suffix: "windows-x64-baseline.exe", platformID: "win-x64-baseline", aliases: []string{"win-x64-baseline", "windows-x64-baseline", "windows-x64-baseline.exe", "win-amd64-baseline", "windows-amd64-baseline"}},
	}
	if platformArg == "" {
		return all
	}
	platformArg = strings.TrimSpace(platformArg)
	out := []uploadEntry{}
	for _, entry := range all {
		if entry.matches(platformArg) {
			out = append(out, entry)
		}
	}
	return out
}

func (e uploadEntry) matches(platformArg string) bool {
	if platformArg == e.suffix || platformArg == strings.TrimSuffix(e.suffix, ".exe") || platformArg == e.platformID {
		return true
	}
	for _, alias := range e.aliases {
		if platformArg == alias {
			return true
		}
	}
	return false
}

func channelForVersion(version string) string {
	if strings.Contains(version, "-") {
		return "beta"
	}
	return "stable"
}

func numberString(value any) string {
	switch v := value.(type) {
	case float64:
		return fmt.Sprintf("%.0f", v)
	case int:
		return fmt.Sprintf("%d", v)
	case string:
		return v
	default:
		return ""
	}
}

func uploadOne(cfg updateConfig, version, channel, platform, filename, size, sha, changelog, patchPath, metaPath string) error {
	reader, writerPipe := io.Pipe()
	writer := multipart.NewWriter(writerPipe)
	writeErr := make(chan error, 1)
	go func() {
		err := writeUploadMultipart(writer, version, channel, platform, filename, size, sha, changelog, patchPath, metaPath)
		if err == nil {
			err = writer.Close()
		}
		if err != nil {
			_ = writerPipe.CloseWithError(err)
		} else {
			_ = writerPipe.Close()
		}
		writeErr <- err
	}()

	req, err := http.NewRequest(http.MethodPost, cfg.ServerURL+"/api/v2/products/narrafork/releases", reader)
	if err != nil {
		_ = reader.CloseWithError(err)
		return err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		_ = reader.CloseWithError(err)
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err := <-writeErr; err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err == nil {
		if ok, _ := parsed["success"].(bool); !ok {
			if msg, _ := parsed["error"].(string); msg != "" {
				return errors.New(msg)
			}
			return errors.New("unknown upload error")
		}
	}
	return nil
}

func writeUploadMultipart(writer *multipart.Writer, version, channel, platform, filename, size, sha, changelog, patchPath, metaPath string) error {
	fields := map[string]string{"version": version, "channel": channel, "platform": platform, "filename": filename, "size": size, "sha512": sha}
	for key, value := range fields {
		if err := writer.WriteField(key, value); err != nil {
			return err
		}
	}
	if strings.TrimSpace(changelog) != "" {
		if err := writer.WriteField("releaseNotes", changelog); err != nil {
			return err
		}
	}
	if err := writeFilePart(writer, "zstdPatch", filename+".zstd-patch", patchPath); err != nil {
		return err
	}
	return writeFilePart(writer, "zstdPatchMeta", filename+".zstd-patch.meta.json", metaPath)
}

func writeFilePart(writer *multipart.Writer, fieldName, filename, path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	part, err := writer.CreateFormFile(fieldName, filename)
	if err != nil {
		return err
	}
	_, err = io.Copy(part, file)
	return err
}

func promote(args []string) error {
	fs := flag.NewFlagSet("promote", flag.ExitOnError)
	listOnly := fs.Bool("list", false, "list releases")
	if err := fs.Parse(args); err != nil {
		return err
	}
	version := ""
	if fs.NArg() > 0 {
		version = fs.Arg(0)
	}
	if version == "" && !*listOnly {
		return errors.New("usage: promote <version> [--list] or promote --list")
	}
	cfg := loadUpdateConfig()
	if strings.TrimSpace(cfg.Token) == "" {
		return errors.New("update server token not found; set NF_UPDATE_TOKEN or ~/.narrafork/update-server.json")
	}
	if *listOnly {
		if err := listReleases(cfg); err != nil {
			return err
		}
		if version == "" {
			return nil
		}
	}
	url := cfg.ServerURL + "/api/v2/products/narrafork/releases/" + version + "/promote"
	body := strings.NewReader(`{"channel":"stable"}`)
	req, _ := http.NewRequest(http.MethodPost, url, body)
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("promote failed: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(payload)))
	}
	fmt.Printf("✅ v%s promoted to stable\n", version)
	return nil
}

func listReleases(cfg updateConfig) error {
	req, _ := http.NewRequest(http.MethodGet, cfg.ServerURL+"/api/v2/products/narrafork/releases", nil)
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("failed to list releases: HTTP %d", resp.StatusCode)
	}
	var body struct {
		Releases []struct {
			Version     string   `json:"version"`
			Channel     string   `json:"channel"`
			ReleaseDate string   `json:"releaseDate"`
			Platforms   []string `json:"platforms"`
		} `json:"releases"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return err
	}
	if len(body.Releases) == 0 {
		fmt.Println("No releases found.")
		return nil
	}
	fmt.Printf("%-12s  %-7s  %-10s  PLATFORMS\n", "VERSION", "CHANNEL", "DATE")
	for _, item := range body.Releases {
		date := item.ReleaseDate
		if len(date) > 10 {
			date = date[:10]
		}
		fmt.Printf("%-12s  %-7s  %-10s  %s\n", item.Version, item.Channel, date, strings.Join(item.Platforms, ", "))
	}
	return nil
}

func buildServer(args []string) error {
	fs := flag.NewFlagSet("build-server", flag.ExitOnError)
	platform := fs.String("platform", defaultBuildPlatform(), "target platform")
	if err := fs.Parse(args); err != nil {
		return err
	}
	root, err := repoRoot()
	if err != nil {
		return err
	}
	version, err := packageVersion(root)
	if err != nil {
		return err
	}
	platformName := canonicalBuildPlatformName(*platform)
	goos, goarch, ext := goTarget(platformName)
	name := fmt.Sprintf("narrafork-update-server-go-%s-%s%s", version, platformName, ext)
	out := filepath.Join(root, "dist", name)
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		return err
	}
	cmd := exec.Command("go", "build", "-o", out, "./cmd/narrafork-update-server")
	cmd.Dir = filepath.Join(root, "update-server-go")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = append(os.Environ(), "GOOS="+goos, "GOARCH="+goarch)
	if err := cmd.Run(); err != nil {
		return err
	}
	fmt.Printf("✓ Built: %s\n", out)
	return nil
}

func packageVersion(root string) (string, error) {
	data, err := os.ReadFile(filepath.Join(root, "package.json"))
	if err != nil {
		return "", err
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return "", err
	}
	version, _ := raw["version"].(string)
	if version == "" {
		version = "0.0.0"
	}
	return version, nil
}

func defaultBuildPlatform() string {
	return canonicalBuildPlatformName(runtime.GOOS + "-" + runtime.GOARCH)
}

func canonicalBuildPlatformName(platform string) string {
	platform = strings.TrimSuffix(strings.TrimSpace(platform), ".exe")
	switch platform {
	case "linux-amd64", "linux-x64":
		return "linux-x64"
	case "linux-amd64-baseline", "linux-x64-baseline":
		return "linux-x64-baseline"
	case "linux-arm64":
		return "linux-arm64"
	case "darwin-amd64", "darwin-x64", "macos-amd64", "macos-x64":
		return "darwin-x64"
	case "darwin-arm64", "macos-arm64":
		return "darwin-arm64"
	case "windows-amd64", "windows-x64", "win-amd64", "win-x64":
		return "win-x64"
	case "windows-amd64-baseline", "windows-x64-baseline", "win-amd64-baseline", "win-x64-baseline":
		return "win-x64-baseline"
	default:
		return platform
	}
}

func goTarget(platform string) (string, string, string) {
	platform = canonicalBuildPlatformName(platform)
	ext := ""
	if strings.HasPrefix(platform, "win-") {
		ext = ".exe"
		return "windows", "amd64", ext
	}
	parts := strings.Split(platform, "-")
	goos := parts[0]
	goarch := "amd64"
	if len(parts) > 1 && parts[1] == "arm64" {
		goarch = "arm64"
	}
	if len(parts) > 1 && parts[1] == "x64" {
		goarch = "amd64"
	}
	return goos, goarch, ext
}

func runCmd(dir, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	return cmd.Run()
}

func commandOutput(dir, name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	return string(out), err
}
