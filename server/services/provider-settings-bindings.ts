import { AppError } from "@server/lib/errors";
import { logger } from "@server/lib/logger";
import {
	type ProviderSettingsContribution,
	providerSettingsContributionSchema,
} from "@shared/provider-settings";
import {
	PROVIDER_SETTINGS_RPC_LIMITS,
	providerSettingsConnectionParamsSchema,
	providerSettingsGetParamsSchema,
} from "@shared/provider-settings-rpc";
import type { ProviderSettingsValues } from "@shared/provider-settings-values";

import { normalizeProviderSettingsRoot } from "./provider-settings-config-policy";

export interface ProviderSettingsPrincipal {
	pluginId: string;
	installationId: string;
	runtimeId: string;
	runtimeGeneration: number;
}
export type ProviderSettingsCapability =
	| "provider.settings.read_self"
	| "provider.settings.connection.use";
export interface ProviderSettingsLeaseSnapshot {
	revision: number;
	bindingRevision: string;
	publicValues: ProviderSettingsValues;
	values: ProviderSettingsValues;
	secrets: Record<string, string>;
	/** Saved host connection, never an extension URL. Missing key/root denies that destination. */
	providerRoot?: string;
	providerKey?: string;
	resolveProxy?: (url: string) => string | undefined;
	tlsRejectUnauthorized?: boolean;
}
export interface ProviderSettingsBindingInput {
	principal: ProviderSettingsPrincipal;
	userId: string;
	target: { kind: string; id: string };
	declaration: ProviderSettingsContribution;
	revision: number;
	bindingRevision: string;
	deadlineAt: number;
	signal: AbortSignal;
	/** Host-owned closures. They must check target, package, grant and current runtime generations. */
	authorize: (capability: ProviderSettingsCapability, signal: AbortSignal) => Promise<boolean>;
	isCurrent: () => boolean;
	read: (signal: AbortSignal) => Promise<ProviderSettingsLeaseSnapshot>;
}
interface Lease extends ProviderSettingsBindingInput {
	reference: string;
	controller: AbortController;
	release: () => void;
	requests: number;
	busy: boolean;
}
export interface ProviderSettingsConnectionResult {
	status: number;
	contentType: string | null;
	body: string;
	bytes: number;
}
function failure(code = "PROVIDER_SETTINGS_REFERENCE_INVALID", status = 403): AppError {
	return new AppError("Provider settings operation is unavailable", status, code);
}
function samePrincipal(a: ProviderSettingsPrincipal, b: ProviderSettingsPrincipal): boolean {
	return (
		a.pluginId === b.pluginId &&
		a.installationId === b.installationId &&
		a.runtimeId === b.runtimeId &&
		a.runtimeGeneration === b.runtimeGeneration
	);
}
async function abortable<T>(
	task: Promise<T>,
	signal: AbortSignal,
	late?: (value: T) => void,
): Promise<T> {
	if (signal.aborted) {
		if (late) void task.then(late, () => {});
		throw signal.reason;
	}
	let abort!: () => void;
	let wasAborted = false;
	const stopped = new Promise<never>((_, reject) => {
		abort = () => {
			wasAborted = true;
			reject(signal.reason);
		};
		signal.addEventListener("abort", abort, { once: true });
	});
	if (late)
		void task.then(
			(value) => {
				if (wasAborted) late(value);
			},
			() => {},
		);
	try {
		return await Promise.race([task, stopped]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
/** Ephemeral runtime-bound references; there is deliberately no API to look up a provider by ID. */
export class ProviderSettingsBindings {
	private readonly leases = new Map<string, Lease>();
	constructor(
		private readonly options: {
			fetch: (
				url: string,
				init: RequestInit,
				options: { proxyUrl?: string; tlsRejectUnauthorized?: boolean; retryPolicy: "never" },
			) => Promise<Response>;
			now?: () => number;
		},
	) {}
	private now(): number {
		return this.options.now?.() ?? Date.now();
	}
	issue(input: ProviderSettingsBindingInput): { reference: string; release: () => void } {
		const declaration = providerSettingsContributionSchema.safeParse(input.declaration);
		if (
			!declaration.success ||
			!input.userId ||
			!input.principal.pluginId ||
			!input.principal.installationId ||
			!input.principal.runtimeId ||
			!Number.isSafeInteger(input.principal.runtimeGeneration) ||
			input.principal.runtimeGeneration < 0 ||
			!Number.isSafeInteger(input.revision) ||
			input.revision < 0 ||
			!input.bindingRevision ||
			!Number.isFinite(input.deadlineAt) ||
			input.deadlineAt <= this.now() ||
			input.signal.aborted ||
			!input.isCurrent()
		)
			throw failure();
		if (this.leases.size >= PROVIDER_SETTINGS_RPC_LIMITS.references)
			throw failure("PROVIDER_SETTINGS_BUSY", 429);
		const reference = crypto.randomUUID(),
			controller = new AbortController(),
			deadlineAt = Math.min(input.deadlineAt, this.now() + PROVIDER_SETTINGS_RPC_LIMITS.ttlMs);
		const release = () => {
			this.leases.delete(reference);
			input.signal.removeEventListener("abort", release);
			clearTimeout(timer);
			controller.abort(failure());
		};
		const timer = setTimeout(release, Math.max(1, deadlineAt - this.now()));
		timer.unref?.();
		const lease: Lease = {
			...input,
			principal: { ...input.principal },
			target: { ...input.target },
			declaration: declaration.data,
			reference,
			controller,
			deadlineAt,
			signal: AbortSignal.any([input.signal, controller.signal]),
			release,
			requests: 0,
			busy: false,
		};
		this.leases.set(reference, lease);
		input.signal.addEventListener("abort", release, { once: true });
		if (input.signal.aborted) release();
		return { reference, release };
	}
	private current(lease: Lease, signal: AbortSignal): void {
		if (
			signal.aborted ||
			this.leases.get(lease.reference) !== lease ||
			this.now() >= lease.deadlineAt ||
			!lease.isCurrent()
		) {
			lease.release();
			throw failure();
		}
	}
	private lease(reference: string, principal: ProviderSettingsPrincipal): Lease {
		const lease = this.leases.get(reference);
		if (!lease || !samePrincipal(lease.principal, principal)) throw failure();
		this.current(lease, lease.signal);
		return lease;
	}
	private async snapshot(
		lease: Lease,
		capability: ProviderSettingsCapability,
		signal: AbortSignal,
	): Promise<ProviderSettingsLeaseSnapshot> {
		this.current(lease, signal);
		if (!(await abortable(lease.authorize(capability, signal), signal))) {
			lease.release();
			throw failure();
		}
		this.current(lease, signal);
		const snapshot = await abortable(lease.read(signal), signal);
		this.current(lease, signal);
		if (
			snapshot.revision !== lease.revision ||
			snapshot.bindingRevision !== lease.bindingRevision
		) {
			lease.release();
			throw failure("PROVIDER_SETTINGS_CONFIGURATION_CHANGED", 409);
		}
		return snapshot;
	}
	async authorize(
		reference: unknown,
		principal: ProviderSettingsPrincipal,
		capability: ProviderSettingsCapability,
		signal: AbortSignal,
	): Promise<void> {
		const parsed = providerSettingsGetParamsSchema.safeParse({ reference });
		if (!parsed.success) throw failure();
		const lease = this.lease(parsed.data.reference, principal);
		await this.snapshot(lease, capability, AbortSignal.any([lease.signal, signal]));
	}
	async get(
		input: unknown,
		principal: ProviderSettingsPrincipal,
		signal?: AbortSignal,
	): Promise<{ revision: number; values: ProviderSettingsValues }> {
		const parsed = providerSettingsGetParamsSchema.safeParse(input);
		if (!parsed.success) throw failure();
		const lease = this.lease(parsed.data.reference, principal),
			effective = signal ? AbortSignal.any([lease.signal, signal]) : lease.signal;
		const snapshot = await this.snapshot(lease, "provider.settings.read_self", effective);
		const values = structuredClone(snapshot.publicValues);
		if (Buffer.byteLength(JSON.stringify(values)) > 32 * 1024)
			throw failure("PROVIDER_SETTINGS_INVALID_RESPONSE", 502);
		return { revision: snapshot.revision, values };
	}
	async request(
		input: unknown,
		principal: ProviderSettingsPrincipal,
		parentSignal?: AbortSignal,
	): Promise<ProviderSettingsConnectionResult> {
		const parsed = providerSettingsConnectionParamsSchema.safeParse(input);
		if (!parsed.success) throw failure();
		const lease = this.lease(parsed.data.reference, principal),
			rule = lease.declaration.connections?.find((rule) => rule.id === parsed.data.connectionId);
		if (!rule || lease.busy || lease.requests >= PROVIDER_SETTINGS_RPC_LIMITS.requests)
			throw failure();
		lease.busy = true;
		lease.requests++;
		const controller = new AbortController(),
			signal = AbortSignal.any([
				lease.signal,
				controller.signal,
				...(parentSignal ? [parentSignal] : []),
			]);
		const timer = setTimeout(
			() => controller.abort(failure("PROVIDER_SETTINGS_TIMEOUT", 504)),
			Math.max(1, Math.min(PROVIDER_SETTINGS_RPC_LIMITS.requestMs, lease.deadlineAt - this.now())),
		);
		let response: Response | undefined;
		const started = performance.now();
		try {
			const snapshot = await this.snapshot(lease, "provider.settings.connection.use", signal);
			const extensionRoot =
				rule.destination === "extension" ? snapshot.values[rule.baseUrlField] : undefined;
			const root = normalizeProviderSettingsRoot(
				rule.destination === "provider"
					? (snapshot.providerRoot ?? "")
					: typeof extensionRoot === "string" && extensionRoot
						? extensionRoot
						: rule.whenUrlMissing === "provider-root"
							? (snapshot.providerRoot ?? "")
							: "",
			);
			const base = new URL(root),
				url = new URL(root + rule.path),
				headers = new Headers({ accept: "application/json" });
			const expectedPath = base.pathname.replace(/\/+$/, "") + rule.path;
			if (
				url.origin !== base.origin ||
				url.pathname !== expectedPath ||
				url.username ||
				url.password ||
				url.search ||
				url.hash ||
				url.href.length > 4096
			)
				throw failure();
			const injected: string[] = [];
			if (rule.destination === "provider" && rule.auth === "provider-key") {
				if (!snapshot.providerKey || /[^\x21-\x7e]/u.test(snapshot.providerKey))
					throw failure("PROVIDER_SETTINGS_CONNECTION_UNAVAILABLE", 409);
				headers.set("authorization", `Bearer ${snapshot.providerKey}`);
				injected.push(snapshot.providerKey);
			} else if (rule.destination === "extension") {
				if (rule.auth !== "none") {
					const value = snapshot.secrets[rule.auth.secretField];
					if (!value || /[^\x21-\x7e]/u.test(value))
						throw failure("PROVIDER_SETTINGS_CONNECTION_UNAVAILABLE", 409);
					headers.set(
						rule.auth.kind === "bearer" ? "authorization" : rule.auth.name,
						rule.auth.kind === "bearer" ? `Bearer ${value}` : value,
					);
					injected.push(value);
				}
				for (const header of rule.headers ?? []) {
					const value = snapshot.values[header.field];
					if (
						typeof value !== "string" ||
						!value ||
						value.length > 128 ||
						/[^\x20-\x7e]/u.test(value)
					)
						throw failure("PROVIDER_SETTINGS_CONNECTION_UNAVAILABLE", 409);
					headers.set(header.name, value);
				}
			}
			// Re-check asynchronous authority/config work and then synchronously fence the
			// current runtime/target immediately before dispatching a credential-bearing request.
			await this.snapshot(lease, "provider.settings.connection.use", signal);
			this.current(lease, signal);
			response = await abortable(
				this.options.fetch(
					url.href,
					{ method: "GET", headers, redirect: "error", signal },
					{
						proxyUrl: snapshot.resolveProxy?.(url.href),
						tlsRejectUnauthorized: snapshot.tlsRejectUnauthorized,
						retryPolicy: "never",
					},
				),
				signal,
				(late) => {
					void late.body?.cancel().catch(() => {});
				},
			);
			if (
				response.redirected ||
				(response.status >= 300 && response.status < 400) ||
				(response.url && response.url !== url.href)
			)
				throw failure();
			if (!response.ok) {
				await this.snapshot(lease, "provider.settings.connection.use", signal);
				return { status: response.status, contentType: null, body: "", bytes: 0 };
			}
			if (
				Number(response.headers.get("content-length")) > PROVIDER_SETTINGS_RPC_LIMITS.responseBytes
			)
				throw failure("PROVIDER_SETTINGS_INVALID_RESPONSE", 502);
			const reader = response.body?.getReader(),
				chunks: Uint8Array[] = [];
			let count = 0;
			if (reader) {
				const cancel = () => void reader.cancel().catch(() => {});
				signal.addEventListener("abort", cancel, { once: true });
				try {
					while (true) {
						const part = await abortable(reader.read(), signal);
						if (part.done) break;
						count += part.value.byteLength;
						if (count > PROVIDER_SETTINGS_RPC_LIMITS.responseBytes)
							throw failure("PROVIDER_SETTINGS_INVALID_RESPONSE", 502);
						chunks.push(part.value);
					}
				} finally {
					signal.removeEventListener("abort", cancel);
					cancel();
					reader.releaseLock();
				}
			}
			const body = new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks));
			// Reject reflected secrets as a fixed error. Repeated substitution can amplify
			// adversarial one-character secrets beyond the response's memory budget.
			const contentType = response.headers.get("content-type")?.slice(0, 256) ?? null;
			for (const value of [...injected, ...Object.values(snapshot.secrets)])
				if (value && (body.includes(value) || contentType?.includes(value)))
					throw failure("PROVIDER_SETTINGS_INVALID_RESPONSE", 502);
			await this.snapshot(lease, "provider.settings.connection.use", signal);
			this.current(lease, signal);
			return {
				status: response.status,
				contentType,
				body,
				bytes: Buffer.byteLength(body),
			};
		} catch (error) {
			if (error instanceof AppError) throw error;
			throw failure("PROVIDER_SETTINGS_REQUEST_FAILED", 502);
		} finally {
			lease.busy = false;
			clearTimeout(timer);
			if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
			const elapsed = performance.now() - started;
			if (elapsed > 2000)
				logger.warn("Slow provider settings connection", {
					pluginId: lease.principal.pluginId,
					contributionId: lease.declaration.id,
					durationMs: Math.round(elapsed),
				});
		}
	}
	revokePlugin(pluginId: string): void {
		for (const lease of this.leases.values())
			if (lease.principal.pluginId === pluginId) lease.release();
	}
	revokeTarget(kind: string, id: string): void {
		for (const lease of this.leases.values())
			if (lease.target.kind === kind && lease.target.id === id) lease.release();
	}
	close(): void {
		for (const lease of this.leases.values()) lease.release();
	}
	get activeReferences(): number {
		return this.leases.size;
	}
}
