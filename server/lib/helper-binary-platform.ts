import { isWindowsPeFile } from "../../shared/windows-pe";
import type { HelperBinarySpec } from "./helper-binaries";

// SHA-256 of rg 15.1.0 executables, extracted from independently verified official
// archives by scripts/prepare-ripgrep-helpers.ts (see its pinned archive hashes).
const CLI_HELPER_SHA256: Record<string, string> = {
	"rg-linux-x64": "ebeaf56f8a25e102e9419933423738b3a2a613a444fd749d695e15eba53f71f2",
	"rg-linux-arm64": "968cabe8efed72fd8fd482cb76b6084fcb695fc5293af7fb62296b02f487fb69",
	"rg-darwin-x64": "3bafa7e6ee51ba3ac4ed065883484a309be09b26ea6dad561ae4049bfe049c50",
	"rg-darwin-arm64": "4fdf1d8365af224bc70e3c1490d8461d859c37cc70e739a11e987af0215f3e94",
	"rg-win64.exe": "decdd4992f3f1b9a5ef9898f1b40ab16886d579d6516b4efd3d5eaa19364e408",
	"rg-win-arm64.exe": "f7799d737b520e00b10dfa72def23904fe66fb03315636a7b78549845ee9609c",
	// zstd 1.5.7, fixed llvm-mingw 20250613 recipe. Reproduced byte-for-byte on
	// two Linux hosts by scripts/lib/zstd-windows-arm64.ts; not an upstream asset.
	"zstd-win-arm64.exe": "bf71f6105d47eff6a8d784ecba544c8fab155099d50308c5b7bee561c1e8cc8b",
};

/** Pure selection: unsupported architectures must not silently receive x64. */
export function getCliHelperSpec(
	tool: "rg" | "zstd",
	platform: string = process.platform,
	arch: string = process.arch,
): HelperBinarySpec | null {
	if (arch !== "x64" && arch !== "arm64") return null;
	const displayName = tool === "rg" ? "ripgrep" : "zstd CLI";
	if (platform === "win32") {
		const toolName = `${tool}-${arch === "arm64" ? "win-arm64" : "win64"}.exe`;
		return {
			tool,
			platform: `windows-${arch}`,
			toolName,
			// Never reuse historical rg.exe / zstd.exe (which may contain x64).
			cachedName: arch === "arm64" ? toolName : `${tool}.exe`,
			displayName,
			windowsArch: arch,
			...(CLI_HELPER_SHA256[toolName] ? { expectedSha256: CLI_HELPER_SHA256[toolName] } : {}),
		};
	}
	if (platform === "linux" || platform === "darwin") {
		const toolName = `${tool}-${platform}-${arch}`;
		return {
			tool,
			platform: `${platform}-${arch}`,
			toolName,
			cachedName: tool,
			displayName,
			...(CLI_HELPER_SHA256[toolName] ? { expectedSha256: CLI_HELPER_SHA256[toolName] } : {}),
		};
	}
	return null;
}

/** Windows ARM64 helpers must be native, including tools found on PATH. */
export function isNativeCliHelper(
	path: string,
	platform: string = process.platform,
	arch: string = process.arch,
): boolean {
	return platform !== "win32" || arch !== "arm64" || isWindowsPeFile(path, "arm64");
}
