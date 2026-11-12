import type { ToolDefinitionSnapshot } from "../lib/agent/tool-loading";
import {
	freezePrefixValue,
	isPrefixToolsManifest,
	PREFIX_TOOLS_FORMAT,
	waitForPrefix,
} from "./narrator-prefix-snapshot-values";

interface ToolSnapshotPorts {
	putBatch(
		values: unknown[],
		signal?: AbortSignal,
	): Promise<Array<{ hash: string; byteSize: number }>>;
	getBatch(hashes: string[]): Promise<Array<{ json: ToolDefinitionSnapshot; byteSize: number }>>;
	putJson(value: unknown, signal?: AbortSignal): Promise<string>;
	readJson<T>(hash: string): Promise<T>;
	peek(hash: string, kind?: "json" | "tools"): unknown;
	remember(hash: string, value: unknown, byteSize: number, kind?: "json" | "tools"): Promise<void>;
	protect(hash: string): () => void;
	check(): void;
}

/** Each write assembles its own manifest; content-addressed storage deduplicates definitions. */
export function createPrefixToolSnapshots(ports: ToolSnapshotPorts) {
	const reads = new Map<
		string,
		{ promise: Promise<ToolDefinitionSnapshot[]>; users: Set<object> }
	>();
	async function put(
		definitions: readonly ToolDefinitionSnapshot[],
		signal?: AbortSignal,
	): Promise<string> {
		const check = () => {
			ports.check();
			signal?.throwIfAborted();
		};
		const release: Array<() => void> = [];
		const hashes: string[] = [];
		let batch: ToolDefinitionSnapshot[] = [];
		let bytes = 0;
		const flush = async () => {
			check();
			if (!batch.length) return;
			const written = await ports.putBatch(batch, signal);
			for (const item of written) {
				hashes.push(item.hash);
				release.push(ports.protect(item.hash));
			}
			batch = [];
			bytes = 0;
		};
		try {
			check();
			let slice = performance.now();
			for (const value of definitions) {
				check();
				if (
					!value ||
					typeof value.name !== "string" ||
					typeof value.description !== "string" ||
					!value.parameters ||
					typeof value.parameters !== "object"
				)
					throw new Error("Prefix tool definition is malformed");
				// Adopt once: later calls reuse only immutable measurement metadata, not write state.
				const size = await freezePrefixValue(value, check);
				// Soft transfer target: an individual oversized definition travels alone.
				if (batch.length && (batch.length === 64 || bytes + size > 512 * 1024)) await flush();
				batch.push(value);
				bytes += size;
				if (performance.now() - slice > 8) {
					await Bun.sleep(0);
					check();
					slice = performance.now();
				}
			}
			await flush();
			check();
			return await ports.putJson({ format: PREFIX_TOOLS_FORMAT, definitions: hashes }, signal);
		} finally {
			for (const done of release) done();
		}
	}
	async function read(hash: string, needed: () => boolean): Promise<ToolDefinitionSnapshot[]> {
		ports.check();
		if (!needed()) throw new Error("Prefix tool snapshot read cancelled");
		const existing = ports.peek(hash, "tools");
		if (existing) return existing as ToolDefinitionSnapshot[];
		const manifest = await ports.readJson<unknown>(hash);
		if (Array.isArray(manifest)) {
			await ports.remember(hash, manifest, 0, "tools");
			return manifest as ToolDefinitionSnapshot[]; // legacy arrays
		}
		if (!isPrefixToolsManifest(manifest)) throw new Error("Prefix tool manifest is malformed");
		const result: ToolDefinitionSnapshot[] = [];
		for (let offset = 0; offset < manifest.definitions.length; ) {
			ports.check();
			if (!needed()) throw new Error("Prefix tool snapshot read cancelled");
			const ready = ports.peek(manifest.definitions[offset]) as ToolDefinitionSnapshot | undefined;
			if (ready) {
				result.push(ready);
				offset++;
				continue;
			}
			const hashes = manifest.definitions.slice(offset, offset + 64);
			const loaded = await ports.getBatch(hashes);
			if (!loaded.length) throw new Error("Prefix tool batch is empty");
			for (let index = 0; index < loaded.length; index++) {
				const item = loaded[index];
				await ports.remember(hashes[index], item.json, item.byteSize);
				result.push(item.json);
			}
			offset += loaded.length;
		}
		if (!needed()) throw new Error("Prefix tool snapshot read cancelled");
		await ports.remember(hash, result, 0, "tools");
		return result;
	}
	return {
		putPrefixToolDefinitions: put,
		getPrefixToolDefinitions(hash: string, signal?: AbortSignal) {
			if (signal?.aborted) return Promise.reject<ToolDefinitionSnapshot[]>(signal.reason);
			const user = {};
			let task = reads.get(hash);
			if (!task) {
				const users = new Set<object>();
				const created = {
					users,
					promise: Promise.resolve().then(() => read(hash, () => users.size > 0)),
				};
				created.promise = created.promise.finally(() => {
					if (reads.get(hash) === created) reads.delete(hash);
				});
				reads.set(hash, created);
				task = created;
			}
			task.users.add(user);
			const current = task;
			return waitForPrefix(current.promise, signal).finally(() => {
				current.users.delete(user);
				if (!current.users.size && reads.get(hash) === current) reads.delete(hash);
			});
		},
	};
}
