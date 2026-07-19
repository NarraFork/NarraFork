import { z } from "zod";
import {
	capabilitySchema,
	isWidePermission,
	manifestCapabilityListSchema,
	manifestCapabilitySchema,
} from "./permissions";
import {
	MANIFEST_SCHEMA_VERSION,
	NARRAFORK_RPC_PROTOCOL,
	pluginToHostFeatureListSchema,
} from "./protocol";

const MAX_ID_LENGTH = 128;
const MAX_PATH_LENGTH = 4096;
const MAX_URL_LENGTH = 2048;
const MAX_ACTIVATION_EVENTS = 100;
const MAX_CONTRIBUTIONS = 200;

const PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const CONTRIBUTION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const SEMVER_PATTERN =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ACTIVATION_EVENT_PATTERN =
	/^(onStartup|onCommand|onView|onProvider|onTool|onEvent|onSchedule)(?::(.+))?$/;

function containsControlCharacter(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint < 0x20 || codePoint === 0x7f) return true;
	}
	return false;
}

const textSchema = (max: number) =>
	z
		.string()
		.max(max)
		.refine((value) => !containsControlCharacter(value), "control characters are not allowed");

/** A plugin identity in reverse-domain notation. */
export const pluginIdSchema = z
	.string()
	.min(3)
	.max(MAX_ID_LENGTH)
	.regex(PLUGIN_ID_PATTERN, "pluginId must be lowercase reverse-domain notation");

/** A contribution-local identifier; the pluginId supplies the namespace. */
export const contributionIdSchema = z
	.string()
	.min(1)
	.max(MAX_ID_LENGTH)
	.regex(CONTRIBUTION_ID_PATTERN, "contribution id contains unsupported characters");

const semverSchema = z.string().regex(SEMVER_PATTERN, "version must be valid SemVer");

/**
 * Manifest-v1 capability reader. Output is always canonical; known legacy names
 * are normalized by the explicit deprecated adapter in permissions.ts.
 */
export const permissionNameSchema = manifestCapabilitySchema;

function hasForbiddenPathSegment(value: string): boolean {
	return value.split("/").some((segment) => segment === ".." || segment === ".");
}

function isWindowsAbsolutePath(value: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

/** Package-relative asset path. URLs, absolute paths and traversal are rejected. */
export const manifestPathSchema = z
	.string()
	.min(1)
	.max(MAX_PATH_LENGTH)
	.refine((value) => !containsControlCharacter(value), "path contains control characters")
	.refine((value) => !value.includes("\\"), "path must use / separators")
	.refine((value) => !value.startsWith("/"), "absolute paths are not allowed")
	.refine((value) => !isWindowsAbsolutePath(value), "absolute paths are not allowed")
	.refine((value) => !hasForbiddenPathSegment(value), "path traversal is not allowed")
	.refine((value) => !/[?#]/.test(value), "path cannot contain a query or fragment")
	.refine((value) => !/^[A-Za-z][A-Za-z\d+.-]*:/.test(value), "URL schemes are not allowed")
	.refine((value) => !value.startsWith("//"), "network paths are not allowed");

/** External URL accepted in publisher metadata and other descriptive fields. */
export const manifestUrlSchema = z
	.string()
	.min(1)
	.max(MAX_URL_LENGTH)
	.refine((value) => !containsControlCharacter(value), "URL contains control characters")
	.superRefine((value, ctx) => {
		let parsed: URL;
		try {
			parsed = new URL(value);
		} catch {
			ctx.addIssue({ code: "custom", message: "invalid URL" });
			return;
		}

		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			ctx.addIssue({ code: "custom", message: "only http(s) URLs are allowed" });
		}
		if (!parsed.hostname || parsed.username || parsed.password) {
			ctx.addIssue({ code: "custom", message: "URL must contain a host and no credentials" });
		}
	});

const publisherSchema = z
	.object({
		id: pluginIdSchema.optional(),
		name: textSchema(200).optional(),
		url: manifestUrlSchema.optional(),
		email: z.string().email().max(254).optional(),
		contact: textSchema(500).optional(),
	})
	.strict();

const engineSchema = z
	.object({
		runtime: z.enum(["bun", "node", "python", "binary"]),
		runtimeVersion: z.string().min(1).max(128).optional(),
		hostApi: z.string().min(1).max(128),
		rpc: z.literal(NARRAFORK_RPC_PROTOCOL),
		features: pluginToHostFeatureListSchema.optional(),
		os: z
			.array(z.enum(["linux", "darwin", "win32"]))
			.max(3)
			.optional(),
		arch: z
			.array(z.enum(["x64", "arm64", "ia32"]))
			.max(3)
			.optional(),
		runner: z.enum(["local-process", "podman"]).default("local-process"),
	})
	.strict();

const serverSchema = z
	.object({
		entry: manifestPathSchema,
		transport: z.literal("stdio").default("stdio"),
		protocol: z.literal(NARRAFORK_RPC_PROTOCOL),
		args: z.array(textSchema(1024)).max(50).default([]),
		workingDirectory: z.enum(["package", "pluginData", "pluginTemp"]).default("package"),
		startupTimeoutMs: z.number().int().min(100).max(300_000).default(15_000),
		activationTimeoutMs: z.number().int().min(100).max(600_000).default(30_000),
	})
	.strict();

const uiSchema = z
	.object({
		entry: manifestPathSchema,
		format: z.literal("iife").default("iife"),
		style: manifestPathSchema.optional(),
		shell: z.literal("host-controlled").default("host-controlled"),
	})
	.strict();

const jsonSchemaObject = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
	if ("$ref" in value && typeof value.$ref !== "undefined") {
		if (typeof value.$ref !== "string" || !value.$ref.startsWith("#")) {
			ctx.addIssue({
				code: "custom",
				path: ["$ref"],
				message: "$ref must be a local JSON pointer",
			});
		}
	}
});

const contributionBaseSchema = z.object({
	id: contributionIdSchema,
});

const providerContributionSchema = contributionBaseSchema
	.extend({
		title: textSchema(200).optional(),
		description: textSchema(2_000).optional(),
		modelDiscovery: z.boolean().optional(),
		sessionMode: z.enum(["stateless", "stateful"]).optional(),
		maxConcurrency: z.number().int().min(1).max(256).optional(),
		configSchema: jsonSchemaObject.optional(),
	})
	.strict();

const toolContributionSchema = contributionBaseSchema
	.extend({
		title: textSchema(200),
		description: textSchema(2_000).optional(),
		inputSchema: jsonSchemaObject,
		execution: z.enum(["server", "ui"]),
		allowBackground: z.boolean().default(false),
	})
	.strict();

const commandContributionSchema = contributionBaseSchema
	.extend({
		title: textSchema(200),
		description: textSchema(2_000).optional(),
		inputSchema: jsonSchemaObject.optional(),
		handler: z.enum(["server", "ui"]),
		when: z
			.string()
			.max(200)
			.regex(/^[A-Za-z][A-Za-z0-9._-]*(?:\s*(?:==|!=)\s*[A-Za-z0-9._-]+)?$/)
			.optional(),
	})
	.strict();

const eventContributionSchema = contributionBaseSchema
	.extend({
		topic: z
			.string()
			.min(1)
			.max(200)
			.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\.[A-Za-z0-9][A-Za-z0-9._-]*)*$/),
		filter: jsonSchemaObject.optional(),
		allowBackground: z.boolean().default(false),
		maxRatePerSecond: z.number().int().min(1).max(10_000).optional(),
	})
	.strict();

const viewContributionSchema = contributionBaseSchema
	.extend({
		title: textSchema(200),
		entry: manifestPathSchema,
		style: manifestPathSchema.optional(),
		surfaces: z
			.array(z.enum(["workspace", "director", "focus", "settings"]))
			.min(1)
			.max(4),
		scope: z.enum(["workspace", "narrator", "project", "global"]),
		instance: z.enum([
			"singleton",
			"singleton-per-workspace",
			"singleton-per-narrator",
			"multiple",
		]),
		defaultPosition: z.enum(["main", "side", "bottom", "director"]).optional(),
		commandId: contributionIdSchema.optional(),
	})
	.strict();

const configurationSchema = z
	.object({
		properties: z.record(contributionIdSchema, jsonSchemaObject),
	})
	.strict();

const contributesSchema = z
	.object({
		providers: z.array(providerContributionSchema).max(MAX_CONTRIBUTIONS).default([]),
		tools: z.array(toolContributionSchema).max(MAX_CONTRIBUTIONS).default([]),
		commands: z.array(commandContributionSchema).max(MAX_CONTRIBUTIONS).default([]),
		events: z.array(eventContributionSchema).max(MAX_CONTRIBUTIONS).default([]),
		views: z.array(viewContributionSchema).max(MAX_CONTRIBUTIONS).default([]),
		configuration: configurationSchema.optional(),
	})
	.strict();

const emptyContributes = () => ({
	providers: [],
	tools: [],
	commands: [],
	events: [],
	views: [],
});

const networkPermissionSchema = z
	.object({
		mode: z.enum(["none", "allowlist"]),
		allow: z.array(textSchema(512)).max(100).default([]),
		domains: z.array(z.string().min(1).max(253)).max(100).optional(),
		ports: z.array(z.number().int().min(1).max(65_535)).max(100).optional(),
		protocols: z
			.array(z.enum(["http", "https"]))
			.max(2)
			.optional(),
		followRedirects: z.boolean().optional(),
		maxConnections: z.number().int().min(1).max(256).optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (
			value.mode === "none" &&
			(value.allow.length > 0 || value.domains?.length || value.ports?.length)
		) {
			ctx.addIssue({ code: "custom", message: "network allowlist fields require mode=allowlist" });
		}
	});

const filesystemPermissionSchema = z
	.object({
		package: z.enum(["none", "readOnly"]),
		pluginData: z.enum(["none", "readOnly", "readWrite"]),
		pluginTemp: z.enum(["none", "readWrite"]).optional(),
		workspace: z.enum(["none", "readOnly", "readWrite"]),
		device: z.enum(["none", "readOnly", "readWrite"]).optional(),
	})
	.strict();

const processPermissionSchema = z
	.object({
		spawn: z.enum(["none", "allowlist"]),
		executables: z.array(contributionIdSchema).max(50).optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.spawn === "none" && value.executables?.length) {
			ctx.addIssue({ code: "custom", message: "executables require process.spawn=allowlist" });
		}
		if (value.spawn === "allowlist" && !value.executables?.length) {
			ctx.addIssue({
				code: "custom",
				path: ["executables"],
				message: "allowlist requires executables",
			});
		}
	});

const permissionsSchema = z
	.object({
		host: manifestCapabilityListSchema.default([]),
		network: networkPermissionSchema,
		filesystem: filesystemPermissionSchema,
		process: processPermissionSchema,
	})
	.strict()
	.superRefine((value, ctx) => {
		for (const [index, permission] of value.host.entries()) {
			if (isWidePermission(permission)) {
				ctx.addIssue({
					code: "custom",
					path: ["host", index],
					message: `wide permission is not allowed: ${permission}`,
				});
			}
		}
		if (value.network.mode === "allowlist" && value.network.allow.some(isWidePermission)) {
			ctx.addIssue({
				code: "custom",
				path: ["network", "allow"],
				message: "wide network permission is not allowed",
			});
		}
		if (value.filesystem.workspace === "none" && value.filesystem.pluginData === "none") {
			// Explicitly denying both scopes is valid; this branch documents the deny-by-default shape.
		}
	});

const secretSchema = z
	.object({
		id: contributionIdSchema,
		label: textSchema(200),
		required: z.boolean().default(false),
		scope: z
			.array(z.enum(["user", "workspace", "project"]))
			.min(1)
			.max(3),
		usage: z.enum(["outbound-network", "provider", "command", "other"]),
		inject: z.enum(["ephemeral-reference", "rpc-opaque-reference"]),
	})
	.strict();

const dependenciesSchema = z
	.object({
		plugins: z.record(pluginIdSchema, z.string().min(1).max(128)).default({}),
		runtime: z.record(z.string().min(1).max(64), z.string().min(1).max(128)).default({}),
	})
	.strict();

const emptyDependencies = () => ({
	plugins: {},
	runtime: {},
});

const activationEventsSchema = z
	.array(z.string().min(1).max(256))
	.max(MAX_ACTIVATION_EVENTS)
	.default([]);

function addContributionReferenceIssue(
	ctx: z.RefinementCtx,
	path: (string | number)[],
	message: string,
): void {
	ctx.addIssue({ code: "custom", path, message });
}

function getContributionMap(manifest: {
	contributes: {
		providers: Array<{ id: string }>;
		tools: Array<{ id: string }>;
		commands: Array<{ id: string }>;
		events: Array<{ id: string; topic: string }>;
		views: Array<{ id: string }>;
	};
}): Map<string, { kind: "provider" | "tool" | "command" | "event" | "view"; topic?: string }> {
	const contributions = new Map<
		string,
		{ kind: "provider" | "tool" | "command" | "event" | "view"; topic?: string }
	>();
	for (const provider of manifest.contributes.providers)
		contributions.set(provider.id, { kind: "provider" });
	for (const tool of manifest.contributes.tools) contributions.set(tool.id, { kind: "tool" });
	for (const command of manifest.contributes.commands)
		contributions.set(command.id, { kind: "command" });
	for (const event of manifest.contributes.events)
		contributions.set(event.id, { kind: "event", topic: event.topic });
	for (const view of manifest.contributes.views) contributions.set(view.id, { kind: "view" });
	return contributions;
}

function validateActivationEvents(
	manifest: {
		pluginId: string;
		activationEvents: string[];
		contributes: {
			providers: Array<{ id: string }>;
			tools: Array<{ id: string }>;
			commands: Array<{ id: string }>;
			events: Array<{ id: string; topic: string }>;
			views: Array<{ id: string }>;
		};
	},
	ctx: z.RefinementCtx,
): void {
	const contributions = getContributionMap(manifest);

	for (const [index, event] of manifest.activationEvents.entries()) {
		const match = ACTIVATION_EVENT_PATTERN.exec(event);
		if (!match) {
			addContributionReferenceIssue(ctx, ["activationEvents", index], "unknown activation event");
			continue;
		}
		const [, kind, reference] = match;
		if (kind === "onStartup") {
			if (reference !== undefined) {
				addContributionReferenceIssue(
					ctx,
					["activationEvents", index],
					"onStartup does not take an id",
				);
			}
			continue;
		}
		if (!reference) {
			addContributionReferenceIssue(
				ctx,
				["activationEvents", index],
				"activation event requires a reference",
			);
			continue;
		}

		if (kind === "onEvent") {
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\.[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(reference)) {
				addContributionReferenceIssue(ctx, ["activationEvents", index], "invalid event topic");
				continue;
			}
			if (!manifest.contributes.events.some((item) => item.topic === reference)) {
				addContributionReferenceIssue(
					ctx,
					["activationEvents", index],
					"activation event references an undeclared event topic",
				);
			}
			continue;
		}

		const expectedKind = {
			onCommand: "command",
			onView: "view",
			onProvider: "provider",
			onTool: "tool",
			onSchedule: undefined,
		}[kind as "onCommand" | "onView" | "onProvider" | "onTool" | "onSchedule"];

		if (kind === "onSchedule") {
			if (!contributionIdSchema.safeParse(reference).success) {
				addContributionReferenceIssue(ctx, ["activationEvents", index], "invalid schedule id");
			}
			continue;
		}

		const localReference = reference.startsWith(`${manifest.pluginId}/`)
			? reference.slice(manifest.pluginId.length + 1)
			: reference;
		const contribution = contributions.get(localReference);
		if (!contribution || contribution.kind !== expectedKind) {
			addContributionReferenceIssue(
				ctx,
				["activationEvents", index],
				"activation event references an undeclared contribution",
			);
		}
	}
}

function validateContributionReferences(
	manifest: {
		pluginId: string;
		activationEvents: string[];
		contributes: {
			providers: Array<{ id: string }>;
			tools: Array<{ id: string }>;
			commands: Array<{ id: string; inputSchema?: unknown }>;
			events: Array<{ id: string; topic: string }>;
			views: Array<{ id: string; commandId?: string }>;
		};
	},
	ctx: z.RefinementCtx,
): void {
	const seen = new Map<string, string>();
	const groups = [
		["providers", manifest.contributes.providers],
		["tools", manifest.contributes.tools],
		["commands", manifest.contributes.commands],
		["events", manifest.contributes.events],
		["views", manifest.contributes.views],
	] as const;

	for (const [kind, entries] of groups) {
		for (const [index, contribution] of entries.entries()) {
			const previousKind = seen.get(contribution.id);
			if (previousKind) {
				addContributionReferenceIssue(
					ctx,
					["contributes", kind, index, "id"],
					`duplicate contribution id: ${contribution.id} (already declared in ${previousKind})`,
				);
			} else {
				seen.set(contribution.id, kind);
			}
		}
	}

	for (const [index, view] of manifest.contributes.views.entries()) {
		if (
			view.commandId &&
			!manifest.contributes.commands.some((command) => command.id === view.commandId)
		) {
			addContributionReferenceIssue(
				ctx,
				["contributes", "views", index, "commandId"],
				"view references an undeclared command",
			);
		}
	}

	validateActivationEvents(manifest, ctx);
}

function validateManifestCrossFields(
	manifest: {
		engine: { features?: string[] };
		server?: unknown;
		ui?: unknown;
		contributes: {
			providers: unknown[];
			tools: unknown[];
			commands: unknown[];
			events: unknown[];
			views: unknown[];
		};
		configuration?: unknown;
	},
	ctx: z.RefinementCtx,
): void {
	const hasServerContributions =
		manifest.contributes.providers.length > 0 ||
		manifest.contributes.tools.length > 0 ||
		manifest.contributes.commands.length > 0 ||
		manifest.contributes.events.length > 0;
	if (hasServerContributions && !manifest.server) {
		ctx.addIssue({
			code: "custom",
			path: ["server"],
			message: "server is required by backend contributions",
		});
	}
	if ((manifest.engine.features?.length ?? 0) > 0 && !manifest.server) {
		ctx.addIssue({
			code: "custom",
			path: ["engine", "features"],
			message: "Plugin-to-Host features require a backend server",
		});
	}
	if (manifest.contributes.views.length > 0 && !manifest.ui) {
		ctx.addIssue({ code: "custom", path: ["ui"], message: "ui is required by view contributions" });
	}
	if (manifest.configuration !== undefined && "configuration" in manifest.contributes) {
		ctx.addIssue({
			code: "custom",
			path: ["configuration"],
			message: "use either top-level configuration or contributes.configuration",
		});
	}
}

/** Return true when a string is a valid Manifest package-relative path. */
export function isManifestPath(value: string): boolean {
	return manifestPathSchema.safeParse(value).success;
}

/** Return true when a string is a valid external Manifest URL. */
export function isManifestUrl(value: string): boolean {
	return manifestUrlSchema.safeParse(value).success;
}

/** Return true when a string is a valid plugin ID. */
export function isPluginId(value: string): boolean {
	return pluginIdSchema.safeParse(value).success;
}

/** Return true when a string is a valid local contribution ID. */
export function isContributionId(value: string): boolean {
	return contributionIdSchema.safeParse(value).success;
}

/** Return true for a canonical or explicitly supported Manifest-v1 legacy capability name. */
export function isPermissionName(value: string): boolean {
	return permissionNameSchema.safeParse(value).success;
}

/** Return true only for the authoritative canonical capability enum. */
export function isCanonicalPermissionName(value: string): boolean {
	return capabilitySchema.safeParse(value).success;
}

/** Parse an activation event into its family and optional reference. */
export function parseActivationEvent(value: string):
	| { kind: "onStartup"; reference?: undefined }
	| {
			kind: "onCommand" | "onView" | "onProvider" | "onTool" | "onEvent" | "onSchedule";
			reference: string;
	  }
	| undefined {
	const match = ACTIVATION_EVENT_PATTERN.exec(value);
	if (!match) return undefined;
	const [, kind, reference] = match;
	if (kind === "onStartup" && reference === undefined) return { kind };
	if (kind !== "onStartup" && reference) {
		return {
			kind: kind as "onCommand" | "onView" | "onProvider" | "onTool" | "onEvent" | "onSchedule",
			reference,
		};
	}
	return undefined;
}

const manifestV1BaseSchema = z
	.object({
		schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
		pluginId: pluginIdSchema,
		version: semverSchema,
		displayName: textSchema(120),
		description: textSchema(4_000).optional(),
		publisher: publisherSchema.optional(),
		license: textSchema(200).optional(),
		engine: engineSchema,
		server: serverSchema.optional(),
		ui: uiSchema.optional(),
		activationEvents: activationEventsSchema,
		contributes: contributesSchema.default(emptyContributes),
		configuration: configurationSchema.optional(),
		permissions: permissionsSchema,
		secrets: z.array(secretSchema).max(100).default([]),
		dependencies: dependenciesSchema.default(emptyDependencies),
	})
	.strict();

/** Strict Zod v4 schema for Manifest schema version 1. */
export const manifestV1Schema = manifestV1BaseSchema.superRefine((manifest, ctx) => {
	validateManifestCrossFields(manifest, ctx);
	validateContributionReferences(manifest, ctx);
});

/** Canonical Manifest schema export. */
export const manifestSchema = manifestV1Schema;

export type ManifestV1 = z.output<typeof manifestV1Schema>;
export type Manifest = ManifestV1;
export type ManifestInput = z.input<typeof manifestV1Schema>;
export type ManifestParseResult = ReturnType<typeof safeParseManifest>;

/** Parse and validate a Manifest, throwing ZodError on failure. */
export function parseManifest(input: unknown): Manifest {
	return manifestV1Schema.parse(input);
}

/** Parse and validate a Manifest without throwing. */
export function safeParseManifest(input: unknown) {
	return manifestV1Schema.safeParse(input);
}

/** Aliases for callers that explicitly name the schema major version. */
export const parseManifestV1 = parseManifest;
export const safeParseManifestV1 = safeParseManifest;

/** Return all contribution IDs in declaration order. */
export function getContributionIds(manifest: Manifest): string[] {
	return [
		...manifest.contributes.providers,
		...manifest.contributes.tools,
		...manifest.contributes.commands,
		...manifest.contributes.events,
		...manifest.contributes.views,
	].map((contribution) => contribution.id);
}

/** Build the globally unique contribution reference used by Host APIs. */
export function getContributionFullId(pluginId: string, contributionId: string): string {
	return `${pluginId}/${contributionId}`;
}
