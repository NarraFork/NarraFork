import {
	type GenUiFileReference,
	type GenUiPreview,
	readGenUiFileReference,
} from "@shared/gen-ui-files";
import type { GenUiKitBundle } from "@shared/gen-ui-kit";
import { GEN_UI_TOOL_NAME } from "@shared/gen-ui-tool-policy";
import { type Context, Hono } from "hono";
import { AppError } from "../lib/errors";
import { answerGenUiForm, readGenUiFormFields } from "../services/gen-ui/form-wait";
import type { KitOverview } from "../services/gen-ui/kit-service";

export interface GenUiRouteDependencies {
	authorize(c: Context, narratorId: string): Promise<string>;
	tool(
		narratorId: string,
		toolUseId: string,
		toolCallId: string,
	): Promise<{
		id: string;
		toolName: string;
		/** Absent in older callers/mocks: no live card, the result is the only reference. */
		inputJson?: unknown;
		outputJson: unknown;
		executionOriginToolCallId?: string | null;
	}>;
	/**
	 * The reference for an app whose tool call has not returned yet. Only `render({path})`
	 * qualifies, and the service refuses anything outside the workspace GenUI directory.
	 */
	liveReference(options: {
		narratorId: string;
		toolUseId: string;
		toolCallId: string;
		appPath: string;
	}): Promise<GenUiFileReference>;
	preview(
		narratorId: string,
		userId: string,
		reference: GenUiFileReference,
		signal: AbortSignal,
	): Promise<GenUiPreview>;
	kit: {
		overview(narratorId: string, userId: string, signal: AbortSignal): Promise<KitOverview>;
		bundle(narratorId: string, userId: string, signal: AbortSignal): Promise<GenUiKitBundle>;
		approve(narratorId: string, userId: string, requestId: string): Promise<KitOverview>;
		dismiss(narratorId: string, requestId: string): Promise<{ dismissed: boolean }>;
	};
	answerForm: typeof answerGenUiForm;
}
const defaults: GenUiRouteDependencies = {
	async authorize(c, narratorId) {
		const { narratorPrincipalOf, requireNarratorAccess } = await import("../lib/narrator-access");
		const { canWriteNarrator } = await import("../services/narrator-acl");
		const principal = narratorPrincipalOf(c);
		const narrator = await requireNarratorAccess(c, narratorId, "read");
		if (!principal.userId || !(await canWriteNarrator(narrator, principal)))
			throw new AppError(
				"Public/read-only readers cannot access live UI workspace files",
				403,
				"UI_PRIVATE_FILES",
			);
		return principal.userId;
	},
	async tool(narratorId, toolUseId, toolCallId) {
		const { narratorService } = await import("../services/narrator-service");
		return narratorService.getToolCallDetail(narratorId, toolUseId, { toolCallId });
	},
	async liveReference(options) {
		const { resolveLiveGenUiReference } = await import("../services/gen-ui/live-reference");
		return resolveLiveGenUiReference(options);
	},
	async preview(...args) {
		const { buildGenUiPreview } = await import("../services/gen-ui/preview");
		return buildGenUiPreview(...args);
	},
	kit: {
		async overview(...args) {
			const { kitService } = await import("../services/gen-ui/kit-service");
			return kitService.overview(...args);
		},
		async bundle(...args) {
			const { kitService } = await import("../services/gen-ui/kit-service");
			return kitService.bundle(...args);
		},
		async approve(...args) {
			const { kitService } = await import("../services/gen-ui/kit-service");
			return kitService.approve(...args);
		},
		async dismiss(...args) {
			const { kitService } = await import("../services/gen-ui/kit-service");
			return kitService.dismiss(...args);
		},
	},
	answerForm: answerGenUiForm,
};

/** The directory argument of a still-running render({path}); anything else has no live card. */
function liveAppPath(input: unknown): string | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const value = input as { action?: unknown; path?: unknown };
	return value.action === "render" && typeof value.path === "string" && value.path
		? value.path
		: undefined;
}

export function createGenUiRoutes(overrides: Partial<GenUiRouteDependencies> = {}) {
	const deps = { ...defaults, ...overrides };
	const app = new Hono();
	app.onError((error, c) => {
		if (error instanceof AppError)
			return c.json({ error: error.message, code: error.code }, error.statusCode as 400);
		return c.json(
			{ error: "UI preview could not be built safely", code: "UI_PREVIEW_FAILED" },
			422,
		);
	});
	app.get("/:id/gen-ui/preview/:toolUseId", async (c) => {
		c.header("Cache-Control", "no-store");
		c.header("X-Content-Type-Options", "nosniff");
		const narratorId = c.req.param("id");
		const toolUseId = c.req.param("toolUseId");
		const toolCallId = c.req.query("toolCallId");
		if (
			!toolCallId ||
			[narratorId, toolUseId, toolCallId].some((id) => id.length > 200) ||
			Object.keys(c.req.query()).some((key) => key !== "toolCallId")
		)
			throw new AppError(
				"Only toolCallId may select a UI preview; source paths are not accepted",
				400,
				"UI_REFERENCE_REQUIRED",
			);
		const userId = await deps.authorize(c, narratorId);
		const tool = await deps.tool(narratorId, toolUseId, toolCallId);
		const output = tool.outputJson;
		const metadata =
			output && typeof output === "object" && "_metadata" in output ? output._metadata : null;
		const settled = readGenUiFileReference(
			metadata && typeof metadata === "object" && "genUi" in metadata ? metadata.genUi : null,
		);
		// A render({path}) app must already be on screen while its call still waits, so the
		// result does not exist yet. The running call's own arguments are the only source
		// left; liveReference still refuses anything outside the workspace GenUI directory.
		const appPath = liveAppPath(tool.inputJson);
		const reference =
			settled ??
			(tool.toolName === GEN_UI_TOOL_NAME && tool.id === toolCallId && appPath
				? await deps
						.liveReference({ narratorId, toolUseId, toolCallId: tool.id, appPath })
						.catch(() => null)
				: null);
		if (
			tool.toolName !== GEN_UI_TOOL_NAME ||
			tool.id !== toolCallId ||
			!reference ||
			reference.toolUseId !== toolUseId ||
			(reference.toolCallId !== tool.id && reference.toolCallId !== tool.executionOriginToolCallId)
		)
			throw new AppError(
				"The selected tool result is not a GenUI file reference",
				404,
				"UI_REFERENCE_NOT_FOUND",
			);
		// COW preserves output bytes and records the original PK in a trusted column.
		// Never fall back to an invisible origin row or accept provenance from client input.
		const preview = await deps.preview(
			narratorId,
			userId,
			{ ...reference, toolCallId: tool.id },
			c.req.raw.signal,
		);
		// Re-check narrator access as well as filesystem policy before releasing source.
		if ((await deps.authorize(c, narratorId)) !== userId)
			throw new AppError("Preview principal changed", 403, "UI_PRIVATE_FILES");
		return c.json(preview);
	});
	// Component kit: state for the chat UI, the built bundle, and the user's confirmation
	// of a build. Same audience as previews: the files are the workspace's own.
	app.get("/:id/gen-ui/kit", async (c) => {
		c.header("Cache-Control", "no-store");
		const narratorId = c.req.param("id");
		const userId = await deps.authorize(c, narratorId);
		return c.json(await deps.kit.overview(narratorId, userId, c.req.raw.signal));
	});
	app.get("/:id/gen-ui/kit/bundle", async (c) => {
		c.header("Cache-Control", "no-store");
		c.header("X-Content-Type-Options", "nosniff");
		const narratorId = c.req.param("id");
		const userId = await deps.authorize(c, narratorId);
		const bundle = await deps.kit.bundle(narratorId, userId, c.req.raw.signal);
		if ((await deps.authorize(c, narratorId)) !== userId)
			throw new AppError("Kit principal changed", 403, "UI_PRIVATE_FILES");
		return c.json(bundle);
	});
	const requestId = async (c: Context): Promise<string> => {
		const body: unknown = await c.req.json().catch(() => null);
		const id =
			body && typeof body === "object" ? (body as { requestId?: unknown }).requestId : null;
		if (typeof id !== "string" || id.length === 0 || id.length > 64)
			throw new AppError("requestId is required", 400, "UI_KIT_REQUEST_REQUIRED");
		return id;
	};
	app.post("/:id/gen-ui/kit/approve", async (c) => {
		const narratorId = c.req.param("id");
		const userId = await deps.authorize(c, narratorId);
		return c.json(await deps.kit.approve(narratorId, userId, await requestId(c)));
	});
	app.post("/:id/gen-ui/kit/dismiss", async (c) => {
		const narratorId = c.req.param("id");
		await deps.authorize(c, narratorId);
		return c.json(await deps.kit.dismiss(narratorId, await requestId(c)));
	});
	// The reader's answer to a form a `render` with `wait: true` is holding its call open
	// for. Answering is acting in the conversation, so it takes the same write access.
	app.post("/:id/gen-ui/form/:toolUseId", async (c) => {
		const narratorId = c.req.param("id");
		const toolUseId = c.req.param("toolUseId");
		if (toolUseId.length > 200) throw new AppError("Invalid tool call", 400, "UI_FORM_INVALID");
		await deps.authorize(c, narratorId);
		const body: unknown = await c.req.json().catch(() => null);
		const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
		let answer: Parameters<GenUiRouteDependencies["answerForm"]>[2];
		if (input.status === "closed") answer = { status: "closed" };
		else {
			const fields = readGenUiFormFields(input.fields ?? {});
			if (input.status !== "submitted" || !fields || typeof input.message !== "string")
				throw new AppError("Not a form answer", 400, "UI_FORM_INVALID");
			answer = { status: "submitted", message: input.message, fields };
		}
		if (!deps.answerForm(narratorId, toolUseId, answer))
			throw new AppError("Nothing is waiting for this form", 409, "UI_FORM_NOT_WAITING");
		return c.json({ ok: true });
	});
	return app;
}
export const genUiRoutes = createGenUiRoutes();
