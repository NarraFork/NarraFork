import { and, count, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { chatRooms, narrators, terminals } from "../db/schema";
import { type ReadQueryOptions, readQuery, readQueryFirst } from "../db/worker-read";
import { AppError, NotFoundError } from "../lib/errors";
import { probeRoomUnreadForUser } from "./chat-service";
import {
	assertNarratorAccess,
	canWriteNarrator,
	NARRATOR_ACL_COLUMNS,
	type NarratorPrincipal,
} from "./narrator-acl";

const UI_SUMMARY_MAX_BYTES = 2 * 1024;

/** An existing room only: badge reads must never create rooms or memberships. */
export async function getNarratorUiSummary(
	narratorId: string,
	principal: NarratorPrincipal,
	signal?: AbortSignal,
) {
	const options: ReadQueryOptions = {
		signal,
		timeoutMs: 5_000,
		deadlineAt: Date.now() + 5_000,
		executionPolicy: "worker-required",
		diagnosticSource: "narrators.ui-summary",
	};
	const narrator = await readQueryFirst(
		db.query.narrators.findMany({
			where: eq(narrators.id, narratorId),
			columns: NARRATOR_ACL_COLUMNS,
			limit: 1,
		}),
		{ ...options, maxRows: 1 },
	);
	if (!narrator) throw new NotFoundError("Narrator", narratorId);
	await assertNarratorAccess(narrator, principal, "read", options);
	const [canWrite, terminalCounts, room] = await Promise.all([
		canWriteNarrator(narrator, principal, options),
		readQuery(
			db
				.select({ count: count() })
				.from(terminals)
				.where(
					and(
						eq(terminals.narratorId, narratorId),
						eq(terminals.status, "running"),
						isNull(terminals.worktreeResourceId),
					),
				),
			{ ...options, maxRows: 1 },
		),
		readQueryFirst(
			db
				.select({ id: chatRooms.id })
				.from(chatRooms)
				.where(and(eq(chatRooms.narratorId, narratorId), eq(chatRooms.kind, "narrator")))
				.limit(1),
			{ ...options, maxRows: 1 },
		),
	]);
	const unread = room
		? await probeRoomUnreadForUser(room.id, principal.userId, options)
		: { count: 0, capped: false };
	signal?.throwIfAborted();
	const summary = {
		narratorId,
		canWrite,
		activeTerminalCount: terminalCounts[0]?.count ?? 0,
		discussion: {
			roomId: room?.id ?? null,
			unread: unread.count,
			unreadCapped: unread.capped,
		},
	};
	// Never truncate identifiers or substitute empty success for invalid legacy data.
	if (Buffer.byteLength(JSON.stringify(summary), "utf8") > UI_SUMMARY_MAX_BYTES) {
		throw new AppError(
			"Narrator UI summary exceeds the 2 KiB response budget",
			413,
			"NARRATOR_UI_SUMMARY_TOO_LARGE",
		);
	}
	return summary;
}
