/**
 * Credentials move in a passphrase-sealed bundle (see bundle.ts). Preview matches
 * installed accounts; import adds or explicitly replaces the admin's selections.
 * Export requires a step-up grant (password + second factor), checked by the route.
 */
import { logger } from "../logger";
import { normalizeLegacyBundle } from "../sourcing/legacy-transfer";
import { openBundle, sealBundle } from "./bundle";
import { exportCredentialItems, importCredentialItems, matchCredentialItem } from "./kinds";

export type { TransferableCredential } from "./kinds";
export { listCredentialSummaries as listTransferableCredentials } from "./kinds";

/** `selection` absent = every credential. Unknown wire kinds select nothing. */
export async function exportCredentials(
	selection: Array<{ kind: string; id: string }> | undefined,
	passphrase: string,
	actor: { userId: string },
): Promise<{ text: string; count: number }> {
	const ids = selection?.filter((item) => item.kind === "credential").map((item) => item.id);
	const items = ids?.length === 0 ? [] : await exportCredentialItems(ids);
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

export async function previewCredentialImport(
	text: string,
	passphrase: string,
): Promise<{ exportedAt: number; items: ImportPreviewItem[] }> {
	const bundle = await openBundle(text, passphrase);
	const items = await Promise.all(
		normalizeLegacyBundle(bundle.items).map(async (item, index): Promise<ImportPreviewItem> => {
			const match = item.kind === "credential" ? await matchCredentialItem(item.data) : null;
			return match
				? { index, kind: item.kind, label: match.label, existingId: match.existingId }
				: { index, kind: item.kind, label: item.label, unsupported: true };
		}),
	);
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
	const result = await importCredentialItems(
		normalizeLegacyBundle(bundle.items),
		(index, existingId) => {
			const choice = choices.get(index);
			if (!choice) return "skip";
			if (!existingId) return "add";
			return choice === "replace" ? "replace" : "skip";
		},
	);
	logger.info("Credentials imported", { userId: actor.userId, ...result });
	return result;
}
