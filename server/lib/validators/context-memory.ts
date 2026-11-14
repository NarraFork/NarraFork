import { z } from "zod";

const id = z.string().min(1).max(128);
export const contextMemoryScopeSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("user") }),
	z.strictObject({ kind: z.literal("project"), id }),
	z.strictObject({ kind: z.literal("session"), id }),
]);
const content = z.string().trim().min(1).max(4096);
const expiresAt = z.string().datetime().nullable().default(null);
const expectedVersion = z
	.number()
	.int()
	.min(1)
	.max(Number.MAX_SAFE_INTEGER - 1);
export const proposeContextMemorySchema = z.strictObject({
	scope: contextMemoryScopeSchema,
	key: z
		.string()
		.trim()
		.min(1)
		.max(128)
		.transform((value) => value.normalize("NFKC").toLowerCase())
		.pipe(z.string().min(1).max(128)),
	content,
	expiresAt,
	source: z.strictObject({ narratorId: id, messageId: id.optional() }).optional(),
});
export const reviseContextMemorySchema = z.strictObject({ expectedVersion, content, expiresAt });
export const decideContextMemorySchema = z.strictObject({
	expectedVersion,
	action: z.enum(["confirm", "reject", "archive"]),
});
export const forgetContextMemorySchema = z.strictObject({ expectedVersion });
export const listContextMemorySchema = z.strictObject({
	scope: contextMemoryScopeSchema,
	cursor: id.optional(),
	limit: z.number().int().min(1).max(50).default(20),
});
export type ContextMemoryScope = z.infer<typeof contextMemoryScopeSchema>;
