import { logger } from "@server/lib/logger";
import { outboundFetch } from "@server/lib/net/outbound-fetch";
import { resolveProxyForUrl } from "@server/lib/net/proxy";
import { ProviderQuotaError, quotaAbortable } from "@server/lib/provider-quota-async";
import type { CustomApiProviderConfig } from "@server/lib/settings";
import { getHttpUserAgent, resolveHttpUserAgent } from "@server/lib/user-agent";
import {
	type CustomApiQuotaTarget,
	customApiQuotaTargetSchema,
	type ProviderConnectionRequest,
	type ProviderConnectionResponse,
	type ProviderQuotaSourceDeclaration,
	providerConnectionRequestSchema,
	providerQuotaSourceSchema,
	QUOTA_MAX_QUERY_MS,
	QUOTA_MAX_REQUEST_MS,
	QUOTA_MAX_RESPONSE_BYTES,
} from "@shared/provider-quota";
import {
	type CustomApiQuotaTargetDirectory,
	customApiQuotaTargets,
} from "./provider-quota-targets";

export interface QuotaConnectionPrincipal {
	pluginId: string;
	installationId: string;
	runtimeId: string;
	runtimeGeneration: number;
}

export interface QuotaConnectionIssue {
	principal: QuotaConnectionPrincipal;
	target: CustomApiQuotaTarget;
	source: ProviderQuotaSourceDeclaration;
	deadlineAt: number;
	signal: AbortSignal;
	/**
	 * Host-owned closure checking source, runtime generation and live authority/grants.
	 * Resolves false once access is gone; rejects when access could not be checked at all.
	 * Either way the request fails closed.
	 */
	isCurrent: () => boolean | Promise<boolean>;
}

interface Lease extends QuotaConnectionIssue {
	reference: string;
	controller: AbortController;
	requests: number;
	active: boolean;
	release: () => void;
}

export interface PluginProviderConnectionServiceOptions {
	directory?: CustomApiQuotaTargetDirectory;
	fetch?: typeof outboundFetch;
	now?: () => number;
	requestTimeoutMs?: number;
	maxReferences?: number;
}

const HOP_HEADERS = new Set([
	"host",
	"connection",
	"content-length",
	"transfer-encoding",
	"proxy-authorization",
	"proxy-connection",
	"upgrade",
	"keep-alive",
	"trailer",
	"te",
]);

export function quotaConnectionHeaders(
	config: CustomApiProviderConfig,
	rule: ProviderQuotaSourceDeclaration["requests"][number],
	supplied: ProviderConnectionRequest["headers"],
): Headers {
	const headers = new Headers({ Accept: "application/json" });
	for (const [name, value] of Object.entries(supplied ?? {})) {
		if (!rule.headers.includes(name as "accept" | "user-agent") || value === undefined)
			throw new ProviderQuotaError("permission_denied");
		headers.set(name, value);
	}
	if (rule.auth === "none") return headers;
	const userAgent = resolveHttpUserAgent({
		mode: config.userAgentMode,
		custom: config.customUserAgent,
		fallback: supplied?.["user-agent"] ?? getHttpUserAgent(),
	});
	if (rule.auth === "site-token") {
		// Site-account authentication never inherits an inference key or its custom headers.
		return new Headers({
			Authorization: `Bearer ${config.quotaAccessToken?.trim() ?? ""}`,
			"New-Api-User": config.quotaUserId?.trim() ?? "",
			"User-Agent": userAgent,
			Accept: "application/json",
		});
	}
	headers.set("Authorization", `Bearer ${config.apiKey}`);
	if (rule.auth === "bearer-and-api-key") headers.set("x-api-key", config.apiKey);
	headers.set("User-Agent", userAgent);
	const extra = new Headers(config.extraHeaders);
	const blocked = new Set(HOP_HEADERS);
	for (const name of (extra.get("Connection") ?? "").split(","))
		if (name.trim()) blocked.add(name.trim().toLowerCase());
	for (const [name, value] of extra) if (!blocked.has(name.toLowerCase())) headers.set(name, value);
	for (const name of blocked) headers.delete(name);
	headers.set("Accept", supplied?.accept ?? "application/json");
	return headers;
}

function samePrincipal(a: QuotaConnectionPrincipal, b: QuotaConnectionPrincipal): boolean {
	return (
		a.pluginId === b.pluginId &&
		a.installationId === b.installationId &&
		a.runtimeId === b.runtimeId &&
		a.runtimeGeneration === b.runtimeGeneration
	);
}

function safePath(path: string): boolean {
	if (!path.startsWith("/") || path.startsWith("//") || /[\\?#\s]/.test(path)) return false;
	try {
		const decoded = decodeURIComponent(path);
		return (
			!/[\\?#]/.test(decoded) &&
			![...decoded].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
			!decoded.startsWith("//") &&
			!/%[0-9a-f]{2}/i.test(decoded) &&
			!decoded.split("/").some((segment) => segment === "." || segment === "..")
		);
	} catch {
		return false;
	}
}

function pathMatches(rule: string, path: string): boolean {
	if (!rule.startsWith("/**/")) return rule === path;
	const suffix = rule.slice(3);
	return path === suffix || path.endsWith(suffix);
}

/** Backend-only, ephemeral authority for GETs to one selected Custom API connection. */
export class PluginProviderConnectionService {
	private readonly directory: CustomApiQuotaTargetDirectory;
	private readonly fetcher: typeof outboundFetch;
	private readonly now: () => number;
	private readonly leases = new Map<string, Lease>();
	private readonly unsubscribe: () => void;

	constructor(private readonly options: PluginProviderConnectionServiceOptions = {}) {
		this.directory = options.directory ?? customApiQuotaTargets;
		this.fetcher = options.fetch ?? outboundFetch;
		this.now = options.now ?? Date.now;
		this.unsubscribe = this.directory.onChanged((ids) => {
			const changed = new Set(ids);
			for (const lease of [...this.leases.values()]) {
				if (!changed.has(lease.target.providerId)) continue;
				try {
					const current = this.directory.getTarget(lease.target);
					if (
						current?.valid &&
						current.target.id === lease.target.id &&
						current.target.generation === lease.target.generation
					)
						continue;
				} catch {
					/* Unverifiable identity remains fail closed. */
				}
				lease.release();
			}
		});
	}

	issue(input: QuotaConnectionIssue): { reference: string; release: () => void } {
		const parsed = customApiQuotaTargetSchema.safeParse(input.target);
		const source = providerQuotaSourceSchema.safeParse(input.source);
		if (!parsed.success || !source.success) throw new ProviderQuotaError("permission_denied");
		const target = this.directory.getTarget(parsed.data);
		if (
			!target?.valid ||
			target.target.id !== parsed.data.id ||
			target.target.generation !== parsed.data.generation ||
			input.signal.aborted ||
			!input.principal.pluginId ||
			!input.principal.installationId ||
			!input.principal.runtimeId ||
			!Number.isSafeInteger(input.principal.runtimeGeneration) ||
			input.principal.runtimeGeneration < 0 ||
			!Number.isFinite(input.deadlineAt) ||
			input.deadlineAt <= this.now()
		) {
			throw new ProviderQuotaError("permission_denied");
		}
		if (this.leases.size >= (this.options.maxReferences ?? 128)) {
			throw new ProviderQuotaError("queue_full");
		}
		const reference = crypto.randomUUID();
		const controller = new AbortController();
		const deadlineAt = Math.min(input.deadlineAt, this.now() + QUOTA_MAX_QUERY_MS);
		const release = () => {
			this.leases.delete(reference);
			input.signal.removeEventListener("abort", release);
			clearTimeout(timer);
			controller.abort(new ProviderQuotaError("unavailable"));
		};
		const timer = setTimeout(release, Math.max(0, deadlineAt - this.now()));
		timer.unref?.();
		const lease: Lease = {
			...input,
			principal: { ...input.principal },
			target: structuredClone(target.target),
			source: source.data,
			reference,
			deadlineAt,
			controller,
			signal: AbortSignal.any([input.signal, controller.signal]),
			requests: 0,
			active: false,
			release,
		};
		this.leases.set(reference, lease);
		input.signal.addEventListener("abort", release, { once: true });
		if (input.signal.aborted) release();
		return { reference, release };
	}

	async request(
		input: ProviderConnectionRequest,
		principal: QuotaConnectionPrincipal,
		parentSignal?: AbortSignal,
	): Promise<ProviderConnectionResponse> {
		const parsed = providerConnectionRequestSchema.safeParse(input);
		if (!parsed.success) throw new ProviderQuotaError("permission_denied");
		const params = parsed.data;
		const lease = this.leases.get(params.reference);
		if (
			!lease ||
			!samePrincipal(lease.principal, principal) ||
			!safePath(params.path) ||
			lease.active ||
			lease.requests >= lease.source.limits.maxRequests
		) {
			throw new ProviderQuotaError("permission_denied");
		}
		const site = params.destination === "site-account";
		const rule = lease.source.requests.find(
			(candidate) =>
				pathMatches(candidate.path, params.path) && (candidate.auth === "site-token") === site,
		);
		if (
			!rule ||
			Object.keys(params.query ?? {}).length > 16 ||
			Object.keys(params.query ?? {}).some((key) => !rule.queryKeys.includes(key))
		) {
			throw new ProviderQuotaError("permission_denied");
		}
		lease.requests++;
		lease.active = true;
		const requestController = new AbortController();
		const signal = AbortSignal.any([
			lease.signal,
			requestController.signal,
			...(parentSignal ? [parentSignal] : []),
		]);
		const timeout = Math.min(
			QUOTA_MAX_REQUEST_MS,
			lease.source.limits.requestTimeoutMs,
			this.options.requestTimeoutMs ?? QUOTA_MAX_REQUEST_MS,
			lease.deadlineAt - this.now(),
		);
		const timer = setTimeout(
			() => requestController.abort(new ProviderQuotaError("timeout")),
			Math.max(0, timeout),
		);
		const startedAt = performance.now();
		let response: Response | undefined;
		let byteLength = 0;
		try {
			await this.assertLive(lease, signal);
			const connection = this.directory.getTarget(lease.target);
			if (!connection?.valid) throw new ProviderQuotaError("unavailable");
			const root = site ? connection.target.siteQuota?.root : connection.target.baseUrl;
			if (
				!root ||
				Boolean(connection.target.siteQuota) !== site ||
				(site &&
					(Object.keys(params.query ?? {}).length !== 0 ||
						params.path !== new URL(`${root.replace(/\/+$/, "")}/api/user/self`).pathname))
			)
				throw new ProviderQuotaError("permission_denied");
			const base = new URL(root);
			const url = new URL(params.path, base.origin);
			for (const [key, value] of Object.entries(params.query ?? {}))
				url.searchParams.set(key, value);
			if (
				url.origin !== base.origin ||
				url.username ||
				url.password ||
				url.hash ||
				url.pathname !== params.path ||
				url.toString().length > 4_096
			) {
				throw new ProviderQuotaError("permission_denied");
			}
			const config = connection.config;
			const headers = quotaConnectionHeaders(config, rule, params.headers);
			// Check again immediately before dispatch (authority checks may have awaited).
			await this.assertLive(lease, signal);
			this.assertConnectionIdentity(lease, signal);
			response = await quotaAbortable(
				this.fetcher(
					url.toString(),
					{
						method: "GET",
						headers,
						redirect: "error",
						signal,
					},
					{
						proxyUrl: resolveProxyForUrl(url.toString(), config.proxy),
						tlsRejectUnauthorized: config.tlsRejectUnauthorized,
						retryPolicy: "never",
					},
				),
				signal,
				(late) => void late.body?.cancel().catch(() => {}),
			);
			if (response.redirected || (response.url && new URL(response.url).origin !== base.origin)) {
				throw new ProviderQuotaError("permission_denied");
			}
			if (!response.ok) {
				// HTTP failure classification belongs to the plugin, not its arbitrary error body.
				// Cancel rather than reading an unbounded/credential-bearing failure stream.
				await this.assertLive(lease, signal);
				return {
					status: response.status,
					contentType: response.headers.get("content-type")?.slice(0, 256) ?? null,
					body: "",
					bytes: 0,
				};
			}
			const limit = Math.min(QUOTA_MAX_RESPONSE_BYTES, lease.source.limits.maxResponseBytes);
			if (Number(response.headers.get("content-length")) > limit) {
				throw new ProviderQuotaError("invalid_response");
			}
			const chunks: Uint8Array[] = [];
			const reader = response.body?.getReader();
			if (reader) {
				const cancel = () => void reader.cancel().catch(() => {});
				signal.addEventListener("abort", cancel, { once: true });
				try {
					while (true) {
						const { value, done } = await quotaAbortable(reader.read(), signal);
						if (done) break;
						byteLength += value.byteLength;
						if (byteLength > limit) throw new ProviderQuotaError("invalid_response");
						chunks.push(value);
					}
				} finally {
					signal.removeEventListener("abort", cancel);
					cancel();
					reader.releaseLock();
				}
			}
			await this.assertLive(lease, signal);
			const bytes = new Uint8Array(byteLength);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return {
				status: response.status,
				contentType: response.headers.get("content-type")?.slice(0, 256) ?? null,
				body: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
				bytes: byteLength,
			};
		} catch (error) {
			throw error instanceof ProviderQuotaError ? error : new ProviderQuotaError("request_failed");
		} finally {
			lease.active = false;
			clearTimeout(timer);
			if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
			const durationMs = Math.round(performance.now() - startedAt);
			if (durationMs >= 2_000)
				logger.warn("plugin quota connection slow", {
					pluginId: lease.principal.pluginId,
					contributionId: lease.source.id,
					targetId: lease.target.id,
					status: response?.status ?? 0,
					durationMs,
					bytes: byteLength,
				});
		}
	}

	private assertConnectionIdentity(lease: Lease, signal: AbortSignal): void {
		if (
			signal.aborted ||
			this.leases.get(lease.reference) !== lease ||
			lease.deadlineAt <= this.now()
		) {
			lease.release();
			throw new ProviderQuotaError("unavailable");
		}
		const current = this.directory.getTarget(lease.target);
		if (
			!current?.valid ||
			current.target.id !== lease.target.id ||
			current.target.generation !== lease.target.generation
		) {
			lease.release();
			throw new ProviderQuotaError("permission_denied");
		}
	}

	private async assertLive(lease: Lease, signal: AbortSignal): Promise<void> {
		this.assertConnectionIdentity(lease, signal);
		if (!(await quotaAbortable(Promise.resolve(lease.isCurrent()), signal))) {
			lease.release();
			throw new ProviderQuotaError("permission_denied");
		}
		// An authority check can yield; the account may have changed without notifying the
		// directory yet. Re-read the live connection after the await, not just the lease map.
		this.assertConnectionIdentity(lease, signal);
	}

	revokePlugin(pluginId: string): void {
		for (const lease of this.leases.values())
			if (lease.principal.pluginId === pluginId) lease.release();
	}

	dispose(): void {
		for (const lease of this.leases.values()) lease.release();
		this.unsubscribe();
	}

	get activeReferences(): number {
		return this.leases.size;
	}
}

export const pluginProviderConnectionService = new PluginProviderConnectionService();
