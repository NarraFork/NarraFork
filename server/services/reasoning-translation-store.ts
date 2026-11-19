import { splitEnvelope } from "@shared/narrator-blocks/storage";
import {
	getValidReasoningTranslationParts,
	isReasoningTranslationBoundary,
	isReasoningTranslationId,
	mergeReasoningTranslationParts,
	type ReasoningTranslationPart,
	type ReasoningTranslationVisibilityTarget,
} from "@shared/reasoning-translation";
import { and, eq, sql } from "drizzle-orm";
import { activeDatabaseBackend, db, sqlite } from "../db";
import { narratorBlocks, narratorMessages, narrators } from "../db/schema";
import { readQuery } from "../db/worker-read";
import { generateId } from "../lib/id";
import { getUserLanguage } from "../lib/prompt-i18n";
import { patchEnvelopeState } from "./narrator-block-sync";
import { readNarratorBodyTexts } from "./narrator-message-reader";
import { reasoningTranslationActivities } from "./reasoning-translation-activity";
import type {
	TranslationViewer,
	VisibleTranslationSource,
} from "./reasoning-translation-visibility";

const MAX_BYTES = 1024 * 1024;
const MAX_BLOCKS = 96;
const MAX_ELEMENTS = 512;
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_PARTS = 512;
function validLocale(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= 35 &&
		/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value)
	);
}
function boundedParts(element: Element): boolean {
	return !Array.isArray(element.translationParts) || element.translationParts.length <= MAX_PARTS;
}
const envelopeBytes = sql<number>`coalesce(octet_length(${narratorMessages.id}),0)
	+ coalesce(octet_length(${narratorMessages.narratorId}),0)
	+ coalesce(octet_length(${narratorMessages.role}),0)
	+ coalesce(octet_length(${narratorMessages.contentText}),0)
	+ coalesce(octet_length(${narratorMessages.parentToolUseId}),0)
	+ coalesce(octet_length(${narratorMessages.messageUuid}),0)
	+ coalesce(octet_length(${narratorMessages.origin}),0)
	+ coalesce(octet_length(${narratorMessages.provider}),0)`;
type Element = Record<string, unknown>;
interface StoredSource extends VisibleTranslationSource {
	bodyFormat: number;
	bodyRevision: number;
	blockRevision: number;
	index: number;
}

/** Direct shared refs authorize forks; child scopes require a real visible Agent origin. */
function scopeSql(narratorId: string) {
	return sql<boolean>`(
		EXISTS (SELECT 1 FROM narrator_message_refs vr
			WHERE vr.narrator_id = ${narratorId} AND vr.message_id = ${narratorMessages.id}
			AND vr.segment_compact_id IS NULL)
		OR EXISTS (SELECT 1 FROM narrators child
			INNER JOIN narrator_tool_calls origin ON origin.id = child.origin_tool_call_id
			INNER JOIN narrator_tool_calls visible ON
				(visible.id = origin.id OR visible.execution_origin_tool_call_id = origin.id)
			INNER JOIN narrator_message_refs parent_ref ON parent_ref.message_id = visible.message_id
				AND parent_ref.narrator_id = ${narratorId} AND parent_ref.segment_compact_id IS NULL
			INNER JOIN narrator_message_refs author_ref ON author_ref.message_id = ${narratorMessages.id}
				AND author_ref.narrator_id = child.id AND author_ref.segment_compact_id IS NULL
			WHERE child.id = ${narratorMessages.narratorId} AND child.type = 'subagent'
			AND child.variant GLOB 'subagent:*' AND child.parent_narrator_id = origin.narrator_id
			AND origin.execution_identity_version = 1 AND origin.execution_origin_tool_call_id IS NULL
			AND visible.execution_identity_version = 1
			AND origin.is_file_history_checkpoint = 0 AND visible.is_file_history_checkpoint = 0
			AND origin.tool_name IN ('Agent', 'Task') AND visible.tool_name IN ('Agent', 'Task')
			AND origin.tool_use_id = visible.tool_use_id
			AND ${narratorMessages.parentToolUseId} = origin.tool_use_id)
	)`;
}
function legacyBlocks(target: ReasoningTranslationVisibilityTarget, content: unknown[]) {
	const { blocks } = splitEnvelope({
		id: target.messageId,
		narratorId: target.ownerNarratorId,
		role: "assistant",
		contentJson: content,
		contentText: null,
		parentToolUseId: null,
	});
	let from = 0;
	return blocks.map((draft) => {
		const block = {
			id: draft.canonical?.id ?? `${target.messageId}:${from}`,
			kind: draft.kind,
			revision: 0,
			bytes: 0,
			count: draft.payload.raw.length,
		};
		from += block.count;
		return block;
	});
}
function elementAt(content: unknown[], index: number): Element | undefined {
	const value = content[index];
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Element)
		: undefined;
}
function reasoningText(element: Element | undefined): string | undefined {
	if (!element || (element.type !== "reasoning" && element.type !== "thinking")) return undefined;
	const text = element.type === "thinking" ? (element.thinking ?? element.text) : element.text;
	return typeof text === "string" ? text : undefined;
}
function reasoning(element: Element | undefined): element is Element {
	return reasoningText(element) !== undefined;
}

export async function canReferenceVisibleTranslationTarget(
	target: ReasoningTranslationVisibilityTarget,
	narratorId: string,
	signal: AbortSignal,
): Promise<boolean> {
	if (activeDatabaseBackend !== "sqlite") return false;
	const [proof] = await readQuery(
		db
			.select({ id: narratorMessages.id })
			.from(narratorMessages)
			.where(
				and(
					eq(narratorMessages.id, target.messageId),
					eq(narratorMessages.role, "assistant"),
					eq(narratorMessages.narratorId, target.ownerNarratorId),
					scopeSql(narratorId),
				),
			)
			.limit(1),
		{ executionPolicy: "worker-required", signal, timeoutMs: 5_000 },
	);
	return Boolean(proof);
}

/** Resolve one just-persisted lane, never a transcript/history scan. */
export async function resolveReasoningTranslationTarget(
	ownerNarratorId: string,
	messageId: string,
	elementId: string,
	seal?: {
		blockRevision: number;
		start: number;
		end: number;
		sourceText: string;
		/** Present only for a full item checkpoint; true must also be durably explicit. */
		completed?: boolean;
	},
): Promise<ReasoningTranslationVisibilityTarget | null> {
	if (activeDatabaseBackend !== "sqlite") return null;
	const rows = await readQuery(
		db
			.select({
				id: narratorBlocks.id,
				text: seal
					? sql<string>`CASE WHEN octet_length(${narratorBlocks.payload}) <= ${MAX_BYTES} THEN
				(SELECT json_extract(item.value, '$.text') FROM json_each(${narratorBlocks.payload}, '$.raw') item
				WHERE json_extract(item.value, '$.id') = ${elementId} LIMIT 1) END`
					: sql<null>`NULL`,
			})
			.from(narratorBlocks)
			.innerJoin(narratorMessages, eq(narratorMessages.id, narratorBlocks.messageId))
			.where(
				and(
					eq(narratorBlocks.messageId, messageId),
					eq(narratorMessages.narratorId, ownerNarratorId),
					eq(narratorBlocks.kind, "reasoning"),
					sql`${narratorBlocks.ordinal} < ${MAX_BLOCKS}`,
					sql`CASE WHEN octet_length(${narratorBlocks.payload}) <= ${MAX_BYTES} THEN EXISTS
					(SELECT 1 FROM json_each(${narratorBlocks.payload}, '$.raw') item
					WHERE json_extract(item.value, '$.id') = ${elementId}
					AND ${seal ? sql`COALESCE(json_extract(item.value, '$.revision'), 0) = ${seal.blockRevision}` : sql`1`}
					AND ${seal?.completed === true ? sql`json_type(item.value, '$.completed') = 'true'` : sql`1`}) ELSE 0 END`,
				),
			)
			.limit(2),
		{ executionPolicy: "worker-required", maxRows: 2, timeoutMs: 5_000 },
	);
	if (
		rows.length !== 1 ||
		(seal &&
			(typeof rows[0].text !== "string" ||
				(seal.completed !== undefined && (seal.start !== 0 || seal.end !== rows[0].text.length)) ||
				!isReasoningTranslationBoundary(rows[0].text, seal.start) ||
				!isReasoningTranslationBoundary(rows[0].text, seal.end) ||
				rows[0].text.slice(seal.start, seal.end) !== seal.sourceText))
	)
		return null;
	return { ownerNarratorId, messageId, blockId: rows[0].id, elementId };
}

/** All body reads run through the existing bounded worker reader. */
async function loadTranslationSnapshot(
	target: ReasoningTranslationVisibilityTarget,
	viewer: TranslationViewer,
	signal: AbortSignal,
) {
	if (activeDatabaseBackend !== "sqlite") return null;
	signal = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
	const options = { executionPolicy: "worker-required" as const, signal, timeoutMs: 5_000 };
	const [message] = await readQuery(
		db
			.select({
				bodyRevision: narratorMessages.bodyRevision,
				bodyFormat: narratorMessages.bodyFormat,
				parentToolUseId: narratorMessages.parentToolUseId,
				bodyBytes: narratorMessages.bodyBytes,
				projectionBytes: sql<number>`octet_length(${narratorMessages.contentJson})`,
				envelopeBytes,
			})
			.from(narratorMessages)
			.where(
				and(
					eq(narratorMessages.id, target.messageId),
					eq(narratorMessages.role, "assistant"),
					eq(narratorMessages.narratorId, target.ownerNarratorId),
					scopeSql(viewer.narratorId),
				),
			)
			.limit(1),
		options,
	);
	if (
		!message ||
		message.envelopeBytes + Math.max(message.bodyBytes, message.projectionBytes) > MAX_BYTES
	)
		return null;
	let blocks = await readQuery(
		db
			.select({
				id: narratorBlocks.id,
				kind: narratorBlocks.kind,
				revision: narratorBlocks.revision,
				bytes: sql<number>`octet_length(${narratorBlocks.payload}) + coalesce(octet_length(${narratorBlocks.state}),0) + coalesce(octet_length(${narratorBlocks.providerMeta}),0)`,
				count: sql<number>`CASE WHEN octet_length(${narratorBlocks.payload}) <= ${MAX_BYTES} THEN json_array_length(${narratorBlocks.payload}, '$.raw') END`,
			})
			.from(narratorBlocks)
			.where(eq(narratorBlocks.messageId, target.messageId))
			.orderBy(narratorBlocks.ordinal)
			.limit(MAX_BLOCKS + 1),
		options,
	);
	if (blocks.length > MAX_BLOCKS || blocks.reduce((sum, block) => sum + block.bytes, 0) > MAX_BYTES)
		return null;
	const body = (
		await readNarratorBodyTexts([{ id: target.messageId, maxBytes: MAX_BYTES }], signal)
	).get(target.messageId);
	if (!body) return null;
	const content: unknown = JSON.parse(body);
	if (!Array.isArray(content) || content.length > MAX_ELEMENTS) return null;
	if (message.bodyFormat === 1) blocks = legacyBlocks(target, content);
	if (blocks.length > MAX_BLOCKS) return null;
	return { message, blocks, content };
}

type TranslationSnapshot = NonNullable<Awaited<ReturnType<typeof loadTranslationSnapshot>>>;

export async function loadVisibleTranslationSources(
	targets: readonly ReasoningTranslationVisibilityTarget[],
	viewer: TranslationViewer,
	signal: AbortSignal,
): Promise<Array<VisibleTranslationSource | null>> {
	if (!targets.length || targets.length > 64) return [];
	const first = targets[0];
	if (
		targets.some(
			(target) =>
				target.ownerNarratorId !== first.ownerNarratorId || target.messageId !== first.messageId,
		)
	)
		return targets.map(() => null);
	const snapshot = await loadTranslationSnapshot(first, viewer, signal);
	if (!snapshot) return targets.map(() => null);
	const result: Array<VisibleTranslationSource | null> = [];
	// Initialization is deliberately sequential on this shared snapshot. Each successful CAS
	// refreshes its small revision metadata before the next element is initialized.
	for (const target of targets)
		result.push(await resolveVisibleTranslationSource(target, viewer, signal, snapshot));
	return result;
}

export async function loadVisibleTranslationSource(
	target: ReasoningTranslationVisibilityTarget,
	viewer: TranslationViewer,
	signal: AbortSignal,
): Promise<StoredSource | null> {
	const snapshot = await loadTranslationSnapshot(target, viewer, signal);
	return snapshot ? resolveVisibleTranslationSource(target, viewer, signal, snapshot) : null;
}

async function resolveVisibleTranslationSource(
	target: ReasoningTranslationVisibilityTarget,
	viewer: TranslationViewer,
	signal: AbortSignal,
	snapshot: TranslationSnapshot,
): Promise<StoredSource | null> {
	const { message, blocks, content } = snapshot;
	const options = { executionPolicy: "worker-required" as const, signal, timeoutMs: 5_000 };
	const block = blocks.find((entry) => entry.id === target.blockId);
	if (!block || block.kind !== "reasoning") return null;
	if (!target.elementId && block.revision !== target.legacyVersion) return null;
	let from = 0;
	for (const row of blocks) {
		if (!Number.isSafeInteger(row.count) || row.count < 0) return null;
		if (row.id === block.id) break;
		from += row.count;
	}
	const indices: number[] = [];
	for (let index = from; index < from + block.count; index++) {
		const element = elementAt(content, index);
		if (!reasoning(element)) continue;
		if (
			target.elementId
				? element.id === target.elementId
				: index === target.legacyIndex && !element.id
		)
			indices.push(index);
	}
	if (indices.length !== 1) return null;
	const index = indices[0];
	let element = elementAt(content, index);
	if (
		!reasoning(element) ||
		!boundedParts(element) ||
		Buffer.byteLength(reasoningText(element) as string) > MAX_SOURCE_BYTES
	)
		return null;
	if (typeof element.translatedText === "string" && element.translatedText.trim()) return null;
	let locale =
		typeof element.translationLocale === "string" && element.translationLocale
			? element.translationLocale
			: undefined;
	if (locale && !validLocale(locale)) return null;
	let generation = isReasoningTranslationId(element.translationGeneration)
		? element.translationGeneration
		: undefined;
	// Unknown-language translated history remains intact; do not add another language.
	if (
		(!locale || !generation) &&
		(element.translatedText ||
			(Array.isArray(element.translationParts) && element.translationParts.length))
	)
		return null;
	if (!locale || !generation) {
		const [owner] = await readQuery(
			db
				.select({ ownerUserId: narrators.ownerUserId })
				.from(narrators)
				.where(eq(narrators.id, target.ownerNarratorId))
				.limit(1),
			options,
		);
		locale ??= await getUserLanguage(owner?.ownerUserId ?? viewer.userId);
		generation ??= generateId();
		signal.throwIfAborted();
		if (!viewer.isCurrent()) return null;
		const desired = { locale, generation, text: reasoningText(element) as string };
		const initialized = mutateSource(
			target,
			viewer,
			message.bodyRevision,
			block.revision,
			index,
			signal,
			(current) => {
				if (reasoningText(current) !== desired.text) return false;
				if (current.translationLocale && current.translationLocale !== desired.locale) return false;
				if (current.translationGeneration && current.translationGeneration !== desired.generation)
					return false;
				if (
					current.translatedText ||
					(Array.isArray(current.translationParts) && current.translationParts.length)
				)
					return false;
				current.translationLocale = desired.locale;
				current.translationGeneration = desired.generation;
				return true;
			},
		);
		if (initialized) {
			element.translationLocale = locale;
			element.translationGeneration = generation;
			const revisions = sqlite
				.query<
					{ bodyRevision: number; blockId: string | null; revision: number | null },
					[string, number]
				>(
					`SELECT m.body_revision AS bodyRevision, b.id AS blockId, b.revision AS revision FROM narrator_messages m LEFT JOIN narrator_blocks b ON b.message_id = m.id WHERE m.id = ? ORDER BY b.ordinal LIMIT ?`,
				)
				.all(target.messageId, MAX_BLOCKS + 1);
			if (revisions[0]) message.bodyRevision = revisions[0].bodyRevision;
			for (const revision of revisions) {
				const row = blocks.find((entry) => entry.id === revision.blockId);
				if (row && revision.revision != null) row.revision = revision.revision;
			}
		}
		// Another viewer may atomically initialize first. Reload its frozen language, never ours.
		if (!initialized) {
			const latest = (
				await readNarratorBodyTexts([{ id: target.messageId, maxBytes: MAX_BYTES }], signal)
			).get(target.messageId);
			if (!latest) return null;
			const values: unknown = JSON.parse(latest);
			if (!Array.isArray(values) || values.length > MAX_ELEMENTS) return null;
			element = elementAt(values, index);
			if (
				!reasoning(element) ||
				!boundedParts(element) ||
				reasoningText(element) !== desired.text ||
				!isReasoningTranslationId(element.translationGeneration) ||
				!validLocale(element.translationLocale)
			)
				return null;
			locale = element.translationLocale;
			generation = element.translationGeneration;
		}
	}
	if (!reasoning(element) || !generation || !locale) return null;
	const text = reasoningText(element) as string;
	let runStart = index;
	while (runStart > 0 && reasoning(elementAt(content, runStart - 1))) runStart--;
	const first = elementAt(content, runStart);
	if (!first) return null;
	let blockStart = 0;
	let anchorBlock = blocks[0];
	for (const row of blocks) {
		if (runStart < blockStart + row.count) {
			anchorBlock = row;
			break;
		}
		blockStart += row.count;
	}
	const runAnchor: ReasoningTranslationVisibilityTarget = {
		ownerNarratorId: target.ownerNarratorId,
		messageId: target.messageId,
		blockId: anchorBlock.id,
		...(typeof first.id === "string" && first.id
			? { elementId: first.id }
			: { legacyIndex: runStart, legacyVersion: anchorBlock.revision }),
	};
	return {
		target,
		text,
		// A historical completed:false flag is not an active provider lane.
		completed:
			!reasoningTranslationActivities.get(target.ownerNarratorId) ||
			reasoningTranslationActivities.get(target.ownerNarratorId)?.elementId !== target.elementId,
		allowedRanges: reasoningTranslationActivities.ranges(target, text.length),
		runAnchor,
		runKey: JSON.stringify([target.ownerNarratorId, target.messageId, runStart, first.id ?? null]),
		order: index,
		generation,
		locale,
		parts: getValidReasoningTranslationParts(
			text,
			generation,
			element.translationParts as ReasoningTranslationPart[] | undefined,
		),
		version: JSON.stringify([message.bodyRevision, block.revision, generation, locale, text]),
		bodyFormat: message.bodyFormat,
		bodyRevision: message.bodyRevision,
		blockRevision: block.revision,
		index,
		reload: message.bodyFormat === 1,
		...(message.parentToolUseId ? { parentToolUseId: message.parentToolUseId } : {}),
	};
}

/** A small writer transaction rechecks refs, revision, source and cancellation before state CAS. */
function mutateSource(
	target: ReasoningTranslationVisibilityTarget,
	viewer: TranslationViewer,
	bodyRevision: number,
	blockRevision: number,
	index: number,
	signal: AbortSignal,
	mutate: (element: Element) => boolean,
	allowAppend = false,
): boolean {
	return sqlite.transaction(() => {
		signal.throwIfAborted();
		if (!viewer.isCurrent()) return false;
		const proof = db
			.select({ id: narratorMessages.id, bodyFormat: narratorMessages.bodyFormat })
			.from(narratorMessages)
			.where(
				and(
					eq(narratorMessages.id, target.messageId),
					eq(narratorMessages.role, "assistant"),
					eq(narratorMessages.narratorId, target.ownerNarratorId),
					allowAppend
						? eq(narratorMessages.bodyFormat, 2)
						: eq(narratorMessages.bodyRevision, bodyRevision),
					scopeSql(viewer.narratorId),
					sql`(${envelopeBytes}) + max(octet_length(${narratorMessages.contentJson}), ${narratorMessages.bodyBytes}) <= ${MAX_BYTES}`,
				),
			)
			.limit(1)
			.get();
		if (!proof) return false;
		const rows = sqlite
			.query<{ id: string; revision: number; bytes: number }, [string, number]>(
				`SELECT id, revision, octet_length(payload) + coalesce(octet_length(state),0) + coalesce(octet_length(provider_meta),0) AS bytes FROM narrator_blocks WHERE message_id = ? ORDER BY ordinal LIMIT ?`,
			)
			.all(target.messageId, MAX_BLOCKS + 1);
		if (
			rows.length > MAX_BLOCKS ||
			rows.reduce((sum, row) => sum + row.bytes, 0) > MAX_BYTES ||
			(proof.bodyFormat === 2 &&
				!rows.some(
					(row) =>
						row.id === target.blockId &&
						(allowAppend ? row.revision >= blockRevision : row.revision === blockRevision),
				))
		)
			return false;
		return patchEnvelopeState(target.messageId, (content) => {
			if (content.length > MAX_ELEMENTS) return null;
			if (proof.bodyFormat === 1) {
				const legacy = legacyBlocks(target, content);
				let from = 0;
				let matches = false;
				for (const block of legacy) {
					if (
						block.id === target.blockId &&
						block.kind === "reasoning" &&
						blockRevision === 0 &&
						index >= from &&
						index < from + block.count
					)
						matches = true;
					from += block.count;
				}
				if (legacy.length > MAX_BLOCKS || !matches) return null;
			}
			const element = elementAt(content, index);
			if (
				!reasoning(element) ||
				(target.elementId ? element.id !== target.elementId : Boolean(element.id))
			)
				return null;
			if (!mutate(element) || signal.aborted || !viewer.isCurrent()) return null;
			return Buffer.byteLength(JSON.stringify(content)) <= MAX_BYTES ? content : null;
		});
	})();
}

export async function applyVisibleTranslationPart(
	source: VisibleTranslationSource,
	viewer: TranslationViewer,
	part: ReasoningTranslationPart,
	signal: AbortSignal,
): Promise<unknown | null> {
	const stored = source as StoredSource;
	const allowAppend = stored.bodyFormat === 2 && Boolean(source.target.elementId);
	const changed = mutateSource(
		source.target,
		viewer,
		stored.bodyRevision,
		stored.blockRevision,
		stored.index,
		signal,
		(element) => {
			const text = reasoningText(element);
			if (
				!boundedParts(element) ||
				typeof text !== "string" ||
				(allowAppend ? !text.startsWith(source.text) : text !== source.text) ||
				!reasoningTranslationActivities.allows(source.target, part.start, part.end) ||
				part.end > source.text.length ||
				source.text.slice(part.start, part.end) !== part.sourceText ||
				element.translationGeneration !== source.generation ||
				element.translationLocale !== source.locale
			)
				return false;
			const previous = getValidReasoningTranslationParts(
				text,
				source.generation,
				element.translationParts as ReasoningTranslationPart[] | undefined,
			);
			const eligible = previous.filter((entry) =>
				reasoningTranslationActivities.allows(source.target, entry.start, entry.end),
			);
			const next = mergeReasoningTranslationParts(text, source.generation, eligible, [part]);
			if (next.length !== eligible.length + 1 || next.length > MAX_PARTS) return false;
			element.translationParts = next;
			return true;
		},
		allowAppend,
	);
	if (!changed) return null;
	const row = sqlite
		.query<{ stateRevision: number; blockRevision: number | null }, [string, string]>(
			`SELECT m.state_revision AS stateRevision, b.revision AS blockRevision FROM narrator_messages m
			LEFT JOIN narrator_blocks b ON b.message_id = m.id AND b.id = ? WHERE m.id = ? LIMIT 1`,
		)
		.get(source.target.blockId, source.target.messageId);
	return {
		messageId: source.target.messageId,
		blockId: source.target.blockId,
		elementId: source.target.elementId,
		blockRevision: row?.blockRevision ?? stored.blockRevision,
		stateRevision: row?.stateRevision ?? 0,
		translationGeneration: source.generation,
		part,
	};
}
