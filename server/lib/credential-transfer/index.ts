/**
 * Moving credentials between NarraFork instances.
 *
 * Each credential family plugs in as a `TransferKind`; export collects the chosen
 * credentials into a passphrase-sealed bundle (see bundle.ts), import previews which
 * of them already exist here and then adds or replaces them as the admin decides.
 * Exporting requires a step-up grant (password + second factor), checked by the route.
 */
import { getCodexManager } from "../codex-manager";
import { logger } from "../logger";
import { type BundleItem, openBundle, sealBundle } from "./bundle";

export interface TransferableCredential {
	kind: string;
	id: string;
	label: string;
	archived?: boolean;
}

type ImportDecision = "add" | "replace" | "skip";

interface TransferKind {
	kind: string;
	list(): TransferableCredential[];
	export(ids: readonly string[] | undefined): BundleItem[];
	/** Aligned with `data`; null marks an item this instance cannot use. */
	match(data: readonly unknown[]): Array<{ label: string; existingId?: string } | null>;
	import(
		data: readonly unknown[],
		decide: (index: number, existingId: string | undefined) => ImportDecision,
	): { added: number; replaced: number; skipped: number };
}

const codexKind: TransferKind = {
	kind: "codex",
	list: () => {
		const snapshot = getCodexManager().snapshot();
		return [...snapshot.entries, ...snapshot.archivedEntries].map((entry) => ({
			kind: "codex",
			id: entry.id,
			label: entry.displayName ?? entry.email ?? entry.id,
			...(entry.archivedAt ? { archived: true } : {}),
		}));
	},
	export: (ids) =>
		getCodexManager()
			.exportForTransfer(ids)
			.map((data) => ({
				kind: "codex",
				id: data.id,
				label: data.displayName ?? data.email ?? data.id,
				data,
			})),
	match: (data) => getCodexManager().matchForTransfer(data),
	import: (data, decide) => getCodexManager().importFromTransfer(data, decide),
};

const KINDS: readonly TransferKind[] = [codexKind];
const kindOf = (kind: string) => KINDS.find((k) => k.kind === kind);

export function listTransferableCredentials(): TransferableCredential[] {
	return KINDS.flatMap((kind) => kind.list());
}

/** `selection` absent = every credential of every kind. */
export async function exportCredentials(
	selection: Array<{ kind: string; id: string }> | undefined,
	passphrase: string,
	actor: { userId: string },
): Promise<{ text: string; count: number }> {
	const items = KINDS.flatMap((kind) => {
		if (!selection) return kind.export(undefined);
		const ids = selection.filter((s) => s.kind === kind.kind).map((s) => s.id);
		return ids.length ? kind.export(ids) : [];
	});
	const text = await sealBundle({ exportedAt: Date.now(), items }, passphrase);
	logger.info("Credentials exported", {
		userId: actor.userId,
		count: items.length,
		kinds: [...new Set(items.map((item) => item.kind))],
	});
	return { text, count: items.length };
}

export interface ImportPreviewItem {
	index: number;
	kind: string;
	label: string;
	/** Same account already on this instance. */
	existingId?: string;
	/** Unknown kind or unusable data; cannot be imported. */
	unsupported?: boolean;
}

function groupByKind(items: readonly BundleItem[]) {
	const groups = new Map<string, Array<{ index: number; item: BundleItem }>>();
	items.forEach((item, index) => {
		const group = groups.get(item.kind) ?? [];
		group.push({ index, item });
		groups.set(item.kind, group);
	});
	return groups;
}

export async function previewCredentialImport(
	text: string,
	passphrase: string,
): Promise<{ exportedAt: number; items: ImportPreviewItem[] }> {
	const bundle = await openBundle(text, passphrase);
	const items: ImportPreviewItem[] = bundle.items.map((item, index) => ({
		index,
		kind: item.kind,
		label: item.label,
		unsupported: true,
	}));
	for (const [kindName, group] of groupByKind(bundle.items)) {
		const kind = kindOf(kindName);
		if (!kind) continue;
		const matches = kind.match(group.map((g) => g.item.data));
		group.forEach(({ index }, i) => {
			const match = matches[i];
			if (match)
				items[index] = { index, kind: kindName, label: match.label, existingId: match.existingId };
		});
	}
	return { exportedAt: bundle.exportedAt, items };
}

/**
 * `choices` maps bundle index → what to do. Items not listed are skipped, and an item
 * whose account already exists is only replaced when its choice says so.
 */
export async function applyCredentialImport(
	text: string,
	passphrase: string,
	choices: ReadonlyMap<number, "import" | "replace">,
	actor: { userId: string },
): Promise<{ added: number; replaced: number; skipped: number }> {
	const bundle = await openBundle(text, passphrase);
	const total = { added: 0, replaced: 0, skipped: 0 };
	for (const [kindName, group] of groupByKind(bundle.items)) {
		const kind = kindOf(kindName);
		if (!kind) {
			total.skipped += group.length;
			continue;
		}
		const result = kind.import(
			group.map((g) => g.item.data),
			(i, existingId) => {
				const choice = choices.get(group[i]?.index ?? -1);
				if (!choice) return "skip";
				if (!existingId) return "add";
				return choice === "replace" ? "replace" : "skip";
			},
		);
		total.added += result.added;
		total.replaced += result.replaced;
		total.skipped += result.skipped;
	}
	logger.info("Credentials imported", { userId: actor.userId, ...total });
	return total;
}
