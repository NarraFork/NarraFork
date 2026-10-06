import { createHash } from "node:crypto";
import { z } from "zod";

export const CONSTRAINT_ARRAY_MAX_ITEMS = 100;
export const CONSTRAINT_TOPIC_MAX_LENGTH = 200;
export const CONSTRAINT_METHOD_MAX_LENGTH = 200;
export const CONSTRAINT_PATH_MAX_LENGTH = 4_096;
export const CONSTRAINT_FIELD_MAX_LENGTH = 200;
export const CONSTRAINT_PROVIDER_ID_MAX_LENGTH = 128;
export const CONSTRAINT_MAX_BYTES = 64 * 1024 * 1024;
export const CONSTRAINT_MAX_RATE_PER_SECOND = 10_000;

function uniqueArray<T extends z.ZodType>(item: T, maximum = CONSTRAINT_ARRAY_MAX_ITEMS) {
	return z
		.array(item)
		.min(1)
		.max(maximum)
		.refine((values) => new Set(values).size === values.length, "Constraint values must be unique");
}

const topicSchema = z
	.string()
	.min(1)
	.max(CONSTRAINT_TOPIC_MAX_LENGTH)
	.regex(/^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*$/);
const methodSchema = z
	.string()
	.min(1)
	.max(CONSTRAINT_METHOD_MAX_LENGTH)
	.regex(/^[A-Za-z][A-Za-z0-9._:-]*$/);
const pathSchema = z
	.string()
	.min(1)
	.max(CONSTRAINT_PATH_MAX_LENGTH)
	.regex(/^\/(?!\/)/)
	.refine(
		(value) =>
			[...value].every((character) => {
				const codePoint = character.codePointAt(0) ?? 0;
				return codePoint >= 0x20 && codePoint !== 0x7f;
			}),
		"Path cannot contain control characters",
	);
const fieldSchema = z
	.string()
	.min(1)
	.max(CONSTRAINT_FIELD_MAX_LENGTH)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const providerIdSchema = z
	.string()
	.min(1)
	.max(CONSTRAINT_PROVIDER_ID_MAX_LENGTH)
	.refine((value) => value === value.trim(), "Provider id cannot contain surrounding whitespace");

export const authorizationConstraintsSchema = z
	.object({
		topics: uniqueArray(topicSchema).optional(),
		methods: uniqueArray(methodSchema).optional(),
		paths: uniqueArray(pathSchema).optional(),
		fields: uniqueArray(fieldSchema).optional(),
		providerIds: uniqueArray(providerIdSchema).optional(),
		resourceIds: uniqueArray(providerIdSchema).optional(),
		maxBytes: z.number().int().nonnegative().max(CONSTRAINT_MAX_BYTES).optional(),
		maxRatePerSecond: z.number().finite().positive().max(CONSTRAINT_MAX_RATE_PER_SECOND).optional(),
	})
	.strict();
export type AuthorizationConstraints = z.infer<typeof authorizationConstraintsSchema>;
export type AuthorizationConstraintKey = keyof AuthorizationConstraints;

const ARRAY_CONSTRAINT_KEYS = [
	"topics",
	"methods",
	"paths",
	"fields",
	"providerIds",
	"resourceIds",
] as const;
type ArrayConstraintKey = (typeof ARRAY_CONSTRAINT_KEYS)[number];

export interface ConstraintCheckResult {
	allowed: boolean;
	failedConstraint?: AuthorizationConstraintKey;
}

function arrayConstraintAllows(
	allowed: readonly string[] | undefined,
	requested: readonly string[] | undefined,
): boolean {
	if (!allowed) return true;
	if (!requested) return false;
	const allowedValues = new Set(allowed);
	return requested.every((value) => allowedValues.has(value));
}

/** A constrained grant requires the operation to declare and remain within every grant limit. */
export function constraintsAllow(
	grantConstraints: AuthorizationConstraints | undefined,
	operationConstraints: AuthorizationConstraints | undefined,
): ConstraintCheckResult {
	const grant = authorizationConstraintsSchema.parse(grantConstraints ?? {});
	const operation = authorizationConstraintsSchema.parse(operationConstraints ?? {});
	for (const key of ARRAY_CONSTRAINT_KEYS) {
		if (!arrayConstraintAllows(grant[key], operation[key])) {
			return { allowed: false, failedConstraint: key };
		}
	}
	if (grant.maxBytes !== undefined) {
		if (operation.maxBytes === undefined || operation.maxBytes > grant.maxBytes) {
			return { allowed: false, failedConstraint: "maxBytes" };
		}
	}
	if (grant.maxRatePerSecond !== undefined) {
		if (
			operation.maxRatePerSecond === undefined ||
			operation.maxRatePerSecond > grant.maxRatePerSecond
		) {
			return { allowed: false, failedConstraint: "maxRatePerSecond" };
		}
	}
	return { allowed: true };
}

function stableConstraintValue(constraints: AuthorizationConstraints | undefined) {
	const parsed = authorizationConstraintsSchema.parse(constraints ?? {});
	const stable: Record<string, number | string[]> = {};
	for (const key of ARRAY_CONSTRAINT_KEYS) {
		const values = parsed[key];
		if (values) stable[key] = [...values].sort();
	}
	if (parsed.maxBytes !== undefined) stable.maxBytes = parsed.maxBytes;
	if (parsed.maxRatePerSecond !== undefined) {
		stable.maxRatePerSecond = parsed.maxRatePerSecond;
	}
	return stable;
}

export function digestAuthorizationConstraints(
	constraints: AuthorizationConstraints | undefined,
): string {
	return createHash("sha256")
		.update(JSON.stringify(stableConstraintValue(constraints)))
		.digest("hex");
}

export function normalizeAuthorizationConstraints(
	constraints: AuthorizationConstraints | undefined,
): AuthorizationConstraints {
	return authorizationConstraintsSchema.parse(stableConstraintValue(constraints));
}

export type { ArrayConstraintKey };
