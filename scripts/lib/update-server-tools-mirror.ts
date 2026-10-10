import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rename, statfs, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	type DistributionLicense,
	HELPER_BINARY_MAX_BYTES,
	HELPER_MANIFEST_FILENAME,
	HELPER_MANIFEST_MAX_BYTES,
	parseExecutorReleaseManifest,
	parseHelperManifest,
} from "../../shared/helper-distribution";
import { compareReleaseVersions, isValidReleaseVersion } from "../../shared/release-version";
import { EXECUTOR_MANIFEST_FILENAME } from "../../shared/remote-executor";
import { parseExecutorManifest } from "../../shared/remote-executor-manifest";
import { hashReleaseFile } from "./ci-release-io";
import { helperFileIdentity, validateHelperReleaseBundle } from "./helper-release";
import {
	BridgeHttpError,
	type UpdateServerBridgeConfig,
	UpdateServerBridgeHttp,
} from "./update-server-bridge-http";

export const HELPER_MIRROR_STATE_FILENAME = "narrafork-helper-mirror-state-v1.json";
const SEAL_NAME = "tools-mirror-seal.json";
const RECEIPT_NAME = "tools-mirror-receipt.json";
const MAX_BUNDLE_BYTES = 640 * 1024 * 1024;
const RACE_WARNING =
	"Legacy tools API has no CAS or cross-publisher transaction; external publishers can race checks.";
type Kind = "helpers" | "executor";
type Identity = Pick<DistributionLicense, "size" | "sha256">;
interface SealedAsset extends DistributionLicense {
	maximum: number;
	observed: Identity | null;
	immutable: boolean;
}
interface ToolsSeal {
	schemaVersion: 1;
	kind: Kind;
	repo: string;
	tag: string;
	version: string;
	commit: string;
	serverUrl: string;
	protocolVersion: number;
	manifestSha256: string;
	sourceRunId: string | null;
	sourceRunAttempt: string | null;
	assets: SealedAsset[];
	control: SealedAsset;
}
export interface PreparedToolsMirror {
	kind: Kind;
	bridgeDir: string;
	bundleDir: string;
	sealPath: string;
	sealSha256: string;
	receiptPath: string;
}
export interface MirrorReceipt {
	schemaVersion: 1;
	kind: Kind;
	serverUrl: string;
	repo: string;
	tag: string;
	version: string;
	commit: string;
	sealSha256: string;
	status: "PREPARED" | "PUBLISHED_NOT_MIRRORED" | "MIRRORED";
	verified: string[];
	failedAsset: string | null;
	atomic: false;
	warning: string;
}
interface FixtureOptions {
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
	requestTimeoutMs?: number;
}
export interface PrepareToolsMirrorOptions extends FixtureOptions {
	kind: Kind;
	bundleDir: string;
	repo: string;
	version: string;
	commit: string;
	config: UpdateServerBridgeConfig;
	bridgeDir: string;
	protocolVersion?: number;
	sourceRunId?: string;
	sourceRunAttempt?: string;
}
export interface RestoreToolsMirrorOptions extends PrepareToolsMirrorOptions {
	/** Independent trust root from the digest-verified CI envelope, never the editable receipt. */
	trustedSealSha256: string;
}
interface HelperState {
	schemaVersion: 1;
	repository: string;
	tag: string;
	commit: string;
	catalogVersion: string;
	manifestSha256: string;
	files: DistributionLicense[];
}
function sha(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function same(a: Identity | null, b: Identity | null): boolean {
	return a === null || b === null ? a === b : a.size === b.size && a.sha256 === b.sha256;
}
function path(name: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(name) || name.includes(".."))
		throw new Error("Unsafe tools mirror filename");
	return `/api/v2/tools/${name}`;
}
function jsonBytes(value: unknown): Buffer {
	const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
	if (bytes.length > HELPER_MANIFEST_MAX_BYTES)
		throw new Error("Tools mirror metadata exceeds 64KiB");
	return bytes;
}
async function localJson(file: string): Promise<{ value: unknown; bytes: Buffer }> {
	await helperFileIdentity(file, HELPER_MANIFEST_MAX_BYTES);
	const bytes = await readFile(file);
	if (bytes.length > HELPER_MANIFEST_MAX_BYTES)
		throw new Error("Tools mirror metadata exceeds 64KiB");
	return { value: JSON.parse(bytes.toString("utf8")), bytes };
}
function keys(value: unknown, allowed: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid mirror state");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => !allowed.includes(key)))
		throw new Error("Unknown mirror state field");
	return record;
}
function parseIdentity(value: unknown): Identity {
	const record = keys(value, ["size", "sha256"]);
	if (
		!Number.isSafeInteger(record.size) ||
		(record.size as number) < 1 ||
		(record.size as number) > HELPER_BINARY_MAX_BYTES ||
		typeof record.sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(record.sha256)
	)
		throw new Error("Invalid mirror file identity");
	return { size: record.size as number, sha256: record.sha256 };
}
function parseHelperState(value: unknown): HelperState {
	const record = keys(value, [
		"schemaVersion",
		"repository",
		"tag",
		"commit",
		"catalogVersion",
		"manifestSha256",
		"files",
	]);
	if (
		record.schemaVersion !== 1 ||
		typeof record.repository !== "string" ||
		!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(record.repository) ||
		typeof record.catalogVersion !== "string" ||
		!isValidReleaseVersion(record.catalogVersion) ||
		record.tag !== `helpers-v${record.catalogVersion}` ||
		typeof record.commit !== "string" ||
		!/^[0-9a-f]{40}$/.test(record.commit) ||
		typeof record.manifestSha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(record.manifestSha256) ||
		!Array.isArray(record.files) ||
		record.files.length < 12 ||
		record.files.length > 44
	)
		throw new Error("Invalid helper mirror state");
	const files = record.files.map((value) => {
		const file = keys(value, ["name", "size", "sha256"]);
		if (typeof file.name !== "string") throw new Error("Invalid mirror filename");
		path(file.name);
		return { name: file.name, ...parseIdentity({ size: file.size, sha256: file.sha256 }) };
	});
	if (new Set(files.map((file) => file.name)).size !== files.length)
		throw new Error("Duplicate mirror file");
	return {
		schemaVersion: 1,
		repository: record.repository,
		tag: record.tag as string,
		commit: record.commit,
		catalogVersion: record.catalogVersion,
		manifestSha256: record.manifestSha256,
		files,
	};
}
async function remoteHash(
	http: UpdateServerBridgeHttp,
	name: string,
	maximum: number,
	signal?: AbortSignal,
): Promise<Identity | null> {
	try {
		const hash = await http.readHash(path(name), { maxBytes: maximum, signal });
		return { size: hash.size, sha256: hash.sha256 };
	} catch (error) {
		if (error instanceof BridgeHttpError && error.status === 404) return null;
		throw error;
	}
}
async function guardControl(
	http: UpdateServerBridgeHttp,
	seal: ToolsSeal,
	signal?: AbortSignal,
): Promise<void> {
	const value = await http.readJson<unknown>(path(seal.control.name), {
		maxBytes: HELPER_MANIFEST_MAX_BYTES,
		allowNotFound: true,
		signal,
	});
	if (value === undefined) {
		await assertAllowed(http, seal.control, signal);
		return;
	}
	if (seal.kind === "helpers") {
		const state = parseHelperState(value);
		const precedence = compareReleaseVersions(state.catalogVersion, seal.version);
		if (precedence > 0) throw new Error("Refusing helper catalog rollback");
		if (
			precedence === 0 &&
			(state.catalogVersion !== seal.version ||
				state.repository.toLowerCase() !== seal.repo.toLowerCase() ||
				state.tag !== seal.tag ||
				state.commit !== seal.commit ||
				state.manifestSha256 !== seal.manifestSha256 ||
				state.files.length !== seal.assets.length ||
				state.files.some(
					(file) => !seal.assets.some((asset) => asset.name === file.name && same(asset, file)),
				))
		)
			throw new Error("Conflicting helper catalog identity");
	} else {
		// Old clients expect the INNER manifest, never the GitHub wrapper.
		let manifest: ReturnType<typeof parseExecutorManifest>;
		try {
			manifest = parseExecutorManifest(value);
		} catch {
			throw new Error("Invalid legacy executor manifest");
		}
		const precedence = compareReleaseVersions(manifest.version, seal.version);
		if (precedence > 0) throw new Error("Refusing executor manifest rollback");
		if (precedence === 0) {
			const current = await remoteHash(http, seal.control.name, HELPER_MANIFEST_MAX_BYTES, signal);
			if (!same(current, seal.control))
				throw new Error("Same executor version has different manifest digest");
		}
	}
	await assertAllowed(http, seal.control, signal);
}
// Directory is runtime-only and cannot leak into the serialized provenance seal.
const sealDirectories = new WeakMap<ToolsSeal, string>();
function sealDirectory(seal: ToolsSeal): string {
	const directory = sealDirectories.get(seal);
	if (!directory) throw new Error("Missing tools mirror seal context");
	return directory;
}
async function assertAllowed(
	http: UpdateServerBridgeHttp,
	asset: SealedAsset,
	signal?: AbortSignal,
): Promise<boolean> {
	const current = await remoteHash(http, asset.name, asset.maximum, signal);
	if (same(current, asset)) return true;
	if (!same(current, asset.observed) || (asset.immutable && current !== null))
		throw new Error(`Unknown tools alias change: ${asset.name}`);
	return false;
}
async function preflight(
	http: UpdateServerBridgeHttp,
	seal: ToolsSeal,
	signal?: AbortSignal,
): Promise<void> {
	await guardControl(http, seal, signal);
	for (const asset of seal.assets) await assertAllowed(http, asset, signal);
}
function receipt(
	seal: ToolsSeal,
	sealSha256: string,
	status: MirrorReceipt["status"],
	verified: string[] = [],
	failedAsset: string | null = null,
): MirrorReceipt {
	return {
		schemaVersion: 1,
		kind: seal.kind,
		serverUrl: seal.serverUrl,
		repo: seal.repo,
		tag: seal.tag,
		version: seal.version,
		commit: seal.commit,
		sealSha256,
		status,
		verified,
		failedAsset,
		atomic: false,
		warning: RACE_WARNING,
	};
}
async function saveReceipt(prepared: PreparedToolsMirror, value: MirrorReceipt): Promise<void> {
	const temporary = `${prepared.receiptPath}.${randomUUID()}.part`;
	await writeFile(temporary, jsonBytes(value), { flag: "wx", mode: 0o600 });
	await rename(temporary, prepared.receiptPath);
}
function prepared(
	directory: string,
	bundle: string,
	kind: Kind,
	sealSha256: string,
): PreparedToolsMirror {
	return {
		kind,
		bridgeDir: directory,
		bundleDir: resolve(bundle),
		sealPath: join(directory, SEAL_NAME),
		sealSha256,
		receiptPath: join(directory, RECEIPT_NAME),
	};
}

function deriveToolsControl(
	options: Pick<PrepareToolsMirrorOptions, "kind" | "repo" | "version" | "commit"> & {
		protocolVersion: number;
	},
	source: { value: unknown; bytes: Buffer },
): { name: string; bytes: Buffer; files: DistributionLicense[]; tag: string; version: string } {
	const identity = { repository: options.repo, commit: options.commit };
	if (options.kind === "helpers") {
		const manifest = parseHelperManifest(source.value, identity);
		if (options.version !== manifest.catalogVersion)
			throw new Error("Helper catalog version mismatch");
		const files = [...manifest.files, ...manifest.licenses].map(({ name, size, sha256 }) => ({
			name,
			size,
			sha256,
		}));
		return {
			name: HELPER_MIRROR_STATE_FILENAME,
			files,
			tag: manifest.tag,
			version: manifest.catalogVersion,
			bytes: jsonBytes({
				schemaVersion: 1,
				repository: manifest.repository,
				tag: manifest.tag,
				commit: manifest.commit,
				catalogVersion: manifest.catalogVersion,
				manifestSha256: sha(source.bytes),
				files,
			}),
		};
	}
	const outer = parseExecutorReleaseManifest(source.value, {
		...identity,
		version: options.version,
		protocolVersion: options.protocolVersion,
	});
	return {
		name: EXECUTOR_MANIFEST_FILENAME,
		bytes: jsonBytes(outer.manifest),
		tag: outer.tag,
		version: outer.manifest.version,
		files: [
			...Object.values(outer.manifest.platforms).map(({ filename, size, sha256 }) => ({
				name: filename,
				size,
				sha256,
			})),
			...outer.licenses,
		],
	};
}

/** Validate projected controls against the original source, not self-consistent edited metadata. */
async function verifyOriginalToolsSource(
	value: PreparedToolsMirror,
	seal: ToolsSeal,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	const description = await validateHelperReleaseBundle({
		repository: seal.repo,
		kind: seal.kind,
		version: seal.version,
		commit: seal.commit,
		protocolVersion: seal.protocolVersion,
		bundleDir: value.bundleDir,
		signal,
	});
	const manifestName =
		seal.kind === "helpers" ? HELPER_MANIFEST_FILENAME : EXECUTOR_MANIFEST_FILENAME;
	const source = await localJson(join(value.bundleDir, manifestName));
	const derived = deriveToolsControl(seal, source);
	if (
		sha(source.bytes) !== seal.manifestSha256 ||
		description.tag !== seal.tag ||
		derived.tag !== seal.tag ||
		derived.version !== seal.version ||
		derived.files.length !== seal.assets.length ||
		seal.assets.some(
			(asset) => !derived.files.some((file) => file.name === asset.name && same(file, asset)),
		)
	)
		throw new Error("Tools mirror recovery source changed");
	if (
		derived.name !== seal.control.name ||
		!same({ size: derived.bytes.length, sha256: sha(derived.bytes) }, seal.control)
	)
		throw new Error("Tools mirror control does not match original manifest projection");
	signal?.throwIfAborted();
}

/** All local bytes and ALL remote aliases are checked before the first PUT. */
export async function prepareUpdateServerToolsMirror(
	options: PrepareToolsMirrorOptions,
): Promise<PreparedToolsMirror> {
	const http = new UpdateServerBridgeHttp(options.config, options);
	if (
		(options.kind !== "helpers" && options.kind !== "executor") ||
		!isValidReleaseVersion(options.version)
	)
		throw new Error("Invalid tools mirror release identity");
	if (
		[options.sourceRunId, options.sourceRunAttempt].some(
			(value) => value !== undefined && !/^[1-9]\d{0,19}$/.test(value),
		)
	)
		throw new Error("Invalid tools mirror source run identity");
	const signal = options.signal
		? AbortSignal.any([options.signal, AbortSignal.timeout(30 * 60_000)])
		: AbortSignal.timeout(30 * 60_000);
	signal.throwIfAborted();
	const protocolVersion = options.protocolVersion ?? 1;
	const description = await validateHelperReleaseBundle({
		kind: options.kind,
		repository: options.repo,
		version: options.version,
		protocolVersion,
		commit: options.commit,
		bundleDir: options.bundleDir,
		signal,
	});
	const manifestName =
		options.kind === "helpers" ? HELPER_MANIFEST_FILENAME : EXECUTOR_MANIFEST_FILENAME;
	const source = await localJson(join(options.bundleDir, manifestName));
	const manifestSha256 = sha(source.bytes);
	const {
		version,
		name: controlName,
		bytes: controlBytes,
		files,
	} = deriveToolsControl({ ...options, protocolVersion }, source);
	const directory = resolve(options.bridgeDir);
	if (
		directory === resolve(options.bundleDir) ||
		directory.startsWith(`${resolve(options.bundleDir)}/`)
	)
		throw new Error("Tools bridge directory must be separate from source bundle");
	await mkdir(directory, { recursive: true });
	const existing = await lstat(directory);
	if (!existing.isDirectory() || existing.isSymbolicLink())
		throw new Error("Invalid tools bridge directory");
	const disk = await statfs(directory);
	const total = files.reduce((sum, file) => sum + file.size, 0);
	if (total > MAX_BUNDLE_BYTES || disk.bavail * disk.bsize < total + 64 * 1024 * 1024)
		throw new Error("Tools mirror disk budget exceeded");
	await mkdir(join(directory, "assets")); // exclusive preparation: never re-observe after partial writes
	const assetDir = join(directory, "assets");
	const assets: SealedAsset[] = [];
	for (const file of files) {
		signal.throwIfAborted();
		path(file.name);
		const maximum = file.name.endsWith(".txt")
			? HELPER_MANIFEST_MAX_BYTES
			: HELPER_BINARY_MAX_BYTES;
		await copyFile(
			join(options.bundleDir, file.name),
			join(assetDir, file.name),
			constants.COPYFILE_EXCL,
		);
		const frozen = await hashReleaseFile(join(assetDir, file.name), maximum, signal);
		if (!same(file, frozen)) throw new Error("Frozen tools mirror asset digest mismatch");
		assets.push({
			...file,
			maximum,
			observed: await remoteHash(http, file.name, maximum, signal),
			immutable: options.kind === "executor" && file.name.startsWith("narrafork-executor-"),
		});
	}
	await writeFile(join(assetDir, controlName), controlBytes, { flag: "wx", mode: 0o600 });
	const seal: ToolsSeal = {
		schemaVersion: 1,
		kind: options.kind,
		repo: options.repo,
		tag: description.tag,
		version,
		commit: options.commit,
		serverUrl: http.serverUrl,
		protocolVersion,
		manifestSha256,
		sourceRunId: options.sourceRunId ?? null,
		sourceRunAttempt: options.sourceRunAttempt ?? null,
		assets,
		control: {
			name: controlName,
			size: controlBytes.length,
			sha256: sha(controlBytes),
			maximum: HELPER_MANIFEST_MAX_BYTES,
			observed: await remoteHash(http, controlName, HELPER_MANIFEST_MAX_BYTES, signal),
			immutable: false,
		},
	};
	sealDirectories.set(seal, assetDir);
	await preflight(http, seal, signal);
	// Existing helper receipt owns all recorded aliases; drift is not a new takeover.
	if (options.kind === "helpers") {
		const old = await http.readJson<unknown>(path(controlName), {
			maxBytes: HELPER_MANIFEST_MAX_BYTES,
			allowNotFound: true,
			signal,
		});
		if (old !== undefined) {
			for (const file of parseHelperState(old).files) {
				const current = await remoteHash(
					http,
					file.name,
					file.name.endsWith(".txt") ? HELPER_MANIFEST_MAX_BYTES : HELPER_BINARY_MAX_BYTES,
					signal,
				);
				if (!same(current, file)) throw new Error("Recorded helper alias drift");
			}
		}
	}
	const sealBytes = jsonBytes(seal);
	await writeFile(join(directory, SEAL_NAME), sealBytes, { flag: "wx", mode: 0o600 });
	const result = prepared(directory, options.bundleDir, options.kind, sha(sealBytes));
	await saveReceipt(result, receipt(seal, result.sealSha256, "PREPARED"));
	return result;
}

async function loadSeal(
	value: PreparedToolsMirror,
	config: UpdateServerBridgeConfig,
	signal?: AbortSignal,
): Promise<ToolsSeal> {
	signal?.throwIfAborted();
	const http = new UpdateServerBridgeHttp(config);
	if (
		value.sealPath !== join(resolve(value.bridgeDir), SEAL_NAME) ||
		value.receiptPath !== join(resolve(value.bridgeDir), RECEIPT_NAME)
	)
		throw new Error("Tools mirror sealed paths changed");
	const raw = await localJson(value.sealPath);
	if (sha(raw.bytes) !== value.sealSha256) throw new Error("Tools mirror seal digest mismatch");
	keys(raw.value, [
		"schemaVersion",
		"kind",
		"repo",
		"tag",
		"version",
		"commit",
		"serverUrl",
		"protocolVersion",
		"manifestSha256",
		"sourceRunId",
		"sourceRunAttempt",
		"assets",
		"control",
	]);
	const seal = raw.value as ToolsSeal;
	if (
		!isValidReleaseVersion(seal.version) ||
		typeof seal.repo !== "string" ||
		!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(seal.repo) ||
		typeof seal.commit !== "string" ||
		!/^[0-9a-f]{40}$/.test(seal.commit) ||
		typeof seal.manifestSha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(seal.manifestSha256) ||
		seal.tag !== `${seal.kind === "helpers" ? "helpers" : "executor"}-v${seal.version}` ||
		!Number.isSafeInteger(seal.protocolVersion) ||
		seal.protocolVersion < 1 ||
		[seal.sourceRunId, seal.sourceRunAttempt].some(
			(id) => id !== null && (typeof id !== "string" || !/^[1-9]\d{0,19}$/.test(id)),
		) ||
		seal.schemaVersion !== 1 ||
		seal.kind !== value.kind ||
		seal.serverUrl !== http.serverUrl ||
		!Array.isArray(seal.assets) ||
		seal.assets.length < 1 ||
		seal.assets.length > 44 ||
		seal.control?.name !==
			(seal.kind === "helpers" ? HELPER_MIRROR_STATE_FILENAME : EXECUTOR_MANIFEST_FILENAME)
	)
		throw new Error("Tools mirror seal identity mismatch");
	sealDirectories.set(seal, join(value.bridgeDir, "assets"));
	if (
		new Set([...seal.assets, seal.control].map((asset) => asset.name)).size !==
		seal.assets.length + 1
	)
		throw new Error("Duplicate sealed tools asset");
	for (const asset of [...seal.assets, seal.control]) {
		signal?.throwIfAborted();
		keys(asset, ["name", "size", "sha256", "maximum", "observed", "immutable"]);
		parseIdentity({ size: asset.size, sha256: asset.sha256 });
		if (asset.observed !== null) parseIdentity(asset.observed);
		if (
			asset.immutable !==
			(seal.kind === "executor" &&
				asset !== seal.control &&
				asset.name.startsWith("narrafork-executor-"))
		)
			throw new Error("Tools mirror immutable asset flag changed");
		path(asset.name);
		const expectedMaximum =
			asset === seal.control || asset.name.endsWith(".txt")
				? HELPER_MANIFEST_MAX_BYTES
				: HELPER_BINARY_MAX_BYTES;
		if (
			asset.maximum !== expectedMaximum ||
			!same(
				asset,
				await hashReleaseFile(join(sealDirectory(seal), asset.name), asset.maximum, signal),
			)
		)
			throw new Error("Tools mirror frozen asset changed");
	}
	await verifyOriginalToolsSource(value, seal, signal);
	return seal;
}

/** Fixed-alias marker is always last; failures seal the exact partial work, never rollback. */
export async function publishUpdateServerToolsMirror(
	value: PreparedToolsMirror,
	config: UpdateServerBridgeConfig,
	options: FixtureOptions = {},
): Promise<MirrorReceipt> {
	const signal = options.signal
		? AbortSignal.any([options.signal, AbortSignal.timeout(30 * 60_000)])
		: AbortSignal.timeout(30 * 60_000);
	const seal = await loadSeal(value, config, signal);
	const http = new UpdateServerBridgeHttp(config, options);
	const verified: string[] = [];
	let failedAsset: string | null = null;
	try {
		await preflight(http, seal, signal);
		for (const asset of [...seal.assets, seal.control]) {
			failedAsset = asset.name;
			await guardControl(http, seal, signal);
			if (asset === seal.control) {
				for (const binary of seal.assets) {
					if (!same(await remoteHash(http, binary.name, binary.maximum, signal), binary))
						throw new Error("Tools asset drift before manifest switch");
				}
			}
			if (!(await assertAllowed(http, asset, signal))) {
				const frozen = await hashReleaseFile(
					join(sealDirectory(seal), asset.name),
					asset.maximum,
					signal,
				);
				if (!same(asset, frozen))
					throw new Error("Tools mirror frozen asset changed before upload");
				const result = await http.put(path(asset.name), join(sealDirectory(seal), asset.name), {
					maxBytes: asset.maximum,
					signal,
					expected: { size: asset.size, sha256: asset.sha256, sha512: frozen.sha512 },
				});
				const record = result as {
					success?: unknown;
					filename?: unknown;
					size?: unknown;
					sha512?: unknown;
				};
				if (
					record?.success !== true ||
					record.filename !== asset.name ||
					record.size !== asset.size ||
					typeof record.sha512 !== "string"
				)
					throw new Error("Invalid legacy tools upload acknowledgement");
			}
			if (!same(await remoteHash(http, asset.name, asset.maximum, signal), asset))
				throw new Error("Legacy tools upload readback mismatch");
			verified.push(asset.name);
			await saveReceipt(value, receipt(seal, value.sealSha256, "PUBLISHED_NOT_MIRRORED", verified));
		}
		// A final all-alias read detects post-switch drift without claiming CAS.
		for (const asset of [...seal.assets, seal.control]) {
			failedAsset = asset.name;
			if (!same(await remoteHash(http, asset.name, asset.maximum, signal), asset))
				throw new Error("Legacy tools final readback mismatch");
		}
		const result = receipt(seal, value.sealSha256, "MIRRORED", verified);
		await saveReceipt(value, result);
		return result;
	} catch {
		await saveReceipt(
			value,
			receipt(seal, value.sealSha256, "PUBLISHED_NOT_MIRRORED", verified, failedAsset),
		);
		throw new Error(
			"PUBLISHED_NOT_MIRRORED: tools mirror failed; restore the original sealed bridge artifact (no CAS)",
		);
	}
}

/** Restore the original seal only: no source selection, endpoint substitution or fresh snapshots. */
export async function restoreUpdateServerToolsMirror(
	options: RestoreToolsMirrorOptions,
): Promise<PreparedToolsMirror> {
	const signal = options.signal
		? AbortSignal.any([options.signal, AbortSignal.timeout(30 * 60_000)])
		: AbortSignal.timeout(30 * 60_000);
	signal.throwIfAborted();
	if (
		typeof options.trustedSealSha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(options.trustedSealSha256)
	)
		throw new Error("Tools mirror recovery requires an independent trusted seal SHA-256");
	const directory = resolve(options.bridgeDir);
	const saved = (await localJson(join(directory, RECEIPT_NAME))).value as MirrorReceipt;
	if (
		saved.schemaVersion !== 1 ||
		saved.kind !== options.kind ||
		saved.repo !== options.repo ||
		saved.version !== options.version ||
		saved.commit !== options.commit ||
		saved.sealSha256 !== options.trustedSealSha256
	)
		throw new Error("Tools mirror recovery receipt identity or trusted digest mismatch");
	const result = prepared(directory, options.bundleDir, options.kind, options.trustedSealSha256);
	const seal = await loadSeal(result, options.config, signal);
	if (
		seal.repo !== options.repo ||
		seal.version !== options.version ||
		seal.commit !== options.commit ||
		seal.tag !== saved.tag ||
		saved.serverUrl !== seal.serverUrl ||
		(options.protocolVersion !== undefined && seal.protocolVersion !== options.protocolVersion) ||
		(options.sourceRunId !== undefined && seal.sourceRunId !== options.sourceRunId) ||
		(options.sourceRunAttempt !== undefined && seal.sourceRunAttempt !== options.sourceRunAttempt)
	)
		throw new Error("Tools mirror recovery sealed identity mismatch");
	await preflight(new UpdateServerBridgeHttp(options.config, options), seal, signal);
	return result;
}
