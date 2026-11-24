import { z } from "zod";

export const PLUGIN_SOURCE_SCHEMA_VERSION = 1 as const;
export const PLUGIN_SOURCE_METADATA_FILE = "plugin-source.json";
export const PLUGIN_SOURCE_MAX_METADATA_BYTES = 16 * 1024;
export const PLUGIN_UPDATE_MAX_METADATA_BYTES = 64 * 1024;
export const PLUGIN_UPDATE_MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
export const PLUGIN_SOURCE_PLUGIN_ID = /^[a-z0-9](?:[a-z0-9.-]{1,126}[a-z0-9])$/;
export const PLUGIN_SOURCE_VERSION =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function noControls(value: string): boolean {
	return ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}
const boundedText = (max = 256) => z.string().min(1).max(max).refine(noControls);
export const pluginSourceIdSchema = boundedText(128).regex(PLUGIN_SOURCE_PLUGIN_ID);
export const pluginSourceVersionSchema = boundedText(128)
	.regex(PLUGIN_SOURCE_VERSION)
	.refine((value) => {
		const core = value.split("+", 1)[0] ?? "";
		const dash = core.indexOf("-");
		return (
			dash < 0 ||
			core
				.slice(dash + 1)
				.split(".")
				.every((part) => !/^\d+$/.test(part) || part === "0" || !part.startsWith("0"))
		);
	}, "Numeric prerelease identifiers must not have leading zeroes");
export const pluginSourceUrlSchema = boundedText(2048).superRefine((value, ctx) => {
	try {
		const url = new URL(value);
		if (
			!["https:", "http:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			value.includes("\\") ||
			/%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)
		) {
			ctx.addIssue({ code: "custom", message: "Expected an HTTP(S) URL without credentials" });
		}
	} catch {
		ctx.addIssue({ code: "custom", message: "Invalid source URL" });
	}
});
const artifactName = boundedText(256).refine(
	(value) => !/[\\/]/u.test(value) && value !== "." && value !== "..",
);
const repoName = boundedText(100)
	.regex(/^[A-Za-z0-9_.-]+$/u)
	.refine((value) => value !== "." && value !== "..");
const homepage = pluginSourceUrlSchema.optional();

export const pluginSourceSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("github"),
			owner: repoName,
			repo: repoName,
			assetName: artifactName,
			metadataAsset: artifactName.optional(),
			checksumAsset: artifactName.optional(),
			homepage,
		})
		.strict(),
	z
		.object({
			type: z.literal("website"),
			updateApi: pluginSourceUrlSchema,
			downloadOrigins: z
				.array(
					pluginSourceUrlSchema.refine((value) => {
						try {
							const url = new URL(value);
							return url.pathname === "/" && !url.search && !url.hash;
						} catch {
							return false;
						}
					}),
				)
				.max(8)
				.default([]),
			allowInsecureHttp: z.boolean().default(false),
			homepage,
		})
		.strict(),
	z.object({ type: z.literal("local"), builtinId: pluginSourceIdSchema, homepage }).strict(),
]);
export type PluginSource = z.infer<typeof pluginSourceSchema>;
export type GithubPluginSource = Extract<PluginSource, { type: "github" }>;
export type WebsitePluginSource = Extract<PluginSource, { type: "website" }>;
export type LocalPluginSource = Extract<PluginSource, { type: "local" }>;

export const pluginSourceMetadataSchema = z
	.object({
		schemaVersion: z.literal(PLUGIN_SOURCE_SCHEMA_VERSION),
		pluginId: pluginSourceIdSchema,
		source: pluginSourceSchema,
	})
	.strict();
export type PluginSourceMetadata = z.infer<typeof pluginSourceMetadataSchema>;

export const pluginSourceBindingSchema = z
	.object({
		revision: z.number().int().nonnegative().default(0),
		mode: z.enum(["inherit", "configured", "none"]).default("inherit"),
		source: pluginSourceSchema.nullable().default(null),
		autoUpdate: z.boolean().default(false),
	})
	.strict()
	.refine(
		(value) => !value.autoUpdate || value.source !== null,
		"Automatic updates require a source",
	)
	.refine(
		(value) => value.mode !== "none" || value.source === null,
		"Cleared bindings must not contain a source",
	)
	.refine(
		(value) => value.mode !== "configured" || value.source !== null,
		"Configured bindings require a source",
	);
export type PluginSourceBinding = z.infer<typeof pluginSourceBindingSchema>;
export const defaultPluginSourceBinding = (): PluginSourceBinding => ({
	revision: 0,
	mode: "inherit",
	source: null,
	autoUpdate: false,
});

export const pluginReleaseCompatibilitySchema = z
	.object({
		hostApi: boundedText(128).optional(),
		os: z
			.array(z.enum(["win32", "linux", "darwin"]))
			.max(3)
			.optional(),
		arch: z
			.array(z.enum(["x64", "arm64", "ia32"]))
			.max(3)
			.optional(),
	})
	.strict();
export const pluginWebsiteReleaseSchema = z
	.object({
		version: pluginSourceVersionSchema,
		publishedAt: z.string().datetime({ offset: true }).optional(),
		artifact: z
			.object({
				url: pluginSourceUrlSchema,
				sha256: z.string().regex(/^[a-f0-9]{64}$/u),
				size: z.number().int().positive().max(PLUGIN_UPDATE_MAX_ARCHIVE_BYTES),
			})
			.strict(),
		compatibility: pluginReleaseCompatibilitySchema.optional(),
		notes: z.string().max(4096).optional(),
	})
	.strict();
export type PluginWebsiteRelease = z.infer<typeof pluginWebsiteReleaseSchema>;
export const pluginWebsiteUpdateResponseSchema = z
	.object({
		schemaVersion: z.literal(1),
		pluginId: pluginSourceIdSchema,
		latest: pluginWebsiteReleaseSchema.nullable(),
	})
	.strict();
export type PluginWebsiteUpdateResponse = z.infer<typeof pluginWebsiteUpdateResponseSchema>;

export interface ResolvedPluginRelease {
	pluginId: string;
	version: string;
	publishedAt?: string;
	notes?: string;
	sha256: string;
	size: number;
	compatibility?: z.infer<typeof pluginReleaseCompatibilitySchema>;
	artifact: { type: "http"; url: string } | { type: "local"; builtinId: string };
}
export const PLUGIN_UPDATE_ERROR_CODES = [
	"no_source",
	"invalid_source",
	"no_release",
	"request_failed",
	"rate_limited",
	"invalid_release",
	"unsafe_url",
	"hash_mismatch",
	"size_mismatch",
	"identity_mismatch",
	"incompatible",
	"manual_required",
	"source_changed",
	"installation_changed",
	"cancelled",
	"apply_failed",
	"local_missing",
	"queue_full",
] as const;
export type PluginUpdateErrorCode = (typeof PLUGIN_UPDATE_ERROR_CODES)[number];
export interface PluginSourceDiagnostic {
	code: "SOURCE_INVALID" | "SOURCE_MISMATCH" | "SOURCE_UNREADABLE";
	message: string;
}
export interface PluginSourceView {
	pluginId: string;
	binding: PluginSourceBinding;
	declaredSource: PluginSource | null;
	origin: "none" | "package" | "configured" | "builtin";
	diagnostics: PluginSourceDiagnostic[];
}
export interface PluginUpdateView {
	pluginId: string;
	status:
		| "no_source"
		| "idle"
		| "checking"
		| "up_to_date"
		| "available"
		| "manual_required"
		| "error";
	installedVersion: string | null;
	checkedAt: string | null;
	latest: {
		version: string;
		size: number;
		sha256: string;
		publishedAt?: string;
		notes?: string;
	} | null;
	candidateId?: string;
	error: PluginUpdateErrorCode | null;
	jobId?: string;
}
export interface PluginUpdateJob {
	id: string;
	pluginId: string;
	kind: "check" | "update" | "install_builtin";
	status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "manual_required";
	phase: "queued" | "checking" | "downloading" | "validating" | "applying" | "completed";
	cancellable: boolean;
	downloadedBytes: number;
	totalBytes: number | null;
	error: PluginUpdateErrorCode | null;
	createdAt: string;
	updatedAt: string;
}
export interface BuiltinPluginSummary {
	pluginId: string;
	displayName: string;
	description?: string;
	version: string;
	source: LocalPluginSource;
	installed: boolean;
	installedVersion: string | null;
	canInstall: boolean;
}
