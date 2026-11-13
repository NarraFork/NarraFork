import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { parse as parseDomain } from "tldts";
import { MAX_MIRROR_TRANSFER_TIMEOUT_MS } from "./mirror-relay";

export type WebDavConfig = {
	url: string;
	feed: string;
	auth: { username: string; password: string } | { bearerToken: string };
	downloadRedirectHosts?: string[];
	/** Internal millisecond budget derived from validated deployment configuration. */
	transferTimeoutMs?: number;
};
export class WebDavError extends Error {
	constructor(
		public readonly code: string,
		public readonly status?: number,
	) {
		super(`WebDAV ${code}${status === undefined ? "" : ` (${status})`}`);
		this.name = "WebDavError";
	}
}
function check(condition: unknown, code = "INVALID_INPUT"): asserts condition {
	if (!condition) throw new WebDavError(code);
}
function hasControl(value: string, allowXmlWhitespace = false): boolean {
	return Array.from(value).some(
		(c) => c.charCodeAt(0) < 32 && !(allowXmlWhitespace && [9, 10, 13].includes(c.charCodeAt(0))),
	);
}
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_OBJECT_BYTES = 4 * 1024 ** 3;
const CONTROL_TIMEOUT_MS = 30_000;
const STREAM_TIMEOUT_MS = 15 * 60_000;
const DOWNLOAD_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
function publicDownloadHostname(host: string): boolean {
	const labels = host.split(".");
	if (
		!(
			host.length <= 253 &&
			labels.length >= 2 &&
			labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
			/^[a-z]{2,63}$/.test(labels.at(-1) ?? "") &&
			!isIP(host)
		)
	)
		return false;
	const parsed = parseDomain(host, { allowPrivateDomains: true });
	return !!parsed.domain && (parsed.isIcann === true || parsed.isPrivate === true);
}
function downloadHosts(input: unknown): string[] | undefined {
	if (input === undefined) return undefined;
	check(Array.isArray(input) && input.length <= 8);
	const normalized = Array.from(input, (value: unknown) => {
		check(typeof value === "string" && value.length > 0 && value === value.trim());
		const normalized = value.toLowerCase();
		const wildcard = normalized.startsWith("*.");
		const host = wildcard ? normalized.slice(2) : normalized;
		check(publicDownloadHostname(host) && (!wildcard || host.split(".").length >= 3));
		return normalized;
	});
	return normalized.length ? [...new Set(normalized)] : undefined;
}
function downloadRedirectUrl(location: string | null, current: URL, hosts: string[]): URL {
	check(
		typeof location === "string" &&
			location.length > 0 &&
			location.length <= 8192 &&
			!hasControl(location) &&
			!/[\\\s#]/.test(location),
		"REDIRECT_TARGET",
	);
	let target: URL;
	try {
		target = new URL(location, current);
	} catch {
		throw new WebDavError("REDIRECT_TARGET");
	}
	check(
		target.protocol === "https:" &&
			!target.port &&
			!target.username &&
			!target.password &&
			!target.hash &&
			publicDownloadHostname(target.hostname) &&
			!/^(?:https:)?\/\/[^/?#]*@/i.test(location),
		"REDIRECT_TARGET",
	);
	check(
		hosts.some((entry) =>
			entry.startsWith("*.")
				? target.hostname.endsWith(`.${entry.slice(2)}`) && target.hostname !== entry.slice(2)
				: target.hostname === entry,
		),
		"REDIRECT_HOST",
	);
	return target;
}
function validDate(date: string): boolean {
	return (
		/^\d{4}-\d\d-\d\d$/.test(date) &&
		Number.isFinite(Date.parse(`${date}T00:00:00.000Z`)) &&
		new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date
	);
}
export function validateWebDavConfig(input: WebDavConfig): WebDavConfig {
	try {
		check(
			input &&
				typeof input.url === "string" &&
				input.url.length <= 2048 &&
				!hasControl(input.url) &&
				!/[ \\?#]/.test(input.url),
		);
		const u = new URL(input.url);
		check(
			u.protocol === "https:" && !!u.hostname && !u.username && !u.password && !u.search && !u.hash,
		);
		check(
			!/%(?:2f|5c|2e|00)/i.test(input.url) &&
				!input.url.split("/").some((s) => s === "." || s === ".."),
		);
		check(typeof input.feed === "string" && SEGMENT.test(input.feed));
		const hosts = downloadHosts(input.downloadRedirectHosts);
		if (input.transferTimeoutMs !== undefined)
			check(
				Number.isSafeInteger(input.transferTimeoutMs) &&
					input.transferTimeoutMs > 0 &&
					input.transferTimeoutMs <= MAX_MIRROR_TRANSFER_TIMEOUT_MS,
			);
		const redirects = {
			...(hosts ? { downloadRedirectHosts: hosts } : {}),
			...(input.transferTimeoutMs === undefined
				? {}
				: { transferTimeoutMs: input.transferTimeoutMs }),
		};
		const auth = input.auth;
		check(auth && typeof auth === "object");
		if ("bearerToken" in auth) {
			check(
				Object.keys(auth).length === 1 &&
					typeof auth.bearerToken === "string" &&
					/^[\x21-\x7e]{1,8192}$/.test(auth.bearerToken),
			);
			return {
				url: `${u.href.replace(/\/+$/, "")}/`,
				feed: input.feed,
				auth: { bearerToken: auth.bearerToken },
				...redirects,
			};
		}
		check(
			Object.keys(auth).length === 2 &&
				typeof auth.username === "string" &&
				typeof auth.password === "string" &&
				auth.username.length > 0 &&
				auth.username.length <= 1024 &&
				auth.password.length > 0 &&
				auth.password.length <= 8192 &&
				!hasControl(auth.username) &&
				!auth.username.includes(":") &&
				!hasControl(auth.password),
		);
		return {
			url: `${u.href.replace(/\/+$/, "")}/`,
			feed: input.feed,
			auth: { username: auth.username, password: auth.password },
			...redirects,
		};
	} catch {
		throw new WebDavError("INVALID_CONFIG");
	}
}
function pathParts(path: string, feed: string): string[] {
	check(
		typeof path === "string" && path.length <= 640 && !path.startsWith("/") && !path.endsWith("/"),
	);
	const p = path.split("/");
	check(p[0] === "narrafork-mirror-v1" && p.length <= 9);
	if (p.length > 1) check(p[1] === feed);
	if (p.length > 2) check(p[2] === "ready" || p[2] === "batches");
	if (p.length > 3) check(SEGMENT.test(p[3] ?? ""));
	if (p.length > 4) check(["main", "helpers", "executor", "remote-peer"].includes(p[4] ?? ""));
	if (p.length > 5) check(validDate(p[5] ?? ""));
	if (p[2] === "ready") {
		check(p.length <= 7);
		if (p.length === 7) check(/^[a-f0-9]{64}\.json$/.test(p[6] ?? ""));
	} else if (p[2] === "batches") {
		if (p.length > 6) check(SEGMENT.test(p[6] ?? ""));
		if (p.length > 7) check(p[7] === "objects");
		if (p.length > 8) check(SHA.test(p[8] ?? ""));
	}
	return p;
}
function safeError(error: unknown): WebDavError {
	return error instanceof WebDavError ? error : new WebDavError("NETWORK_ERROR");
}
type Lifetime = ReturnType<typeof lifetime>;
function lifetime(parent: AbortSignal, timeout: number) {
	const controller = new AbortController();
	const cleanups = new Set<() => void>();
	let finished = false;
	let failure: WebDavError | undefined;
	const abort = (code: string) => {
		failure ??= new WebDavError(code);
		controller.abort(failure);
	};
	const onAbort = () => abort("ABORTED");
	parent.addEventListener("abort", onAbort, { once: true });
	if (parent.aborted) onAbort();
	const timer = setTimeout(() => abort("TIMEOUT"), timeout);
	timer.unref?.();
	return {
		signal: controller.signal,
		abort,
		async run<T>(operation: () => Promise<T>): Promise<T> {
			if (controller.signal.aborted) throw failure;
			let listener: (() => void) | undefined;
			try {
				const result = await Promise.race([
					operation(),
					new Promise<never>((_, reject) => {
						listener = () => reject(failure);
						controller.signal.addEventListener("abort", listener, { once: true });
						if (controller.signal.aborted) listener();
					}),
				]);
				if (controller.signal.aborted) throw failure;
				return result;
			} catch (error) {
				throw failure ?? safeError(error);
			} finally {
				if (listener) controller.signal.removeEventListener("abort", listener);
			}
		},
		onFinish(cleanup: () => void) {
			if (finished) cleanup();
			else cleanups.add(cleanup);
		},
		finish() {
			finished = true;
			clearTimeout(timer);
			parent.removeEventListener("abort", onAbort);
			for (const cleanup of cleanups) cleanup();
			cleanups.clear();
		},
	};
}
function boundedStream(
	source: ReadableStream<Uint8Array>,
	max: number,
	exact: boolean,
	life: Lifetime,
): ReadableStream<Uint8Array> {
	const reader = source.getReader();
	let total = 0;
	let ended = false;
	const stop = () => {
		if (!ended) void reader.cancel().catch(() => {});
	};
	let output: ReadableStreamDefaultController<Uint8Array> | undefined;
	const finish = () => {
		ended = true;
		life.signal.removeEventListener("abort", onAbort);
		life.finish();
	};
	const onAbort = () => {
		stop();
		finish();
		output?.error(safeError(life.signal.reason));
	};
	return new ReadableStream<Uint8Array>(
		{
			start(controller) {
				output = controller;
				life.signal.addEventListener("abort", onAbort, { once: true });
				if (life.signal.aborted) onAbort();
			},
			async pull(controller) {
				try {
					const result = await life.run(() => reader.read());
					if (result.done) {
						check(!exact || total === max, "SIZE_MISMATCH");
						finish();
						controller.close();
						return;
					}
					total += result.value.byteLength;
					check(total <= max, "SIZE_LIMIT");
					controller.enqueue(result.value);
				} catch (error) {
					stop();
					finish();
					controller.error(safeError(error));
				}
			},
			async cancel() {
				life.abort("ABORTED");
				stop();
				finish();
			},
		},
		{ highWaterMark: 0 },
	);
}

export class WebDavClient {
	private readonly config: WebDavConfig;
	private readonly fetchImpl: typeof fetch;
	private readonly authorization: string;
	constructor(config: WebDavConfig, options?: { fetchImpl?: typeof fetch }) {
		this.config = validateWebDavConfig(config);
		this.fetchImpl = options?.fetchImpl ?? fetch;
		this.authorization =
			"bearerToken" in this.config.auth
				? `Bearer ${this.config.auth.bearerToken}`
				: `Basic ${Buffer.from(`${this.config.auth.username}:${this.config.auth.password}`).toString("base64")}`;
	}
	private url(path: string, collection = false): URL {
		pathParts(path, this.config.feed);
		return new URL(`${path}${collection ? "/" : ""}`, this.config.url);
	}
	private async request(
		url: URL,
		init: RequestInit,
		life: Lifetime,
		download?: { anonymous: boolean },
	): Promise<Response> {
		const manualDownload =
			download !== undefined &&
			init.method === "GET" &&
			!!this.config.downloadRedirectHosts?.length;
		let receivedResponse: Response | undefined;
		let abandoned = false;
		const cancelUnownedBody = () => {
			if (receivedResponse?.body && !receivedResponse.body.locked) {
				void receivedResponse.body.cancel().catch(() => {});
			}
		};
		const onAbort = () => {
			abandoned = true;
			cancelUnownedBody();
		};
		// Retain response ownership across both async handoff boundaries: fetch ->
		// lifetime.run -> caller. An injected fetch need not honor AbortSignal.
		life.signal.addEventListener("abort", onAbort, { once: true });
		life.onFinish(() => life.signal.removeEventListener("abort", onAbort));
		if (life.signal.aborted) onAbort();
		try {
			const response = await life.run(() =>
				Promise.resolve(
					this.fetchImpl(url, {
						...(download?.anonymous
							? {
									method: "GET",
									headers: new Headers(),
									credentials: "omit" as const,
									referrer: "",
									referrerPolicy: "no-referrer" as const,
								}
							: { ...init, headers: { ...init.headers, Authorization: this.authorization } }),
						// Real fetch rejects a 302 with mode "error" before headers are
						// available. Only opted-in GETs expose them for our own checks.
						redirect: manualDownload ? "manual" : "error",
						signal: life.signal,
					}),
				).then((response) => {
					receivedResponse = response;
					// This hook also runs when abort won and the request already returned.
					if (abandoned || life.signal.aborted) cancelUnownedBody();
					return response;
				}),
			);
			const mayFollowDownload = manualDownload && DOWNLOAD_REDIRECT_STATUSES.has(response.status);
			if (
				response.redirected ||
				(response.status >= 300 && response.status < 400 && !mayFollowDownload)
			) {
				cancelUnownedBody();
				throw new WebDavError("REDIRECT", response.status);
			}
			return response;
		} catch (error) {
			abandoned = true;
			cancelUnownedBody();
			throw safeError(error);
		}
	}
	async ensureCollection(path: string, signal: AbortSignal): Promise<void> {
		const parts = pathParts(path, this.config.feed);
		check(parts.length < 7 || (parts[2] === "batches" && parts.length <= 8));
		for (let i = 1; i <= parts.length; i++) {
			const life = lifetime(signal, CONTROL_TIMEOUT_MS);
			try {
				const response = await this.request(
					this.url(parts.slice(0, i).join("/"), true),
					{ method: "MKCOL" },
					life,
				);
				void response.body?.cancel().catch(() => {});
				if (response.status !== 201 && response.status !== 405)
					throw new WebDavError("HTTP_STATUS", response.status);
			} finally {
				life.finish();
			}
		}
	}
	async put(
		path: string,
		body: ReadableStream<Uint8Array> | Uint8Array,
		expected: { size: number; sha256: string },
		signal: AbortSignal,
	): Promise<"created" | "exists"> {
		const parts = pathParts(path, this.config.feed);
		check(
			(parts[2] === "ready" && parts.length === 7) ||
				(parts[2] === "batches" && parts.length === 9),
		);
		check(
			Number.isSafeInteger(expected.size) &&
				expected.size > 0 &&
				expected.size <= MAX_OBJECT_BYTES &&
				SHA.test(expected.sha256),
		);
		const life = lifetime(signal, this.config.transferTimeoutMs ?? STREAM_TIMEOUT_MS);
		let complete = false;
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let outgoing: Uint8Array | ReadableStream<Uint8Array>;
		try {
			if (body instanceof Uint8Array && body.byteLength <= 1024 * 1024) {
				check(
					body.byteLength === expected.size &&
						createHash("sha256").update(body).digest("hex") === expected.sha256,
					"INTEGRITY",
				);
				outgoing = body;
				complete = true;
			} else {
				// Large caller-owned byte arrays use the same backpressured incremental
				// verifier as network streams, not one multi-GiB synchronous hash call.
				let input: ReadableStream<Uint8Array>;
				if (body instanceof Uint8Array) {
					check(body.byteLength === expected.size, "INTEGRITY");
					const bytes = body;
					let offset = 0;
					input = new ReadableStream<Uint8Array>(
						{
							pull(controller) {
								if (offset === bytes.length) {
									controller.close();
									return;
								}
								const end = Math.min(offset + 64 * 1024, bytes.length);
								controller.enqueue(bytes.subarray(offset, end));
								offset = end;
							},
						},
						{ highWaterMark: 0 },
					);
				} else input = body;
				reader = input.getReader();
				const source = reader;
				const hash = createHash("sha256");
				let count = 0;
				outgoing = new ReadableStream<Uint8Array>(
					{
						async pull(controller) {
							try {
								const result = await life.run(() => source.read());
								if (result.done) {
									check(
										count === expected.size && hash.digest("hex") === expected.sha256,
										"INTEGRITY",
									);
									complete = true;
									controller.close();
								} else {
									count += result.value.byteLength;
									check(count <= expected.size, "SIZE_LIMIT");
									hash.update(result.value);
									controller.enqueue(result.value);
								}
							} catch (error) {
								life.abort(error instanceof WebDavError ? error.code : "NETWORK_ERROR");
								void source.cancel().catch(() => {});
								controller.error(safeError(error));
							}
						},
						cancel() {
							void source.cancel().catch(() => {});
						},
					},
					{ highWaterMark: 0 },
				);
			}
			const response = await this.request(
				this.url(path),
				{
					method: "PUT",
					headers: {
						"If-None-Match": "*",
						"Content-Length": String(expected.size),
						"Content-Type": "application/octet-stream",
					},
					body: outgoing as BodyInit,
				},
				life,
			);
			void response.body?.cancel().catch(() => {});
			if (response.status === 412) return "exists";
			if (![200, 201, 204].includes(response.status))
				throw new WebDavError("HTTP_STATUS", response.status);
			check(complete, "EARLY_RESPONSE");
			return "created";
		} finally {
			if (!complete) {
				life.abort("ABORTED");
				void reader?.cancel().catch(() => {});
			}
			life.finish();
		}
	}
	private async open(
		path: string,
		max: number,
		exact: boolean,
		signal: AbortSignal,
		timeout: number,
		method = "GET",
	): Promise<ReadableStream<Uint8Array> | null> {
		check(Number.isSafeInteger(max) && max > 0 && max <= MAX_OBJECT_BYTES);
		const life = lifetime(signal, timeout);
		let response: Response | undefined;
		try {
			let current = this.url(path, method === "PROPFIND");
			const visited = new Set([current.href]);
			let hops = 0;
			for (;;) {
				response = await this.request(
					current,
					{
						method,
						...(method === "PROPFIND"
							? {
									headers: { Depth: "1", "Content-Type": "application/xml" },
									body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
								}
							: {}),
					},
					life,
					method === "GET" ? { anonymous: hops > 0 } : undefined,
				);
				if (!DOWNLOAD_REDIRECT_STATUSES.has(response.status)) break;
				void response.body?.cancel().catch(() => {});
				check(
					method === "GET" && this.config.downloadRedirectHosts?.length && hops < 3,
					"REDIRECT_LIMIT",
				);
				const next = downloadRedirectUrl(
					response.headers.get("location"),
					current,
					this.config.downloadRedirectHosts,
				);
				check(!visited.has(next.href), "REDIRECT_LOOP");
				visited.add(next.href);
				current = next;
				hops++;
			}
			if (response.status === 404) {
				void response.body?.cancel().catch(() => {});
				life.finish();
				return null;
			}
			if (response.status !== (method === "PROPFIND" ? 207 : 200))
				throw new WebDavError("HTTP_STATUS", response.status);
			const length = response.headers.get("content-length");
			if (length !== null)
				check(
					/^\d+$/.test(length) && Number(length) <= max && (!exact || Number(length) === max),
					"SIZE_LIMIT",
				);
			check(response.body, "EMPTY_BODY");
			return boundedStream(response.body, max, exact, life);
		} catch (error) {
			void response?.body?.cancel().catch(() => {});
			life.abort("ABORTED");
			life.finish();
			throw safeError(error);
		}
	}
	async getBytes(path: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null> {
		check(maxBytes <= 1024 * 1024);
		const stream = await this.open(path, maxBytes, false, signal, CONTROL_TIMEOUT_MS);
		return stream ? collect(stream) : null;
	}
	async getStream(
		path: string,
		expectedSize: number,
		signal: AbortSignal,
	): Promise<ReadableStream<Uint8Array> | null> {
		return this.open(
			path,
			expectedSize,
			true,
			signal,
			this.config.transferTimeoutMs ?? STREAM_TIMEOUT_MS,
		);
	}
	async list(
		path: string,
		options: { maxEntries?: number; maxBytes?: number; signal: AbortSignal },
	): Promise<Array<{ name: string; isCollection: boolean }>> {
		const maxEntries = options.maxEntries ?? 32;
		const maxBytes = options.maxBytes ?? 256 * 1024;
		check(
			Number.isInteger(maxEntries) &&
				maxEntries >= 1 &&
				maxEntries <= 512 &&
				Number.isInteger(maxBytes) &&
				maxBytes > 0 &&
				maxBytes <= 256 * 1024,
		);
		const stream = await this.open(
			path,
			maxBytes,
			false,
			options.signal,
			CONTROL_TIMEOUT_MS,
			"PROPFIND",
		);
		if (!stream) return [];
		const bytes = await collect(stream);
		return parseListing(bytes, this.url(path, true), maxEntries);
	}
	async deleteCollection(path: string, signal: AbortSignal): Promise<void> {
		const p = pathParts(path, this.config.feed);
		check(p.length === 6 && (p[2] === "ready" || p[2] === "batches"));
		const life = lifetime(signal, CONTROL_TIMEOUT_MS);
		try {
			const response = await this.request(this.url(path, true), { method: "DELETE" }, life);
			void response.body?.cancel().catch(() => {});
			if (![200, 204, 404].includes(response.status))
				throw new WebDavError("HTTP_STATUS", response.status);
		} finally {
			life.finish();
		}
	}
}
async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const result = await reader.read();
		if (result.done) break;
		chunks.push(result.value);
		size += result.value.byteLength;
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return bytes;
}

function isXmlCodePoint(code: number): boolean {
	return (
		code === 9 ||
		code === 10 ||
		code === 13 ||
		(code >= 0x20 && code <= 0xd7ff) ||
		(code >= 0xe000 && code <= 0xfffd) ||
		(code >= 0x10000 && code <= 0x10ffff)
	);
}
function xmlValue(value: string): string {
	// Decode token values once, never the document: escaped markup stays text.
	return value.replace(/&([^&;]*);|&/g, (_reference, entity: string | undefined) => {
		switch (entity) {
			case "amp":
				return "&";
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "apos":
				return "'";
			case "quot":
				return '"';
		}
		check(entity !== undefined && /^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity), "INVALID_XML");
		const code = entity.startsWith("#x")
			? Number.parseInt(entity.slice(2), 16)
			: Number.parseInt(entity.slice(1), 10);
		check(isXmlCodePoint(code), "INVALID_XML");
		return String.fromCodePoint(code);
	});
}
// A deliberately small, bounded XML parser. Unlike HTML DOM parsers it never repairs
// malformed XML, silently drops namespace bindings, or resolves DTDs/custom entities.
type XmlNode = {
	qname: string;
	name: string;
	ns: string;
	text: string;
	children: XmlNode[];
	namespaces: Record<string, string>;
};
function xml(bytes: Uint8Array): XmlNode {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new WebDavError("INVALID_XML");
	}
	for (const char of text) check(isXmlCodePoint(char.codePointAt(0) ?? -1), "INVALID_XML");
	check(!text.includes("<!") && !text.includes("]]>"), "INVALID_XML");
	text = text.replace(
		/^[ \t\r\n]*<\?xml[ \t\r\n]+version=(?:"1\.0"|'1\.0')(?:[ \t\r\n]+encoding=(?:"(?:UTF-8|utf-8)"|'(?:UTF-8|utf-8)'))?[ \t\r\n]*\?>/,
		"",
	);
	const stack: XmlNode[] = [];
	let root: XmlNode | undefined;
	let cursor = 0;
	let nodes = 0;
	const name = "[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?";
	const ws = "[ \\t\\r\\n]";
	const token = /<[^>]*>|[^<]+/g;
	for (const match of text.matchAll(token)) {
		check(match.index === cursor, "INVALID_XML");
		const value = match[0];
		cursor += value.length;
		if (!value.startsWith("<")) {
			const parent = stack.at(-1);
			if (parent) parent.text += xmlValue(value);
			else check(!value.trim(), "INVALID_XML");
			continue;
		}
		if (value.startsWith("</")) {
			const close = new RegExp(`^</(${name})${ws}*>$`).exec(value);
			check(close && stack.pop()?.qname === close[1], "INVALID_XML");
			continue;
		}
		const open = new RegExp(
			`^<(${name})((?:${ws}+${name}${ws}*=${ws}*(?:"[^"<>]*"|'[^'<>]*'))*)${ws}*(/?)>$`,
		).exec(value);
		check(open && ++nodes <= 8192 && stack.length < 32, "INVALID_XML");
		const qname = open[1] ?? "";
		const xmlNamespace = "http://www.w3.org/XML/1998/namespace";
		const namespaces: Record<string, string> = {
			xml: xmlNamespace,
			...(stack.at(-1)?.namespaces ?? {}),
		};
		const seen = new Set<string>();
		const attributes = [
			...(open[2] ?? "").matchAll(new RegExp(`(${name})${ws}*=${ws}*(?:"([^"]*)"|'([^']*)')`, "g")),
		];
		for (const a of attributes) {
			const key = a[1] ?? "";
			const value = xmlValue(a[2] ?? a[3] ?? "");
			check(!seen.has(key), "INVALID_XML");
			seen.add(key);
			if (key === "xmlns" || key.startsWith("xmlns:")) {
				const prefix = key === "xmlns" ? "" : key.slice(6);
				check(
					prefix !== "xmlns" &&
						(!prefix || value) &&
						value !== "http://www.w3.org/2000/xmlns/" &&
						(prefix === "xml" ? value === xmlNamespace : value !== xmlNamespace),
					"INVALID_XML",
				);
				Object.defineProperty(namespaces, prefix, {
					value,
					writable: true,
					configurable: true,
					enumerable: true,
				});
			}
		}
		const expandedAttributes = new Set<string>();
		for (const a of attributes) {
			const key = a[1] ?? "";
			if (key === "xmlns" || key.startsWith("xmlns:")) continue;
			const [prefix, local] = key.split(":");
			if (local)
				check(Object.hasOwn(namespaces, prefix ?? "") && namespaces[prefix ?? ""], "INVALID_XML");
			const expanded = local ? `${namespaces[prefix ?? ""]}:${local}` : key;
			check(!expandedAttributes.has(expanded), "INVALID_XML");
			expandedAttributes.add(expanded);
		}
		const parts = qname.split(":");
		const prefix = parts.length === 2 ? (parts[0] ?? "") : "";
		check(
			prefix !== "xmlns" && (!prefix || (Object.hasOwn(namespaces, prefix) && namespaces[prefix])),
			"INVALID_XML",
		);
		const node: XmlNode = {
			qname,
			name: parts.at(-1) ?? "",
			ns: namespaces[prefix] ?? "",
			text: "",
			children: [],
			namespaces,
		};
		const parent = stack.at(-1);
		if (parent) parent.children.push(node);
		else {
			check(!root, "INVALID_XML");
			root = node;
		}
		if (!open[3]) stack.push(node);
	}
	check(cursor === text.length && stack.length === 0 && root, "INVALID_XML");
	return root;
}
function dav(node: XmlNode, name: string): boolean {
	return node.ns === "DAV:" && node.name === name;
}
function parseListing(
	bytes: Uint8Array,
	directory: URL,
	limit: number,
): Array<{ name: string; isCollection: boolean }> {
	const root = xml(bytes);
	check(dav(root, "multistatus") && !root.text.trim(), "INVALID_XML");
	const result: Array<{ name: string; isCollection: boolean }> = [];
	const seen = new Set<string>();
	let self = false;
	for (const entry of root.children) {
		check(dav(entry, "response") && !entry.text.trim(), "INVALID_XML");
		const hrefs = entry.children.filter((n) => dav(n, "href"));
		check(hrefs.length === 1 && hrefs[0]?.children.length === 0, "INVALID_XML");
		const href = hrefs[0]?.text.trim() ?? "";
		check(
			href &&
				!/[\\?#\s]/.test(href) &&
				!/%(?:2e|2f|5c|00)/i.test(href) &&
				!href.split("/").some((s) => s === "." || s === ".."),
			"INVALID_HREF",
		);
		let url: URL;
		try {
			url = new URL(href, directory);
		} catch {
			throw new WebDavError("INVALID_HREF");
		}
		check(
			url.origin === directory.origin && !url.username && !url.password && !url.search && !url.hash,
			"INVALID_HREF",
		);
		const props = entry.children.filter((n) => dav(n, "propstat"));
		check(props.length > 0, "INVALID_XML");
		let isCollection = false;
		let resourceTypes = 0;
		check(!entry.children.some((n) => dav(n, "status")), "INVALID_XML");
		for (const ps of props) {
			const statuses = ps.children.filter((n) => dav(n, "status"));
			const values = ps.children.filter((n) => dav(n, "prop"));
			check(
				statuses.length === 1 &&
					statuses[0]?.children.length === 0 &&
					/^HTTP\/1\.[01] 200(?: [^\r\n]*)?$/.test(statuses[0]?.text.trim() ?? "") &&
					values.length === 1,
				"INVALID_XML",
			);
			for (const rt of values[0]?.children ?? []) {
				if (dav(rt, "resourcetype")) {
					resourceTypes++;
					check(
						!rt.text.trim() &&
							rt.children.every(
								(n) => dav(n, "collection") && n.children.length === 0 && !n.text.trim(),
							),
						"INVALID_XML",
					);
					isCollection ||= rt.children.length > 0;
				}
			}
		}
		check(resourceTypes === 1, "INVALID_XML");
		if (url.pathname.replace(/\/$/, "") === directory.pathname.replace(/\/$/, "")) {
			check(!self && isCollection, "INVALID_HREF");
			self = true;
			continue;
		}
		check(url.pathname.startsWith(directory.pathname), "INVALID_HREF");
		const child = url.pathname.slice(directory.pathname.length).replace(/\/$/, "");
		check(
			child &&
				!child.includes("/") &&
				/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(child) &&
				!child.includes("..") &&
				!seen.has(child),
			"INVALID_HREF",
		);
		check(result.length < limit, "ENTRY_LIMIT");
		seen.add(child);
		result.push({ name: child, isCollection });
	}
	return result;
}
