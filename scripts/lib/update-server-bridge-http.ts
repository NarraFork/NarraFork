import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, link, mkdtemp, open, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hashReleaseFile } from "./ci-release-io";

export interface UpdateServerBridgeConfig {
	serverUrl: string;
	token: string;
}
export interface FileHash {
	size: number;
	sha256: string;
	sha512: string;
}
export const BRIDGE_METADATA_LIMIT = 1024 * 1024;
export const BRIDGE_POST_LIMIT = 256 * 1024 * 1024;
export const BRIDGE_REQUEST_TIMEOUT = 15 * 60 * 1000;
export const BRIDGE_DISK_RESERVE = 64 * 1024 * 1024;

/** Explicit CI configuration only. No HOME files or implicit private endpoints. */
export function resolveUpdateServerBridgeConfig(
	env: NodeJS.ProcessEnv,
): UpdateServerBridgeConfig | undefined {
	const server = env.NF_UPDATE_SERVER;
	const token = env.NF_UPDATE_TOKEN;
	if (!server && !token) return undefined;
	if (
		!server ||
		!token?.length ||
		token.length > 4096 ||
		[...token].some((character) => character.charCodeAt(0) < 33 || character.charCodeAt(0) > 126)
	)
		throw new Error(
			"NF_UPDATE_SERVER and NF_UPDATE_TOKEN must both be configured with a valid bearer token",
		);
	let url: URL;
	try {
		url = new URL(server);
	} catch {
		throw new Error("Invalid NF_UPDATE_SERVER URL");
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/" ||
		server !== server.trim()
	)
		throw new Error("NF_UPDATE_SERVER must be a credential-free HTTPS origin");
	const config = { serverUrl: url.origin } as UpdateServerBridgeConfig;
	Object.defineProperty(config, "token", { value: token, enumerable: false });
	return Object.freeze(config);
}

export class BridgeHttpError extends Error {
	constructor(readonly status: number) {
		super(`Update server HTTP ${status}`);
		this.name = "BridgeHttpError";
	}
}
interface ReadOptions {
	signal?: AbortSignal;
	maxBytes?: number;
	allowNotFound?: boolean;
	authenticated?: boolean;
	/** Payload requests use the longer budget; JSON reads default to at most 30 seconds. */
	timeoutMs?: number;
}
interface BodyOptions {
	maxBytes: number;
	signal?: AbortSignal;
}

function boundedLimit(value: number): number {
	if (!Number.isSafeInteger(value) || value <= 0 || value > 1024 ** 3)
		throw new Error("Invalid bridge byte limit");
	return value;
}
function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(new Error("Update server operation cancelled or timed out"));
		signal.addEventListener("abort", abort, { once: true });
		task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

/** A byte-verified private snapshot, with no writer or pathname remaining during network awaits. */
export async function snapshotBridgeUploadFile(
	sourcePath: string,
	temporaryDirectory: string,
	expected: FileHash,
	signal: AbortSignal,
): Promise<FileHandle> {
	boundedLimit(expected.size);
	signal.throwIfAborted();
	const disk = await statfs(temporaryDirectory);
	if (disk.bavail * disk.bsize < expected.size + BRIDGE_DISK_RESERVE)
		throw new Error("Insufficient bridge snapshot disk budget");
	const temporary = join(temporaryDirectory, `.upload-${randomUUID()}.part`);
	let input: FileHandle | undefined;
	let writer: FileHandle | undefined;
	let snapshot: FileHandle | undefined;
	let ownsTemporary = false;
	try {
		writer = await open(temporary, "wx", 0o600);
		ownsTemporary = true;
		input = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stat = await input.stat();
		if (!stat.isFile() || stat.size !== expected.size)
			throw new Error("Sealed upload source drift before snapshot");
		const sha256 = createHash("sha256");
		const sha512 = createHash("sha512");
		let size = 0;
		for await (const chunk of input.createReadStream({ autoClose: false, signal })) {
			signal.throwIfAborted();
			size += chunk.length;
			if (size > expected.size) throw new Error("Snapshot input exceeds sealed byte budget");
			sha256.update(chunk);
			sha512.update(chunk);
			let offset = 0;
			while (offset < chunk.length) {
				signal.throwIfAborted();
				const { bytesWritten } = await writer.write(chunk, offset, chunk.length - offset);
				if (!bytesWritten) throw new Error("Snapshot disk write failed");
				offset += bytesWritten;
			}
		}
		if (
			size !== expected.size ||
			sha256.digest("hex") !== expected.sha256 ||
			sha512.digest("base64") !== expected.sha512
		)
			throw new Error("Sealed upload source byte drift before request");
		signal.throwIfAborted();
		snapshot = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
		await writer.close();
		writer = undefined;
		await rm(temporary);
		ownsTemporary = false;
		const result = snapshot;
		snapshot = undefined;
		return result;
	} finally {
		await input?.close().catch(() => {});
		await writer?.close().catch(() => {});
		await snapshot?.close().catch(() => {});
		if (ownsTemporary) await rm(temporary, { force: true });
	}
}

function cappedUpload(stream: ReadableStream<Uint8Array>, maximum: number) {
	const reader = stream.getReader();
	let size = 0;
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const chunk = await reader.read();
				if (chunk.done) {
					controller.close();
					return;
				}
				size += chunk.value.byteLength;
				if (size > maximum) throw new Error("Bridge outgoing body exceeds byte limit");
				controller.enqueue(chunk.value);
			} catch (error) {
				controller.error(error);
				void reader.cancel().catch(() => {});
			}
		},
		cancel() {
			void reader.cancel().catch(() => {});
		},
	});
	return {
		body,
		close: () => {
			void reader.cancel().catch(() => {});
		},
	};
}

/** Same-origin, redirect-free transport. Never expose arbitrary fetch errors or response text. */
export class UpdateServerBridgeHttp {
	readonly serverUrl: string;
	#token: string;
	#fetch: typeof fetch;
	#timeout: number;
	constructor(
		config: UpdateServerBridgeConfig,
		options: { fetchImpl?: typeof fetch; requestTimeoutMs?: number } = {},
	) {
		const validated = resolveUpdateServerBridgeConfig({
			NF_UPDATE_SERVER: config.serverUrl,
			NF_UPDATE_TOKEN: config.token,
		});
		if (!validated) throw new Error("Missing bridge configuration");
		this.serverUrl = validated.serverUrl;
		this.#token = validated.token;
		this.#fetch = options.fetchImpl ?? fetch;
		this.#timeout = options.requestTimeoutMs ?? BRIDGE_REQUEST_TIMEOUT;
		if (!Number.isSafeInteger(this.#timeout) || this.#timeout <= 0)
			throw new Error("Invalid bridge request timeout");
	}
	#url(path: string): string {
		let url: URL;
		try {
			url = new URL(path, `${this.serverUrl}/`);
		} catch {
			throw new Error("Invalid bridge endpoint URL");
		}
		if (
			url.origin !== this.serverUrl ||
			url.username ||
			url.password ||
			url.hash ||
			!url.pathname.startsWith("/api/v2/")
		)
			throw new Error("Bridge URL must be a same-origin v2 API endpoint");
		return url.href;
	}
	async #operation<T>(
		path: string,
		init: RequestInit,
		options: ReadOptions,
		consume: (response: Response, signal: AbortSignal) => Promise<T>,
	): Promise<T | undefined> {
		const url = this.#url(path);
		const signal = AbortSignal.any([
			AbortSignal.timeout(Math.min(options.timeoutMs ?? this.#timeout, this.#timeout)),
			...(options.signal ? [options.signal] : []),
		]);
		const headers = new Headers(init.headers);
		if (options.authenticated) headers.set("Authorization", `Bearer ${this.#token}`);
		let response: Response | undefined;
		try {
			signal.throwIfAborted();
			const pending = Promise.resolve(
				this.#fetch(url, { ...init, headers, redirect: "error", signal }),
			);
			void pending.then(
				(lateResponse) => {
					if (signal.aborted && lateResponse.body && !lateResponse.body.locked)
						void lateResponse.body.cancel().catch(() => {});
				},
				() => {},
			);
			response = await abortable(pending, signal);
			if (response.redirected || (response.url && new URL(response.url).origin !== this.serverUrl))
				throw new Error("Bridge redirect rejected");
			if (response.status === 404 && options.allowNotFound) return undefined;
			if (!response.ok) throw new BridgeHttpError(response.status);
			return await consume(response, signal);
		} catch (error) {
			if (error instanceof BridgeHttpError) throw error;
			throw new Error(
				"Update server operation failed (transport, bounds, integrity or cancellation)",
			);
		} finally {
			if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
		}
	}
	async #consume(
		response: Response,
		maximum: number,
		signal: AbortSignal,
		onChunk: (bytes: Uint8Array) => Promise<void> | void,
	): Promise<number> {
		boundedLimit(maximum);
		const length = response.headers.get("content-length");
		if (length && (!/^\d+$/.test(length) || Number(length) > maximum))
			throw new Error("Bridge response exceeds byte limit");
		if (!response.body) throw new Error("Missing bridge response body");
		const reader = response.body.getReader();
		let size = 0;
		try {
			while (true) {
				const { value, done } = await abortable(reader.read(), signal);
				if (done) break;
				size += value.byteLength;
				if (size > maximum) throw new Error("Bridge response exceeds byte limit");
				await onChunk(value);
			}
			if (length && size !== Number(length)) throw new Error("Bridge response size mismatch");
			return size;
		} finally {
			void reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	}
	async #json(response: Response, maximum: number, signal: AbortSignal): Promise<unknown> {
		const bytes = Buffer.alloc(boundedLimit(maximum));
		let offset = 0;
		const size = await this.#consume(response, maximum, signal, (chunk) => {
			bytes.set(chunk, offset);
			offset += chunk.length;
		});
		return JSON.parse(bytes.subarray(0, size).toString("utf8"));
	}
	async readJson<T>(path: string, options: ReadOptions = {}): Promise<T | undefined> {
		const maximum = boundedLimit(
			Math.min(options.maxBytes ?? BRIDGE_METADATA_LIMIT, BRIDGE_METADATA_LIMIT),
		);
		return this.#operation(
			path,
			{},
			{ ...options, timeoutMs: options.timeoutMs ?? 30_000 },
			async (response, signal) => (await this.#json(response, maximum, signal)) as T,
		);
	}
	async readHash(path: string, options: BodyOptions): Promise<FileHash> {
		boundedLimit(options.maxBytes);
		const result = await this.#operation(path, {}, options, async (response, signal) => {
			const sha256 = createHash("sha256");
			const sha512 = createHash("sha512");
			const size = await this.#consume(response, options.maxBytes, signal, (chunk) => {
				sha256.update(chunk);
				sha512.update(chunk);
			});
			return { size, sha256: sha256.digest("hex"), sha512: sha512.digest("base64") };
		});
		if (!result) throw new Error("Missing bridge response");
		return result;
	}
	async download(
		path: string,
		destination: string,
		options: BodyOptions & { expected?: { size: number; sha256?: string; sha512?: string } },
	): Promise<FileHash> {
		boundedLimit(options.maxBytes);
		const disk = await statfs(dirname(destination));
		if (disk.bavail * disk.bsize < options.maxBytes + BRIDGE_DISK_RESERVE)
			throw new Error("Insufficient bridge download disk budget");
		const temporary = `${destination}.${randomUUID()}.part`;
		const handle = await open(temporary, "wx", 0o600);
		try {
			await this.#operation(path, {}, options, async (response, signal) => {
				await this.#consume(response, options.maxBytes, signal, async (chunk) => {
					let offset = 0;
					while (offset < chunk.length) {
						signal.throwIfAborted();
						const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
						if (!bytesWritten) throw new Error("Bridge disk write failed");
						offset += bytesWritten;
					}
				});
				return true;
			});
			await handle.close();
			const identity = await hashReleaseFile(temporary, options.maxBytes, options.signal);
			if (
				options.expected &&
				(Object.entries(options.expected) as [keyof FileHash, string | number][]).some(
					([key, value]) => identity[key] !== value,
				)
			)
				throw new Error("Bridge download identity mismatch");
			await link(temporary, destination); // exclusive publication; never overwrite a local file
			return identity;
		} finally {
			await handle.close().catch(() => {});
			await rm(temporary, { force: true });
		}
	}
	async upload(path: string, form: FormData, options: ReadOptions = {}): Promise<unknown> {
		const maximum = boundedLimit(
			Math.min(options.maxBytes ?? BRIDGE_POST_LIMIT, BRIDGE_POST_LIMIT),
		);
		let size = 64 * 1024; // conservative reserve for at most 32 bounded fields
		let fields = 0;
		for (const [key, value] of form) {
			if (++fields > 32 || Buffer.byteLength(key) > 256)
				throw new Error("Multipart field count/name exceeds limit");
			size += typeof value === "string" ? Buffer.byteLength(value) : value.size;
			if (
				typeof value !== "string" &&
				(Buffer.byteLength(value.name) > 256 || Buffer.byteLength(value.type) > 256)
			)
				throw new Error("Multipart filename/type exceeds limit");
		}
		if (size > maximum) throw new Error("Bridge multipart exceeds 256MiB request budget");
		const serialized = new Request(this.#url(path), { method: "POST", body: form });
		if (!serialized.body) throw new Error("Missing multipart body");
		const outgoing = cappedUpload(serialized.body, maximum);
		try {
			return await this.#operation(
				path,
				{ method: "POST", body: outgoing.body, headers: serialized.headers },
				{ ...options, authenticated: true },
				(response, signal) => this.#json(response, BRIDGE_METADATA_LIMIT, signal),
			);
		} finally {
			outgoing.close();
		}
	}
	async put(
		path: string,
		filePath: string,
		options: BodyOptions & {
			contentType?: string;
			expected?: { size: number; sha256?: string; sha512?: string };
		},
	): Promise<unknown> {
		this.#url(path);
		boundedLimit(options.maxBytes);
		const signal = AbortSignal.any([
			AbortSignal.timeout(this.#timeout),
			...(options.signal ? [options.signal] : []),
		]);
		const identity = await hashReleaseFile(filePath, options.maxBytes, signal);
		if (
			options.expected &&
			Object.entries(options.expected).some(
				([key, value]) => identity[key as keyof FileHash] !== value,
			)
		)
			throw new Error("Sealed PUT source identity mismatch before request");
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "nf-bridge-put-"));
		let snapshot: FileHandle | undefined;
		let outgoing: ReturnType<typeof cappedUpload> | undefined;
		try {
			snapshot = await snapshotBridgeUploadFile(filePath, temporaryDirectory, identity, signal);
			outgoing = cappedUpload(Bun.file(snapshot.fd).stream(), identity.size);
			return await this.#operation(
				path,
				{
					method: "PUT",
					body: outgoing.body,
					headers: {
						"Content-Type": options.contentType ?? "application/octet-stream",
						"Content-Length": String(identity.size),
					},
				},
				{ ...options, signal, authenticated: true },
				(response, activeSignal) => this.#json(response, BRIDGE_METADATA_LIMIT, activeSignal),
			);
		} finally {
			outgoing?.close();
			try {
				await snapshot?.close();
			} finally {
				await rm(temporaryDirectory, { force: true, recursive: true });
			}
		}
	}
}
