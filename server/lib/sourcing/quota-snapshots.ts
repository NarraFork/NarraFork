import { createHmac, randomBytes } from "node:crypto";
import type {
	PublicQuotaSnapshot,
	QuotaSnapshot,
	QuotaSnapshotEntry,
	QuotaSnapshotsResponse,
} from "@shared/quota-snapshot";
import {
	getTokenDanceBalance,
	getTokenDanceQuotaSnapshot,
	isTokenDanceQuotaRefreshing,
} from "../../services/tokendance-service";
import { getCodexManager } from "../codex-manager";
import { resolveCommandCodeToken } from "../commandcode-manager";
import {
	commandCodeUsageSnapshot,
	fetchCommandCodeUsage,
	getCommandCodeQuotaSnapshot,
	isCommandCodeQuotaRefreshing,
	refreshCommandCodeQuota,
} from "../commandcode-usage";
import { getCustomApiQuotaSnapshot } from "../custom-api-quota-cache";
import {
	getDeepSeekQuotaSnapshot,
	isDeepSeekQuotaRefreshing,
	refreshStaleDeepSeekBalances,
} from "../deepseek-balance-cache";
import { AppError } from "../errors";
import {
	getKimiQuotaSnapshot,
	isKimiQuotaRefreshing,
	KIMI_USAGES_STALE_MS,
	refreshStaleKimiUsages,
} from "../kimi-usage-cache";
import { getNugQuotaSnapshot, isNugQuotaRefreshing } from "../nug-quota-cache";
import {
	getOpencodeQuotaSnapshot,
	isOpencodeQuotaRefreshing,
	refreshStaleOpencodeUsages,
} from "../opencode-usage-cache";
import { providerBalanceCache } from "../provider-balance-cache";
import { usageSubjects } from "../provider-key-subjects";
import {
	COMMAND_CODE_KEY_OWNER,
	getProviderKeyStore,
	nugKeyOwner,
	TOKENDANCE_KEY_OWNER,
} from "../provider-keys";
import { settings } from "../settings";
import { STREAM_QUOTA_SOURCE } from "./quota-store";
import { listSourceGroups, type SourceGroupView } from "./source-groups";
import { getServiceTemplate } from "./templates";

/** Explicit field projection; neither private detail nor raw upstream errors can escape. */
export function publicQuotaSnapshot(
	snapshot: QuotaSnapshot | undefined,
): PublicQuotaSnapshot | null {
	if (!snapshot) return null;
	return {
		fetchedAt: snapshot.fetchedAt,
		scope: snapshot.scope,
		windows: snapshot.windows.map(
			({ kind, label, usedRatio, resetsAt, used, total, remaining, unit }) => ({
				kind,
				...(label ? { label } : {}),
				usedRatio,
				resetsAt,
				...(typeof used === "number" && Number.isFinite(used) ? { used } : {}),
				...(typeof total === "number" && Number.isFinite(total) ? { total } : {}),
				...(typeof remaining === "number" && Number.isFinite(remaining) ? { remaining } : {}),
				...(typeof unit === "string" ? { unit } : {}),
			}),
		),
		balances: snapshot.balances.map(({ unit, remaining, total, unlimited }) => ({
			unit,
			remaining,
			...(total !== undefined ? { total } : {}),
			...(unlimited !== undefined ? { unlimited } : {}),
		})),
		...(snapshot.plan ? { plan: snapshot.plan } : {}),
		...(snapshot.expiresAt !== undefined ? { expiresAt: snapshot.expiresAt } : {}),
		hasError: !!snapshot.error,
		...(snapshot.error ? { error: "quota_unavailable" } : {}),
	};
}

function credentialIds(group: SourceGroupView): string[] {
	if (group.templateId === "codex") return getCodexManager().quotaCredentialIds;
	if (group.templateId === "plugin") return [];
	const owner =
		group.templateId === "nug"
			? nugKeyOwner(group.id)
			: group.templateId === "tokendance"
				? TOKENDANCE_KEY_OWNER
				: group.templateId === "command-code"
					? COMMAND_CODE_KEY_OWNER
					: group.id;
	const keys = getProviderKeyStore().list(owner);
	if (keys.length) return keys.map((key) => key.id);
	const hasKey =
		group.templateId === "tokendance"
			? settings.tokendance?.apiKey
			: group.templateId === "command-code"
				? settings.commandCode?.apiKey
				: group.templateId === "nug"
					? settings.nugProviders?.find((p) => p.id === group.id)?.apiKey
					: settings.customApiProviders?.find((p) => p.id === group.id)?.apiKey;
	return hasKey ? [group.id] : [];
}

function directSnapshot(group: SourceGroupView, id: string): QuotaSnapshot | undefined {
	switch (group.templateId) {
		case "codex":
			return getServiceTemplate("codex").projectQuota?.(id);
		case "kimi-code":
			return getKimiQuotaSnapshot(id);
		case "opencode-go":
			return getOpencodeQuotaSnapshot(id);
		case "deepseek":
			return getDeepSeekQuotaSnapshot(group.id, id);
		case "nug": {
			const quota = getNugQuotaSnapshot(group.id, id);
			return quota?.credentialId === id ? quota.snapshot : undefined;
		}
		case "tokendance": {
			const quota = getTokenDanceQuotaSnapshot();
			return quota?.credentialId === id ? quota.snapshot : undefined;
		}
		case "command-code":
			return getCommandCodeQuotaSnapshot(id)?.snapshot;
		default: {
			const quota = providerBalanceCache.quotaSnapshot(group.id);
			return quota?.credentialId === id ? quota.snapshot : undefined;
		}
	}
}

function sourceRefreshing(group: SourceGroupView, id: string | null): boolean {
	if (group.disabled) return false;
	switch (group.templateId) {
		case "kimi-code":
			return !!id && isKimiQuotaRefreshing(id);
		case "opencode-go":
			return !!id && isOpencodeQuotaRefreshing(id);
		case "deepseek":
			return isDeepSeekQuotaRefreshing(group.id, id ?? undefined);
		case "nug":
			return isNugQuotaRefreshing(group.id, id ?? undefined);
		case "tokendance":
			return isTokenDanceQuotaRefreshing();
		case "command-code":
			return isCommandCodeQuotaRefreshing(id ?? undefined);
		default:
			return providerBalanceCache.isRefreshing(group.id, id ?? undefined);
	}
}

/** Anonymous Codex allowance only; project state, never trigger the account usage queue. */
function codexOverview(): PublicQuotaSnapshot | null {
	const ids = getCodexManager().quotaCredentialIds;
	const snapshots = ids
		.map((id) => getServiceTemplate("codex").projectQuota?.(id))
		.filter((snapshot): snapshot is QuotaSnapshot => !!snapshot);
	if (!snapshots.length) return null;
	const windows: PublicQuotaSnapshot["windows"] = [];
	const groups = new Map<string, PublicQuotaSnapshot["windows"]>();
	for (const snapshot of snapshots) {
		for (const window of snapshot.windows) {
			const key = JSON.stringify([window.kind, window.label ?? null]);
			const group = groups.get(key);
			if (group) group.push(window);
			else groups.set(key, [window]);
		}
	}
	for (const matched of groups.values()) {
		const { kind, label } = matched[0];
		const ratios = matched.flatMap((window) =>
			window.usedRatio === null ? [] : [window.usedRatio],
		);
		// Known plans without this window do not participate. An entirely missing account
		// or an account with no known windows still leaves coverage unknown, as does an
		// unknown ratio in an applicable window.
		// An unnamed `other` on an account missing this window might be that window, so it
		// cannot prove non-applicability. Nor can unnamed periods safely be merged together.
		const complete =
			snapshots.length === ids.length &&
			snapshots.every((snapshot) => snapshot.windows.length > 0) &&
			snapshots.every(
				(snapshot) =>
					snapshot.windows.some(
						(window) => window.kind === kind && (window.label ?? null) === (label ?? null),
					) || !snapshot.windows.some((window) => window.kind === "other" && !window.label),
			) &&
			ratios.length === matched.length &&
			(kind !== "other" || !!label);
		const resets = matched.flatMap((window) => (window.resetsAt === null ? [] : [window.resetsAt]));
		windows.push({
			kind,
			...(label ? { label } : {}),
			usedRatio: complete ? ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length : null,
			resetsAt: resets.length ? Math.min(...resets) : null,
		});
	}
	return {
		scope: "subscription",
		fetchedAt: Math.max(...snapshots.map((s) => s.fetchedAt)),
		windows,
		balances: [],
		hasError: false,
	};
}

/** Preserve the sources' own TTL/backoff/concurrency budgets. Never await an upstream. */
function revalidate(): void {
	void refreshStaleKimiUsages(KIMI_USAGES_STALE_MS).catch(() => {});
	void refreshStaleOpencodeUsages().catch(() => {});
	void refreshStaleDeepSeekBalances().catch(() => {});
	providerBalanceCache.read();
	getTokenDanceBalance();
	if (!settings.commandCode?.disabled) void refreshCommandCodeQuota().catch(() => {});
}

export function readQuotaSnapshots(
	isAdmin: boolean,
	staleWhileRevalidate = true,
): QuotaSnapshotsResponse {
	if (staleWhileRevalidate) revalidate();
	const entries: QuotaSnapshotEntry[] = [];
	for (const group of listSourceGroups()) {
		const template = getServiceTemplate(group.templateId);
		const ids = credentialIds(group);
		const selected =
			group.templateId === "tokendance"
				? getTokenDanceQuotaSnapshot()?.credentialId
				: providerBalanceCache.quotaSnapshot(group.id)?.credentialId;
		let shown = ids;
		if (!isAdmin) {
			// The old ordinary-user endpoints showed one credential per provider, not the pool.
			if (group.templateId === "kimi-code" || group.templateId === "opencode-go")
				shown = usageSubjects((p) => p.id === group.id)
					.slice(0, 1)
					.map((s) => s.id);
			else shown = selected ? [selected] : ids.slice(0, 1);
		}
		const base = { groupId: group.id, prefix: group.prefix, templateId: group.templateId };
		if (group.templateId === "codex" && !isAdmin) {
			entries.push({
				...base,
				credentialId: null,
				source: "probe",
				supported: true,
				snapshot: codexOverview(),
			});
			continue;
		}
		for (const id of shown.length ? shown : [null]) {
			const stored = id && !group.disabled ? directSnapshot(group, id) : undefined;
			const relay =
				!template.subscription &&
				!["deepseek", "nug", "tokendance", "command-code", "codex", "plugin"].includes(
					group.templateId,
				)
					? providerBalanceCache.peek(group.id)
					: null;
			entries.push({
				...base,
				credentialId: isAdmin ? id : null,
				source: "probe",
				...(selected ? { primary: id === selected } : {}),
				...(group.templateId === "command-code" &&
				!group.disabled &&
				ids.length === 0 &&
				!settings.commandCode?.apiKey
					? { refreshOnRead: true, generation: commandCodeCliGeneration() }
					: {}),
				snapshot: publicQuotaSnapshot(stored || undefined),
				...(relay
					? relay.status === "supported"
						? { supported: true }
						: relay.status === "unsupported"
							? { supported: false }
							: {}
					: { supported: !!(template.probeQuota || template.projectQuota) }),
				refreshing: sourceRefreshing(group, id) || relay?.status === "pending",
			});
			// Use the stream's identity-checked accessor, never quotaStore.peek or the probe slot.
			const streamId = id;
			const stream =
				streamId && !group.disabled
					? group.templateId === "nug"
						? getNugQuotaSnapshot(group.id, streamId, STREAM_QUOTA_SOURCE)?.snapshot
						: getCustomApiQuotaSnapshot(group.id, streamId)
					: undefined;
			if (stream)
				entries.push({
					...base,
					credentialId: isAdmin ? id : null,
					source: "quota_balance",
					...(selected ? { primary: streamId === selected } : {}),
					supported: true,
					snapshot: publicQuotaSnapshot(stream),
				});
		}
	}
	return { entries };
}

export interface QuotaRefreshFilter {
	groupId?: string;
	credentialId?: string;
}

/** Preserve explicit relay cooldown/backpressure reporting from the old admin routes. */
export function quotaRefreshRetryAfterMs(filter: QuotaRefreshFilter): number {
	let delay = 0;
	for (const group of listSourceGroups()) {
		if (group.disabled || (filter.groupId && filter.groupId !== group.id)) continue;
		const quota = providerBalanceCache.quotaSnapshot(group.id);
		if (!quota || (filter.credentialId && filter.credentialId !== quota.credentialId)) continue;
		delay = Math.max(delay, providerBalanceCache.manualRetryAfterMs(group.id));
	}
	return delay;
}

/** Templates delegate to the existing source owners; no second task registry. */
export function refreshQuotaSnapshots(
	filter: QuotaRefreshFilter,
): Promise<(QuotaSnapshot | undefined)[]> {
	const jobs: Promise<QuotaSnapshot | undefined>[] = [];
	for (const group of listSourceGroups()) {
		if (group.disabled || (filter.groupId && filter.groupId !== group.id)) continue;
		const probe = getServiceTemplate(group.templateId).probeQuota;
		if (!probe) continue;
		for (const id of credentialIds(group)) {
			if (!filter.credentialId || filter.credentialId === id) jobs.push(probe(group, id));
		}
	}
	return Promise.all(jobs);
}

/** Payment flows await this request's real source work, with a bounded waiting budget. */
export async function waitForTokenDanceQuotaRefresh(
	task: Promise<unknown>,
	signal?: AbortSignal,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	const cancelled = new Promise<never>((_resolve, reject) => {
		abort = () => reject(new AppError("Quota refresh cancelled", 499, "QUOTA_REFRESH_CANCELLED"));
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		timer = setTimeout(
			() => reject(new AppError("Quota refresh timed out", 504, "QUOTA_REFRESH_TIMEOUT")),
			15_000,
		);
	});
	try {
		await Promise.race([task, cancelled]);
	} finally {
		clearTimeout(timer);
		if (abort) signal?.removeEventListener("abort", abort);
	}
}

const cliGenerationSalt = randomBytes(32);
function commandCodeCliGeneration(): string | undefined {
	const identity = currentCommandCodeCliIdentity();
	return identity
		? createHmac("sha256", cliGenerationSalt).update(identity).digest("hex")
		: undefined;
}

export function currentCommandCodeCliIdentity(): string | undefined {
	if (settings.commandCode?.apiKey || settings.commandCode?.disabled) return undefined;
	const auth = resolveCommandCodeToken(undefined, { fresh: true });
	return auth.credential
		? JSON.stringify([auth.credential.token, settings.commandCode?.baseUrl])
		: undefined;
}

// CLI auth has no unified credential. Only share a running request, never its result.
interface CliRefresh {
	identity: string;
	controller: AbortController;
	readers: number;
	task: Promise<QuotaSnapshot | undefined>;
}
let cliRefresh: CliRefresh | undefined;
export function refreshCommandCodeCliQuota(
	signal?: AbortSignal,
): Promise<QuotaSnapshot | undefined> {
	if (signal?.aborted || settings.commandCode?.apiKey || settings.commandCode?.disabled)
		return Promise.resolve(undefined);
	const auth = resolveCommandCodeToken(undefined, { fresh: true });
	if (!auth.credential) return Promise.resolve(undefined);
	const identity = JSON.stringify([auth.credential.token, settings.commandCode?.baseUrl]);
	if (cliRefresh?.identity !== identity || cliRefresh.controller.signal.aborted) {
		cliRefresh?.controller.abort();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 15_000);
		const cancelled = new Promise<never>((_resolve, reject) => {
			controller.signal.addEventListener("abort", () => reject(new Error("quota_cancelled")), {
				once: true,
			});
		});
		const task = Promise.race([
			fetchCommandCodeUsage(
				auth.credential.token,
				settings.commandCode?.baseUrl,
				controller.signal,
			).then((usage) => commandCodeUsageSnapshot(usage)),
			cancelled,
		])
			.catch(
				(): QuotaSnapshot => ({
					fetchedAt: Date.now(),
					scope: "subscription",
					windows: [],
					balances: [],
					error: "quota_unavailable",
				}),
			)
			.finally(() => {
				clearTimeout(timer);
				if (cliRefresh?.task === task) cliRefresh = undefined;
			});
		cliRefresh = { identity, controller, readers: 0, task };
	}
	const entry = cliRefresh;
	entry.readers++;
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: QuotaSnapshot | undefined) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", abort);
			entry.readers--;
			if (entry.readers === 0) entry.controller.abort();
			resolve(value);
		};
		const abort = () => finish(undefined);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		entry.task.then((snapshot) =>
			finish(currentCommandCodeCliIdentity() === entry.identity ? snapshot : undefined),
		);
	});
}
