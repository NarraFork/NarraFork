/**
 * Worker thread for post-processing a single platform binary.
 * Runs signing, SHA-512, zstd patch generation in an isolated thread
 * so multiple platforms can be processed in true parallelism.
 *
 * Communication: parentPort.postMessage({ type: "log" | "done", ... })
 */
import { createHash } from "node:crypto";
import {
	existsSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { workerData, parentPort } from "node:worker_threads";
import { generateZstdPatch } from "../server/lib/zstd-patch";
import {
	type BinaryMetadata,
	computeBinaryMetadata,
	formatMetadataJson,
} from "./lib/binary-metadata";

interface WorkerInput {
	platform: { target: string; platformId: string; name: string };
	distDir: string;
	root: string;
	version: string;
	commit: string;
}

const { platform, distDir, root, version, commit } = workerData as WorkerInput;

function log(message: string) {
	parentPort!.postMessage({ type: "log", message });
}

// ---------------------------------------------------------------------------
// Ad-hoc codesign (macOS)
// ---------------------------------------------------------------------------

function findRcodesign(): string | null {
	try {
		const check = Bun.spawnSync(["rcodesign", "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (check.exitCode === 0) return "rcodesign";
	} catch {}

	const localPath = join(homedir(), ".narrafork", "bin", "rcodesign");
	if (existsSync(localPath)) {
		try {
			const localCheck = Bun.spawnSync([localPath, "--version"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			if (localCheck.exitCode === 0) return localPath;
		} catch {}
	}

	return null;
}

function adHocSign(filePath: string): boolean {
	const rcodesign = findRcodesign();
	if (rcodesign) {
		const result = Bun.spawnSync([rcodesign, "sign", filePath], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode === 0) {
			log(`✓ Ad-hoc signed (rcodesign): ${relative(root, filePath)}`);
			return true;
		}
		const stderr = new TextDecoder().decode(result.stderr);
		log(`⚠ rcodesign failed: ${stderr.trim()}`);
	}

	if (process.platform === "darwin") {
		const result = Bun.spawnSync(["codesign", "--force", "--sign", "-", filePath], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode === 0) {
			log(`✓ Ad-hoc signed (codesign): ${relative(root, filePath)}`);
			return true;
		}
	}

	return false;
}

// ---------------------------------------------------------------------------
// Find previous version binary
// ---------------------------------------------------------------------------

function findPreviousVersionBinary(
	currentName: string,
	currentVersion: string,
): { path: string; version: string } | null {
	const versionedPrefix = `narrafork-${currentVersion}-`;
	if (!currentName.startsWith(versionedPrefix)) return null;
	const platformSuffix = currentName.slice(versionedPrefix.length);

	const candidates: { version: string; path: string }[] = [];
	const pattern = new RegExp(
		`^narrafork-(\\d+\\.\\d+\\.\\d+)-${platformSuffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
	);

	for (const name of readdirSync(distDir)) {
		const m = name.match(pattern);
		if (m && m[1] !== currentVersion) {
			candidates.push({ version: m[1], path: join(distDir, name) });
		}
	}

	if (candidates.length === 0) return null;

	candidates.sort((a, b) => {
		const pa = a.version.split(".").map(Number);
		const pb = b.version.split(".").map(Number);
		for (let i = 0; i < 3; i++) {
			if (pa[i] !== pb[i]) return pb[i] - pa[i];
		}
		return 0;
	});

	const currentParts = currentVersion.split(".").map(Number);
	for (const c of candidates) {
		const parts = c.version.split(".").map(Number);
		let isLess = false;
		for (let i = 0; i < 3; i++) {
			if (parts[i] < currentParts[i]) {
				isLess = true;
				break;
			}
			if (parts[i] > currentParts[i]) break;
		}
		if (isLess) return c;
	}

	return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const outfile = join(distDir, platform.name);
const buildDate = new Date().toISOString();

// 1. macOS signing (must happen before hashing so digests match the final file)
if (platform.target.includes("darwin")) {
	if (!adHocSign(outfile)) {
		log(
			`⚠ Ad-hoc signing failed — users may need to run: codesign --force --sign - ${relative(root, outfile)}`,
		);
	}
}

// 2. SHA-512 (kept for latest*.yml) + verifiable sidecar metadata
const fileSha512 = createHash("sha512").update(readFileSync(outfile)).digest("base64");
const fileSize = statSync(outfile).size;

let metadata: BinaryMetadata | undefined;
try {
	metadata = computeBinaryMetadata(outfile, {
		version,
		platformId: platform.platformId,
		target: platform.target,
		commit,
		buildDate,
	});
	const metadataPath = `${outfile}.metadata.json`;
	writeFileSync(metadataPath, formatMetadataJson(metadata));
	log(`✓ Metadata: ${relative(root, metadataPath)} (sha256 ${metadata.sha256.slice(0, 12)}…)`);
} catch (err) {
	const message = err instanceof Error ? err.message : String(err);
	log(`⚠ Metadata generation failed for ${platform.platformId}: ${message}`);
}

// 3. Zstd patch
const prevBinary = findPreviousVersionBinary(platform.name, version);
if (prevBinary) {
	log(`→ Generating zstd patch from ${relative(root, prevBinary.path)}...`);
	try {
		const oldBuf = readFileSync(prevBinary.path);
		const newBuf = readFileSync(outfile);

		const { patch, meta } = generateZstdPatch(oldBuf, newBuf, {
			fromVersion: prevBinary.version,
			toVersion: version,
		});

		const patchPath = `${outfile}.zstd-patch`;
		const metaPath = `${outfile}.zstd-patch.meta.json`;
		writeFileSync(patchPath, patch);
		writeFileSync(metaPath, JSON.stringify(meta, null, 2));

		const savings = ((1 - patch.length / newBuf.length) * 100).toFixed(1);
		log(
			`✓ Zstd patch: ${relative(root, patchPath)} (${(patch.length / 1024).toFixed(0)}KB, ${savings}% savings)`,
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log(`⚠ Zstd patch generation failed for ${platform.platformId}: ${message}`);
	}
} else {
	log("ℹ No previous version found for zstd patch generation");
}

// 4. Done — send latestYml back
function getLatestYmlName(target: string): string {
	if (target.includes("darwin")) return "latest-mac.yml";
	if (target.includes("windows")) return "latest.yml";
	return "latest-linux.yml";
}

const latestYml = {
	name: getLatestYmlName(platform.target),
	version,
	releaseDate: buildDate,
	file: { url: platform.name, size: fileSize, sha512: fileSha512 },
};

parentPort!.postMessage({ type: "done", latestYml, metadata });
