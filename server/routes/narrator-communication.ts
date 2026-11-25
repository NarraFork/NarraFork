import { COMMUNICATION_LIMITS } from "@shared/narrator-communication";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { AppError, ValidationError } from "../lib/errors";
import { mutateCommunication } from "../services/narrator-communication/service";
import { searchCommunicationCandidates } from "../services/search/communication-candidates";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const mutationSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("connect"), targetNarratorId: id }),
	z.strictObject({ kind: z.literal("disconnect"), peerId: id }),
	z.strictObject({ kind: z.literal("split"), version }),
	z.strictObject({ kind: z.literal("restore"), version }),
]);
const querySchema = z.strictObject({
	q: z.string().max(COMMUNICATION_LIMITS.searchQueryChars).optional(),
	limit: z.coerce.number().int().min(1).max(COMMUNICATION_LIMITS.searchMaxLimit).optional(),
	targetId: id.optional(),
});
const searches = new Map<string, { at: number; count: number }>();
function admitSearch(userId: string): void {
	const now = Date.now();
	const existing = searches.get(userId);
	if (existing && now - existing.at < 60_000) {
		if (++existing.count > 120)
			throw new AppError(
				"Communication search rate limit exceeded",
				429,
				"COMMUNICATION_SEARCH_RATE_LIMIT",
			);
		return;
	}
	if (searches.size >= 5000) {
		for (const [key, value] of searches) if (now - value.at >= 60_000) searches.delete(key);
		if (searches.size >= 5000)
			throw new AppError("Communication search is busy", 503, "SEARCH_QUERY_BUSY");
	}
	searches.set(userId, { at: now, count: 1 });
}
async function readCommunicationBody(c: Context): Promise<unknown> {
	const reader = c.req.raw.body?.getReader();
	if (!reader) throw new ValidationError("A JSON request body is required");
	const bytes = new Uint8Array(4096);
	let size = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			if (chunk.value.byteLength > bytes.byteLength - size) {
				void reader.cancel().catch(() => {});
				throw new AppError("Communication request is too large", 413, "REQUEST_TOO_LARGE");
			}
			bytes.set(chunk.value, size);
			size += chunk.value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
	} catch {
		throw new ValidationError("The request body must be valid JSON");
	}
}
/** Mount AFTER the existing narrator authentication and PostgreSQL surface guard. */
export function registerNarratorCommunicationRoutes(
	app: Hono,
	dependencies = { search: searchCommunicationCandidates, mutate: mutateCommunication },
): void {
	app.get("/:id/communication/candidates", async (c) => {
		const source = id.safeParse(c.req.param("id"));
		const query = querySchema.safeParse(c.req.query());
		if (!source.success || !query.success)
			throw new ValidationError("Invalid communication candidate query");
		const user = c.get("user");
		admitSearch(user.sub);
		return c.json(
			await dependencies.search(
				source.data,
				{ userId: user.sub, isAdmin: user.role === "admin" },
				{
					query: query.data.q,
					limit: query.data.limit,
					signal: c.req.raw.signal,
					...(query.data.targetId !== undefined && { targetId: query.data.targetId }),
				},
			),
		);
	});
	app.post("/:id/communication", async (c) => {
		const source = id.safeParse(c.req.param("id"));
		const mutation = mutationSchema.safeParse(await readCommunicationBody(c));
		if (!source.success || !mutation.success)
			throw new ValidationError("Invalid communication mutation");
		const user = c.get("user");
		return c.json(
			await dependencies.mutate(
				source.data,
				{ userId: user.sub, isAdmin: user.role === "admin" },
				mutation.data,
			),
		);
	});
}
