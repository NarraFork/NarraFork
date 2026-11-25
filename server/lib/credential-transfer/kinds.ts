/** The single credential format shared by credential transfer and data exports. */
import { SERVICE_TEMPLATE_IDS } from "@shared/sourcing/identify";
import {
	codexFromCredential,
	codexToCredential,
	getCodexManager,
	parseStoredCodexCredentials,
} from "../codex-manager";
import type { Credential, GroupSecrets } from "../credential-store";
import { generateShortId } from "../id";
import { getProviderKeyStore, keyPartOf } from "../provider-keys";
import { saveSettings, settings } from "../settings";
import type { CustomApiProviderConfig, NUGProviderConfig } from "../settings/types";
import { createGroupAllocator } from "../sourcing/allocate-group";
import { getSourceGroup, listSourceGroups, type SourceGroupView } from "../sourcing/source-groups";
import { getServiceTemplate, type ServiceTemplateId } from "../sourcing/templates";
import type { BundleItem } from "./bundle";
import {
	asPluginTransferData,
	importPluginCredential,
	matchPluginCredential,
	pluginCredentialItems,
} from "./plugin";

export interface TransferableCredential {
	kind: "credential";
	id: string;
	label: string;
	archived?: boolean;
}

export type ImportDecision = "add" | "replace" | "skip";

export type TransferGroup = Record<string, unknown> & {
	id: string;
	prefix: string;
	name: string;
};

export interface CredentialTransferData {
	group: TransferGroup;
	templateId: ServiceTemplateId;
	/** Ids are instance-local and deliberately absent from the portable credential. */
	credential?: Omit<Credential, "id">;
	groupSecrets?: GroupSecrets;
}

type ProviderSection = Record<string, unknown>;

const TEMPLATE_IDS = new Set<string>(SERVICE_TEMPLATE_IDS);
const SINGLETONS: Readonly<Record<string, ServiceTemplateId>> = {
	codex: "codex",
	tokendance: "tokendance",
	CommandCode: "command-code",
};

export function transferGroupKey(templateId: ServiceTemplateId, groupId: string): string {
	return `${templateId}:${groupId}`;
}

export function publicGroup(config: Record<string, unknown>): TransferGroup {
	const {
		apiKey: _apiKey,
		quotaAccessToken: _quotaAccessToken,
		oauthClientSecret: _oauthClientSecret,
		...group
	} = structuredClone(config);
	return group as TransferGroup;
}

export function singletonGroup(
	templateId: "codex" | "tokendance" | "command-code",
	config?: Record<string, unknown>,
): TransferGroup {
	const id = templateId === "command-code" ? "CommandCode" : templateId;
	const name =
		templateId === "command-code"
			? "Command Code"
			: templateId === "codex"
				? "Codex"
				: "TokenDance";
	return publicGroup({ id, prefix: id, name, ...(config ?? {}) });
}

function viewGroup(view: SourceGroupView): TransferGroup {
	if (view.templateId === "codex") return singletonGroup("codex");
	if (view.templateId === "tokendance") {
		return singletonGroup("tokendance", settings.tokendance as unknown as Record<string, unknown>);
	}
	if (view.templateId === "command-code") {
		return singletonGroup(
			"command-code",
			settings.commandCode as unknown as Record<string, unknown> | undefined,
		);
	}
	const config =
		(settings.customApiProviders ?? []).find((provider) => provider.id === view.id) ??
		(settings.nugProviders ?? []).find((provider) => provider.id === view.id);
	return config
		? publicGroup(config as unknown as Record<string, unknown>)
		: { id: view.id, prefix: view.prefix, name: view.name };
}

function maskedKey(apiKey: string): string {
	return apiKey.length > 8 ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}` : "…";
}

function credentialLabel(group: TransferGroup, credential: Omit<Credential, "id">): string {
	const own =
		credential.label ??
		credential.account?.email ??
		credential.account?.accountId ??
		(credential.auth.kind === "api_key" ? maskedKey(credential.auth.apiKey) : "credential");
	return `${group.name} · ${own}`;
}

function credentialItem(
	group: TransferGroup,
	templateId: ServiceTemplateId,
	credential: Credential,
	kind = "credential",
): BundleItem {
	const { id: _id, ...portable } = structuredClone(credential);
	return {
		kind,
		id: credential.id,
		label: credentialLabel(group, portable),
		data: { group, templateId, credential: portable } satisfies CredentialTransferData,
	};
}

function groupSecretItem(
	group: TransferGroup,
	templateId: ServiceTemplateId,
	secrets: GroupSecrets,
	kind = "credential",
): BundleItem {
	return {
		kind,
		id: `group:${group.id}`,
		label: `${group.name} · group secrets`,
		data: { group, templateId, groupSecrets: secrets } satisfies CredentialTransferData,
	};
}

function groupItems(
	view: SourceGroupView,
	includeCodex: boolean,
	dataExport: boolean,
): BundleItem[] {
	const group = viewGroup(view);
	const store = getProviderKeyStore();
	const credentials =
		view.templateId === "codex"
			? includeCodex
				? getCodexManager()
						.exportForTransfer()
						.map((entry) => credentialItem(group, "codex", codexToCredential(entry)))
				: []
			: view.templateId === "plugin"
				? []
				: store.listGroup(view.id).map((key) =>
						credentialItem(group, view.templateId, {
							id: key.id,
							target: { groupId: view.id },
							ownerUserId: null,
							...(key.label ? { label: key.label } : {}),
							priority: key.priority,
							createdAt: key.createdAt,
							...(key.disabled
								? {
										disabled: true,
										...(key.disabledReason ? { disabledReason: key.disabledReason } : {}),
									}
								: {}),
							...(key.network ? { network: structuredClone(key.network) } : {}),
							...(key.account ? { account: structuredClone(key.account) } : {}),
							auth: { kind: "api_key", apiKey: key.apiKey },
						}),
					);
	const secrets =
		view.templateId === "codex" || view.templateId === "plugin" ? {} : store.groupSecrets(view.id);
	if (Object.values(secrets).some(Boolean)) {
		return [
			...credentials,
			groupSecretItem(group, view.templateId, secrets, dataExport ? "group-secrets" : "credential"),
		];
	}
	return credentials;
}

/** All credentials for the credential-transfer card. Codex accounts are included here only. */
async function allCredentialItems(): Promise<BundleItem[]> {
	// Plugin bags use stable contribution identities and the Vault in either storage mode.
	return [
		...listSourceGroups()
			.filter((view) => view.templateId !== "plugin")
			.flatMap((view) => groupItems(view, true, false)),
		...(await pluginCredentialItems()),
	];
}

/** Credentials for provider groups present in providers.json (never Codex accounts). */
export function collectProviderTransferItems(providers: ProviderSection): BundleItem[] {
	const items: BundleItem[] = [];
	for (const raw of (providers.customApiProviders ?? []) as Array<Record<string, unknown>>) {
		if (typeof raw.id !== "string") continue;
		const view = getSourceGroup(raw.id);
		if (view && view.templateId !== "nug") items.push(...groupItems(view, false, true));
	}
	for (const raw of (providers.nugProviders ?? []) as Array<Record<string, unknown>>) {
		if (typeof raw.id !== "string") continue;
		const view = getSourceGroup(raw.id);
		if (view?.templateId === "nug") items.push(...groupItems(view, false, true));
	}
	for (const [field, templateId] of [
		["tokendance", "tokendance"],
		["commandCode", "command-code"],
	] as const) {
		if (providers[field] === undefined) continue;
		const id = templateId === "command-code" ? "CommandCode" : "tokendance";
		const view = getSourceGroup(id);
		if (view) items.push(...groupItems(view, false, true));
	}
	return items;
}

export function asCredentialTransferData(raw: unknown): CredentialTransferData | null {
	if (!raw || typeof raw !== "object") return null;
	const item = raw as Partial<CredentialTransferData>;
	if (
		!item.group ||
		typeof item.group !== "object" ||
		typeof item.group.id !== "string" ||
		!item.group.id ||
		typeof item.group.prefix !== "string" ||
		typeof item.group.name !== "string" ||
		typeof item.templateId !== "string" ||
		!TEMPLATE_IDS.has(item.templateId)
	) {
		return null;
	}
	if (item.templateId === "plugin") return asPluginTransferData(item as CredentialTransferData);
	if (item.credential) {
		if (!item.credential.auth || typeof item.credential.auth !== "object") return null;
		if (item.templateId === "codex" && item.credential.auth.kind === "api_key") return null;
		if (item.templateId !== "codex" && item.credential.auth.kind !== "api_key") return null;
		if (item.credential.auth.kind === "api_key" && !item.credential.auth.apiKey.trim()) return null;
	}
	if (!item.credential && !item.groupSecrets) return null;
	if (item.templateId === "codex" && item.credential) {
		// The old matcher normalized JWT/display-name identity before computing dedupe keys.
		// Keep that pure normalization so a rotated token still replaces the same account.
		const normalized = parseStoredCodexCredentials([
			codexFromCredential({ ...item.credential, id: "transfer" }),
		])[0];
		if (!normalized) return null;
		const { id: _id, ...credential } = codexToCredential(normalized);
		return { ...structuredClone(item), credential } as CredentialTransferData;
	}
	return structuredClone(item) as CredentialTransferData;
}

function normalizedUrl(value: unknown): string {
	return String(value ?? "").replace(/\/+$/, "");
}

/** Group id wins within a template; otherwise the same template and endpoint is the group. */
export function targetTransferGroup(item: CredentialTransferData): SourceGroupView | undefined {
	// DEFAULTS contains a placeholder TokenDance connection. With no local key it is not
	// configured yet, so createGroup must also restore the imported model catalog and metadata.
	if (item.templateId === "tokendance" && !settings.tokendance?.apiKey) return undefined;
	if (item.templateId === "command-code" && !settings.commandCode) return undefined;
	const groups = listSourceGroups().filter((group) => group.templateId === item.templateId);
	return (
		groups.find((group) => group.id === item.group.id) ??
		groups.find(
			(group) =>
				!!item.group.baseUrl &&
				normalizedUrl(group.endpoint.baseUrl) === normalizedUrl(item.group.baseUrl),
		)
	);
}

function existingCredential(
	templateId: ServiceTemplateId,
	groupId: string,
	credential: Omit<Credential, "id">,
): string | undefined {
	const template = getServiceTemplate(templateId);
	const keys = new Set(template.dedupeKeys({ ...credential, target: { groupId } }));
	const candidates =
		templateId === "codex"
			? getCodexManager()
					.exportForTransfer()
					.map((entry) => codexToCredential(entry))
			: keyPartOf(getProviderKeyStore().listGroup(groupId)).credentials;
	return candidates.find((candidate) =>
		template.dedupeKeys({ ...candidate, target: { groupId } }).some((key) => keys.has(key)),
	)?.id;
}

async function matchItem(
	item: CredentialTransferData,
): Promise<{ label: string; existingId?: string } | null> {
	if (item.templateId === "plugin") return matchPluginCredential(item);
	const target = targetTransferGroup(item);
	if (!item.credential) {
		const hasSecrets =
			target && Object.values(getProviderKeyStore().groupSecrets(target.id)).some(Boolean);
		return {
			label: `${target?.name ?? item.group.name} · group secrets`,
			existingId: hasSecrets ? target.id : undefined,
		};
	}
	const label = credentialLabel(item.group, item.credential);
	if (!target) return { label };
	if (getServiceTemplate(item.templateId).dedupeKeys(item.credential).length === 0) return null;
	return {
		label: `${target.name} · ${label.split(" · ").slice(1).join(" · ")}`,
		existingId: existingCredential(item.templateId, target.id, item.credential),
	};
}

function createGroup(
	item: CredentialTransferData,
	allocate: ReturnType<typeof createGroupAllocator>,
) {
	if (item.templateId === "codex") return getSourceGroup("codex");
	if (item.templateId === "plugin") return undefined;
	const next = structuredClone(settings);
	if (SINGLETONS[item.group.id] === item.templateId) {
		const { id: _id, prefix: _prefix, name: _name, ...config } = item.group;
		if (item.templateId === "tokendance") {
			next.tokendance = { ...config, apiKey: "" } as unknown as NonNullable<typeof next.tokendance>;
		} else {
			next.commandCode = { ...config, apiKey: "" } as unknown as NonNullable<
				typeof next.commandCode
			>;
		}
		saveSettings(next);
		return getSourceGroup(item.group.id);
	}
	const allocated = allocate.allocate({ id: item.group.id, prefix: item.group.prefix });
	const group = { ...item.group, ...allocated, apiKey: "" };
	if (item.templateId === "nug") {
		next.nugProviders = [...(next.nugProviders ?? []), group as unknown as NUGProviderConfig];
	} else {
		next.customApiProviders = [
			...(next.customApiProviders ?? []),
			group as unknown as CustomApiProviderConfig,
		];
	}
	saveSettings(next);
	return getSourceGroup(allocated.id);
}

function importGroupSecrets(groupId: string, secrets: GroupSecrets): void {
	getProviderKeyStore().setGroupSecrets(groupId, secrets);
}

export async function listCredentialSummaries(): Promise<TransferableCredential[]> {
	return (await allCredentialItems()).map((item) => ({
		kind: "credential",
		id: item.id,
		label: item.label,
		...((item.data as CredentialTransferData).credential?.archivedAt ? { archived: true } : {}),
	}));
}

export async function exportCredentialItems(ids?: readonly string[]): Promise<BundleItem[]> {
	const wanted = ids ? new Set(ids) : null;
	return (await allCredentialItems()).filter((item) => !wanted || wanted.has(item.id));
}

export async function matchCredentialItem(raw: unknown) {
	const item = asCredentialTransferData(raw);
	return item ? matchItem(item) : null;
}

/** Process the bundle in wire order so decisions use its original item indices. */
export async function importCredentialItems(
	items: readonly BundleItem[],
	decide: (index: number, existingId: string | undefined) => ImportDecision,
): Promise<{ added: number; replaced: number; skipped: number }> {
	const result = { added: 0, replaced: 0, skipped: 0 };
	const allocator = createGroupAllocator();
	const targets = new Map<string, SourceGroupView>();
	const createdIds = new Set<string>();
	for (const [index, raw] of items.entries()) {
		const item = raw.kind === "credential" ? asCredentialTransferData(raw.data) : null;
		if (!item) {
			result.skipped++;
			continue;
		}
		if (item.templateId === "plugin") {
			const outcome = await importPluginCredential(item, (existingId) => decide(index, existingId));
			result[outcome]++;
			continue;
		}
		const key = transferGroupKey(item.templateId, item.group.id);
		const cached = targets.get(key);
		let target = cached ?? targetTransferGroup(item);
		// Endpoint matching is for groups that already existed locally. A distinct incoming
		// group must not collapse into another group created earlier in this same bundle.
		if (!cached && target && createdIds.has(target.id)) target = undefined;
		const store = getProviderKeyStore();
		const existing =
			item.credential && target
				? existingCredential(item.templateId, target.id, item.credential)
				: target && !item.credential && Object.values(store.groupSecrets(target.id)).some(Boolean)
					? target.id
					: undefined;
		const action = decide(index, existing);
		if (action === "skip" || (action === "add" && existing)) {
			result.skipped++;
			continue;
		}
		if (!target) {
			target = createGroup(item, allocator);
			if (!target) {
				result.skipped++;
				continue;
			}
			createdIds.add(target.id);
		}
		targets.set(key, target);
		if (item.groupSecrets) importGroupSecrets(target.id, item.groupSecrets);
		if (!item.credential) {
			if (existing) result.replaced++;
			else result.added++;
			continue;
		}
		if (item.templateId === "codex") {
			const rawCredential = codexFromCredential({
				...item.credential,
				id: generateShortId(),
				target: { groupId: "codex" },
			});
			const imported = getCodexManager().importFromTransfer([rawCredential], () => action);
			result.added += imported.added;
			result.replaced += imported.replaced;
			result.skipped += imported.skipped;
			continue;
		}
		if (item.credential.auth.kind !== "api_key") {
			result.skipped++;
			continue;
		}
		const fields = {
			label: item.credential.label ?? "",
			account: item.credential.account ?? null,
			disabled: !!item.credential.disabled,
			...(item.credential.disabledReason === "manual" ||
			item.credential.disabledReason === "invalid"
				? { disabledReason: item.credential.disabledReason }
				: {}),
			network: item.credential.network ?? null,
		};
		if (existing) {
			store.update(existing, fields);
			result.replaced++;
			continue;
		}
		const added = store.addGroupCredential(
			target.id,
			item.templateId === "nug" ||
				item.templateId === "tokendance" ||
				item.templateId === "command-code"
				? item.templateId
				: undefined,
			{ apiKey: item.credential.auth.apiKey },
		);
		store.update(added.id, fields);
		result.added++;
	}
	return result;
}

/** Restore only groups that a data import actually added; merged local groups keep their keys. */
export function restoreProviderTransferItems(
	data: readonly CredentialTransferData[],
	added: ReadonlyMap<string, { id: string }>,
): { imported: number; failed: number } {
	const store = getProviderKeyStore();
	const result = { imported: 0, failed: 0 };
	const secrets = new Map<string, { id: string; values: GroupSecrets }>();
	const restored = new Set<string>();
	for (const item of data) {
		const target = added.get(transferGroupKey(item.templateId, item.group.id));
		if (!target) continue;
		if (item.groupSecrets) {
			const current = secrets.get(target.id) ?? { id: target.id, values: {} };
			Object.assign(current.values, item.groupSecrets);
			secrets.set(target.id, current);
		}
		if (!item.credential || item.credential.auth.kind !== "api_key") continue;
		try {
			const apiKey = item.credential.auth.apiKey;
			const existingId = existingCredential(item.templateId, target.id, item.credential);
			if (existingId && restored.has(existingId)) continue;
			// Settings may already have recreated the first key. Restore its metadata too,
			// notably TokenDance's login marker, without moving it to a different key.
			const id =
				existingId ??
				store.addGroupCredential(
					target.id,
					item.templateId === "nug" ||
						item.templateId === "tokendance" ||
						item.templateId === "command-code"
						? item.templateId
						: undefined,
					{ apiKey },
				).id;
			const fields = {
				label: item.credential.label ?? "",
				account: item.credential.account ?? null,
				disabled: !!item.credential.disabled,
				...(item.credential.disabledReason === "manual" ||
				item.credential.disabledReason === "invalid"
					? { disabledReason: item.credential.disabledReason }
					: {}),
				network: item.credential.network ?? null,
			};
			store.update(id, fields);
			restored.add(id);
			result.imported++;
		} catch {
			result.failed++;
		}
	}
	for (const { id, values } of secrets.values()) {
		try {
			importGroupSecrets(id, values);
			result.imported += Object.values(values).filter(Boolean).length;
		} catch {
			result.failed += Object.values(values).filter(Boolean).length;
		}
	}
	return result;
}
