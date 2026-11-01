// This worker must never import db/index: no bootstrap, migrations or main-thread DB handle.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { parentPort } from "node:worker_threads";
import { SQL } from "bun";
import {
	PrefixSnapshotCollector,
	type PrefixSnapshotGcOptions,
} from "./narrator-prefix-snapshot-gc";
import { isPrefixToolsManifest, PREFIX_TOOLS_FORMAT } from "./narrator-prefix-snapshot-values";

export type PrefixSnapshotBackend =
	| { backend: "sqlite"; path: string }
	| { backend: "postgres"; url: string };
export type PrefixSnapshotOperation =
	| "putText"
	| "getText"
	| "putJson"
	| "getJson"
	| "putJsonBatch"
	| "getJsonBatch"
	| "touch"
	| "lease"
	| "collect";
export interface PrefixSnapshotRequest {
	action: "task";
	backend: PrefixSnapshotBackend;
	operation: PrefixSnapshotOperation;
	value: unknown;
	cacheBytes: number;
	deadline: number;
}

/** Cache capacity is NOT a snapshot size limit. Oversized values simply bypass the cache. */
export class PrefixSnapshotCache {
	private entries = new Map<string, { text: string; bytes: number }>();
	private bytes = 0;
	constructor(private budget: number) {}
	get retainedBytes() {
		return this.bytes;
	}
	get size() {
		return this.entries.size;
	}
	get(hash: string): string | undefined {
		const entry = this.entries.get(hash);
		if (!entry) return;
		this.entries.delete(hash);
		this.entries.set(hash, entry);
		return entry.text;
	}
	set(hash: string, text: string, byteSize: number): void {
		const previous = this.entries.get(hash);
		if (previous) {
			this.bytes -= previous.bytes;
			this.entries.delete(hash);
		}
		// Charge UTF-16 backing storage as well as UTF-8 and bounded metadata per entry.
		const bytes = Math.max(byteSize, text.length * 2) + 256;
		if (bytes > this.budget) return;
		while (this.bytes + bytes > this.budget) {
			const oldest = this.entries.entries().next().value;
			if (!oldest) break;
			this.entries.delete(oldest[0]);
			this.bytes -= oldest[1].bytes;
		}
		this.entries.set(hash, { text, bytes });
		this.bytes += bytes;
	}
}

const port = parentPort;
let sqlite: Database | undefined;
let postgres: SQL | undefined;
let cache: PrefixSnapshotCache | undefined;
let collector: PrefixSnapshotCollector | undefined;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

async function connect(request: PrefixSnapshotRequest): Promise<void> {
	cache ??= new PrefixSnapshotCache(request.cacheBytes);
	if (request.backend.backend === "sqlite") {
		if (sqlite) return;
		if (!request.backend.path || request.backend.path === ":memory:")
			throw new Error("Prefix snapshots require a file-backed SQLite database");
		sqlite = new Database(request.backend.path, { readwrite: true, create: false });
		sqlite.run("PRAGMA busy_timeout = 50");
		sqlite.run("PRAGMA cache_size = -4096");
	} else if (!postgres) {
		postgres = new SQL(request.backend.url, { max: 1, connectTimeout: 5 });
		await postgres.unsafe("SET statement_timeout = '110s'");
		await postgres.unsafe("SET lock_timeout = '250ms'");
	}
}

async function query<T>(statement: string, parameters: Array<string | number>): Promise<T[]> {
	if (sqlite) return sqlite.query(statement).all(...parameters) as T[];
	if (!postgres) throw new Error("Prefix snapshot connection unavailable");
	let index = 0;
	return (await postgres.unsafe(
		statement.replace(/\?/g, () => `$${++index}`),
		parameters,
	)) as T[];
}

async function retry<T>(request: PrefixSnapshotRequest, action: () => Promise<T>): Promise<T> {
	let attempts = 0;
	while (Date.now() < request.deadline) {
		try {
			return await action();
		} catch (error) {
			const code = (error as { code?: string }).code;
			if (code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED" && code !== "55P03") throw error;
			await Bun.sleep(Math.min(250, 10 * 2 ** Math.min(attempts++, 5)));
		}
	}
	throw new Error("Prefix snapshot operation timed out");
}

async function execute(request: PrefixSnapshotRequest): Promise<unknown> {
	await connect(request);
	if (request.operation === "collect") {
		collector ??= new PrefixSnapshotCollector(query);
		const current = collector;
		const result = await retry(request, () =>
			current.step(request.value as PrefixSnapshotGcOptions),
		);
		if (result.deleted) cache = new PrefixSnapshotCache(request.cacheBytes);
		return result;
	}
	if (request.operation === "lease") {
		const roots = request.value as string[];
		const hashes = new Set(roots);
		for (const hash of roots) {
			const rows = await query<{ prefix: string }>(
				"SELECT substr(text, 1, 1) AS prefix FROM narrator_text_snapshots WHERE sha256 = ?",
				[hash],
			);
			if (!rows[0]) throw new Error("Prefix snapshot publication target is missing");
			if (/^[{\s]$/.test(rows[0].prefix)) {
				const [content] = await query<{ text: string }>(
					"SELECT text FROM narrator_text_snapshots WHERE sha256 = ?",
					[hash],
				);
				if (!content) throw new Error("Prefix snapshot publication target is missing");
				let manifest: unknown;
				try {
					manifest = JSON.parse(content.text);
				} catch {
					/* A text snapshot need not be JSON. */
				}
				if (
					manifest &&
					typeof manifest === "object" &&
					(manifest as { format?: unknown }).format === PREFIX_TOOLS_FORMAT
				) {
					if (!isPrefixToolsManifest(manifest))
						throw new Error("Prefix snapshot manifest is malformed");
					for (const child of manifest.definitions) hashes.add(child);
				}
			}
		}
		const all = [...hashes];
		for (let start = 0; start < all.length; start += 64) {
			const chunk = all.slice(start, start + 64);
			const touched = (await execute({
				...request,
				operation: "touch",
				value: chunk,
			})) as unknown[];
			if (touched.length !== chunk.length)
				throw new Error("Prefix snapshot publication child is missing");
		}
		return true;
	}
	if (request.operation === "touch") {
		const hashes = request.value as string[];
		if (!hashes.length) return [];
		return retry(request, () =>
			query<{ sha256: string }>(
				`UPDATE narrator_text_snapshots SET created_at = ? WHERE sha256 IN (${hashes.map(() => "?").join(",")}) RETURNING sha256`,
				[new Date().toISOString(), ...hashes],
			),
		);
	}
	if (request.operation === "putJsonBatch") {
		const values = request.value as unknown[];
		const entries = values.map((value) => {
			const text = JSON.stringify(value);
			if (typeof text !== "string") throw new Error("Prefix snapshot value is not JSON/text");
			return { text, hash: digest(text), byteSize: Buffer.byteLength(text) };
		});
		if (!entries.length) return [];
		const existing = await retry(request, () =>
			query<{ sha256: string }>(
				`SELECT sha256 FROM narrator_text_snapshots WHERE sha256 IN (${entries.map(() => "?").join(",")})`,
				entries.map((entry) => entry.hash),
			),
		);
		const present = new Set(existing.map((row) => row.sha256));
		const missing = entries.filter((entry) => !present.has(entry.hash));
		if (missing.length) {
			await retry(request, () =>
				query(
					`INSERT INTO narrator_text_snapshots (sha256, text, byte_size, created_at) VALUES ${missing.map(() => "(?, ?, ?, ?)").join(",")} ON CONFLICT (sha256) DO NOTHING`,
					missing.flatMap((entry) => [
						entry.hash,
						entry.text,
						entry.byteSize,
						new Date().toISOString(),
					]),
				),
			);
		}
		await execute({ ...request, operation: "touch", value: entries.map((entry) => entry.hash) });
		for (const entry of entries) cache?.set(entry.hash, entry.text, entry.byteSize);
		return entries.map(({ hash, byteSize }) => ({ hash, byteSize }));
	}
	if (request.operation === "getJsonBatch") {
		const hashes = request.value as string[];
		if (!hashes.length) return [];
		const metadata = await retry(request, () =>
			query<{ sha256: string; byte_size: number }>(
				`SELECT sha256, byte_size FROM narrator_text_snapshots WHERE sha256 IN (${hashes.map(() => "?").join(",")})`,
				hashes,
			),
		);
		const sizes = new Map(metadata.map((row) => [row.sha256, Number(row.byte_size)]));
		const selected: string[] = [];
		let bytes = 0;
		for (const hash of hashes) {
			const size = sizes.get(hash);
			if (size === undefined) throw new Error("Prefix snapshot not found");
			if (selected.length && bytes + size > 512 * 1024) break;
			bytes += size;
			selected.push(hash);
		}
		const rows = await retry(request, () =>
			query<{ sha256: string; text: string; byte_size: number }>(
				`SELECT sha256, text, byte_size FROM narrator_text_snapshots WHERE sha256 IN (${selected.map(() => "?").join(",")})`,
				selected,
			),
		);
		const decoded = new Map<string, { json: unknown; byteSize: number }>();
		for (const row of rows) {
			if (digest(row.text) !== row.sha256 || Buffer.byteLength(row.text) !== Number(row.byte_size))
				throw new Error("Prefix snapshot integrity mismatch");
			decoded.set(row.sha256, { json: JSON.parse(row.text), byteSize: Number(row.byte_size) });
		}
		return selected.map((hash) => {
			const value = decoded.get(hash);
			if (!value) throw new Error("Prefix snapshot not found");
			return value;
		});
	}
	if (request.operation === "putText" || request.operation === "putJson") {
		const text = request.operation === "putJson" ? JSON.stringify(request.value) : request.value;
		if (typeof text !== "string") throw new Error("Prefix snapshot value is not JSON/text");
		const hash = digest(text);
		const byteSize = Buffer.byteLength(text);
		// A tiny existence probe prevents rebinding a multi-MiB value for a duplicate put.
		if (
			!(
				await retry(request, () =>
					query("SELECT sha256 FROM narrator_text_snapshots WHERE sha256 = ?", [hash]),
				)
			).length
		) {
			await retry(request, () =>
				query(
					"INSERT INTO narrator_text_snapshots (sha256, text, byte_size, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (sha256) DO NOTHING",
					[hash, text, byteSize, new Date().toISOString()],
				),
			);
		}
		// created_at is also the durable publication-grace clock; content/hash never change.
		await execute({ ...request, operation: "touch", value: [hash] });
		cache?.set(hash, text, byteSize);
		return hash;
	}
	const hash = request.value;
	if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
		throw new Error("Prefix snapshot hash is invalid");
	let text = cache?.get(hash);
	if (text === undefined) {
		const rows = await retry(request, () =>
			query<{ text: string; byte_size: number }>(
				"SELECT text, byte_size FROM narrator_text_snapshots WHERE sha256 = ?",
				[hash],
			),
		);
		if (!rows[0]) throw new Error("Prefix snapshot not found");
		text = rows[0].text;
		if (digest(text) !== hash || Buffer.byteLength(text) !== Number(rows[0].byte_size))
			throw new Error("Prefix snapshot integrity mismatch");
		cache?.set(hash, text, Number(rows[0].byte_size));
	}
	return request.operation === "getJson"
		? { json: JSON.parse(text), byteSize: Buffer.byteLength(text) }
		: text;
}

// The client admits one task at a time, so PG awaits cannot introduce concurrent writes.
port?.on("message", async (request: PrefixSnapshotRequest | { action: "ping" }) => {
	if (request.action === "ping") {
		port.postMessage({ ready: true });
		return;
	}
	try {
		port.postMessage({ value: await execute(request) });
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		// SQL/driver failures can contain credentials or snapshot text; do not forward them.
		port.postMessage({
			error: message.startsWith("Prefix snapshot") ? message : "Prefix snapshot worker failed",
		});
	}
});
