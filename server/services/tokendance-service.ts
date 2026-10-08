import { createHash, randomBytes } from "node:crypto";
import {
	parseTokenDanceRecoveryAction,
	selectTokenDanceProtocol,
	TOKENDANCE_APP_URL,
	TOKENDANCE_ORIGIN,
	type TokenDanceCatalogModel,
	type TokenDanceDraftRestore,
	type TokenDanceDraftSnapshot,
	type TokenDanceOAuthComplete,
	type TokenDanceOAuthStart,
	type TokenDancePublicConnection,
	type TokenDanceRecoveryAction,
} from "@shared/tokendance";
import { maskSecretValues } from "../lib/agent/request-dump";
import { normalizeConfiguredOrigins, resolveAllowedCorsOrigin } from "../lib/cors-origin";
import { AppError } from "../lib/errors";
import { saveSettings, settings } from "../lib/settings";
import { settingsUpdateLock } from "../lib/settings/write-lock";
import { registerTokenDanceRuntime } from "../lib/tokendance-runtime";

registerTokenDanceRuntime({
	setTokenDanceRecoveryAction,
	getTokenDanceRuntimeConfig,
	assertTokenDanceConnection,
	registerTokenDanceRequest,
	getTokenDanceCatalogModels,
});

const TTL = 10 * 60_000;
const MAX_SNAPSHOT = 1024 * 1024;
const MAX_SNAPSHOTS = 8 * MAX_SNAPSHOT;
interface Flow {
	owner: string;
	verifier?: string;
	expiresAt: number;
	generation: number;
	status: TokenDanceDraftRestore["status"];
	snapshot?: TokenDanceDraftSnapshot;
	bytes: number;
	controller?: AbortController;
}
const flows = new Map<string, Flow>();
const requests = new Set<AbortController>();
let models: TokenDanceCatalogModel[] = [];
let modelsGeneration = -1;
let recoveryAction: TokenDanceRecoveryAction | undefined;

function fail(message: string, status = 400, action?: TokenDanceRecoveryAction): AppError {
	return Object.assign(new AppError(message, status, "TOKENDANCE_ERROR"), {
		extra: action ? { recoveryAction: action } : undefined,
	});
}
function assertNoPrefixConflict(): void {
	const providers = [
		...(settings.customApiProviders ?? []),
		...(settings.openaiProviders ?? []),
		...(settings.anthropicProviders ?? []),
		...(settings.geminiProviders ?? []),
		...(settings.nugProviders ?? []),
	];
	if (providers.some((provider) => provider.prefix === "tokendance")) {
		throw new AppError(
			"Rename the existing custom provider prefix tokendance before connecting TokenDance",
			409,
			"TOKENDANCE_PREFIX_CONFLICT",
		);
	}
}
function assertGeneration(expected: number): void {
	if (!settings.tokendance?.apiKey || generation() !== expected) {
		throw fail("TokenDance connection changed", 409);
	}
}
function normalizeCatalog(entries: unknown): TokenDanceCatalogModel[] {
	if (!Array.isArray(entries)) return [];
	const next: TokenDanceCatalogModel[] = [];
	let bytes = 0;
	const seen = new Set<string>();
	for (const entry of entries.slice(0, 10_000)) {
		const model = record(entry);
		if (
			!model ||
			typeof model.id !== "string" ||
			!/^[!-~]+$/.test(model.id) ||
			model.id.length > 512 ||
			(!!settings.tokendance?.apiKey &&
				model.id.length >= settings.tokendance.apiKey.length &&
				maskSecretValues(model.id, [settings.tokendance.apiKey]) !== model.id) ||
			seen.has(model.id) ||
			!Array.isArray(model.supported_protocols) ||
			model.supported_protocols.length > 64 ||
			!model.supported_protocols.every((p) => typeof p === "string") ||
			!selectTokenDanceProtocol(model.supported_protocols)
		)
			continue;
		const item: TokenDanceCatalogModel = {
			id: model.id,
			name: typeof model.name === "string" ? model.name.slice(0, 512) : model.id,
			context_length:
				typeof model.context_length === "number" &&
				Number.isSafeInteger(model.context_length) &&
				model.context_length > 0
					? model.context_length
					: 0,
			supported_protocols: [
				...new Set(
					model.supported_protocols.filter((p) =>
						[
							"openai:responses",
							"anthropic:messages",
							"openai:chat-completions",
							"gemini:generate-content",
						].includes(p),
					),
				),
			],
		};
		const secret = settings.tokendance?.apiKey;
		if (secret) {
			if (item.name.length >= secret.length) item.name = maskSecretValues(item.name, [secret]);
			item.supported_protocols = item.supported_protocols.filter(
				(protocol) =>
					protocol.length < secret.length || maskSecretValues(protocol, [secret]) === protocol,
			);
			if (!selectTokenDanceProtocol(item.supported_protocols)) continue;
		}
		bytes += Buffer.byteLength(JSON.stringify(item));
		if (bytes > MAX_SNAPSHOT || next.length >= 1000) break;
		seen.add(item.id);
		next.push(item);
	}
	return next;
}
function generation(): number {
	return settings.tokendance?.generation ?? 0;
}
function cleanup(): void {
	for (const [id, flow] of flows) {
		if (flow.expiresAt <= Date.now()) {
			flow.controller?.abort();
			flows.delete(id);
		}
	}
}
const cleanupTimer = setInterval(cleanup, 60_000);
cleanupTimer.unref();

export function getTokenDanceRuntimeConfig():
	| { apiKey: string; generation: number; disabled: boolean }
	| undefined {
	const config = settings.tokendance;
	return config?.apiKey
		? { apiKey: config.apiKey, generation: config.generation, disabled: config.disabled }
		: undefined;
}
export function getTokenDanceCatalogModels(): TokenDanceCatalogModel[] {
	if (!getTokenDanceRuntimeConfig()) return [];
	if (modelsGeneration !== generation()) {
		models = normalizeCatalog(settings.tokendance?.models ?? []);
		modelsGeneration = generation();
	}
	return structuredClone(models);
}
export function setTokenDanceRecoveryAction(
	action: TokenDanceRecoveryAction | undefined,
	expected: number,
): void {
	if (settings.tokendance?.apiKey && generation() === expected)
		recoveryAction = parseTokenDanceRecoveryAction(action);
}
export function getTokenDanceConnection(): TokenDancePublicConnection {
	return {
		connected: !!settings.tokendance?.apiKey,
		name: "TokenDance",
		disabled: settings.tokendance?.disabled ?? false,
		generation: generation(),
		models: getTokenDanceCatalogModels(),
		...(recoveryAction && settings.tokendance?.apiKey ? { recoveryAction } : {}),
	};
}
export function assertTokenDanceConnection(expected: number): void {
	const config = getTokenDanceRuntimeConfig();
	if (!config || config.disabled || config.generation !== expected) {
		throw fail("TokenDance connection changed or is disabled", 409);
	}
}
export function registerTokenDanceRequest(
	controller: AbortController,
	expected: number,
): () => void {
	assertTokenDanceConnection(expected);
	requests.add(controller);
	return () => requests.delete(controller);
}

async function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw fail("TokenDance request cancelled", 502);
	let abort!: () => void;
	const cancelled = new Promise<never>((_resolve, reject) => {
		abort = () => reject(fail("TokenDance request cancelled", 502));
		signal.addEventListener("abort", abort, { once: true });
	});
	try {
		return await Promise.race([promise, cancelled]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}
async function boundedJson(
	url: string,
	init: RequestInit,
	limit: number,
	controller: AbortController,
): Promise<{ ok: boolean; body: unknown; action?: TokenDanceRecoveryAction }> {
	const timer = setTimeout(() => controller.abort(), 30_000);
	try {
		const response = await untilAbort(
			fetch(url, { ...init, signal: controller.signal, redirect: "error" }),
			controller.signal,
		);
		const action = parseTokenDanceRecoveryAction(
			response.headers.get("TokenDance-Recovery-Action"),
		);
		// Recovery is determined by the header, not by whether an error body can be read.
		// We never expose error bodies here, so cancel them instead of waiting or buffering.
		if (!response.ok) {
			void response.body?.cancel().catch(() => {});
			return { ok: false, body: undefined, action };
		}
		if (Number(response.headers.get("content-length")) > limit) {
			void response.body?.cancel().catch(() => {});
			throw fail("TokenDance response exceeds size limit", 502);
		}
		const reader = response.body?.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		if (reader) {
			try {
				while (true) {
					const { done, value } = await untilAbort(reader.read(), controller.signal);
					if (done) break;
					size += value.byteLength;
					if (size > limit) {
						void reader.cancel().catch(() => {});
						throw fail("TokenDance response exceeds size limit", 502);
					}
					chunks.push(value);
				}
			} finally {
				reader.releaseLock();
			}
		}
		return {
			ok: response.ok,
			body: response.ok ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined,
			action: parseTokenDanceRecoveryAction(response.headers.get("TokenDance-Recovery-Action")),
		};
	} catch {
		throw fail("TokenDance request failed; retry or reauthorize", 502);
	} finally {
		clearTimeout(timer);
	}
}
function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
export function validateTokenDanceSnapshot(value: unknown): TokenDanceDraftSnapshot | undefined {
	if (value === undefined) return undefined;
	const input = record(value);
	if (
		!input ||
		!record(input.draft) ||
		!record(input.baseline) ||
		(input.addPage !== undefined && !record(input.addPage)) ||
		Object.keys(input).some((key) => !["draft", "baseline", "addPage"].includes(key))
	) {
		throw fail("Invalid draft snapshot");
	}
	const stack: { value: unknown; depth: number }[] = [{ value: input, depth: 0 }];
	let nodes = 0;
	while (stack.length) {
		const item = stack.pop();
		if (!item) break;
		if (++nodes > 100_000 || item.depth > 64) throw fail("Draft snapshot is too complex", 413);
		if (settings.tokendance?.apiKey && item.value === settings.tokendance.apiKey) {
			throw fail("TokenDance credentials must be excluded from draft snapshots");
		}
		const entries = Array.isArray(item.value)
			? item.value.map((value, index) => [String(index), value] as const)
			: record(item.value)
				? Object.entries(item.value as Record<string, unknown>)
				: [];
		if (entries.length + nodes + stack.length > 100_000)
			throw fail("Draft snapshot is too complex", 413);
		for (const [key, child] of entries) {
			// Reject platform credential/config fields, not model-reference maps or custom headers.
			const field = key.replace(/[-_]/g, "").toLowerCase();
			if (
				/^(tokendance(?:apikey|key|credentials?|connection|oauth|token)?|(?:apikey|credentials?|token)tokendance)$/.test(
					field,
				)
			)
				throw fail("TokenDance fields must be excluded from draft snapshots");
			stack.push({ value: child, depth: item.depth + 1 });
		}
	}
	const serialized = JSON.stringify(input);
	if (Buffer.byteLength(serialized) > MAX_SNAPSHOT) throw fail("Draft snapshot exceeds 1 MiB", 413);
	return JSON.parse(serialized) as TokenDanceDraftSnapshot;
}
export function validateTokenDanceCallback(
	callbackUrl: string,
	requestUrl: string,
	origin?: string,
): URL {
	let callback: URL;
	try {
		callback = new URL(callbackUrl);
	} catch {
		throw fail("Invalid callback URL");
	}
	const self = new URL(requestUrl);
	const selfOrigin = self.origin;
	const configured = normalizeConfiguredOrigins(settings.server.allowedOrigins);
	const caller = origin ?? selfOrigin;
	// A TLS-terminating proxy may preserve the public Host while using HTTP upstream.
	// Permit only this same-authority upgrade; never infer hosts from forwarded headers.
	let tlsUpgrade = false;
	try {
		const publicOrigin = new URL(caller);
		tlsUpgrade =
			self.protocol === "http:" &&
			publicOrigin.protocol === "https:" &&
			publicOrigin.host === self.host;
	} catch {
		/* malformed origin is rejected below */
	}
	if (
		!["http:", "https:"].includes(callback.protocol) ||
		callback.username ||
		callback.password ||
		callback.search ||
		callback.hash ||
		callback.origin !== caller ||
		(!tlsUpgrade && !resolveAllowedCorsOrigin(caller, { selfOrigin, configured })) ||
		!callback.pathname.endsWith("/settings/providers/tokendance/callback")
	) {
		throw fail("Callback must be the first-party TokenDance settings callback");
	}
	return callback;
}
export function startTokenDanceOAuth(
	owner: string,
	callback: URL,
	draftSnapshot?: unknown,
): TokenDanceOAuthStart {
	cleanup();
	assertNoPrefixConflict();
	const snapshot = validateTokenDanceSnapshot(draftSnapshot);
	const bytes = snapshot ? Buffer.byteLength(JSON.stringify(snapshot)) : 0;
	if (
		flows.size >= 100 ||
		[...flows.values()].filter((flow) => flow.owner === owner).length >= 10
	) {
		throw fail("Too many pending TokenDance authorization flows", 429);
	}
	if ([...flows.values()].reduce((sum, flow) => sum + flow.bytes, 0) + bytes > MAX_SNAPSHOTS) {
		throw fail("Draft snapshot storage is full", 413);
	}
	const flowId = randomBytes(32).toString("base64url");
	const verifier = randomBytes(32).toString("base64url");
	const expiresAt = Date.now() + TTL;
	flows.set(flowId, {
		owner,
		verifier,
		expiresAt,
		generation: generation(),
		status: "pending",
		snapshot,
		bytes,
	});
	const returnUrl = new URL(callback);
	returnUrl.searchParams.set("state", flowId);
	const authorize = new URL("/auth", TOKENDANCE_ORIGIN);
	authorize.searchParams.set("app_url", TOKENDANCE_APP_URL);
	authorize.searchParams.set("key_name", "NarraFork");
	authorize.searchParams.set("callback_url", returnUrl.href);
	authorize.searchParams.set(
		"code_challenge",
		createHash("sha256").update(verifier).digest("base64url"),
	);
	authorize.searchParams.set("code_challenge_method", "S256");
	return { authorizeUrl: authorize.href, flowId, expiresAt };
}
function ownedFlow(owner: string, id: string): Flow {
	cleanup();
	const flow = flows.get(id);
	if (!flow || flow.owner !== owner)
		throw fail("Authorization flow expired or unavailable; start again", 404);
	return flow;
}
export function restoreTokenDanceDraft(owner: string, id: string): TokenDanceDraftRestore {
	const flow = ownedFlow(owner, id);
	const draftSnapshot = flow.snapshot;
	flow.snapshot = undefined;
	flow.bytes = 0;
	return { status: flow.status, ...(draftSnapshot ? { draftSnapshot } : {}) };
}
export function cancelTokenDanceOAuth(owner: string, id: string): void {
	const flow = ownedFlow(owner, id);
	flow.verifier = undefined;
	flow.controller?.abort();
	flow.status = "cancelled";
}
export async function completeTokenDanceOAuth(
	owner: string,
	id: string,
	code: string,
): Promise<TokenDanceOAuthComplete> {
	const flow = ownedFlow(owner, id);
	if (!flow.verifier || flow.status !== "pending")
		throw fail("Authorization flow was already consumed", 409);
	const verifier = flow.verifier;
	flow.verifier = undefined; // Claim synchronously before the first await; never replay an exchange.
	const controller = new AbortController();
	flow.controller = controller;
	try {
		const response = await boundedJson(
			`${TOKENDANCE_ORIGIN}/portal/api/v1/auth/keys`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json", "X-App-URL": TOKENDANCE_APP_URL },
				body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
			},
			64 * 1024,
			controller,
		);
		const body = record(response.body);
		const key = body?.key;
		if (
			!response.ok ||
			typeof key !== "string" ||
			key.length < 8 ||
			key.length > 4096 ||
			!/^[!-~]+$/.test(key)
		) {
			throw fail("TokenDance authorization failed; start again", 502, response.action);
		}
		await settingsUpdateLock.acquire("settings", async () => {
			if (
				controller.signal.aborted ||
				flow.expiresAt <= Date.now() ||
				flow.status !== "pending" ||
				flow.generation !== generation()
			) {
				throw fail("TokenDance connection changed during authorization", 409);
			}
			assertNoPrefixConflict();
			const latest = structuredClone(settings);
			latest.tokendance = {
				apiKey: key,
				disabled: false,
				generation: generation() + 1,
				models: [],
			};
			saveSettings(latest);
			models = [];
			recoveryAction = undefined;
			flow.status = "completed";
			invalidateRequests();
		});
	} catch (error) {
		if (flow.status === "pending") flow.status = "failed";
		throw error instanceof AppError
			? error
			: fail("TokenDance authorization failed; start again", 502);
	} finally {
		flow.controller = undefined;
	}
	try {
		await refreshTokenDanceModels();
		return { connected: true, modelsRefreshed: true };
	} catch {
		return {
			connected: true,
			modelsRefreshed: false,
			refreshError: "TokenDance model refresh failed",
			...(recoveryAction ? { recoveryAction } : {}),
		};
	}
}
export async function refreshTokenDanceModels(
	signal?: AbortSignal,
): Promise<TokenDanceCatalogModel[]> {
	const config = getTokenDanceRuntimeConfig();
	if (!config) throw fail("TokenDance is not connected", 409);
	const controller = new AbortController();
	// Catalog management remains available while the runtime provider is disabled.
	assertGeneration(config.generation);
	requests.add(controller);
	const unregister = () => requests.delete(controller);
	const abort = () => controller.abort();
	if (signal?.aborted) controller.abort();
	signal?.addEventListener("abort", abort, { once: true });
	try {
		const response = await boundedJson(
			`${TOKENDANCE_ORIGIN}/gateway/v1/models`,
			{
				headers: { Authorization: `Bearer ${config.apiKey}`, "X-App-URL": TOKENDANCE_APP_URL },
			},
			8 * 1024 * 1024,
			controller,
		);
		assertGeneration(config.generation);
		if (controller.signal.aborted) throw fail("TokenDance request cancelled", 409);
		const body = record(response.body);
		if (!response.ok) {
			recoveryAction = response.action;
			throw fail("TokenDance model refresh failed", 502, recoveryAction);
		}
		const entries = body?.data;
		if (!Array.isArray(entries)) throw fail("Invalid TokenDance model catalog", 502);
		const next = normalizeCatalog(entries);
		await settingsUpdateLock.acquire("settings", async () => {
			assertGeneration(config.generation);
			if (controller.signal.aborted) throw fail("TokenDance request cancelled", 409);
			const latest = structuredClone(settings);
			latest.tokendance = { ...config, models: next };
			saveSettings(latest);
		});
		models = next;
		modelsGeneration = config.generation;
		recoveryAction = undefined;
		return structuredClone(next);
	} finally {
		unregister();
		signal?.removeEventListener("abort", abort);
	}
}
function invalidateRequests(): void {
	for (const controller of requests) controller.abort();
	requests.clear();
	for (const flow of flows.values()) {
		flow.controller?.abort();
		flow.verifier = undefined;
		if (flow.status === "pending") flow.status = "cancelled";
	}
}
export async function setTokenDanceDisabled(
	disabled: boolean,
): Promise<TokenDancePublicConnection> {
	return settingsUpdateLock.acquire("settings", async () => {
		if (!settings.tokendance?.apiKey) throw fail("TokenDance is not connected", 409);
		const cached = getTokenDanceCatalogModels();
		const latest = structuredClone(settings);
		latest.tokendance = { ...settings.tokendance, disabled, generation: generation() + 1 };
		models = cached;
		saveSettings(latest);
		invalidateRequests();
		modelsGeneration = generation();
		return getTokenDanceConnection();
	});
}
export async function deleteTokenDanceConnection(): Promise<void> {
	await settingsUpdateLock.acquire("settings", async () => {
		const latest = structuredClone(settings);
		latest.tokendance = { apiKey: "", disabled: false, generation: generation() + 1 };
		// Only model-reference fields belong to this connection. Prompts, permission
		// patterns and retry keywords may legitimately start with the same text.
		// Disconnected installations may also have an unrelated legacy manual prefix.
		if (settings.tokendance?.apiKey) {
			const agent = latest.agent;
			const isReference = (value: unknown) =>
				typeof value === "string" && (value === "tokendance" || value.startsWith("tokendance:"));
			for (const field of [
				"defaultModel",
				"summaryModel",
				"translationModel",
				"promptOptimizeModel",
			] as const) {
				if (isReference(agent[field])) agent[field] = "";
			}
			for (const field of ["hiddenModels", "disabledProviders", "providerOrder"] as const) {
				const values = agent[field];
				if (values) agent[field] = values.filter((value) => !isReference(value));
			}
			if (agent.customModels)
				agent.customModels = agent.customModels.filter((model) => !isReference(model.value));
			if (agent.modelCards)
				agent.modelCards = agent.modelCards.filter((card) => !isReference(card.modelKey));
			if (agent.modelContextWindows)
				agent.modelContextWindows = Object.fromEntries(
					Object.entries(agent.modelContextWindows).filter(([key]) => !isReference(key)),
				);
			if (agent.subagentModels) {
				for (const key of Object.keys(
					agent.subagentModels,
				) as (keyof typeof agent.subagentModels)[]) {
					if (isReference(agent.subagentModels[key])) agent.subagentModels[key] = "";
				}
			}
			if (agent.subagentAllowedModels) {
				for (const key of Object.keys(
					agent.subagentAllowedModels,
				) as (keyof typeof agent.subagentAllowedModels)[]) {
					const values = agent.subagentAllowedModels[key];
					if (values)
						agent.subagentAllowedModels[key] = values.filter((value) => !isReference(value));
				}
			}
			if (agent.modelAggregations)
				agent.modelAggregations = agent.modelAggregations
					.map((aggregation) => ({
						...aggregation,
						models: aggregation.models.filter((value) => !isReference(value)),
					}))
					.filter((aggregation) => aggregation.models.length > 0);
		}
		saveSettings(latest);
		invalidateRequests();
		models = [];
		modelsGeneration = -1;
		recoveryAction = undefined;
	});
}
