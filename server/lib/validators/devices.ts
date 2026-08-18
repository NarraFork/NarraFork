import {
	isAbsoluteExecutorPath,
	MAX_EXECUTOR_PATH_LENGTH,
	MAX_EXECUTOR_PATH_RULES,
} from "@shared/executor-path-rules";
import { EXECUTOR_PLATFORMS } from "@shared/remote-executor";
import { z } from "zod";
import { isSecureDirectDeviceUrl } from "../device-url";

/** Device slug: lowercase letters, digits, hyphen, underscore. */
export const deviceSlugSchema = z
	.string()
	.min(2)
	.max(64)
	.regex(/^[a-z0-9_-]+$/, "Slug may only contain lowercase letters, digits, '-' and '_'");

const directDeviceUrlSchema = z.string().url().max(2000).refine(isSecureDirectDeviceUrl, {
	message: "Direct device URL must use wss://, or ws:// with a loopback IP literal",
});

export const createRemoteDeviceSchema = z
	.object({
		name: z.string().trim().min(1).max(120),
		/** Optional explicit slug; generated from name when omitted. */
		slug: deviceSlugSchema.optional(),
		description: z.string().trim().max(2000).optional(),
		connectionMode: z.enum(["reverse", "direct"]).default("reverse"),
		/** Required when connectionMode === "direct". */
		directUrl: directDeviceUrlSchema.optional(),
		/**
		 * Owner axis. "private" confines the device to the registering user (a
		 * personal machine); "shared" leaves it open to everyone the project axis
		 * allows. Defaults to "shared", matching the pre-existing behaviour.
		 */
		ownerScope: z.enum(["private", "shared"]).default("shared"),
		scope: z.enum(["global", "project"]).default("global"),
		/** Required when scope === "project". */
		projectId: z.string().trim().min(1).optional(),
	})
	.superRefine((data, ctx) => {
		if (data.connectionMode === "direct" && !data.directUrl) {
			ctx.addIssue({
				code: "custom",
				path: ["directUrl"],
				message: "directUrl is required for direct connection mode",
			});
		}
		if (data.scope === "project" && !data.projectId) {
			ctx.addIssue({
				code: "custom",
				path: ["projectId"],
				message: "projectId is required for project scope",
			});
		}
	});

export const updateRemoteDeviceSchema = z.object({
	name: z.string().trim().min(1).max(120).optional(),
	description: z.string().trim().max(2000).nullable().optional(),
	connectionMode: z.enum(["reverse", "direct"]).optional(),
	directUrl: directDeviceUrlSchema.nullable().optional(),
	ownerScope: z.enum(["private", "shared"]).optional(),
	scope: z.enum(["global", "project"]).optional(),
	projectId: z.string().trim().min(1).nullable().optional(),
});

export const deviceTransferSchema = z.object({
	direction: z.enum(["download", "upload"]),
	remotePath: z.string().min(1).max(4096),
	localPath: z.string().min(1).max(4096),
	recursive: z.boolean().optional(),
});

export const deviceStatQuerySchema = z.object({
	path: z.string().min(1).max(4096),
	recursive: z.boolean().optional(),
});

/**
 * Single-level directory listing for interactive browsing. Unlike
 * deviceStatQuerySchema's recursive mode (which walks an entire tree and is
 * meant for transfer manifests), this lists one directory at a time. `path` is
 * optional so the picker can open at the device's default working directory.
 */
export const deviceBrowseQuerySchema = z.object({
	path: z.string().min(1).max(4096).optional(),
	showHidden: z.boolean().optional(),
});

/**
 * Install-script generation request. The script generator validates path shape
 * and escaping itself; this layer only bounds the inputs and rejects the control
 * characters that must never reach a generated shell script.
 */
export const deviceInstallScriptSchema = z.object({
	platform: z.enum(EXECUTOR_PLATFORMS),
	mode: z.enum(["system", "user"]).default("system"),
	disableShell: z.boolean().default(false),
	/**
	 * Absolute base URL the target machine uses to reach NarraFork. Optional: the
	 * server derives it from the forwarded public origin when omitted.
	 */
	serverBaseUrl: z.string().url().max(2000).optional(),
	/**
	 * How the device key reaches the machine.
	 *
	 * Defaults to "enroll" (the script collects the key itself, enabling a one-line
	 * install) because the manual hand-off was the main friction in enrollment. The
	 * route still refuses "enroll" when the transport cannot carry a key safely, so a
	 * permissive default here does not weaken the guarantee — it only decides which
	 * path is offered first.
	 */
	tokenDelivery: z.enum(["enroll", "prompt"]).default("enroll"),
});

/**
 * Renders rules as the `pathRules` fragment of the executor config file.
 *
 * Built with JSON.stringify rather than string concatenation so a path containing
 * quotes or backslashes (routine on Windows) cannot break out of its JSON string.
 */
export function buildPathRulesConfigSnippet(
	rules: ReadonlyArray<{ action: string; path: string }>,
): string {
	return JSON.stringify({ pathRules: rules }, null, 2);
}

/**
 * One ordered path guard rule. Paths are accepted in both POSIX and Windows shape
 * because the server may run on a different OS than the device, and rewriting the
 * operator's path by the server's own rules would change its meaning.
 */
export const executorPathRuleSchema = z.object({
	action: z.enum(["allow", "deny"]),
	path: z
		.string()
		.trim()
		.min(1)
		.max(MAX_EXECUTOR_PATH_LENGTH)
		// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the intent
		.refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
			message: "Path may not contain control characters or newlines",
		})
		.refine(isAbsoluteExecutorPath, { message: "Path must be absolute" }),
});

/**
 * Ordered rule list. Never sorted or deduped on the way in: order is the priority
 * mechanism (last match wins) and duplicates are a legitimate way to override an
 * earlier entry, so normalizing either one would silently change the policy.
 */
export const updateDevicePathRulesSchema = z.object({
	rules: z.array(executorPathRuleSchema).max(MAX_EXECUTOR_PATH_RULES),
});
