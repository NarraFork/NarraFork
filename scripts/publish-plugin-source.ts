import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
	chmod,
	link,
	lstat,
	mkdir,
	mkdtemp,
	open,
	opendir,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
	openPublicPluginSourceRoot,
	PLUGIN_SOURCE_FEED_IDENTITY,
	PLUGIN_SOURCE_FEED_MARKER,
	pluginSourcePublicOrigin,
	readPublicSourceJson,
} from "../server/lib/plugins/source-feed";
import { PluginPackageStore } from "../server/services/plugin-package-store";
import { checkSbomInstallPolicy, parseSbom } from "../server/services/plugin-sbom";
import {
	PluginTrustKeyring,
	parsePluginSignature,
	verifyPluginPackageSignature,
} from "../server/services/plugin-signature";
import { hashPluginArchive } from "../server/services/plugin-source-download";
import { comparePluginVersions, sourceAbortable } from "../server/services/plugin-source-resolvers";
import {
	PLUGIN_UPDATE_MAX_ARCHIVE_BYTES,
	type PluginWebsiteUpdateResponse,
	pluginSourceIdSchema,
	pluginSourceVersionSchema,
	pluginWebsiteUpdateResponseSchema,
} from "../shared/plugin-source";

const trustedKeySchema = z
	.object({
		keyId: z.string().min(1).max(128),
		publicKey: z
			.string()
			.min(1)
			.max(16384)
			.refine((value) => !value.includes("PRIVATE KEY")),
		pluginIds: z.array(pluginSourceIdSchema).max(128).optional(),
		revokedAt: z.string().datetime().optional(),
	})
	.strict();
const keysSchema = z.array(trustedKeySchema).max(64);
const receiptSchema = z
	.object({
		pluginId: pluginSourceIdSchema,
		version: pluginSourceVersionSchema,
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
		size: z.number().int().positive().max(PLUGIN_UPDATE_MAX_ARCHIVE_BYTES),
		hostApi: z.string().min(1).max(128),
		os: z
			.array(z.enum(["win32", "linux", "darwin"]))
			.max(3)
			.optional(),
		arch: z
			.array(z.enum(["x64", "arm64", "ia32"]))
			.max(3)
			.optional(),
	})
	.strict();
const controlSchema = z
	.object({
		archive: z.string().min(1).max(4096),
		root: z.string().min(1).max(4096),
		receipt: z.string().min(1).max(4096),
		pluginId: pluginSourceIdSchema,
		version: pluginSourceVersionSchema.optional(),
		requireSignature: z.boolean(),
		keys: keysSchema,
	})
	.strict();

export interface PublishPluginSourceOptions {
	archive: string;
	root: string;
	pluginId: string;
	publicOrigin: string;
	version?: string;
	notes?: string;
	requireSignature?: boolean;
	keyring?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

async function ensurePublicRoot(path: string): Promise<string> {
	const root = resolve(path);
	try {
		await mkdir(root, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const info = await lstat(root);
	if (!info.isDirectory() || info.isSymbolicLink()) {
		throw new Error("Public release root must be a regular directory");
	}
	const actual = await realpath(root);
	const directory = await opendir(actual);
	let empty = false;
	try {
		empty = (await directory.read()) === null;
	} finally {
		await directory.close();
	}
	if (empty) {
		try {
			await writeFile(
				join(actual, PLUGIN_SOURCE_FEED_MARKER),
				JSON.stringify(PLUGIN_SOURCE_FEED_IDENTITY),
				{ flag: "wx", mode: 0o600 },
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	return openPublicPluginSourceRoot(actual);
}

async function readTrustJson(path: string): Promise<unknown | undefined> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const initial = await lstat(path);
		if (!initial.isFile() || initial.isSymbolicLink() || initial.size > 1024 * 1024)
			throw new Error("Invalid bounded trust metadata");
		handle = await open(path, "r");
		const info = await handle.stat();
		if (
			initial.ino !== info.ino ||
			initial.dev !== info.dev ||
			!info.isFile() ||
			info.size > 1024 * 1024
		)
			throw new Error("Trust metadata changed while opening");
		const bytes = new Uint8Array(1024 * 1024 + 1);
		let length = 0;
		while (length < bytes.length) {
			const read = await handle.read(bytes, length, bytes.length - length, length);
			if (!read.bytesRead) break;
			length += read.bytesRead;
		}
		if (length > 1024 * 1024) throw new Error("Trust metadata exceeded budget");
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	} finally {
		await handle?.close();
	}
}

async function copyPublicationArchive(
	source: string,
	target: string,
	signal: AbortSignal,
): Promise<void> {
	signal.throwIfAborted();
	const initial = await lstat(source);
	if (
		!initial.isFile() ||
		initial.isSymbolicLink() ||
		!initial.size ||
		initial.size > PLUGIN_UPDATE_MAX_ARCHIVE_BYTES
	) {
		throw new Error("Invalid bounded publication archive");
	}
	const handle = await open(source, "r");
	try {
		const opened = await handle.stat();
		if (
			!opened.isFile() ||
			opened.dev !== initial.dev ||
			opened.ino !== initial.ino ||
			opened.size !== initial.size
		) {
			throw new Error("Publication archive changed while opening");
		}
		let size = 0;
		const limiter = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				size += chunk.byteLength;
				if (size > initial.size)
					callback(new Error("Publication archive exceeded the captured byte budget"));
				else callback(null, chunk);
			},
		});
		await pipeline(
			handle.createReadStream({
				start: 0,
				end: initial.size,
				highWaterMark: 64 * 1024,
				autoClose: false,
			}),
			limiter,
			createWriteStream(target, { flags: "wx", mode: 0o600 }),
			{ signal },
		);
		if (size !== initial.size) throw new Error("Publication archive size changed while copying");
	} finally {
		await handle.close();
	}
}

async function archiveDigest(path: string): Promise<{ size: number; sha256: string }> {
	const hash = createHash("sha256");
	let size = 0;
	for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
		size += chunk.length;
		if (size > PLUGIN_UPDATE_MAX_ARCHIVE_BYTES)
			throw new Error("Archive exceeded publication budget");
		hash.update(chunk);
	}
	if (!size) throw new Error("Empty publication archive");
	return { size, sha256: hash.digest("hex") };
}

/** This static validation only runs in our isolated child, never the source HTTP thread. */
async function validateArchiveInChild(controlPath: string): Promise<void> {
	const raw = await readTrustJson(controlPath);
	const control = controlSchema.parse(raw);
	const digest = await archiveDigest(control.archive);
	const store = new PluginPackageStore({
		root: control.root,
		limits: {
			maxArchiveBytes: PLUGIN_UPDATE_MAX_ARCHIVE_BYTES,
			maxUnpackedBytes: 128 * 1024 * 1024,
			maxFileBytes: 50 * 1024 * 1024,
			maxFiles: 10000,
			timeoutMs: 60000,
		},
	});
	const installed = await store.install(control.archive, { updateCurrent: false });
	if (
		installed.pluginId !== control.pluginId ||
		(control.version && installed.version !== control.version)
	)
		throw new Error("Publication package identity mismatch");
	pluginSourceVersionSchema.parse(installed.version);
	const signatureRaw = await readTrustJson(join(installed.packagePath, "signature.json"));
	if (!signatureRaw && control.requireSignature)
		throw new Error("Publication signature is required");
	if (signatureRaw !== undefined) {
		const signature = parsePluginSignature(signatureRaw);
		if (signature.pluginId !== installed.pluginId || signature.version !== installed.version)
			throw new Error("Signature identity mismatch");
		const verification = await verifyPluginPackageSignature(
			installed.packagePath,
			signature,
			new PluginTrustKeyring(control.keys),
		);
		if (!verification.valid || !verification.trusted)
			throw new Error("Publication signature is invalid or untrusted");
	}
	const spdx = await readTrustJson(join(installed.packagePath, "sbom.spdx.json"));
	const sbom = spdx ?? (await readTrustJson(join(installed.packagePath, "sbom.cdx.json")));
	if (
		sbom !== undefined &&
		!checkSbomInstallPolicy(parseSbom(sbom), { maxComponents: 10000 }).allowed
	)
		throw new Error("Publication SBOM policy refused the package");
	const after = await archiveDigest(control.archive);
	if (after.sha256 !== digest.sha256 || after.size !== digest.size)
		throw new Error("Publication archive changed during validation");
	const receipt = receiptSchema.parse({
		pluginId: installed.pluginId,
		version: installed.version,
		...digest,
		hostApi: installed.manifest.engine.hostApi,
		os: installed.manifest.engine.os,
		arch: installed.manifest.engine.arch,
	});
	await writeFile(control.receipt, JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
}

async function consumeChildOutput(
	stream: ReadableStream<Uint8Array>,
	cancel: () => void,
): Promise<void> {
	const reader = stream.getReader();
	let size = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > 32 * 1024) {
				cancel();
				throw new Error("Publication validation output exceeded budget");
			}
		}
	} finally {
		reader.releaseLock();
	}
}

async function validateIsolated(
	controlPath: string,
	scratch: string,
	signal: AbortSignal,
): Promise<void> {
	signal.throwIfAborted();
	const child = Bun.spawn(
		[process.execPath, fileURLToPath(import.meta.url), "--internal-validation", controlPath],
		{
			cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
			env: { ...process.env, NARRAFORK_HOME: join(scratch, "home"), HOME: join(scratch, "home") },
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		},
	);
	const cancel = () => {
		try {
			child.kill();
		} catch {
			/* Only this owned child can be cancelled. */
		}
	};
	signal.addEventListener("abort", cancel, { once: true });
	try {
		const work = Promise.all([
			child.exited,
			consumeChildOutput(child.stdout, cancel),
			consumeChildOutput(child.stderr, cancel),
		]);
		const [exit] = await sourceAbortable(work, signal);
		if (exit !== 0) throw new Error("Plugin publication package validation failed");
	} finally {
		signal.removeEventListener("abort", cancel);
		cancel();
		await sourceAbortable(child.exited, AbortSignal.timeout(5000)).catch(() => {});
	}
}

export async function publishPluginSource(
	options: PublishPluginSourceOptions,
): Promise<PluginWebsiteUpdateResponse> {
	const pluginId = pluginSourceIdSchema.parse(options.pluginId);
	const origin = pluginSourcePublicOrigin(options.publicOrigin);
	if (options.version) pluginSourceVersionSchema.parse(options.version);
	if (options.notes && options.notes.length > 4096)
		throw new Error("Release notes exceeded budget");
	const timeout = AbortSignal.timeout(Math.min(120000, Math.max(1, options.timeoutMs ?? 120000)));
	const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
	signal.throwIfAborted();
	const root = await ensurePublicRoot(options.root);
	const lockPath = join(root, `.publish-${pluginId}.lock`);
	const lock = await open(lockPath, "wx", 0o600);
	let scratch: string | undefined;
	try {
		scratch = await mkdtemp(join(root, ".publish-"));
		const input = await lstat(options.archive);
		if (
			!input.isFile() ||
			input.isSymbolicLink() ||
			!input.size ||
			input.size > PLUGIN_UPDATE_MAX_ARCHIVE_BYTES
		)
			throw new Error("Invalid bounded publication archive");
		const archive = join(scratch, "archive.nfplugin");
		await copyPublicationArchive(options.archive, archive, signal);
		const copied = await lstat(archive);
		if (copied.size !== input.size || copied.size > PLUGIN_UPDATE_MAX_ARCHIVE_BYTES)
			throw new Error("Publication archive changed while copying");
		const keys = options.keyring ? keysSchema.parse(await readTrustJson(options.keyring)) : [];
		const receipt = join(scratch, "receipt.json");
		const controlPath = join(scratch, "control.json");
		const control = controlSchema.parse({
			archive,
			root: join(scratch, "validation"),
			receipt,
			pluginId,
			version: options.version,
			requireSignature: options.requireSignature ?? false,
			keys,
		});
		await writeFile(controlPath, JSON.stringify(control), { flag: "wx", mode: 0o600 });
		await validateIsolated(controlPath, scratch, signal);
		signal.throwIfAborted();
		const verified = receiptSchema.parse(await readPublicSourceJson(root, receipt));
		if (verified.version.split("+", 1)[0]?.includes("-"))
			throw new Error("Stable source publication cannot point to a prerelease");
		const pluginsPath = join(root, "plugins");
		const assetsPath = join(root, "assets");
		await mkdir(pluginsPath, { recursive: true });
		await mkdir(assetsPath, { recursive: true });
		for (const path of [pluginsPath, assetsPath]) {
			const info = await lstat(path);
			if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
				throw new Error("Public publication subdirectory is unsafe");
		}
		const pluginPath = join(pluginsPath, pluginId);
		await mkdir(pluginPath, { recursive: true });
		if ((await lstat(pluginPath)).isSymbolicLink())
			throw new Error("Public plugin directory is unsafe");
		const latestPath = join(pluginPath, "latest.json");
		const oldRaw = await readPublicSourceJson(root, latestPath);
		if (oldRaw !== undefined) {
			const previous = pluginWebsiteUpdateResponseSchema.parse(oldRaw);
			if (previous.pluginId !== pluginId) throw new Error("Published plugin identity mismatch");
			if (previous.latest) {
				const comparison = comparePluginVersions(verified.version, previous.latest.version);
				if (comparison < 0)
					throw new Error("Publication cannot downgrade the stable latest release");
				if (comparison === 0 && previous.latest.artifact.sha256 !== verified.sha256)
					throw new Error("A published version cannot change archive content");
			}
		}
		const asset = join(assetsPath, `${verified.sha256}.nfplugin`);
		try {
			await link(archive, asset);
			await chmod(asset, 0o644);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const existing = await lstat(asset);
			if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== verified.size) {
				throw new Error("Existing public asset is not a valid regular file");
			}
			const digest = await hashPluginArchive(asset, { signal });
			if (digest.sha256 !== verified.sha256 || digest.size !== verified.size)
				throw new Error("Existing public asset failed checksum validation");
		}
		const document = pluginWebsiteUpdateResponseSchema.parse({
			schemaVersion: 1,
			pluginId,
			latest: {
				version: verified.version,
				publishedAt: new Date().toISOString(),
				artifact: {
					url: `${origin}/assets/${verified.sha256}.nfplugin`,
					sha256: verified.sha256,
					size: verified.size,
				},
				compatibility: {
					hostApi: verified.hostApi,
					...(verified.os ? { os: verified.os } : {}),
					...(verified.arch ? { arch: verified.arch } : {}),
				},
				...(options.notes ? { notes: options.notes } : {}),
			},
		});
		const pending = join(pluginPath, `.latest-${crypto.randomUUID()}.json`);
		signal.throwIfAborted();
		try {
			await writeFile(pending, JSON.stringify(document), { flag: "wx", mode: 0o644 });
			signal.throwIfAborted();
			await rename(pending, latestPath);
		} finally {
			await rm(pending, { force: true });
		}
		return document;
	} finally {
		await lock.close();
		await rm(lockPath, { force: true });
		if (scratch) await rm(scratch, { recursive: true, force: true });
	}
}

export function parsePluginPublishArgs(args: string[]): PublishPluginSourceOptions {
	const values = new Map<string, string>();
	const allowed = new Set([
		"archive",
		"root",
		"plugin-id",
		"origin",
		"version",
		"notes",
		"keyring",
		"require-signature",
	]);
	for (const argument of args) {
		const match = /^--([a-z-]+)=(.+)$/.exec(argument);
		if (!match || !allowed.has(match[1] ?? "") || values.has(match[1] ?? ""))
			throw new Error("Invalid or duplicate plugin publication argument");
		values.set(match[1] ?? "", match[2] ?? "");
	}
	for (const key of ["archive", "root", "plugin-id", "origin"])
		if (!values.has(key)) throw new Error(`Missing --${key}`);
	const requireSignature = values.get("require-signature");
	if (requireSignature !== undefined && requireSignature !== "true" && requireSignature !== "false")
		throw new Error("Invalid signature requirement");
	return {
		archive: resolve(values.get("archive") ?? ""),
		root: resolve(values.get("root") ?? ""),
		pluginId: values.get("plugin-id") ?? "",
		publicOrigin: values.get("origin") ?? "",
		version: values.get("version"),
		notes: values.get("notes"),
		keyring: values.get("keyring"),
		requireSignature: requireSignature === "true",
	};
}

if (import.meta.main) {
	try {
		if (process.argv[2] === "--internal-validation" && process.argv.length === 4)
			await validateArchiveInChild(process.argv[3] ?? "");
		else
			console.info(
				JSON.stringify(await publishPluginSource(parsePluginPublishArgs(process.argv.slice(2)))),
			);
	} catch (error) {
		console.error(error instanceof Error ? error.message : "Plugin source publication failed");
		process.exitCode = 1;
	}
}
