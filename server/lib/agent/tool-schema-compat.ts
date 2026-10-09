/**
 * Provider compatibility for tool input schemas.
 *
 * Anthropic's Messages API rejects `oneOf`/`allOf`/`anyOf` at the top level of a tool's
 * `input_schema` — nested inside `properties` they are fine — and it rejects the entire
 * request rather than just the offending tool, so one bad definition stops the agent loop
 * from starting at all. Tool schemas reach a provider from plugins, MCP servers and user
 * configuration as much as from this codebase, so the shape is normalized at the provider
 * boundary instead of at each definition site.
 *
 * Kept in its own module because it is pure — no provider state, no database — which is what
 * makes the merge rules testable on their own.
 */

import { logger } from "../logger";

/**
 * One property as it appears across the branches of a flattened union.
 *
 * A discriminator — the same property carrying a different `const`/`enum` per branch, e.g.
 * `ruleType` — collapses into the enum of those values. Anything that cannot be merged that
 * simply keeps the first definition: every branch describes the same property name, so the
 * first one is as wide as any, and inventing a narrower shape risks describing arguments the
 * tool does not accept.
 */
function mergePropertyVariants(definitions: unknown[]): unknown {
	if (definitions.length === 1) return definitions[0];
	const literals = new Set<string>();
	for (const definition of definitions) {
		if (typeof definition !== "object" || definition === null) return definitions[0];
		const record = definition as Record<string, unknown>;
		if (typeof record.const === "string") {
			literals.add(record.const);
			continue;
		}
		if (Array.isArray(record.enum) && record.enum.every((value) => typeof value === "string")) {
			for (const value of record.enum) literals.add(value as string);
			continue;
		}
		return definitions[0];
	}
	if (literals.size === 0) return definitions[0];
	const { const: _const, enum: _enum, ...rest } = definitions[0] as Record<string, unknown>;
	return { ...rest, enum: [...literals] };
}

/**
 * Flatten a top-level `oneOf`/`allOf`/`anyOf` into a single object schema.
 *
 * Anthropic rejects those keywords at the TOP level of a tool `input_schema` — nested inside
 * `properties` they are fine — and it rejects the entire request rather than the one tool, so
 * a single offending definition stops the agent loop from starting at all. Tool schemas reach
 * this provider from plugins, MCP servers and user configuration as much as from this
 * codebase, which is why the shape is enforced here rather than at each definition site.
 *
 * The merge is deliberately conservative and returns the schema untouched whenever it cannot
 * be done confidently: a schema the API refuses is better than one describing the wrong
 * arguments. It applies only when every branch is an object schema, and then:
 *   - `properties` is the union of the branches' properties;
 *   - `required` is their INTERSECTION, so a field that only some branches need does not
 *     become mandatory for all of them;
 *   - the discriminator collapses through {@link mergePropertyVariants}.
 */
export function flattenTopLevelUnion(schema: Record<string, unknown>): Record<string, unknown> {
	const keyword = (["anyOf", "oneOf", "allOf"] as const).find((key) => Array.isArray(schema[key]));
	if (!keyword) return schema;
	const raw = schema[keyword] as unknown[];
	const branches = raw.filter(
		(branch): branch is Record<string, unknown> =>
			typeof branch === "object" && branch !== null && !Array.isArray(branch),
	);
	if (
		branches.length !== raw.length ||
		branches.length === 0 ||
		branches.some((branch) => branch.type !== "object")
	) {
		// Reported rather than silently sent: the API will reject this shape with a message
		// that names neither the tool nor the keyword, which is why the issue that prompted
		// this function was hard to diagnose.
		logger.warn("Tool input_schema has a top-level union that could not be flattened", {
			keyword,
			branches: raw.length,
		});
		return schema;
	}

	const variants = new Map<string, unknown[]>();
	const requiredPerBranch: Set<string>[] = [];
	for (const branch of branches) {
		const properties = branch.properties;
		if (typeof properties === "object" && properties !== null) {
			for (const [name, definition] of Object.entries(properties as Record<string, unknown>)) {
				const seen = variants.get(name);
				if (seen) seen.push(definition);
				else variants.set(name, [definition]);
			}
		}
		requiredPerBranch.push(
			new Set(Array.isArray(branch.required) ? (branch.required as string[]) : []),
		);
	}

	const properties: Record<string, unknown> = {};
	for (const [name, definitions] of variants) {
		properties[name] = mergePropertyVariants(definitions);
	}
	const required = [...(requiredPerBranch[0] ?? [])].filter((name) =>
		requiredPerBranch.every((set) => set.has(name)),
	);

	const flattened: Record<string, unknown> = { type: "object", properties };
	if (required.length > 0) flattened.required = required;
	logger.debug("Flattened a top-level tool schema union for Anthropic", {
		keyword,
		branches: branches.length,
		properties: Object.keys(properties).length,
	});
	return flattened;
}
