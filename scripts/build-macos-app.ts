/**
 * Experimental macOS .app packaging for NarraFork (see docs/MACOS_APP.md).
 *
 * Wraps a compiled `narrafork-<version>-macos-<arch>` binary into a double-clickable
 * `NarraFork.app`, and optionally produces a drag-install DMG. Runs on macOS hosts
 * only (needs clang/iconutil/codesign/hdiutil).
 *
 * Usage:
 *   bun scripts/build-macos-app.ts                          # arm64 app from dist binary
 *   bun scripts/build-macos-app.ts --arch=x64 --dmg
 *   bun scripts/build-macos-app.ts --binary=dist/narrafork-0.9.15-macos-arm64 --dmg
 *
 * Flags:
 *   --binary=<path>     compiled NarraFork binary (default: dist/narrafork-<version>-macos-<arch>)
 *   --arch=<arm64|x64>  target arch (default: inferred from --binary name, else this machine's)
 *   --output=<dir>      build directory (default: dist/macos-app-<arch>)
 *   --app-name=<name>   app display name (default: NarraFork)
 *   --bundle-id=<id>    CFBundleIdentifier (default: com.narrafork.app)
 *   --icon=<png>        icon source PNG (default: frontend/public/pwa-512x512.png; "" disables)
 *   --dmg               also create dist/narrafork-<version>-macos-<arch>.dmg
 *   --no-sign           skip ad-hoc codesign (signature only silences "damaged"; real
 *                       distribution still needs Developer ID + notarization)
 */
import { execFileSync, execSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const VERSION: string = pkg.version ?? "0.0.0";

if (process.platform !== "darwin") {
	throw new Error("macOS .app packaging must run on a macOS host (clang/iconutil/hdiutil).");
}

// ── Args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const flag = (name: string) => args.includes(`--${name}`);

const binaryArg = arg("binary");
const archArg = arg("arch") as "arm64" | "x64" | undefined;
const arch =
	archArg ??
	(binaryArg?.includes("x64")
		? "x64"
		: binaryArg?.includes("arm64")
			? "arm64"
			: process.arch === "x64"
				? "x64"
				: "arm64");
if (!["arm64", "x64"].includes(arch)) throw new Error(`--arch must be arm64 or x64, got ${arch}`);

const binaryPath = binaryArg ?? join(ROOT, "dist", `narrafork-${VERSION}-macos-${arch}`);
const outDir = arg("output") ?? join(ROOT, "dist", `macos-app-${arch}`);
const appName = arg("app-name") ?? "NarraFork";
const bundleId = arg("bundle-id") ?? "com.narrafork.app";
const iconArg = arg("icon");
const iconPath = iconArg === "" ? null : (iconArg ?? join(ROOT, "frontend/public/pwa-512x512.png"));
const wantDmg = flag("dmg");
const wantSign = !flag("no-sign");

if (!existsSync(binaryPath)) {
	throw new Error(
		`Binary not found: ${binaryPath}\nBuild it first: bun run build:macos-${arch} (or pass --binary=…).`,
	);
}

// ── Bundle layout ───────────────────────────────────────────────────────────
const appDir = join(outDir, `${appName}.app`);
const contentsDir = join(appDir, "Contents");
const macosDir = join(contentsDir, "MacOS");
const resourcesDir = join(contentsDir, "Resources");

console.log(`Packaging ${binaryPath} -> ${appDir} (arch ${arch})`);
rmSync(appDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
mkdirSync(macosDir, { recursive: true });
mkdirSync(resourcesDir, { recursive: true });

// 1. The real server binary.
const serverDest = join(macosDir, "narrafork-server");
cpSync(binaryPath, serverDest);
chmodSync(serverDest, 0o755);

// 2. Compiled Mach-O launcher as CFBundleExecutable: an NSApplication living in
//    the menu bar and supervising the bundled server. A Mach-O (not a script) is
//    required for later Developer-ID signing/notarization of the whole bundle.
const launcherSrc = join(ROOT, "scripts/macos-app/launcher.m");
execFileSync(
	"clang",
	[
		"-O2",
		"-Wall",
		"-fobjc-arc",
		"-arch",
		arch,
		"-framework",
		"Cocoa",
		"-framework",
		"WebKit",
		"-o",
		join(macosDir, appName),
		launcherSrc,
	],
	{ stdio: "inherit" },
);

// 3. Info.plist
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>${appName}</string>
	<key>CFBundleIdentifier</key>
	<string>${bundleId}</string>
	<key>CFBundleName</key>
	<string>${appName}</string>
	<key>CFBundleDisplayName</key>
	<string>${appName}</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleShortVersionString</key>
	<string>${VERSION}</string>
	<key>CFBundleVersion</key>
	<string>${VERSION}</string>
	<key>CFBundleIconFile</key>
	<string>AppIcon</string>
	<key>CFBundleSupportedPlatforms</key>
	<array><string>MacOSX</string></array>
	<key>LSMinimumSystemVersion</key>
	<string>11.0</string>
	<key>LSApplicationCategoryType</key>
	<string>public.app-category.developer-tools</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSSupportsSuddenTermination</key>
	<false/>
</dict>
</plist>
`;
writeFileSync(join(contentsDir, "Info.plist"), plist);

// 4. Icon: PNG source -> .iconset -> AppIcon.icns (all slots; 1024 upscales the
//    512 source for the experiment — pass --icon with a 1024px render for release).
if (iconPath && existsSync(iconPath)) {
	const iconset = `${mkdtempSync(join(tmpdir(), "narrafork-iconset-"))}/App.iconset`;
	mkdirSync(iconset, { recursive: true });
	const slots: [string, number][] = [
		["icon_16x16.png", 16],
		["icon_16x16@2x.png", 32],
		["icon_32x32.png", 32],
		["icon_32x32@2x.png", 64],
		["icon_128x128.png", 128],
		["icon_128x128@2x.png", 256],
		["icon_256x256.png", 256],
		["icon_256x256@2x.png", 512],
		["icon_512x512.png", 512],
		["icon_512x512@2x.png", 1024],
	];
	for (const [name, px] of slots) {
		execFileSync("sips", ["-z", String(px), String(px), iconPath, "--out", join(iconset, name)], {
			stdio: "pipe",
		});
	}
	execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(resourcesDir, "AppIcon.icns")]);
	rmSync(join(iconset, ".."), { recursive: true, force: true });
} else {
	console.warn(iconPath ? `Icon source not found: ${iconPath} — skipping icon.` : "No icon set.");
}

// 5. Ad-hoc signature so a quarantined launch shows "unverified developer" instead
//    of a misleading "damaged" dialog. NOT a distribution signature — see doc.
if (wantSign) {
	try {
		execFileSync("codesign", ["--force", "--deep", "--sign", "-", appDir], { stdio: "pipe" });
	} catch (error) {
		console.warn(`codesign ad-hoc failed (non-fatal): ${String(error)}`);
	}
}

const appSize = execSync(`du -sm "${appDir}"`, { encoding: "utf-8" }).split("\t")[0].trim();
console.log(`Built ${appDir} (${appSize} MB)`);

// 6. Optional DMG: app + /Applications symlink for drag-install.
if (wantDmg) {
	const dmgPath = join(ROOT, "dist", `narrafork-${VERSION}-macos-${arch}.dmg`);
	const staging = mkdtempSync(join(tmpdir(), "narrafork-dmg-"));
	try {
		cpSync(appDir, join(staging, `${appName}.app`), { recursive: true, verbatimSymlinks: true });
		symlinkSync("/Applications", join(staging, "Applications"));
		rmSync(dmgPath, { force: true });
		execFileSync(
			"hdiutil",
			["create", "-volname", appName, "-srcfolder", staging, "-ov", "-format", "UDZO", dmgPath],
			{ stdio: "inherit" },
		);
		const mb = (statSync(dmgPath).size / 1024 / 1024).toFixed(1);
		console.log(`Built ${dmgPath} (${mb} MB)`);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

console.log(`Done. Try it:  open ${appDir}`);
