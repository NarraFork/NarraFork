import type { ModelCard } from "@shared/model-card";
import { Hono } from "hono";
import { ValidationError } from "../lib/errors";
import {
	diffModelCards,
	getEffectiveModelCards,
	invalidateModelCardCache,
	mergeModelCards,
} from "../lib/model-cards";
import { saveSettings, settings } from "../lib/settings";
import { modelCardSchema } from "../lib/validators";
import { requireAdmin } from "../middleware/auth";

export const modelCardRoutes = new Hono();

/**
 * Read the effective cards.
 *
 * Readable by any authenticated user, not admin-only: the narrator's reasoning
 * tier menu resolves its options from cards, so gating reads behind admin would
 * leave a non-admin with a menu built from stale fallbacks while their requests
 * were clamped by the real card tiers — the UI and the request path disagreeing.
 * Writes below are admin-only, since cards are instance-wide configuration.
 */
modelCardRoutes.get("/", (c) => {
	const userCards = settings.agent.modelCards ?? [];
	const cards = getEffectiveModelCards(userCards);
	const { provenance } = mergeModelCards(userCards);
	return c.json({
		cards: [...cards].sort((a, b) => {
			const family = (a.family ?? "").localeCompare(b.family ?? "");
			return family !== 0 ? family : a.modelKey.localeCompare(b.modelKey);
		}),
		// Which fields the user changed, so the editor can label a value as
		// inherited or overridden instead of presenting both identically.
		provenance: Object.fromEntries(
			[...provenance.entries()].map(([key, value]) => [key, value.overriddenFields]),
		),
	});
});

/**
 * Persist the effective card set, storing only the difference from builtin data.
 *
 * The client sends whole cards (it edits whole cards); the diff happens here so
 * the "store only what changed" rule cannot be bypassed by a client that does
 * not implement it.
 */
function persistEffectiveCards(nextEffective: ModelCard[]): ModelCard[] {
	const deltas = diffModelCards(nextEffective);
	settings.agent.modelCards = deltas;
	saveSettings(settings);
	// saveSettings drops the memo too; called here as well so a future refactor
	// of that path cannot leave this route serving a stale index.
	invalidateModelCardCache();
	return getEffectiveModelCards(settings.agent.modelCards ?? []);
}

/** Create or update one card. */
modelCardRoutes.put("/:key", requireAdmin, async (c) => {
	const parsed = modelCardSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const key = decodeURIComponent(c.req.param("key") ?? "")
		.trim()
		.toLowerCase();
	if (!key) throw new ValidationError("model key is required");
	// The path is authoritative for identity: a body key that disagreed would
	// otherwise silently write a different card than the URL names.
	const incoming: ModelCard = { ...parsed.data, modelKey: key };

	const current = getEffectiveModelCards(settings.agent.modelCards ?? []);
	const next = current.filter((card) => card.modelKey !== key);
	next.push(incoming);

	const effective = persistEffectiveCards(next);
	const saved = effective.find((card) => card.modelKey === key);
	return c.json({ card: saved ?? incoming });
});

/**
 * Delete one card.
 *
 * Deleting a builtin card records a tombstone rather than removing an entry:
 * builtin cards come from code, so without the marker the next load would bring
 * the card back.
 */
modelCardRoutes.delete("/:key", requireAdmin, (c) => {
	const key = decodeURIComponent(c.req.param("key") ?? "")
		.trim()
		.toLowerCase();
	if (!key) throw new ValidationError("model key is required");
	const current = getEffectiveModelCards(settings.agent.modelCards ?? []);
	const next = current.filter((card) => card.modelKey !== key);
	if (next.length === current.length) {
		return c.json({ ok: true, deleted: false });
	}
	persistEffectiveCards(next);
	return c.json({ ok: true, deleted: true });
});

/**
 * Restore a card to its builtin values by dropping the user's delta.
 *
 * Distinct from PUT-ing the builtin values back: that would record a delta whose
 * values happen to match, pinning those fields against future builtin updates.
 * Removing the delta is what actually returns the card to "follows builtin".
 */
modelCardRoutes.post("/:key/reset", requireAdmin, (c) => {
	const key = decodeURIComponent(c.req.param("key") ?? "")
		.trim()
		.toLowerCase();
	if (!key) throw new ValidationError("model key is required");
	const deltas = (settings.agent.modelCards ?? []).filter((card) => card.modelKey !== key);
	settings.agent.modelCards = deltas;
	saveSettings(settings);
	invalidateModelCardCache();
	const effective = getEffectiveModelCards(settings.agent.modelCards ?? []);
	const restored = effective.find((card) => card.modelKey === key);
	return c.json({ card: restored ?? null });
});
