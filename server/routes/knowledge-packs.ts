import { existsSync } from "node:fs";
import { Hono } from "hono";
import { ValidationError } from "../lib/errors";
import { packArchivePath } from "../lib/pack-archives";
import {
	createKnowledgePackSchema,
	listKnowledgePacksQuerySchema,
	updateKnowledgePackSchema,
} from "../lib/validators";
import { packActivationService } from "../services/knowledge-pack-activation-service";
import { knowledgePackService } from "../services/knowledge-pack-service";

export const knowledgePackRoutes = new Hono();

/** Build the Principal from the authed JWT context. */
function principalOf(c: { get: (k: "user") => { sub: string; role: "admin" | "user" } }) {
	const u = c.get("user");
	return { userId: u.sub, role: u.role };
}

/** Parse optional JSON-encoded multipart fields (controlledTags, manifest) safely. */
function parseJsonField(form: FormData, key: string): unknown {
	const raw = form.get(key);
	if (typeof raw !== "string" || raw.trim() === "") return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		throw new ValidationError(`Field "${key}" must be valid JSON`);
	}
}

// ─── List / get ───────────────────────────────────────────────────────

knowledgePackRoutes.get("/", async (c) => {
	const parsed = listKnowledgePacksQuerySchema.safeParse({
		projectId: c.req.query("projectId"),
		entryId: c.req.query("entryId"),
	});
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(await knowledgePackService.listPacks(principalOf(c), parsed.data));
});

knowledgePackRoutes.get("/:id", async (c) => {
	return c.json(await knowledgePackService.getPack(c.req.param("id"), principalOf(c)));
});

// ─── Create (multipart: archive + metadata) ───────────────────────────

knowledgePackRoutes.post("/", async (c) => {
	const form = await c.req.formData();
	const archive = form.get("archive") ?? form.get("file");
	if (!archive || !(archive instanceof File)) {
		throw new ValidationError("No pack archive provided (field 'archive')");
	}
	const meta = {
		name: (form.get("name") as string | null) ?? undefined,
		slug: (form.get("slug") as string | null) ?? undefined,
		description: (form.get("description") as string | null) ?? undefined,
		projectId: (form.get("projectId") as string | null) ?? undefined,
		entryId: (form.get("entryId") as string | null) ?? undefined,
		classificationLevel: (form.get("classificationLevel") as string | null) ?? undefined,
		controlledTags: parseJsonField(form, "controlledTags"),
		manifest: parseJsonField(form, "manifest"),
	};
	const parsed = createKnowledgePackSchema.safeParse(meta);
	if (!parsed.success) throw new ValidationError(parsed.error.message);

	const pack = await knowledgePackService.createPack({
		...parsed.data,
		ownerUserId: c.get("user").sub,
		archive,
	});
	return c.json(pack, 201);
});

// ─── Update metadata ──────────────────────────────────────────────────

knowledgePackRoutes.patch("/:id", async (c) => {
	const parsed = updateKnowledgePackSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	return c.json(
		await knowledgePackService.updatePackMeta(c.req.param("id"), parsed.data, principalOf(c)),
	);
});

// ─── Replace archive (multipart) ──────────────────────────────────────

knowledgePackRoutes.put("/:id/archive", async (c) => {
	const form = await c.req.formData();
	const archive = form.get("archive") ?? form.get("file");
	if (!archive || !(archive instanceof File)) {
		throw new ValidationError("No pack archive provided (field 'archive')");
	}
	return c.json(
		await knowledgePackService.replaceArchive(c.req.param("id"), archive, principalOf(c)),
	);
});

// ─── Delete ───────────────────────────────────────────────────────────

knowledgePackRoutes.delete("/:id", async (c) => {
	return c.json(await knowledgePackService.deletePack(c.req.param("id"), principalOf(c)));
});

// ─── Download archive (ACL-gated) ─────────────────────────────────────

knowledgePackRoutes.get("/:id/download", async (c) => {
	const pack = await knowledgePackService.getPack(c.req.param("id"), principalOf(c));
	const path = packArchivePath(pack.id, pack.archiveFormat as "tar.gz" | "zip");
	if (!existsSync(path)) throw new ValidationError("Pack archive file is missing on disk");
	const file = Bun.file(path);
	const ext = pack.archiveFormat === "zip" ? "zip" : "tar.gz";
	return new Response(file, {
		headers: {
			"Content-Type": "application/octet-stream",
			"Content-Disposition": `attachment; filename="${pack.slug}.${ext}"`,
		},
	});
});

// ─── Activations (view / manual release) ──────────────────────────────

knowledgePackRoutes.get("/activations/list", async (c) => {
	const narratorId = c.req.query("narratorId");
	if (!narratorId) throw new ValidationError("narratorId is required");
	return c.json(await packActivationService.listActive(narratorId));
});

knowledgePackRoutes.post("/:id/deactivate", async (c) => {
	const narratorId = c.req.query("narratorId");
	if (!narratorId) throw new ValidationError("narratorId is required");
	return c.json(await packActivationService.deactivate(narratorId, c.req.param("id")));
});
