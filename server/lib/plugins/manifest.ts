import { z } from "zod";
import {
	capabilitySchema,
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

/**
 *
 * Mirrors the runtime rule enforced by `assertPrefix()` in
 * `plugin-provider-registry.ts`: 1–32 visible ASCII characters with no colon
 * (the model-value separator) and no whitespace. The manifest value is only a
 * *suggestion* — the host validates it against reserved and already-claimed
 * prefixes at registration time, and the user may override it.
 */
const PROVIDER_PREFIX_PATTERN = /^[\x21-\x39\x3b-\x7e]+$/;

export const providerPrefixSchema = z
	.string()
	.min(1)
	.max(32)
	.regex(
		PROVIDER_PREFIX_PATTERN,
		"providerPrefix must be visible ASCII without a colon or whitespace",
	);

/**
 * A bare model ID as returned by the plugin's model catalog (no provider
 * prefix). Host sentinels are rejected so a plugin cannot masquerade as the
 * "follow the default/summary model" meta values.
 */
const providerModelIdSchema = z
	.string()
	.min(1)
	.max(256)
	.refine((value) => !containsControlCharacter(value), "model id contains control characters")
	.refine(
		(value) => !["__default__", "__summary__"].includes(value),
		"model id must not be a host sentinel",
	);

/**
 * Provider-type capabilities the host needs before it ever starts the plugin.
 *
 * These mirror `ProviderTypeCapabilities` in `plugin-provider-registry.ts`.
 * Declaring them statically lets the host register a provider (and show it in
 * the model picker) without spawning the plugin process first; `provider.describe`
 * may refine them once the runtime is live.
 */
const providerCapabilitiesSchema = z
	.object({
		validateConfig: z.boolean().optional(),
		listModels: z.boolean().optional(),
		chat: z.boolean().optional(),
		generate: z.boolean().optional(),
		reasoningContinuation: z.boolean().optional(),
		inputImages: z.boolean().optional(),
		/**
		 * True when the upstream can leak `<invoke>` tool calls into assistant text
		 * instead of using native tool-use fields. The agent loop uses this to keep a
		 * bounded raw dump and run the post-turn recovery safety net.
		 */
		mayLeakXmlToolCalls: z.boolean().optional(),
	})
	.strict();

/** Concurrency and payload ceilings, mirroring `ProviderTypeLimits`. */
const providerLimitsSchema = z
	.object({
		maxConcurrentChat: z.number().int().min(1).max(256).optional(),
		maxConcurrentGenerate: z.number().int().min(1).max(256).optional(),
		maxConfigBytes: z
			.number()
			.int()
			.min(1)
			.max(1024 * 1024)
			.optional(),
		maxModelPageSize: z.number().int().min(1).max(200).optional(),
	})
	.strict();

const providerContributionSchema = contributionBaseSchema
	.extend({
		title: textSchema(200).optional(),
		description: textSchema(2_000).optional(),
		/**
		 * Suggested user-facing prefix. Optional for backward compatibility: when
		 * omitted the host falls back to the contribution `id`, which is already
		 * unique within the plugin.
		 */
		providerPrefix: providerPrefixSchema.optional(),
		/** Model selected when the user picks this provider without naming a model. */
		defaultModelId: providerModelIdSchema.optional(),
		modelDiscovery: z.boolean().optional(),
		sessionMode: z.enum(["stateless", "stateful"]).optional(),
		maxConcurrency: z.number().int().min(1).max(256).optional(),
		capabilities: providerCapabilitiesSchema.optional(),
		limits: providerLimitsSchema.optional(),
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
			.array(z.enum(["workspace", "director", "focus", "settings", "provider-settings"]))
			.min(1)
			.max(5),
		scope: z.enum(["workspace", "narrator", "project", "global"]),
		/**
		 * Provider this view configures. Required for (and only meaningful on) the
		 * `provider-settings` surface, where the view replaces the host's generated
		 * config form for one specific provider. Binding it here means the host knows at
		 * install time which provider a view belongs to instead of guessing at runtime.
		 */
		providerId: contributionIdSchema.optional(),
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

/**
 * A safe color token. Only `#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa` hex and the
 * comma/space `rgb()`/`rgba()` functional forms are allowed. This deliberately
 * rejects `url(`, `@import`, `expression(`, `javascript:`, `var(`, `calc(`,
 * `image-set(`, closing tags and any other construct that could smuggle
 * external requests or markup into host-document CSS, since plugin theme
 * tokens are compiled into the host's real stylesheet (not a sandbox iframe).
 */
const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGB_COLOR_PATTERN =
	/^rgba?\(\s*\d{1,3}\s*[, ]\s*\d{1,3}\s*[, ]\s*\d{1,3}\s*(?:[,/]\s*(?:0|1|0?\.\d+|\d{1,3}%)\s*)?\)$/;

export const safeColorSchema = z
	.string()
	.min(1)
	.max(64)
	.refine(
		(value) => HEX_COLOR_PATTERN.test(value) || RGB_COLOR_PATTERN.test(value),
		"color must be a #hex or rgb()/rgba() value",
	);

/**
 * A clamped CSS dimension for box-model tokens (spacing / font-size / radius).
 * Only a plain number with a `px`/`rem`/`em` unit is accepted, and the numeric
 * magnitude is bounded so a malicious or low-quality theme cannot collapse or
 * explode the layout (e.g. `0` or `9999px`). Expressions (`calc`, `var`, `%`)
 * are rejected outright. The concrete min/max per token family is enforced by
 * the theme compiler; this schema enforces the shared syntactic + coarse bound.
 */
const DIMENSION_PATTERN = /^(\d{1,4}(?:\.\d{1,3})?)(px|rem|em)$/;

export const clampedDimensionSchema = z
	.string()
	.min(1)
	.max(16)
	.refine((value) => {
		const match = DIMENSION_PATTERN.exec(value);
		if (!match) return false;
		const magnitude = Number(match[1]);
		return Number.isFinite(magnitude) && magnitude >= 0 && magnitude <= 512;
	}, "dimension must be a bounded number with a px/rem/em unit");

/** A full 10-shade Mantine color scale. */
const colorScaleSchema = z.tuple([
	safeColorSchema,
	safeColorSchema,
	safeColorSchema,
	safeColorSchema,
	safeColorSchema,
	safeColorSchema,
	safeColorSchema,
	safeColorSchema,
	safeColorSchema,
	safeColorSchema,
]);

/**
 * The controlled host regions a theme may paint a background onto. Each maps to a
 * stable host class/variable in the theme compiler; plugins can never target an
 * arbitrary selector.
 */
export const THEME_BACKGROUND_REGIONS = ["body", "app", "main", "navbar", "header"] as const;

/**
 * Raster image extensions a theme background may point at. Deliberately narrow:
 * the theme-asset route serves these bytes from the *host* origin without a
 * session, so the extension decides the response `Content-Type`. Allowing an
 * active type (`.html`, `.js`, `.svg`, `.json`, …) would turn a background image
 * into same-origin script delivery. SVG is excluded on purpose — it can carry
 * script and is not needed for a background.
 */
const THEME_BACKGROUND_IMAGE_EXTENSIONS = [
	".png",
	".jpg",
	".jpeg",
	".webp",
	".gif",
	".avif",
] as const;

/** Whether a package-relative path ends in an allowed raster image extension. */
function hasAllowedThemeImageExtension(value: string): boolean {
	const lower = value.toLowerCase();
	return THEME_BACKGROUND_IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * A single region background. `image` is a package-relative path (never a URL —
 * the host builds the final same-origin URL at compile time) and must be a
 * raster image, because the host serves it unauthenticated with a Content-Type
 * derived from its extension. All CSS-affecting fields are strict enums or a
 * clamped number, so no arbitrary CSS can be smuggled in.
 */
const backgroundRegionSchema = z
	.object({
		image: manifestPathSchema.refine(
			hasAllowedThemeImageExtension,
			`background image must be one of ${THEME_BACKGROUND_IMAGE_EXTENSIONS.join(", ")}`,
		),
		size: z.enum(["cover", "contain", "auto"]).optional(),
		position: z.enum(["center", "top", "bottom", "left", "right"]).optional(),
		repeat: z.enum(["no-repeat", "repeat"]).optional(),
		overlay: z.enum(["none", "scrim-light", "scrim-dark"]).optional(),
		opacity: z.number().min(0).max(1).optional(),
	})
	.strict();

/**
 * Region → background map. Every region key is optional; a theme sets only the
 * regions it wants. (An object with optional keys avoids Zod v4's
 * `z.record(enum)` behavior of requiring every enum key.)
 */
const backgroundsSchema = z
	.object({
		body: backgroundRegionSchema.optional(),
		app: backgroundRegionSchema.optional(),
		main: backgroundRegionSchema.optional(),
		navbar: backgroundRegionSchema.optional(),
		header: backgroundRegionSchema.optional(),
	})
	.strict();

/**
 * The core set of theme design tokens. Colors repaint only; box-model tokens can
 * reflow and are range-clamped. A custom color entry is either a single base
 * color (the host generates the 10 shades) or a complete 10-shade scale.
 */
const themeTokenFields = {
	primaryColor: safeColorSchema.optional(),
	body: safeColorSchema.optional(),
	text: safeColorSchema.optional(),
	colors: z
		.record(
			z
				.string()
				.min(1)
				.max(32)
				.regex(/^[a-z][a-z0-9-]*$/, "color name must be lowercase kebab-case"),
			z.union([safeColorSchema, colorScaleSchema]),
		)
		.optional(),
	spacing: clampedDimensionSchema.optional(),
	fontSize: clampedDimensionSchema.optional(),
	radius: clampedDimensionSchema.optional(),
	backgrounds: backgroundsSchema.optional(),
};

/** A per-color-scheme token set (light/dark variant). */
const themeSchemeTokensSchema = z.object(themeTokenFields).strict();

/**
 * Theme design tokens. The top-level fields act as a shared base applied to all
 * color schemes; the optional `light`/`dark` sub-objects override the base for
 * that scheme, enabling a single "dual" theme that follows the system light/dark
 * setting. Requires `colorScheme: "both"` to take effect.
 */
const themeTokensSchema = z
	.object({
		...themeTokenFields,
		light: themeSchemeTokensSchema.optional(),
		dark: themeSchemeTokensSchema.optional(),
	})
	.strict();

const themeContributionSchema = contributionBaseSchema
	.extend({
		title: textSchema(200),
		colorScheme: z.enum(["light", "dark", "both"]),
		tokens: themeTokensSchema,
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
		themes: z.array(themeContributionSchema).max(50).default([]),
		configuration: configurationSchema.optional(),
	})
	.strict();

const emptyContributes = () => ({
	providers: [],
	tools: [],
	commands: [],
	events: [],
	views: [],
	themes: [],
});

/**
 * Serialized-size ceiling for one uninspected `permissions` sub-object, in JSON characters.
 *
 * Size rather than a key count: a key count bounds nothing, because a single key can hold a
 * megabyte-long string or a deeply nested array. 8K characters is far above any honest
 * and far below a size that matters on the main thread.
 *
 * This is a **B-class survival limit, not a trust limit** (see
 * `docs/plugin-system/11-capability-policy.md` §2). A parsed manifest is retained in memory
 * and copied into the plugin state file, which is a synchronous JSON read/modify/write; an
 * unvalidated `looseObject` therefore let a manifest smuggle up to the whole
 * `MAX_MANIFEST_BYTES` budget into every state write, for a field nothing reads.
 */
const MAX_UNINSPECTED_PERMISSION_JSON_CHARS = 8 * 1024;

/**
 * `network` / `filesystem` / `process` declarations: optional, uninspected, size-capped.
 *
 * These are **documentation, not enforcement**. A search of the host finds no reader of
 * `permissions.network`, `permissions.filesystem` or `permissions.process` — a plugin
 * process gets its network access from the OS and its filesystem access from the runner,
 * neither of which consults these fields. Validating their contents therefore only rejected
 * manifests; it never restricted a running plugin.
 *
 * So the shape is kept loose enough to describe intent (and to keep old manifests parsing)
 * without pretending to be a sandbox. Cross-field consistency rules are gone: refusing
 * `mode: "none"` alongside a populated `allow` list was enforcing tidiness in a field nobody
 * reads. Real network and process containment, when wanted, belongs to the Podman runner.
 *
 * The one check that remains is the size ceiling above, which constrains cost rather than
 * shape: any keys are still accepted, there just cannot be 500 KB of them.
 */
const uninspectedPermissionSchema = (field: string) =>
	z
		.looseObject({})
		.refine(
			(value) => JSON.stringify(value).length <= MAX_UNINSPECTED_PERMISSION_JSON_CHARS,
			`permissions.${field} must serialize to at most ${MAX_UNINSPECTED_PERMISSION_JSON_CHARS} JSON characters`,
		)
		.optional();

const networkPermissionSchema = uninspectedPermissionSchema("network");
const filesystemPermissionSchema = uninspectedPermissionSchema("filesystem");
const processPermissionSchema = uninspectedPermissionSchema("process");

const permissionsSchema = z
	.object({
		host: manifestCapabilityListSchema.default([]),
		network: networkPermissionSchema,
		filesystem: filesystemPermissionSchema,
		process: processPermissionSchema,
	})
	.strict();
// No wide-permission rejection. A plugin may declare any capability, including `*`,
// `admin` or `network.any`: the host does not gate on declarations, so refusing them at
// parse time only blocked honest plugins from describing what they do. Broad requests are
// still identifiable via `isWidePermission`, which admin UIs use to label them.

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
			views: Array<{ id: string; commandId?: string; providerId?: string; surfaces: string[] }>;
			themes: Array<{ id: string }>;
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
		["themes", manifest.contributes.themes],
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
		const isProviderSettings = view.surfaces.includes("provider-settings");
		if (isProviderSettings && !view.providerId) {
			// Without this the host would have no way to tell which provider's settings the
			// view replaces, and a plugin contributing two providers would be ambiguous.
			addContributionReferenceIssue(
				ctx,
				["contributes", "views", index, "providerId"],
				"provider-settings view requires providerId",
			);
		}
		if (
			view.providerId &&
			!manifest.contributes.providers.some((provider) => provider.id === view.providerId)
		) {
			addContributionReferenceIssue(
				ctx,
				["contributes", "views", index, "providerId"],
				"view references an undeclared provider",
			);
		}
		if (view.providerId && !isProviderSettings) {
			// A providerId on any other surface would silently do nothing, which reads as a
			// working declaration to the plugin author.
			addContributionReferenceIssue(
				ctx,
				["contributes", "views", index, "providerId"],
				"providerId is only valid on the provider-settings surface",
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
		// Optional now: a plugin that declares nothing gets the same treatment as one that
		// declares everything, so requiring the block was pure ceremony. Defaults keep
		// `manifest.permissions.host` safe to read without a null check.
		permissions: permissionsSchema.default({ host: [] }),
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

/** A per-color-scheme token set (light/dark variant). */
export type ThemeSchemeTokens = z.output<typeof themeSchemeTokensSchema>;
/** Theme design tokens (validated). */
export type ThemeTokens = z.output<typeof themeTokensSchema>;
/** A single theme contribution (validated). */
export type ThemeContribution = z.output<typeof themeContributionSchema>;
/** A controlled host background region. */
export type ThemeBackgroundRegion = (typeof THEME_BACKGROUND_REGIONS)[number];
/** A single region background (validated). */
export type ThemeBackground = z.output<typeof backgroundRegionSchema>;

/**
 * Collect every package-relative background image path declared by a theme
 * contribution, across the base tokens and the optional light/dark variants.
 * Used to extend the served-asset whitelist so background images (and only
 * declared ones) can be fetched by the host document.
 */
export function collectThemeBackgroundImages(contribution: ThemeContribution): string[] {
	const paths = new Set<string>();
	const addFrom = (tokens: { backgrounds?: Record<string, { image?: string }> } | undefined) => {
		if (!tokens?.backgrounds) return;
		for (const bg of Object.values(tokens.backgrounds)) {
			if (bg && typeof bg.image === "string" && bg.image.length > 0) paths.add(bg.image);
		}
	};
	addFrom(contribution.tokens);
	addFrom(contribution.tokens.light);
	addFrom(contribution.tokens.dark);
	return [...paths];
}

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
		...manifest.contributes.themes,
	].map((contribution) => contribution.id);
}

/** Build the globally unique contribution reference used by Host APIs. */
export function getContributionFullId(pluginId: string, contributionId: string): string {
	return `${pluginId}/${contributionId}`;
}

/**
 * What kind of plugin this manifest describes, from its shape alone.
 *
 * - `backend`  — declares a `server` (runs a backend process).
 * - `frontend` — no server but contributes `views` (ships IIFE JS that executes
 *   in a sandboxed iframe on every client).
 * - `theme-only` — no server, no views: only `themes` (design tokens compiled to
 *   scoped CSS variables).
 *
 * **Descriptive only — no longer a gate.** This used to decide who could install and enable
 * a plugin: `theme-only` was open to any logged-in user, everything else needed an admin.
 * That line was in the wrong place, because a `frontend` plugin runs arbitrary JavaScript
 * against the user's own session, and a plugin changed risk class just by adding a view.
 * Install and lifecycle now uniformly require an administrator (`server/routes/plugins.ts`).
 *
 * Retained because "does this ship a server / a view / only a theme" is genuinely useful for
 * listing and filtering in an admin UI.
 */
export type PluginTier = "theme-only" | "frontend" | "backend";

export function pluginTier(manifest: {
	server?: unknown;
	contributes: { views: unknown[] };
}): PluginTier {
	if (manifest.server) return "backend";
	if (manifest.contributes.views.length > 0) return "frontend";
	return "theme-only";
}

/** Whether a manifest ships only themes: no server process, no view JavaScript. */
export function isThemeOnlyPlugin(manifest: {
	server?: unknown;
	contributes: { views: unknown[] };
}): boolean {
	return pluginTier(manifest) === "theme-only";
}
