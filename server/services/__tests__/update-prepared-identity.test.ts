import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { PreparedUpdateIdentity, UpdateSourceIdentity } from "../../../shared/update-identity";
import { settings } from "../../lib/settings";
import { APP_VERSION } from "../../lib/version";
import {
	getUpdateCoordinationStatus,
	resetUpdateCoordinationForTests,
	scheduleUpdate,
} from "../update-coordinator";
import {
	__resetVerifiedDigestCacheForTests,
	applyUpdate,
	getCurrentUpdateSourceIdentity,
	getUpdateDirectory,
	getUpdateStatus,
} from "../update-service";

const updateDir = getUpdateDirectory();
const metadataPath = join(updateDir, "placed-update.json");
const version = "77.0.0";
const originalSettings = structuredClone(settings.update);
const originalProxy = structuredClone(settings.proxy);
const source: UpdateSourceIdentity = {
	source: "github",
	repository: "fixture/original",
	channel: "stable",
	platform: "linux-x64",
};
const payload = Buffer.from("fixture executable bytes; never executed");

function writePrepared(
	options: { bytes?: Buffer; sourceIdentity?: UpdateSourceIdentity | null; fileName?: string } = {},
) {
	const bytes = options.bytes ?? payload;
	const fileName = options.fileName ?? `narrafork-${version}`;
	const updatePath = join(updateDir, fileName);
	const info = {
		version,
		fromVersion: APP_VERSION,
		fileName,
		updatePath,
		placed: false,
		placedAt: "2026-10-08T00:00:00.000Z",
		sha512: createHash("sha512").update(bytes).digest("base64"),
		sizeBytes: bytes.length,
		...(options.sourceIdentity === null
			? {}
			: { sourceIdentity: options.sourceIdentity ?? source }),
	};
	writeFileSync(updatePath, bytes);
	writeFileSync(metadataPath, JSON.stringify(info));
	return info;
}

async function preparedIdentity(): Promise<PreparedUpdateIdentity> {
	const status = await getUpdateStatus(version);
	expect(status.ready).toBe(true);
	expect(status.preparedIdentity).toBeDefined();
	if (!status.preparedIdentity) throw new Error("Verified artifact is missing prepared identity");
	expect(status.preparedIdentity.id).toMatch(/^[a-f0-9]{64}$/);
	return status.preparedIdentity;
}

function assertIsolatedUpdateDirectory() {
	const home = process.env.NARRAFORK_HOME;
	const child = home ? relative(home, updateDir) : "";
	if (
		process.env.NARRAFORK_TEST !== "1" ||
		!child ||
		isAbsolute(child) ||
		child === ".." ||
		child.startsWith(`..${sep}`)
	) {
		throw new Error("Prepared update tests require the isolated test preload home");
	}
}

beforeEach(() => {
	assertIsolatedUpdateDirectory();
	resetUpdateCoordinationForTests();
	__resetVerifiedDigestCacheForTests();
	rmSync(updateDir, { recursive: true, force: true });
	mkdirSync(updateDir, { recursive: true });
});
afterEach(() => {
	assertIsolatedUpdateDirectory();
	settings.update = structuredClone(originalSettings);
	settings.proxy = structuredClone(originalProxy);
	resetUpdateCoordinationForTests();
	__resetVerifiedDigestCacheForTests();
	rmSync(updateDir, { recursive: true, force: true });
});

describe("verified prepared update identity", () => {
	test.each([
		"github",
		"update-server",
	] as const)("%s proxy-only edits preserve source identity, prepared selector and scheduled operation", async (selectedSource) => {
		settings.proxy = { mode: "custom", url: "http://global.fixture.example:8080" };
		settings.update = {
			...originalSettings,
			source: selectedSource,
			githubRepository: "fixture/original",
			serverUrl: "https://updates.fixture.example",
			product: "narrafork",
			channel: "stable",
			checkIntervalMinutes: 60,
			autoDownload: false,
			proxy: { mode: "default" },
		};
		const sourceIdentity = getCurrentUpdateSourceIdentity();
		if (!sourceIdentity) throw new Error("Expected selected source identity");
		writePrepared({ sourceIdentity });
		const prepared = await preparedIdentity();
		const metadata = readFileSync(metadataPath, "utf8");
		const scheduled = scheduleUpdate(version);
		for (const proxy of [
			{ mode: "direct" as const },
			{ mode: "system" as const },
			{ mode: "custom" as const, url: "http://user:secret@dedicated.fixture.example:3128" },
			{ mode: "default" as const },
		]) {
			settings.update.proxy = proxy;
			settings.proxy = { mode: "custom", url: "http://changed-global.fixture.example:8081" };
			expect(getCurrentUpdateSourceIdentity()).toEqual(sourceIdentity);
			expect(await preparedIdentity()).toEqual(prepared);
			expect(readFileSync(metadataPath, "utf8")).toBe(metadata);
			expect(getUpdateCoordinationStatus()).toMatchObject({
				scheduled: true,
				updateEpoch: scheduled.updateEpoch,
				targetVersion: version,
			});
		}
	});

	test("ready status returns a stable identity bound to verified metadata", async () => {
		const info = writePrepared();
		const identity = await preparedIdentity();
		expect(identity).toEqual({
			id: expect.stringMatching(/^[a-f0-9]{64}$/),
			version,
			sha512: info.sha512,
			sizeBytes: payload.length,
			sourceIdentity: source,
		});
		expect(await preparedIdentity()).toEqual(identity);
	});

	test("same version with different bytes produces a different selector", async () => {
		writePrepared();
		const before = await preparedIdentity();
		writePrepared({ bytes: Buffer.from("different verified fixture payload") });
		const after = await preparedIdentity();
		expect(after.version).toBe(before.version);
		expect(after.sha512).not.toBe(before.sha512);
		expect(after.id).not.toBe(before.id);
	});

	test.each([
		{ ...source, repository: "fixture/other" },
		{ ...source, channel: "beta" as const },
		{ ...source, platform: "darwin-arm64" },
		{
			source: "update-server" as const,
			serverUrl: "https://updates.fixture.example",
			product: "narrafork",
			channel: "stable" as const,
			platform: "linux-x64",
		},
	])("same bytes from another effective source produce a different selector: %j", async (other) => {
		writePrepared();
		const before = await preparedIdentity();
		const info = JSON.parse(readFileSync(metadataPath, "utf8"));
		writeFileSync(metadataPath, JSON.stringify({ ...info, sourceIdentity: other }));
		const after = await preparedIdentity();
		expect(after.sha512).toBe(before.sha512);
		expect(after.id).not.toBe(before.id);
		expect(after.sourceIdentity).toEqual(other);
	});

	test("the actual local artifact location is part of the selector", async () => {
		writePrepared();
		const before = await preparedIdentity();
		writePrepared({ fileName: `narrafork-${version}-other` });
		const after = await preparedIdentity();
		expect(after.sha512).toBe(before.sha512);
		expect(after.id).not.toBe(before.id);
	});

	test("switching settings preserves the original artifact and its provenance", async () => {
		const info = writePrepared();
		const before = await preparedIdentity();
		const metadata = readFileSync(metadataPath, "utf8");
		const updateSettings = settings.update;
		if (!updateSettings) throw new Error("Expected isolated update settings");
		settings.update = {
			...updateSettings,
			source: "update-server",
			serverUrl: "https://other.fixture.example",
			product: "other-product",
			channel: "beta",
		};
		expect(await preparedIdentity()).toEqual(before);
		expect(existsSync(info.updatePath)).toBe(true);
		expect(readFileSync(metadataPath, "utf8")).toBe(metadata);
	});

	test("legacy metadata stays readable with stable unknown provenance, never current settings", async () => {
		writePrepared({ sourceIdentity: null });
		const before = await preparedIdentity();
		expect(before.sourceIdentity).toBeNull();
		const updateSettings = settings.update;
		if (!updateSettings) throw new Error("Expected isolated update settings");
		settings.update = {
			...updateSettings,
			source: "github",
			githubRepository: "fixture/not-the-original",
			channel: "beta",
		};
		expect(await preparedIdentity()).toEqual(before);
		expect(JSON.parse(readFileSync(metadataPath, "utf8")).sourceIdentity).toBeUndefined();
	});

	test("corrupt bytes never yield a ready identity", async () => {
		const info = writePrepared();
		writeFileSync(info.updatePath, Buffer.alloc(payload.length, 0));
		for (let poll = 0; poll < 2; poll++) {
			const status = await getUpdateStatus(version);
			expect(status.ready).toBe(false);
			expect(status.preparedIdentity).toBeUndefined();
		}
	});

	test("metadata replaced while hashing cannot publish the old ready identity", async () => {
		const info = writePrepared({ bytes: Buffer.alloc(1024 * 1024, 7) });
		const pending = getUpdateStatus(version);
		// getUpdateStatus has read metadata and yielded to the asynchronous file hash.
		writeFileSync(
			metadataPath,
			JSON.stringify({
				...info,
				sourceIdentity: { ...source, repository: "fixture/replaced-during-hash" },
			}),
		);
		const status = await pending;
		expect(status.ready).toBe(false);
		expect(status.preparedIdentity).toBeUndefined();
		expect((await preparedIdentity()).sourceIdentity).toEqual({
			...source,
			repository: "fixture/replaced-during-hash",
		});
	});
});

describe("prepared selector apply boundary (never starts a replacement)", () => {
	afterEach(() => {
		expect(getUpdateCoordinationStatus().scheduled).toBe(false);
	});

	test("version alone is rejected before the compiled-binary check", async () => {
		writePrepared();
		expect(await applyUpdate({ targetVersion: version })).toMatchObject({
			success: false,
			code: "PREPARED_UPDATE_IDENTITY_REQUIRED",
		});
	});

	test("an unknown selector is rejected before any restart scheduling", async () => {
		writePrepared();
		expect(await applyUpdate({ targetVersion: version, preparedId: "0".repeat(64) })).toMatchObject(
			{
				success: false,
				code: "PREPARED_UPDATE_CHANGED",
			},
		);
	});

	for (const change of ["hash", "source", "path"] as const) {
		test(`same-version ${change} replacement rejects the old selector`, async () => {
			writePrepared();
			const before = await preparedIdentity();
			writePrepared({
				...(change === "hash" ? { bytes: Buffer.from("replacement fixture") } : {}),
				...(change === "source"
					? { sourceIdentity: { ...source, repository: "fixture/replaced" } }
					: {}),
				...(change === "path" ? { fileName: `narrafork-${version}-replacement` } : {}),
			});
			expect(await applyUpdate({ targetVersion: version, preparedId: before.id })).toMatchObject({
				success: false,
				code: "PREPARED_UPDATE_CHANGED",
			});
		});
	}

	test("a verified current selector stops safely at the development-mode boundary", async () => {
		writePrepared();
		const identity = await preparedIdentity();
		expect(await applyUpdate({ targetVersion: version, preparedId: identity.id })).toMatchObject({
			success: false,
			code: "NOT_COMPILED_BINARY",
		});
	});

	test("metadata replacement during apply verification rejects the pending selection", async () => {
		const info = writePrepared({ bytes: Buffer.alloc(1024 * 1024, 8) });
		const identity = await preparedIdentity();
		__resetVerifiedDigestCacheForTests();
		const pending = applyUpdate({ targetVersion: version, preparedId: identity.id });
		writeFileSync(
			metadataPath,
			JSON.stringify({
				...info,
				sourceIdentity: { ...source, repository: "fixture/replaced-during-apply" },
			}),
		);
		expect(await pending).toMatchObject({ success: false, code: "PREPARED_UPDATE_CHANGED" });
	});
});
