/**
 * knowledge-entry-fields.ts — read a knowledge entry's body and title regardless of scope.
 *
 * ## Why this exists as its own module
 *
 * The two scopes carry the body under DIFFERENT field names, and nothing in the type
 * system forced the reader to notice:
 *
 * - a GLOBAL entry (`KnowledgeEntry`) exposes the published body as `currentContent`
 *   (the column the current revision was copied into);
 * - a PERSONAL entry (`KnowledgePersonalEntry`) exposes its working copy as `content`.
 *
 * The panel used to read `entryData.content` for both, so every global entry rendered as
 * "(empty)" — an entry with a 46KB body looked like an empty document, which reads as
 * "the knowledge base lost my content" rather than "the UI looked at the wrong field".
 * There was no error and no warning: the fallback for a missing body and the display for
 * a genuinely empty body are the same string.
 *
 * Both accessors are therefore SCOPE-DISCRIMINATED and typed against the API shapes, so
 * a renamed field becomes a compile error instead of a silently empty panel.
 */

import type { KnowledgeEntry, KnowledgePersonalEntry } from "@frontend/lib/api/knowledge-types";
import type { KnowledgeEntryScope } from "../panels/panel-kind";

/** The entry shape each scope hands to the panel. */
export type ScopedKnowledgeEntry =
	| { scope: "global"; entry: KnowledgeEntry }
	| { scope: "personal"; entry: KnowledgePersonalEntry };

/**
 * The entry's body, or null when the entry itself is not loaded.
 *
 * `null` means "no entry" and an empty string means "an entry with an empty body" — the
 * caller needs to tell those apart (one is a loading/permission state, the other is real
 * content the user can start editing).
 */
export function knowledgeEntryContent(
	scope: KnowledgeEntryScope,
	entry: KnowledgeEntry | KnowledgePersonalEntry | null | undefined,
): string | null {
	if (!entry) return null;
	if (scope === "global") {
		// A global entry's published body lives in `currentContent`; the detail endpoint is
		// the only one that includes it (list rows project it away), so an entry loaded from
		// a summary legitimately has none yet.
		return (entry as KnowledgeEntry).currentContent ?? null;
	}
	return (entry as KnowledgePersonalEntry).content ?? null;
}

/**
 * A human-facing title for the entry.
 *
 * A personal entry's `title` is nullable (a standalone draft need not have picked one
 * before it is published), so it falls back to the draft `name` and finally to a short id
 * — the same ladder the standalone personal-entry page uses. Returns null when there is
 * nothing to show at all, letting the caller decide on generic copy rather than baking an
 * untranslated "Knowledge" into this layer.
 */
export function knowledgeEntryTitle(
	scope: KnowledgeEntryScope,
	entry: KnowledgeEntry | KnowledgePersonalEntry | null | undefined,
): string | null {
	if (!entry) return null;
	if (scope === "global") {
		return (entry as KnowledgeEntry).title?.trim() || null;
	}
	const personal = entry as KnowledgePersonalEntry;
	return personal.title?.trim() || personal.name?.trim() || personal.id.slice(0, 8) || null;
}

/**
 * Whether the caller may edit this entry from the panel.
 *
 * Global: admin or the entry owner (write grants are NOT honored here — the panel's edit
 * button writes straight to main via `useAddKnowledgeRevision`, and the server re-checks
 * anyway; being conservative in the UI only costs a button, while being permissive shows
 * an affordance that 403s).
 * Personal: always, because a personal entry belongs to whoever is reading it (the detail
 * endpoint 404s for anybody else).
 */
export function canEditKnowledgeEntry(
	scope: KnowledgeEntryScope,
	entry: KnowledgeEntry | KnowledgePersonalEntry | null | undefined,
	user: { id: string; role?: string | null } | null | undefined,
): boolean {
	if (!entry || !user) return false;
	if (scope === "personal") return true;
	const global = entry as KnowledgeEntry;
	return user.role === "admin" || global.ownerUserId === user.id;
}
