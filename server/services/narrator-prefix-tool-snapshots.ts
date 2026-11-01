import type { ToolDefinitionSnapshot } from "../lib/agent/tool-loading";
import {
	freezePrefixValue,
	isPrefixToolsManifest,
	PREFIX_TOOLS_FORMAT,
	waitForPrefix,
} from "./narrator-prefix-snapshot-values";

interface ToolSnapshotPorts {
	putBatch(values: unknown[]): Promise<Array<{ hash: string; byteSize: number }>>;
	getBatch(hashes: string[]): Promise<Array<{ json: ToolDefinitionSnapshot; byteSize: number }>>;
	putJson(value: unknown): Promise<string>;
	readJson<T>(hash: string): Promise<T>;
	peek(hash: string): unknown;
	remember(hash: string, value: unknown, byteSize: number): Promise<void>;
	touch(hashes: string[]): Promise<string[]>;
	protect(hash: string): () => void;
	check(): void;
}

/** Static definitions are versioned by immutable parameters identity + name/description. */
export function createPrefixToolSnapshots(ports: ToolSnapshotPorts) {
	type Unit = {
		id: number;
		value: ToolDefinitionSnapshot;
		hash: Promise<string>;
		users: Set<object>;
		failed: boolean;
	};
	let sequence = 0;
	const byParameters = new WeakMap<object, Map<string, Unit>>();
	const byObject = new WeakMap<object, Unit>();
	const catalogs = new Map<string, { promise: Promise<string>; until: number; bytes: number }>();
	let catalogBytes = 0;
	const decoded = new Map<string, WeakRef<ToolDefinitionSnapshot[]>>();
	const reads = new Map<
		string,
		{ promise: Promise<ToolDefinitionSnapshot[]>; users: Set<object> }
	>();
	type Pending = {
		value: ToolDefinitionSnapshot;
		bytes: number;
		needed: () => boolean;
		resolve: (hash: string) => void;
		reject: (error: unknown) => void;
	};
	const writes: Pending[] = [];
	let flushing = false;
	async function flush() {
		if (flushing) return;
		flushing = true;
		try {
			while (writes.length) {
				let bytes = 0;
				let count = 0;
				while (count < Math.min(64, writes.length)) {
					const next = writes[count].bytes;
					if (count && bytes + next > 512 * 1024) break;
					bytes += next;
					count++;
				}
				const batch = writes.splice(0, count).filter((item) => {
					if (item.needed()) return true;
					item.reject(new Error("Prefix tool snapshot preparation cancelled"));
					return false;
				});
				if (!batch.length) continue;
				try {
					ports.check();
					const result = await ports.putBatch(batch.map((item) => item.value));
					for (let index = 0; index < batch.length; index++)
						batch[index].resolve(result[index].hash);
				} catch (error) {
					for (const item of batch) item.reject(error);
				}
			}
		} finally {
			flushing = false;
		}
	}
	function write(
		value: ToolDefinitionSnapshot,
		needed: () => boolean = () => true,
	): Promise<string> {
		return freezePrefixValue(value, () => {
			ports.check();
			if (!needed()) throw new Error("Prefix tool snapshot preparation cancelled");
		}).then(
			(bytes) =>
				new Promise<string>((resolve, reject) => {
					writes.push({
						value,
						needed,
						bytes: Math.max(bytes, value.description.length * 2 + 256),
						resolve,
						reject,
					});
					queueMicrotask(() => {
						void flush();
					});
				}),
		);
	}
	function unit(value: ToolDefinitionSnapshot, user: object): Unit {
		const known = byObject.get(value);
		if (known && !known.failed) {
			known.users.add(user);
			return known;
		}
		if (
			!value ||
			typeof value.name !== "string" ||
			typeof value.description !== "string" ||
			!value.parameters ||
			typeof value.parameters !== "object"
		)
			throw new Error("Prefix tool definition is malformed");
		// The API accepts snapshots, not mutable tool registrations. Freeze on adoption.
		Object.freeze(value);
		let versions = byParameters.get(value.parameters);
		if (!versions) {
			versions = new Map();
			byParameters.set(value.parameters, versions);
		}
		const previous = versions.get(value.name);
		if (previous && !previous.failed && previous.value.description === value.description) {
			previous.users.add(user);
			byObject.set(value, previous);
			return previous;
		}
		const users = new Set([user]);
		const current: Unit = {
			id: ++sequence,
			value,
			users,
			failed: false,
			hash: write(value, () => users.size > 0),
		};
		// Ensure a cancelled caller cannot leave a queued worker rejection unhandled.
		void current.hash.catch(() => {
			current.failed = true;
			if (byObject.get(value) === current) byObject.delete(value);
			if (versions.get(value.name) === current) versions.delete(value.name);
		});
		versions.set(value.name, current);
		byObject.set(value, current);
		return current;
	}
	async function put(
		definitions: readonly ToolDefinitionSnapshot[],
		units: Unit[],
		user: object,
		signal?: AbortSignal,
	): Promise<string> {
		ports.check();
		signal?.throwIfAborted();
		let slice = performance.now();
		for (const value of definitions) {
			signal?.throwIfAborted();
			units.push(unit(value, user));
			if (performance.now() - slice > 8) {
				await Bun.sleep(0);
				ports.check();
				slice = performance.now();
			}
		}
		// Only small numeric identities, never descriptions/schema text, form this cache key.
		const key = units.map((item) => item.id).join(",");
		const known = catalogs.get(key);
		if (known && known.until > Date.now()) return known.promise;
		if (known) {
			catalogBytes -= known.bytes;
			catalogs.delete(key);
		}
		const promise = (async () => {
			const release: Array<() => void> = [];
			try {
				const settled = await Promise.allSettled(
					units.map((item) =>
						item.hash.then((hash) => {
							release.push(ports.protect(hash));
							return hash;
						}),
					),
				);
				const hashes = settled.map((result) => {
					if (result.status === "rejected") throw result.reason;
					return result.value;
				});
				// Refresh persisted preparation leases in bounded batches. Recreate GC'd units.
				for (let start = 0; start < hashes.length; start += 64) {
					if (!units.some((item) => item.users.size))
						throw new Error("Prefix tool snapshot preparation cancelled");
					const chunk = hashes.slice(start, start + 64);
					const present = new Set(await ports.touch(chunk));
					for (let index = 0; index < chunk.length; index++)
						if (!present.has(chunk[index]))
							hashes[start + index] = await write(units[start + index].value);
				}
				return await ports.putJson({ format: PREFIX_TOOLS_FORMAT, definitions: hashes });
			} finally {
				for (const done of release) done();
			}
		})();
		const bytes = key.length * 2 + 256;
		if (bytes <= 4 * 1024 * 1024) {
			while (catalogBytes + bytes > 4 * 1024 * 1024) {
				const oldest = catalogs.entries().next().value;
				if (!oldest) break;
				catalogs.delete(oldest[0]);
				catalogBytes -= oldest[1].bytes;
			}
			catalogs.set(key, { promise, until: Date.now() + 5 * 60 * 1000, bytes });
			catalogBytes += bytes;
		}
		void promise.catch(() => {
			const current = catalogs.get(key);
			if (current?.promise === promise) {
				catalogs.delete(key);
				catalogBytes -= current.bytes;
			}
		});
		return promise;
	}
	async function read(hash: string, needed: () => boolean): Promise<ToolDefinitionSnapshot[]> {
		ports.check();
		if (!needed()) throw new Error("Prefix tool snapshot read cancelled");
		const existing = decoded.get(hash)?.deref();
		if (existing) return existing;
		const manifest = await ports.readJson<unknown>(hash);
		if (Array.isArray(manifest)) return manifest as ToolDefinitionSnapshot[]; // legacy arrays
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
		Object.freeze(result);
		// Weak references do not retain giant catalogs or defeat the strong byte-budget cache.
		decoded.set(hash, new WeakRef(result));
		while (decoded.size > 4096) {
			const oldest = decoded.keys().next().value;
			if (oldest === undefined) break;
			decoded.delete(oldest);
		}
		return result;
	}
	return {
		invalidate() {
			catalogs.clear();
			catalogBytes = 0;
			decoded.clear();
		},
		putPrefixToolDefinitions(definitions: readonly ToolDefinitionSnapshot[], signal?: AbortSignal) {
			if (signal?.aborted) return Promise.reject<string>(signal.reason);
			const user = {};
			const units: Unit[] = [];
			return waitForPrefix(put(definitions, units, user, signal), signal).finally(() => {
				for (const item of units) item.users.delete(user);
			});
		},
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
