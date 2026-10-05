import type { PermissionRuleRequestResult } from "@shared/permission-rule-request";
import { z } from "zod/v4";

const ruleBase = {
	id: z.string().min(1).max(256),
	enabled: z.literal(true),
	selector: z.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("host") }),
		z.strictObject({ kind: z.literal("device"), deviceId: z.string().min(1).max(200) }),
	]),
	source: z.literal("narrator"),
	createdAt: z.string().max(64).optional(),
	updatedAt: z.string().max(64).optional(),
};
const pathBase = {
	path: z.string().min(1).max(4096),
	pathFlavor: z.enum(["posix", "windows"]),
	pathKey: z.string().min(1).max(4096),
};
export const permissionRuleRequestResultSchema: z.ZodType<PermissionRuleRequestResult> =
	z.strictObject({
		requestId: z.string().min(1).max(256),
		status: z.enum(["applied", "alreadyExists"]),
		ruleId: z.string().min(1).max(256),
		proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
		scope: z.literal("narrator"),
		deviceId: z.string().min(1).max(200),
		approvalSource: z.enum(["user", "reflection"]),
		approvalUserId: z.string().min(1).max(256).nullable(),
		rule: z.discriminatedUnion("ruleType", [
			z.strictObject({
				...ruleBase,
				...pathBase,
				ruleType: z.literal("directoryWhitelist"),
				accessLevel: z.enum(["readOnly", "readWrite", "full"]),
			}),
			z.strictObject({
				...ruleBase,
				...pathBase,
				ruleType: z.literal("directoryBlacklist"),
				denyLevel: z.enum(["denyWrite", "denyAll"]),
			}),
			z.strictObject({
				...ruleBase,
				ruleType: z.literal("commandWhitelist"),
				pattern: z.string().min(1).max(200),
			}),
			z.strictObject({
				...ruleBase,
				ruleType: z.literal("commandBlacklist"),
				pattern: z.string().min(1).max(200),
				denyPrompt: z.string().max(2000).optional(),
			}),
		]),
	});
