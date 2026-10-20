import { readQuery } from "@server/db/worker-read";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { RequestRecordingDetail } from "../../shared/request-recording";
import { db } from "../db";
import { apiRequests } from "../db/schema";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import {
	deleteSavedRecording,
	downloadSavedRecording,
	getRequestRecordingDetail,
	listSavedRecordings,
	saveRequestRecording,
	saveSpecificRequestRecording,
} from "../lib/request-recorder";
import { sanitizeRecordingDisplayText } from "../lib/request-recorder-sanitize";

export async function lookupApiRequestMetadata(
	narratorId: string,
	apiRequestId: string,
): Promise<RequestRecordingDetail["apiRequest"]> {
	// Primary-key lookup, same-narrator ownership, bounded metadata only. No dump columns.
	const [row] = await readQuery(
		db
			.select({
				id: apiRequests.id,
				createdAt: apiRequests.createdAt,
				durationMs: apiRequests.durationMs,
				ttftMs: apiRequests.ttftMs,
				errorMessage: sql<string | null>`substr(${apiRequests.errorMessage}, 1, 2048)`,
			})
			.from(apiRequests)
			.where(and(eq(apiRequests.id, apiRequestId), eq(apiRequests.narratorId, narratorId)))
			.limit(1),
	);
	if (!row) return undefined;
	return {
		...row,
		errorMessage: row.errorMessage === null ? null : sanitizeRecordingDisplayText(row.errorMessage),
	};
}

interface RecordingService {
	lookupApiRequestMetadata?: typeof lookupApiRequestMetadata;
	saveRequestRecording: typeof saveRequestRecording;
	getRequestRecordingDetail: typeof getRequestRecordingDetail;
	saveSpecificRequestRecording: typeof saveSpecificRequestRecording;
	listSavedRecordings: typeof listSavedRecordings;
	deleteSavedRecording: typeof deleteSavedRecording;
	downloadSavedRecording: typeof downloadSavedRecording;
}

function parseRequestId(value: string): string {
	if (!value || Buffer.byteLength(value) > 512 || /[\p{Cc}]/u.test(value))
		throw new NotFoundError("Request recording", "request");
	return value;
}

function parseSaveId(value: string): string {
	if (!/^[A-Za-z0-9_-]{21}$/.test(value)) throw new NotFoundError("Request recording", value);
	return value;
}

/** Mounted under the narrator read/write ACL gate; injectable for isolated route tests. */
export function createRequestRecordingRoutes(
	service: RecordingService = {
		saveRequestRecording,
		saveSpecificRequestRecording,
		listSavedRecordings,
		deleteSavedRecording,
		downloadSavedRecording,
		getRequestRecordingDetail,
		lookupApiRequestMetadata,
	},
) {
	const routes = new Hono();
	routes.use("*", async (c, next) => {
		if (!c.get("user")?.sub) throw new AppError("Authentication required", 401, "UNAUTHORIZED");
		c.header("Cache-Control", "no-store");
		await next();
	});
	routes.post("/", async (c) => {
		return c.json(await service.saveRequestRecording(c.req.param("id") ?? ""));
	});
	routes.get("/", async (c) => {
		const rawLimit = c.req.query("limit");
		const limit = rawLimit === undefined ? 20 : Number(rawLimit);
		if (
			(rawLimit !== undefined && !/^\d+$/.test(rawLimit)) ||
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > 100
		)
			throw new ValidationError("limit must be an integer from 1 to 100");
		const cursor = c.req.query("cursor");
		if (cursor !== undefined && (cursor.length > 256 || !/^[^\p{Cc}]+$/u.test(cursor)))
			throw new ValidationError("Invalid request recording cursor");
		return c.json(await service.listSavedRecordings(c.req.param("id") ?? "", cursor, limit));
	});
	routes.get("/requests/:requestId", async (c) => {
		const narratorId = c.req.param("id") ?? "";
		const detail = await service.getRequestRecordingDetail(
			narratorId,
			parseRequestId(c.req.param("requestId")),
			c.req.raw.signal,
		);
		if (detail.apiRequestId) {
			const apiRequest = await (service.lookupApiRequestMetadata ?? lookupApiRequestMetadata)(
				narratorId,
				detail.apiRequestId,
			);
			if (apiRequest) return c.json({ ...detail, apiRequest });
		}
		return c.json(detail);
	});
	routes.post("/requests/:requestId", async (c) => {
		return c.json(
			await service.saveSpecificRequestRecording(
				c.req.param("id") ?? "",
				parseRequestId(c.req.param("requestId")),
				c.req.raw.signal,
			),
		);
	});
	routes.delete("/:saveId", async (c) => {
		await service.deleteSavedRecording(c.req.param("id") ?? "", parseSaveId(c.req.param("saveId")));
		return c.json({ ok: true });
	});
	routes.get("/:saveId/download", async (c) => {
		return service.downloadSavedRecording(
			c.req.param("id") ?? "",
			parseSaveId(c.req.param("saveId")),
			c.req.raw.signal,
		);
	});
	return routes;
}

export const requestRecordingRoutes = createRequestRecordingRoutes();
