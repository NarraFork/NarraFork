import { createHash, randomBytes } from "node:crypto";
import type {
	CreatedPublicShare,
	PublicSharedSession,
	PublicShareLinkPage,
} from "@shared/public-narrator-share";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db";
import { chatRooms, narratorPublicShares, narrators } from "../db/schema";
import { AppError } from "../lib/errors";
import { generateId } from "../lib/id";
import {
	createPublicShareSchema,
	publicShareListSchema,
} from "../lib/validators/public-narrator-shares";
import { ensureNarratorDiscussionRoomForShare } from "./chat-service";
import { canManageNarratorAcl, NARRATOR_ACL_COLUMNS, type NarratorPrincipal } from "./narrator-acl";
import {
	assertPublicLineageVersions,
	publicLineageVersion,
	publicReadLineage,
} from "./public-narrator-share-lineage";

export function unavailablePublicShare(): AppError {
	return new AppError("Share link unavailable", 404, "PUBLIC_SHARE_UNAVAILABLE");
}

export function hashPublicShareToken(secret: string): string {
	return createHash("sha256").update(secret).digest("hex");
}

/** Never constructed from HTTP narrator/room/author fields. Hash stays server-side. */
export interface VerifiedPublicShare {
	shareId: string;
	tokenHash: string;
	narratorId: string;
	roomId: string;
	guestName: string;
}

const shareSelection = {
	id: narratorPublicShares.id,
	guestName: narratorPublicShares.guestName,
	label: narratorPublicShares.label,
	createdAt: narratorPublicShares.createdAt,
	revokedAt: narratorPublicShares.revokedAt,
};

/** Indexed synchronous revalidation also used immediately before a stream write. */
export function revalidatePublicShare(
	auth: Pick<VerifiedPublicShare, "shareId" | "tokenHash">,
): VerifiedPublicShare {
	const row = db
		.select({
			shareId: narratorPublicShares.id,
			tokenHash: narratorPublicShares.tokenHash,
			narratorId: narratorPublicShares.narratorId,
			guestName: narratorPublicShares.guestName,
			roomId: chatRooms.id,
		})
		.from(narratorPublicShares)
		.innerJoin(narrators, eq(narrators.id, narratorPublicShares.narratorId))
		.innerJoin(
			chatRooms,
			and(eq(chatRooms.narratorId, narrators.id), eq(chatRooms.kind, "narrator")),
		)
		.where(
			and(
				eq(narratorPublicShares.id, auth.shareId),
				eq(narratorPublicShares.tokenHash, auth.tokenHash),
				isNull(narratorPublicShares.revokedAt),
				eq(narrators.type, "primary"),
			),
		)
		.limit(1)
		.get();
	if (!row) throw unavailablePublicShare();
	return row;
}

export function verifyPublicShare(
	shareId: string,
	authorization: string | undefined,
): VerifiedPublicShare {
	// Exact shape bounds work before hashing and rejects Bearer/session credentials.
	const match = /^Share ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
	if (!/^[A-Za-z0-9_-]{21}$/.test(shareId) || !match) throw unavailablePublicShare();
	return revalidatePublicShare({ shareId, tokenHash: hashPublicShareToken(match[1]) });
}

async function assertManager(narratorId: string, principal: NarratorPrincipal): Promise<void> {
	const row = db.query.narrators
		.findFirst({ where: eq(narrators.id, narratorId), columns: NARRATOR_ACL_COLUMNS })
		.sync();
	if (!row || row.type !== "primary" || !(await canManageNarratorAcl(row, principal))) {
		throw unavailablePublicShare();
	}
}

/** Synchronous post-commit fanout: revocation never waits behind an async write. */
const revokeListeners = new Set<(shareId: string) => void>();
export function onPublicShareRevoked(listener: (shareId: string) => void): () => void {
	revokeListeners.add(listener);
	return () => {
		revokeListeners.delete(listener);
	};
}

export async function createPublicShare(
	narratorId: string,
	principal: NarratorPrincipal,
	input: unknown,
): Promise<CreatedPublicShare> {
	await assertManager(narratorId, principal);
	const parsed = createPublicShareSchema.safeParse(input);
	if (!parsed.success)
		throw new AppError("Invalid share parameters", 400, "PUBLIC_SHARE_INVALID_INPUT");
	await ensureNarratorDiscussionRoomForShare(narratorId);
	await assertManager(narratorId, principal);
	const token = randomBytes(32).toString("base64url");
	const share = db
		.insert(narratorPublicShares)
		.values({
			id: generateId(),
			narratorId,
			tokenHash: hashPublicShareToken(token),
			guestName: parsed.data.guestName,
			label: parsed.data.label || null,
			createdByUserId: principal.userId,
			createdAt: new Date().toISOString(),
		})
		.returning(shareSelection)
		.get();
	return { share, token };
}

export async function listPublicShares(
	narratorId: string,
	principal: NarratorPrincipal,
	input: unknown,
): Promise<PublicShareLinkPage> {
	await assertManager(narratorId, principal);
	const parsed = publicShareListSchema.safeParse(input);
	if (!parsed.success)
		throw new AppError("Invalid share parameters", 400, "PUBLIC_SHARE_INVALID_INPUT");
	const { cursor, limit } = parsed.data;
	let boundary: { createdAt: string; id: string } | undefined;
	if (cursor) {
		try {
			const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
			if (
				!Array.isArray(value) ||
				value.length !== 2 ||
				typeof value[0] !== "string" ||
				typeof value[1] !== "string" ||
				!/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value[0]) ||
				!/^[A-Za-z0-9_-]{21}$/.test(value[1])
			)
				throw new Error();
			boundary = { createdAt: value[0], id: value[1] };
		} catch {
			throw new AppError("Invalid cursor", 400, "PUBLIC_SHARE_INVALID_INPUT");
		}
	}
	const rows = db
		.select(shareSelection)
		.from(narratorPublicShares)
		.where(
			and(
				eq(narratorPublicShares.narratorId, narratorId),
				boundary
					? or(
							lt(narratorPublicShares.createdAt, boundary.createdAt),
							and(
								eq(narratorPublicShares.createdAt, boundary.createdAt),
								lt(narratorPublicShares.id, boundary.id),
							),
						)
					: undefined,
			),
		)
		.orderBy(desc(narratorPublicShares.createdAt), desc(narratorPublicShares.id))
		.limit(limit + 1)
		.all();
	const shares = rows.slice(0, limit);
	const last = shares.at(-1);
	return {
		shares,
		hasMore: rows.length > limit,
		nextCursor:
			rows.length > limit && last
				? Buffer.from(JSON.stringify([last.createdAt, last.id])).toString("base64url")
				: null,
	};
}

export async function revokePublicShare(
	narratorId: string,
	shareId: string,
	principal: NarratorPrincipal,
): Promise<void> {
	await assertManager(narratorId, principal);
	const row = db
		.update(narratorPublicShares)
		.set({
			revokedAt: sql`coalesce(${narratorPublicShares.revokedAt}, ${new Date().toISOString()})`,
		})
		.where(
			and(eq(narratorPublicShares.narratorId, narratorId), eq(narratorPublicShares.id, shareId)),
		)
		.returning({ id: narratorPublicShares.id })
		.get();
	if (!row) throw unavailablePublicShare();
	for (const listener of revokeListeners) listener(shareId);
}

export function getPublicSharedSession(auth: VerifiedPublicShare): PublicSharedSession {
	const current = revalidatePublicShare(auth);
	const row = db
		.select({
			title: sql<string>`substr(${narrators.title}, 1, 240)`,
			status: narrators.status,
			messageVersion: narrators.messageVersion,
		})
		.from(narrators)
		.where(eq(narrators.id, current.narratorId))
		.limit(1)
		.get();
	if (!row) throw unavailablePublicShare();
	const scopes = publicReadLineage(current.narratorId);
	assertPublicLineageVersions(scopes);
	revalidatePublicShare(current);
	return {
		shareId: current.shareId,
		guestName: current.guestName,
		title: row.title ?? "",
		status: ["working", "waiting", "archived"].includes(row.status) ? row.status : "idle",
		messageVersion: publicLineageVersion(scopes),
	};
}
