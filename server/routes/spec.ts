import { Hono } from "hono";
import { ValidationError } from "../lib/errors";
import { getUserLanguage } from "../lib/prompt-i18n";
import { specFileQuerySchema, updateSpecFileSchema } from "../lib/validators";
import { interjectSpecEditAsUserMessage } from "../services/spec-edit-interject";
import { compileSpecTasks, parseSpecTasksDocument } from "../services/spec-task-service";
import { specVfsService } from "../services/spec-vfs-service";
import { broadcastToNarrator } from "../websocket/narrator-ws";

export const specRoutes = new Hono();

/** GET /:id/spec/files — list spec file metadata (no content). */
specRoutes.get("/:id/spec/files", async (c) => {
	const narratorId = c.req.param("id");
	const files = await specVfsService.listSpecFiles(narratorId);
	return c.json({
		files: files.map((f) => ({
			path: f.path,
			uri: f.uri,
			readonly: f.readonly,
			uiEditable: f.uiEditable,
			builtin: f.builtin,
			revisionId: f.revisionId ?? null,
		})),
	});
});

/** GET /:id/spec/file?uri=spec://index.md — read a single spec file. */
specRoutes.get("/:id/spec/file", async (c) => {
	const narratorId = c.req.param("id");
	const rawUri = c.req.query("uri");
	if (!rawUri) throw new ValidationError("uri query parameter is required");
	const parsed = specFileQuerySchema.safeParse({ uri: rawUri });
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const file = await specVfsService.readSpecFile(narratorId, parsed.data.uri);
	return c.json({
		path: file.path,
		uri: file.uri,
		content: file.content,
		readonly: file.readonly,
		uiEditable: file.uiEditable,
		builtin: file.builtin,
		revisionId: file.revisionId ?? null,
	});
});

/** GET /:id/spec/tasks — read and compile tasks.json. */
specRoutes.get("/:id/spec/tasks", async (c) => {
	const narratorId = c.req.param("id");
	const file = await specVfsService.readTasksFileForNarrator(narratorId);
	const document = parseSpecTasksDocument(file.content);
	const compiled = compileSpecTasks(document);
	return c.json({
		content: file.content,
		revisionId: file.revisionId ?? null,
		document,
		compiled,
	});
});

/** POST /:id/spec/tasks/clear — empty tasks.json (UI action). */
specRoutes.post("/:id/spec/tasks/clear", async (c) => {
	const narratorId = c.req.param("id");
	const written = await specVfsService.clearSpecTasks(narratorId);
	broadcastToNarrator(narratorId, {
		type: "spec_changed",
		narratorId,
		uri: written.uri,
		path: "tasks.json",
		revisionId: written.revisionId ?? null,
		updatedBy: "user",
		source: "ui",
	});
	return c.json({ ok: true, revisionId: written.revisionId ?? null });
});

/** POST /:id/spec/reset — reset the entire Dynamic Spec namespace to defaults. */
specRoutes.post("/:id/spec/reset", async (c) => {
	const narratorId = c.req.param("id");
	await specVfsService.resetSpecNamespace(narratorId);
	broadcastToNarrator(narratorId, {
		type: "spec_changed",
		narratorId,
		uri: "spec://tasks.json",
		path: "tasks.json",
		revisionId: null,
		updatedBy: "user",
		source: "reset",
	});
	return c.json({ ok: true });
});

/** PUT /:id/spec/file — write a spec file from the UI. */
specRoutes.put("/:id/spec/file", async (c) => {
	const narratorId = c.req.param("id");
	const body = await c.req.json();
	const parsed = updateSpecFileSchema.safeParse(body);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const { uri, content, baseRevisionId, notifyAgent } = parsed.data;

	// Optimistic concurrency: check current revision before writing.
	let currentRevisionId: string | null = null;
	try {
		const current = await specVfsService.readSpecFile(narratorId, uri);
		currentRevisionId = current.revisionId ?? null;
	} catch {
		// File doesn't exist yet (user-created); no conflict possible.
	}

	if (baseRevisionId !== undefined && baseRevisionId !== currentRevisionId) {
		return c.json(
			{
				error: "conflict",
				message: "The file was modified since you loaded it.",
				currentRevisionId,
			},
			409,
		);
	}

	const written = await specVfsService.writeSpecFile(narratorId, uri, content, {
		createdBy: "user",
		actor: "user",
		allowProtectedTaskMutation: true,
	});

	// Broadcast spec_changed to all subscribers
	const path = specVfsService.normalizeSpecPath(uri);
	broadcastToNarrator(narratorId, {
		type: "spec_changed",
		narratorId,
		uri: written.uri,
		path,
		revisionId: written.revisionId ?? null,
		updatedBy: "user",
		source: "ui",
	});

	// Notify the agent (unless explicitly disabled). A working narrator receives
	// the edit as a cut-in user message so it carries real user-turn weight; an
	// idle one falls back to the sidecar queue.
	let interjected = false;
	if (notifyAgent !== false) {
		let taskSummary: string | null = null;
		let preview: string | null = null;

		if (path === "tasks.json") {
			try {
				const doc = parseSpecTasksDocument(written.content);
				const compiled = compileSpecTasks(doc);
				const openTasks = compiled.tasks.filter(
					(t) => t.status === "doing" || t.status === "todo" || t.status === "blocked",
				);
				if (openTasks.length > 0) {
					taskSummary = openTasks
						.slice(0, 8)
						.map((t) => `- [${t.status}] ${t.text}${t.protected ? " [protected]" : ""}`)
						.join("\n");
				}
			} catch {
				// Non-fatal — tasks may be invalid mid-edit.
			}
		} else {
			// Short preview for non-task files
			preview = content.slice(0, 300);
		}

		const userId = c.get("user").sub;
		const locale = await getUserLanguage(userId);
		const { delivered } = await interjectSpecEditAsUserMessage(
			narratorId,
			{
				uri: written.uri,
				path,
				revisionId: written.revisionId ?? null,
				updatedBy: "user",
				preview,
				taskSummary,
				timestamp: new Date().toISOString(),
			},
			locale,
			userId,
		);
		interjected = delivered === "interjected";
	}

	return c.json({
		path: written.path,
		uri: written.uri,
		revisionId: written.revisionId ?? null,
		readonly: written.readonly,
		interjected,
	});
});
