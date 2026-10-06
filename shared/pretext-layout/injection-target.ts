/**
 * injection-target.ts — where an injection bubble's speaker row navigates to.
 *
 * ## Why this is one discriminated value and not a handful of flat fields
 *
 * The first version of this feature carried `sessionNarratorId` + `sessionMessageId`
 * on the bubble's data: two fields for one target kind. Three more kinds then wanted
 * in (a knowledge entry, a Dynamic Spec file, a review chapter), and the flat shape
 * scales badly in a specific way — not just "more fields", but fields that are
 * mutually exclusive with no way to say so. Nothing would stop a row from carrying a
 * narrator id AND a spec uri, and the integration layer would silently pick whichever
 * it happened to check first.
 *
 * One tagged union makes the exclusivity structural, and makes "which targets exist"
 * a list somebody can read. Adding a kind is one variant plus one `switch` arm that
 * the compiler demands.
 *
 * ## Why the target lives on MEASURED data at all
 *
 * It is height-neutral chrome: the header lane is one fixed line whether or not the
 * row is a link (see `INJECTION_HEADER_HEIGHT`). It rides along on the adapter's
 * output only because the adapter is the layer that knows the payload — the render
 * layer receives a resolved target and never inspects a `SideCarBody`.
 *
 * ⚠️ Do NOT let the reader's identity or capabilities influence this value. Whether a
 * given host CAN open a panel is decided in the integration layer; baking it in here
 * would fork the measurement cache per surface for zero geometric difference.
 */

/**
 * A place a speaker row can take the reader.
 *
 * Each variant names a resource that demonstrably exists as a destination today:
 *
 * - `narrator` — a child session, optionally scrolled to one message. The only kind
 *   with a secondary coordinate, because a subagent's report IS one message in a
 *   history rather than a whole object.
 * - `knowledge` — a knowledge-base entry. `scope` is carried explicitly rather than
 *   probed: global and personal entries are different routes with different hooks, and
 *   "try global, fall back to personal on 404" would fire a wasted request on the
 *   normal path and leave the loading state unable to decide what to render.
 * - `spec` — a Dynamic Spec file, addressed by its `spec://` uri. The panel is a
 *   singleton with a file selector, so the uri selects within it rather than opening
 *   an instance per file.
 * - `chapter` — a chapter (a review's own chapter, a merge's source chapter). Always a
 *   route, never a dock panel: a chapter is not a panel kind.
 */
export type InjectionTarget =
	| { kind: "narrator"; narratorId: string; messageId?: string | null }
	| { kind: "knowledge"; entryId: string; scope: "global" | "personal" }
	| { kind: "spec"; uri: string }
	| { kind: "chapter"; chapterId: string };

/** Every target kind, for exhaustiveness checks and runtime validation. */
const INJECTION_TARGET_KINDS = new Set(["narrator", "knowledge", "spec", "chapter"]);

/**
 * Narrow a value read off measured data back to an `InjectionTarget`.
 *
 * Needed because `spec.data` is untyped by construction (the measure/render seam
 * passes plain records), so the render side receives `unknown` and must not trust it.
 * Rejecting a malformed target yields an inert row — the same outcome as a row that
 * never had one — rather than a link that throws on click.
 *
 * Validates the discriminant AND the identifier each variant needs, because an
 * "id-less" target is exactly the shape that paints a live-looking control and then
 * navigates nowhere.
 */
export function coerceInjectionTarget(value: unknown): InjectionTarget | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const kind = raw.kind;
	if (typeof kind !== "string" || !INJECTION_TARGET_KINDS.has(kind)) return undefined;
	const str = (field: unknown): string | undefined =>
		typeof field === "string" && field.trim().length > 0 ? field : undefined;
	switch (kind) {
		case "narrator": {
			const narratorId = str(raw.narratorId);
			if (!narratorId) return undefined;
			const messageId = str(raw.messageId);
			return { kind: "narrator", narratorId, ...(messageId ? { messageId } : {}) };
		}
		case "knowledge": {
			const entryId = str(raw.entryId);
			if (!entryId) return undefined;
			// An unrecognized scope is treated as global rather than rejected: the entry id
			// is the load-bearing part, and global is where a hint's entries come from.
			const scope = raw.scope === "personal" ? "personal" : "global";
			return { kind: "knowledge", entryId, scope };
		}
		case "spec": {
			const uri = str(raw.uri);
			return uri ? { kind: "spec", uri } : undefined;
		}
		case "chapter": {
			const chapterId = str(raw.chapterId);
			return chapterId ? { kind: "chapter", chapterId } : undefined;
		}
		default:
			return undefined;
	}
}
