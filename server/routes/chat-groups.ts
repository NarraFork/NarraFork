import { ValidationError } from "@server/lib/errors";
import {
	addGroupMemberSchema,
	createGroupSchema,
	postGroupMessageSchema,
} from "@server/lib/validators";
import { chatGroupService } from "@server/services/chat-group-service";
import { narratorService } from "@server/services/narrator-service";
import { Hono } from "hono";

const app = new Hono();

/** Resolve a friendly sender label for a stored message row. */
async function senderLabelFor(msg: {
	senderType: "user" | "narrator" | "system";
	senderNarratorId: string | null;
	senderUserId: string | null;
}): Promise<string> {
	if (msg.senderType === "narrator" && msg.senderNarratorId) {
		const n = await narratorService.getById(msg.senderNarratorId).catch(() => null);
		return n?.handle || n?.title || "narrator";
	}
	if (msg.senderType === "system") return "system";
	return "user";
}

// GET / — list active chat groups visible to the current user
app.get("/", async (c) => {
	const userId = c.get("user").sub;
	const limitRaw = Number.parseInt(c.req.query("limit") ?? "50", 10);
	const limit = Number.isNaN(limitRaw) ? 50 : limitRaw;
	const groups = await chatGroupService.listGroupsForUser(userId, { limit });
	return c.json({ groups });
});

// GET /:groupId — group detail + members (narrator members hydrated with handle/title)
app.get("/:groupId", async (c) => {
	const groupId = c.req.param("groupId");
	const group = await chatGroupService.getById(groupId);
	if (!group) throw new ValidationError("Chat group not found");
	const members = await chatGroupService.listMembers(groupId);
	// Attach a friendly handle/title for narrator members so the UI can show
	// "@handle" instead of a raw id. Bounded work (groups are small).
	const hydrated = await Promise.all(
		members.map(async (m) => {
			if (m.memberType !== "narrator" || !m.narratorId) return m;
			const n = await narratorService.getById(m.narratorId).catch(() => null);
			return { ...m, handle: n?.handle ?? null, title: n?.title ?? null };
		}),
	);
	return c.json({ group, members: hydrated });
});

// GET /:groupId/messages?cursor=&limit= — cursor-paginated history (newest first)
app.get("/:groupId/messages", async (c) => {
	const groupId = c.req.param("groupId");
	const cursor = c.req.query("cursor") || undefined;
	const limitRaw = Number.parseInt(c.req.query("limit") ?? "50", 10);
	const limit = Number.isNaN(limitRaw) ? 50 : limitRaw;
	const { messages, nextCursor } = await chatGroupService.listMessages(groupId, { cursor, limit });
	// Hydrate sender labels (small page; bounded work).
	const hydrated = await Promise.all(
		messages.map(async (m) => ({ ...m, senderLabel: await senderLabelFor(m) })),
	);
	return c.json({ messages: hydrated, nextCursor });
});

// POST /:groupId/messages — user posts a message into the group
app.post("/:groupId/messages", async (c) => {
	const groupId = c.req.param("groupId");
	const userId = c.get("user").sub;
	const parsed = postGroupMessageSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const message = await chatGroupService.postMessage({
		groupId,
		content: parsed.data.content,
		senderType: "user",
		senderUserId: userId,
		urgent: parsed.data.urgent,
	});
	return c.json(message, 201);
});

// POST /:groupId/members — add a named narrator to the group by handle
app.post("/:groupId/members", async (c) => {
	const groupId = c.req.param("groupId");
	const parsed = addGroupMemberSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	const named = await narratorService.getByHandle(parsed.data.handle);
	if (!named) throw new ValidationError(`No named narrator with handle "@${parsed.data.handle}"`);
	await chatGroupService.addNamedMember(groupId, named.id);
	const members = await chatGroupService.listMembers(groupId);
	return c.json({ members }, 201);
});

// POST / — explicitly create a group for an origin narrator
app.post("/", async (c) => {
	const userId = c.get("user").sub;
	const parsed = createGroupSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(parsed.error.message);
	// Validate the origin narrator exists.
	await narratorService.getById(parsed.data.originNarratorId);
	const group = await chatGroupService.createGroup({
		originNarratorId: parsed.data.originNarratorId,
		createdBy: userId,
		title: parsed.data.title ?? null,
	});
	return c.json(group, 201);
});

export const chatGroupRoutes = app;
