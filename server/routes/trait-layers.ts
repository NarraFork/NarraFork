/**
 * Project- and user-level trait layer editing.
 *
 * Narrator-level traits are edited under `/api/narrators/:id/custom-traits`; these
 * are the two layers above it. The payload shapes are deliberately identical to
 * the narrator ones so the same UI editor can drive all three.
 *
 * Authorization: project traits are admin-only for now because there is no
 * project membership model yet (any authenticated user can currently see every
 * project), so "members may edit their project's policy" is not yet expressible.
 * User traits are self-service — they are that user's own defaults — with admins
 * additionally able to edit anyone's.
 */
import { type Context, Hono } from "hono";
import {
	DEVICE_INJECTION_TRAIT_PREFIX,
	encodeDeviceInjectionTrait,
	normalizeDeviceInjectionTrait,
	parseDeviceInjectionTrait,
} from "../lib/device-injection-trait";
import { ValidationError } from "../lib/errors";
import {
	BLOCKED_SKILLS_TRAIT_PREFIX,
	buildCustomTraitsResponse,
	DISABLED_TOOLS_TRAIT_PREFIX,
	normalizeBlockedSkills,
	normalizeDisabledTools,
	normalizeSubagentModelRestriction,
	removeEncodedTrait,
	SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX,
	upsertEncodedTrait,
} from "../lib/narrator-custom-traits";
import { parseTraits } from "../lib/narrator-utils";
import {
	type EnforcedTraitKeys,
	parseEnforcedKeys,
	withEnforcedKeys,
} from "../lib/trait-resolution";
import { assertAdmin } from "../middleware/auth";
import {
	type EditableTraitLayer,
	getLayerTraits,
	updateLayerTraits,
} from "../services/trait-layer-service";

export const traitLayerRoutes = new Hono();

/**
 * Response shape shared by every endpoint here. Mirrors the narrator
 * custom-traits response plus the layer's enforcement flags, so one UI editor can
 * render all three layers.
 */
function buildLayerTraitsResponse(view: {
	layer: EditableTraitLayer;
	traits: string[];
	enforced: EnforcedTraitKeys;
}) {
	return {
		ok: true,
		layer: view.layer,
		enforced: {
			disabledTools: view.enforced.disabledTools === true,
			blockedSkills: view.enforced.blockedSkills === true,
			subagentModels: view.enforced.subagentModels === true,
		},
		customTraits: buildCustomTraitsResponse(view.traits),
		deviceInjection: parseDeviceInjectionTrait(view.traits),
	};
}

/** Resolve and authorize the layer being edited. */
function resolveTarget(c: Context): { layer: EditableTraitLayer; ownerId: string } {
	const layer = c.req.param("layer");
	const ownerId = c.req.param("ownerId");
	if (layer !== "project" && layer !== "user") {
		throw new ValidationError("Trait layer must be 'project' or 'user'");
	}
	if (!ownerId) throw new ValidationError("Owner id is required");

	if (layer === "project") {
		// No project membership model exists yet, so project policy stays admin-only.
		assertAdmin(c);
	} else {
		const user = c.get("user");
		if (user.sub !== ownerId) assertAdmin(c);
	}
	return { layer, ownerId };
}

function readEnforcedFlag(body: unknown): boolean {
	return !!body && typeof body === "object" && (body as { enforced?: unknown }).enforced === true;
}

/**
 * Parse the request body as JSON, throwing a 400 ValidationError on failure.
 *
 * The previous `.catch(() => ({}))` pattern silently swallowed malformed JSON
 * and treated it as an empty object, making debugging impossible for callers
 * sending broken payloads. An explicit error is safer and more honest.
 */
async function parseJsonBody(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		throw new ValidationError("Invalid JSON body");
	}
}

/**
 * Set or clear the enforced marker for one trait key while leaving the others
 * alone. Enforcement is per trait key, so editing tools must not disturb the
 * skills marker.
 */
function applyEnforced(
	traits: string[],
	key: keyof EnforcedTraitKeys,
	enforced: boolean,
): string[] {
	const current = parseEnforcedKeys(traits);
	return withEnforcedKeys(traits, { ...current, [key]: enforced });
}

traitLayerRoutes.get("/:layer/:ownerId", async (c) => {
	const { layer, ownerId } = resolveTarget(c);
	const view = await getLayerTraits(layer, ownerId);
	return c.json(buildLayerTraitsResponse(view));
});

traitLayerRoutes.put("/:layer/:ownerId/disabled-tools", async (c) => {
	const { layer, ownerId } = resolveTarget(c);
	const body = await parseJsonBody(c);
	const disabledTools = normalizeDisabledTools(body);
	const enforced = readEnforcedFlag(body);
	const view = await updateLayerTraits(layer, ownerId, (current) =>
		applyEnforced(
			upsertEncodedTrait(current, DISABLED_TOOLS_TRAIT_PREFIX, disabledTools),
			"disabledTools",
			enforced,
		),
	);
	return c.json(buildLayerTraitsResponse(view));
});

traitLayerRoutes.delete("/:layer/:ownerId/disabled-tools", async (c) => {
	const { layer, ownerId } = resolveTarget(c);
	const view = await updateLayerTraits(layer, ownerId, (current) =>
		applyEnforced(removeEncodedTrait(current, DISABLED_TOOLS_TRAIT_PREFIX), "disabledTools", false),
	);
	return c.json(buildLayerTraitsResponse(view));
});

traitLayerRoutes.put("/:layer/:ownerId/blocked-skills", async (c) => {
	const { layer, ownerId } = resolveTarget(c);
	const body = await parseJsonBody(c);
	const blockedSkills = normalizeBlockedSkills(body);
	const enforced = readEnforcedFlag(body);
	const view = await updateLayerTraits(layer, ownerId, (current) =>
		applyEnforced(
			upsertEncodedTrait(current, BLOCKED_SKILLS_TRAIT_PREFIX, blockedSkills),
			"blockedSkills",
			enforced,
		),
	);
	return c.json(buildLayerTraitsResponse(view));
});

traitLayerRoutes.delete("/:layer/:ownerId/blocked-skills", async (c) => {
	const { layer, ownerId } = resolveTarget(c);
	const view = await updateLayerTraits(layer, ownerId, (current) =>
		applyEnforced(removeEncodedTrait(current, BLOCKED_SKILLS_TRAIT_PREFIX), "blockedSkills", false),
	);
	return c.json(buildLayerTraitsResponse(view));
});

traitLayerRoutes.put("/:layer/:ownerId/subagent-model-restriction", async (c) => {
	const { layer, ownerId } = resolveTarget(c);
	const body = await parseJsonBody(c);
	const restriction = normalizeSubagentModelRestriction(body);
	const enforced = readEnforcedFlag(body);
	const view = await updateLayerTraits(layer, ownerId, (current) =>
		applyEnforced(
			Object.keys(restriction.pools).length === 0
				? removeEncodedTrait(current, SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX)
				: upsertEncodedTrait(current, SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX, restriction),
			"subagentModels",
			enforced,
		),
	);
	return c.json(buildLayerTraitsResponse(view));
});

traitLayerRoutes.delete("/:layer/:ownerId/subagent-model-restriction", async (c) => {
	const { layer, ownerId } = resolveTarget(c);
	const view = await updateLayerTraits(layer, ownerId, (current) =>
		applyEnforced(
			removeEncodedTrait(current, SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX),
			"subagentModels",
			false,
		),
	);
	return c.json(buildLayerTraitsResponse(view));
});

/**
 * Device injection is a preference, so it has no enforced flag: a lower layer can
 * always be overridden by a higher one, and injection grants no access on its own.
 */
traitLayerRoutes.put("/:layer/:ownerId/device-injection", async (c) => {
	const { layer, ownerId } = resolveTarget(c);
	const body = await parseJsonBody(c);
	const injection = normalizeDeviceInjectionTrait(body);
	const view = await updateLayerTraits(layer, ownerId, (current) => [
		...parseTraits(current).filter((t) => !t.startsWith(DEVICE_INJECTION_TRAIT_PREFIX)),
		encodeDeviceInjectionTrait(injection),
	]);
	return c.json(buildLayerTraitsResponse(view));
});

traitLayerRoutes.delete("/:layer/:ownerId/device-injection", async (c) => {
	const { layer, ownerId } = resolveTarget(c);
	const view = await updateLayerTraits(layer, ownerId, (current) =>
		parseTraits(current).filter((t) => !t.startsWith(DEVICE_INJECTION_TRAIT_PREFIX)),
	);
	return c.json(buildLayerTraitsResponse(view));
});

/** Exposed for tests: the parsed injection trait for one layer. */
export function readLayerDeviceInjection(traits: unknown) {
	return parseDeviceInjectionTrait(traits);
}
