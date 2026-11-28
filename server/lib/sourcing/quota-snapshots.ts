import { createHmac, randomBytes } from "node:crypto";
import type {
	PublicQuotaSnapshot,
	QuotaSnapshot,
	QuotaSnapshotEntry,
	QuotaSnapshotsResponse,
} from "@shared/quota-snapshot";
import { providerQuotaService, toQuotaSnapshot } from "../../services/provider-quota-service";
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
	listCommandCodeUsageSubjects,
	refreshCommandCodeQuota,
} from "../commandcode-usage";
import { getCustomApiQuotaSnapshot } from "../custom-api-quota-cache";
import { getDeepSeekQuotaSnapshot, isDeepSeekQuotaRefreshing } from "../deepseek-balance-cache";
import { AppError } from "../errors";
import { getKimiQuotaSnapshot, isKimiQuotaRefreshing } from "../kimi-usage-cache";
import { getNugQuotaSnapshot, isNugQuotaRefreshing } from "../nug-quota-cache";
import { getOpencodeQuotaSnapshot, isOpencodeQuotaRefreshing } from "../opencode-usage-cache";
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
	const isObservationTime = (value: unknown): value is number | null =>
		value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
	return {
		fetchedAt: snapshot.fetchedAt,
		scope: snapshot.scope,
		...(typeof snapshot.available === "boolean" ? { available: snapshot.available } : {}),
		windows: snapshot.windows.map(
			({ kind, label, status, usedRatio, resetsAt, used, total, remaining, unit }) => ({
				kind,
				...(label ? { label } : {}),
				usedRatio,
				resetsAt,
				...(status === "ok" || status === "rate-limited" ? { status } : {}),
				...(typeof used === "number" && Number.isFinite(used) ? { used } : {}),
				...(typeof total === "number" && Number.isFinite(total) ? { total } : {}),
				...(typeof remaining === "number" && Number.isFinite(remaining) ? { remaining } : {}),
				...(typeof unit === "string" ? { unit } : {}),
			}),
		),
		balances: snapshot.balances.map(
			({
				id,
				label,
				display,
				unit,
				remaining,
				remainingText,
				quota,
				used,
				window,
				windowStart,
				total,
				unlimited,
				remainingObservedAt,
				totalObservedAt,
			}) => ({
				...(typeof id === "string" && id.length <= 256 ? { id } : {}),
				...(typeof label === "string" && label.length <= 256 ? { label } : {}),
				...(display === "summary" || display === "detail" ? { display } : {}),
				unit,
				remaining,
				...(typeof remainingText === "string" &&
				remainingText.length <= 64 &&
				/^-?(?:\d+\.?\d*|\.\d+)$/.test(remainingText) &&
				remaining !== null &&
				Number(remainingText) === remaining
					? { remainingText }
					: {}),
				...(quota === "required" || quota === "alternative" || quota === "none" ? { quota } : {}),
				...(typeof used === "number" && Number.isFinite(used) ? { used } : {}),
				...(typeof window === "string" && window.length <= 64 ? { window } : {}),
				...(typeof windowStart === "number" && Number.isFinite(windowStart) ? { windowStart } : {}),
				...(total !== undefined ? { total } : {}),
				...(unlimited !== undefined ? { unlimited } : {}),
				...(isObservationTime(remainingObservedAt) ? { remainingObservedAt } : {}),
				...(isObservationTime(totalObservedAt) ? { totalObservedAt } : {}),
			}),
		),
		...(typeof snapshot.details === "string" && snapshot.details.length <= 4 * 1024
			? { details: snapshot.details }
			: {}),
		...(snapshot.plan ? { plan: snapshot.plan } : {}),
		...(snapshot.expiresAt !== undefined ? { expiresAt: snapshot.expiresAt } : {}),
		hasError: !!snapshot.error,
		...(snapshot.error
			? {
					error:
						snapshot.error === "plugin_not_enabled" ? "plugin_not_enabled" : "quota_unavailable",
				}
			: {}),
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
		case "tokendance":
			return getTokenDanceQuotaSnapshot(id)?.snapshot;
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
			return isTokenDanceQuotaRefreshing(id ?? undefined);
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
function revalidate(isAdmin: boolean, groupId?: string): void {
	if (!groupId || settings.customApiProviders?.some((config) => config.id === groupId))
		void providerQuotaService.refreshStale(groupId ? [groupId] : undefined).catch(() => {});
	if (!groupId) getTokenDanceBalance();
	if ((!groupId || groupId === "CommandCode") && !settings.commandCode?.disabled) {
		if (isAdmin) {
			for (const subject of listCommandCodeUsageSubjects())
				void refreshCommandCodeQuota(false, subject.id).catch(() => {});
		} else void refreshCommandCodeQuota(false).catch(() => {});
	}
}

/** One projection per live plugin subject, with independent site-account and stream namespaces. */
function customApiEntries(group: SourceGroupView, isAdmin: boolean): QuotaSnapshotEntry[] {
	const base = { groupId: group.id, prefix: group.prefix, templateId: group.templateId };
	const primary = group.disabled ? null : providerQuotaService.peek(group.id);
	const site = primary?.pushCompatible === false;
	const selected = primary ? (site ? null : (primary.keyId ?? group.id)) : null;
	const ids: Array<string | null> = site
		? [null]
		: isAdmin
			? credentialIds(group)
			: selected
				? [selected]
				: [];
	const entries: QuotaSnapshotEntry[] = [];
	for (const id of ids.length ? ids : [null]) {
		const source = group.disabled
			? null
			: site || id === selected
				? primary
				: id
					? providerQuotaService.peekKey(id)
					: null;
		const current = source?.providerId === group.id ? source : null;
		const metadata = {
			...base,
			credentialId: isAdmin ? id : null,
			primary: site || (!!selected && id === selected),
			...(current ? { generation: current.generation } : {}),
		};
		const unavailable =
			!current || current.status === "unavailable" || current.error === "unavailable";
		entries.push({
			...metadata,
			source: "probe",
			snapshot: unavailable ? null : publicQuotaSnapshot(toQuotaSnapshot(current)),
			...(unavailable || current?.status === "unsupported"
				? { supported: false }
				: current?.status === "supported"
					? { supported: true }
					: {}),
			refreshing: current?.status === "probing" || current?.status === "pending",
		});
		if (
			!id ||
			!current ||
			current.status === "unavailable" ||
			current.error === "unavailable" ||
			current.pushCompatible === false
		)
			continue;
		const stream = getCustomApiQuotaSnapshot(group.id, id, current.generation);
		if (stream)
			entries.push({
				...metadata,
				source: "quota_balance",
				supported: true,
				snapshot: publicQuotaSnapshot(stream),
			});
	}
	return entries;
}

export function readQuotaSnapshots(
	isAdmin: boolean,
	staleWhileRevalidate = true,
	groupId?: string,
): QuotaSnapshotsResponse {
	if (staleWhileRevalidate) revalidate(isAdmin, groupId);
	const entries: QuotaSnapshotEntry[] = [];
	for (const group of listSourceGroups()) {
		if (groupId && group.id !== groupId) continue;
		if (settings.customApiProviders?.some((config) => config.id === group.id)) {
			entries.push(...customApiEntries(group, isAdmin));
			continue;
		}
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
				// Unsupported discovery has no quota observation, only an owner diagnostic snapshot.
				snapshot: relay?.status === "unsupported" ? null : publicQuotaSnapshot(stored || undefined),
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
		if (settings.customApiProviders?.some((config) => config.id === group.id)) {
			if (filter.credentialId && !credentialIds(group).includes(filter.credentialId)) continue;
			delay = Math.max(
				delay,
				providerQuotaService.manualRetryAfterMs(group.id, filter.credentialId),
			);
		}
	}
	return delay;
}

/** Templates delegate to the existing source owners; no second task registry. */
export function refreshQuotaSnapshots(
	filter: QuotaRefreshFilter,
): Promise<(QuotaSnapshot | undefined)[]> {
	const jobs: Promise<QuotaSnapshot | undefined>[] = [];
	try {
		for (const group of listSourceGroups()) {
			if (group.disabled || (filter.groupId && filter.groupId !== group.id)) continue;
			if (settings.customApiProviders?.some((config) => config.id === group.id)) {
				const primary = providerQuotaService.peek(group.id);
				if (primary?.pushCompatible === false) {
					if (!filter.credentialId)
						jobs.push(
							providerQuotaService.refresh(group.id, { manual: true }).then(toQuotaSnapshot),
						);
				} else
					for (const id of credentialIds(group)) {
						if (
							getProviderKeyStore().get(id)?.disabled ||
							(filter.credentialId && filter.credentialId !== id)
						)
							continue;
						jobs.push(providerQuotaService.refreshKey(id, { manual: true }).then(toQuotaSnapshot));
					}
				continue;
			}
			const probe = getServiceTemplate(group.templateId).probeQuota;
			if (!probe) continue;
			for (const id of credentialIds(group)) {
				if (getProviderKeyStore().get(id)?.disabled) continue;
				if (!filter.credentialId || filter.credentialId === id) jobs.push(probe(group, id));
			}
		}
	} catch (error) {
		// A later subject can be refused while earlier jobs were accepted. Keep their
		// results observed without delaying the caller's immediate admission failure.
		void Promise.allSettled(jobs);
		throw error;
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
