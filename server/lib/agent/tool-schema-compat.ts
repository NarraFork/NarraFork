/** Provider-boundary projection of object unions; nested combinators remain supported. */
import { logger } from "../logger";

type Schema = Record<string, unknown>;
const combinators = ["anyOf", "oneOf", "allOf"] as const;
const annotations = [
	"title",
	"description",
	"$comment",
	"default",
	"examples",
	"deprecated",
	"readOnly",
	"writeOnly",
];

function isRecord(value: unknown): value is Schema {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function combine(definitions: unknown[], keyword: "anyOf" | "allOf"): unknown {
	if (definitions.length === 1) return definitions[0];
	if (
		definitions.every((definition) => JSON.stringify(definition) === JSON.stringify(definitions[0]))
	) {
		return definitions[0];
	}
	// Only collapse literals when ALL other constraints agree (including type and metadata).
	if (keyword === "anyOf" && definitions.every(isRecord)) {
		const records = definitions as Schema[];
		const rest = records.map(({ const: _const, enum: _enum, ...constraints }) => constraints);
		if (
			rest.every((constraints) => JSON.stringify(constraints) === JSON.stringify(rest[0])) &&
			records.every(
				(record) =>
					Object.hasOwn(record, "const") !== Object.hasOwn(record, "enum") &&
					(Object.hasOwn(record, "const") || Array.isArray(record.enum)),
			)
		) {
			const values = records.flatMap((record) =>
				Object.hasOwn(record, "const") ? [record.const] : (record.enum as unknown[]),
			);
			return {
				...rest[0],
				enum: [...new Map(values.map((value) => [JSON.stringify(value), value])).values()],
			};
		}
	}
	return { [keyword]: definitions };
}

// Do not rewrite JSON Pointers: combination removal and property wrapping can relocate targets.
function hasRelocatedReference(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(hasRelocatedReference);
	if (!isRecord(value)) return false;
	for (const key of ["$ref", "$dynamicRef", "$recursiveRef"]) {
		const reference = value[key];
		if (typeof reference !== "string" || !reference.startsWith("#")) continue;
		let fragment: string;
		try {
			fragment = decodeURIComponent(reference.slice(1));
		} catch {
			return true;
		}
		if (fragment === "") return true;
		if (!fragment.startsWith("/")) continue;
		const first = fragment.split("/")[1].replace(/~1/g, "/").replace(/~0/g, "~");
		if (first === "properties" || combinators.some((key) => key === first)) return true;
	}
	return Object.values(value).some(hasRelocatedReference);
}

/**
 * Union projection intentionally loses cross-property correlations (and oneOf exclusivity),
 * but never picks an arbitrary property's first variant. allOf remains conjunctive.
 * Unsupported object-level constraints are left untouched with a diagnostic instead of guessed.
 */
export function flattenTopLevelUnion(schema: Schema): Schema {
	const keywords = combinators.filter((key) => Object.hasOwn(schema, key));
	if (keywords.length === 0) return schema;
	const refuse = (reason: string): Schema => {
		logger.warn("Tool input_schema has a top-level union that could not be flattened", {
			keywords,
			reason,
		});
		return schema;
	};
	if (keywords.length !== 1) return refuse("multiple top-level combinators");
	if (hasRelocatedReference(schema)) return refuse("local reference target may be relocated");
	const keyword = keywords[0];
	const raw = schema[keyword];
	if (!Array.isArray(raw) || raw.length === 0) return refuse("invalid branches");
	if (schema.type !== undefined && schema.type !== "object") return refuse("non-object root");
	const branches: Schema[] = [];
	for (const branch of raw) {
		if (!isRecord(branch) || branch.type !== "object") return refuse("non-object branch");
		if (
			Object.keys(branch).some(
				(key) =>
					!["type", "properties", "required", "additionalProperties", ...annotations].includes(key),
			) ||
			(branch.properties !== undefined && !isRecord(branch.properties)) ||
			(branch.required !== undefined &&
				(!Array.isArray(branch.required) ||
					!branch.required.every((name) => typeof name === "string"))) ||
			(branch.additionalProperties !== undefined &&
				typeof branch.additionalProperties !== "boolean")
		)
			return refuse("unsupported branch constraints");
		branches.push(branch);
	}
	if (
		(schema.properties !== undefined && !isRecord(schema.properties)) ||
		(schema.required !== undefined &&
			(!Array.isArray(schema.required) ||
				!schema.required.every((name) => typeof name === "string")))
	)
		return refuse("invalid root properties or required");

	const flattened = { ...schema };
	delete flattened[keyword];
	flattened.type = "object";
	// Object annotations can be hoisted only when every branch agrees with the root.
	for (const key of annotations) {
		const values = branches.map((branch) => branch[key]);
		if (values.every((value) => value === undefined)) continue;
		if (!values.every((value) => JSON.stringify(value) === JSON.stringify(values[0])))
			return refuse("conflicting branch metadata");
		if (schema[key] !== undefined && JSON.stringify(schema[key]) !== JSON.stringify(values[0]))
			return refuse("conflicting root metadata");
		flattened[key] = values[0];
	}

	const rootProperties = (schema.properties ?? {}) as Schema;
	const names = [
		...new Set(branches.flatMap((branch) => Object.keys((branch.properties ?? {}) as Schema))),
	];
	const addsProperties = names.some((name) => !Object.hasOwn(rootProperties, name));
	if (
		addsProperties &&
		schema.additionalProperties !== undefined &&
		schema.additionalProperties !== true
	)
		return refuse("root additionalProperties constrains introduced properties");
	if (
		addsProperties &&
		["$ref", "patternProperties", "unevaluatedProperties", "dependentSchemas"].some((key) =>
			Object.hasOwn(schema, key),
		)
	)
		return refuse("root constraints depend on property coverage");
	const closed = branches.map((branch) => branch.additionalProperties === false);
	if (closed.some(Boolean) && !closed.every(Boolean))
		return refuse("conflicting additionalProperties");
	if (closed.every(Boolean)) {
		if (
			keyword === "allOf" &&
			names.some((name) =>
				branches.some((branch) => !Object.hasOwn((branch.properties ?? {}) as Schema, name)),
			)
		)
			return refuse("closed allOf branches have different properties");
		if (Object.keys(rootProperties).some((name) => !names.includes(name)))
			return refuse("closed branches exclude root properties");
		flattened.additionalProperties = false;
	}

	const properties: Schema = { ...rootProperties };
	for (const name of names) {
		const definitions: unknown[] = [];
		for (const branch of branches) {
			const branchProperties = (branch.properties ?? {}) as Schema;
			if (Object.hasOwn(branchProperties, name)) definitions.push(branchProperties[name]);
			else if (keyword !== "allOf" && branch.additionalProperties !== false) definitions.push(true);
		}
		const merged = combine(definitions, keyword === "allOf" ? "allOf" : "anyOf");
		properties[name] = Object.hasOwn(rootProperties, name)
			? combine([rootProperties[name], merged], "allOf")
			: merged;
	}
	flattened.properties = properties;
	const requiredPerBranch = branches.map((branch) => new Set((branch.required ?? []) as string[]));
	const branchRequired =
		keyword === "allOf"
			? requiredPerBranch.flatMap((set) => [...set])
			: [...requiredPerBranch[0]].filter((name) => requiredPerBranch.every((set) => set.has(name)));
	const required = [...new Set([...((schema.required ?? []) as string[]), ...branchRequired])];
	if (required.length > 0 || schema.required !== undefined) flattened.required = required;
	logger.debug("Flattened a top-level tool schema union for Anthropic", {
		keyword,
		branches: branches.length,
	});
	return flattened;
}
