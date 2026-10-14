import { createHash } from "node:crypto";
import { and, asc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "../db";
import { integrationResourceBindings, narrators, narratorToolCalls, users } from "../db/schema";
import type { ToolCallBinding } from "../lib/agent/types";
import type { Locale } from "../lib/prompt-i18n";
import { isPlanModeTrait } from "../lib/narrator-utils";
import {
	isRuntimeToolAllowed,
	type RuntimePolicy,
	resolveRuntimePolicy,
} from "./agent-runtime/policy";
import {
	canReadNarrator,
	canWriteNarrator,
	type NarratorPrincipal,
	narratorReadableWhere,
	resolveNarratorListPrincipal,
} from "./narrator-acl";

type PeerRow = typeof narrators.$inferSelect;
interface PeerCallerInput {
	callerNarratorId: string;
	userId: string | null;
	runtimePolicy?: RuntimePolicy;
}
export interface ListPeerNarratorsInput extends PeerCallerInput {
	query?: string;
	limit?: number;
	cursor?: string;
}
export interface SendPeerNarratorMessageInput extends PeerCallerInput {
	id: string;
	message: string;
	toolUseId: string;
	toolCallBinding: ToolCallBinding;
	signal?: AbortSignal;
	locale?: Locale;
}
export interface PeerNarratorListItem {
	id: string;
	title: string | null;
	handle: string | null;
	status: string;
	canSend: boolean;
}

function ordinary(row: PeerRow | undefined): row is PeerRow {
	return !!row && row.type === "primary" && row.variant === "primary" && row.status !== "archived";
}
function sendModeAllowed(row: PeerRow): boolean {
	return (
		!row.planMode &&
		!isPlanModeTrait(row.traits) &&
		["default", "acceptEdits", "bypassPermissions"].includes(row.permissionMode ?? "")
	);
}
/** Plugin/OAuth provenance is a separate authority domain, even after revocation. */
function ordinaryDomainWhere() {
	return and(
		isNull(narrators.oauthPolicySnapshotJson),
		sql`not exists (select 1 from integration_resource_bindings b
			where b.resource_type = 'narrator' and b.resource_id = ${narrators.id}
			and (b.source_type <> 'first_party' or b.authority_type not in ('user', 'system') or b.state <> 'active'))`,
	);
}
async function assertOrdinaryDomain(row: PeerRow): Promise<void> {
	const [binding] = await db
		.select({
			sourceType: integrationResourceBindings.sourceType,
			authorityType: integrationResourceBindings.authorityType,
			state: integrationResourceBindings.state,
		})
		.from(integrationResourceBindings)
		.where(
			and(
				eq(integrationResourceBindings.resourceType, "narrator"),
				eq(integrationResourceBindings.resourceId, row.id),
			),
		)
		.limit(1);
	if (
		row.oauthPolicySnapshotJson !== null ||
		(binding &&
			(binding.sourceType !== "first_party" ||
				!["user", "system"].includes(binding.authorityType) ||
				binding.state !== "active"))
	)
		throw new Error("Ordinary narrator communication is unavailable in this authority domain");
}
async function caller(input: PeerCallerInput, sending: boolean) {
	if (!input.userId)
		throw new Error("Ordinary narrator communication requires an authenticated user");
	const [user] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.id, input.userId))
		.limit(1);
	if (!user) throw new Error("Ordinary narrator communication requires an authenticated user");
	const principal = await resolveNarratorListPrincipal(input.userId);
	const [source] = await db
		.select()
		.from(narrators)
		.where(eq(narrators.id, input.callerNarratorId))
		.limit(1);
	const policy = input.runtimePolicy ?? resolveRuntimePolicy({ variant: "primary" });
	if (!ordinary(source) || !isRuntimeToolAllowed(policy, sending ? "NarratorSend" : "NarratorList"))
		throw new Error("Only ordinary primary narrators may communicate with peers");
	await assertOrdinaryDomain(source);
	if (
		!(sending
			? await canWriteNarrator(source, principal)
			: await canReadNarrator(source, principal))
	)
		throw new Error("Source narrator access denied");
	if (sending && !sendModeAllowed(source))
		throw new Error("Source narrator is in plan or restricted permission mode");
	return { source, principal, policy };
}
function cursorScope(input: PeerCallerInput, query: string): string {
	return createHash("sha256")
		.update(JSON.stringify([input.callerNarratorId, input.userId, query]))
		.digest("hex");
}
function decodeCursor(cursor: string | undefined, scope: string): string | undefined {
	if (cursor === undefined) return undefined;
	try {
		if (!cursor || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
		const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (!value || typeof value !== "object") throw new Error();
		const c = value as Record<string, unknown>;
		if (
			c.v !== 1 ||
			c.scope !== scope ||
			typeof c.after !== "string" ||
			!c.after ||
			c.after.length > 256
		)
			throw new Error();
		return c.after;
	} catch {
		throw new Error("Invalid narrator cursor");
	}
}
/** ACL, domain and search predicates precede LIMIT; no full-table post-filtering. */
export async function listPeerNarrators(input: ListPeerNarratorsInput): Promise<{
	narrators: PeerNarratorListItem[];
	nextCursor: string | null;
}> {
	const query = input.query?.trim() ?? "";
	const limit = input.limit ?? 20;
	if (query.length > 256 || !Number.isInteger(limit) || limit < 1 || limit > 100)
		throw new Error("Invalid narrator query or limit");
	const scope = cursorScope(input, query);
	const after = decodeCursor(input.cursor, scope);
	const { source, principal, policy } = await caller(input, false);
	const needle = `%${query.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
	const rows = await db
		.select({
			id: narrators.id,
			title: narrators.title,
			handle: narrators.handle,
			status: narrators.status,
			ownerUserId: narrators.ownerUserId,
			visibility: narrators.visibility,
			writeAudience: narrators.writeAudience,
			type: narrators.type,
			aclRootNarratorId: narrators.aclRootNarratorId,
			chapterId: narrators.chapterId,
			contextProjectId: narrators.contextProjectId,
		})
		.from(narrators)
		.where(
			and(
				narratorReadableWhere(principal),
				ordinaryDomainWhere(),
				eq(narrators.type, "primary"),
				eq(narrators.variant, "primary"),
				ne(narrators.status, "archived"),
				ne(narrators.id, source.id),
				after ? gt(narrators.id, after) : undefined,
				query
					? or(
							eq(narrators.id, query),
							sql`lower(${narrators.title}) like ${needle} escape '\\'`,
							sql`lower(${narrators.handle}) like ${needle} escape '\\'`,
						)
					: undefined,
			),
		)
		.orderBy(asc(narrators.id))
		.limit(limit + 1);
	const page = rows.slice(0, limit);
	const sourceCanSend =
		isRuntimeToolAllowed(policy, "NarratorSend") &&
		sendModeAllowed(source) &&
		(await canWriteNarrator(source, principal));
	return {
		narrators: await Promise.all(
			page.map(async (row) => ({
				id: row.id,
				title: row.title,
				handle: row.handle,
				status: row.status,
				canSend: sourceCanSend && (await canWriteNarrator(row, principal)),
			})),
		),
		nextCursor:
			rows.length > limit
				? Buffer.from(JSON.stringify({ v: 1, scope, after: page.at(-1)?.id })).toString("base64url")
				: null,
	};
}
function assertNotCancelled(signal?: AbortSignal): void {
	signal?.throwIfAborted();
}
async function assertSendReceipt(input: SendPeerNarratorMessageInput): Promise<void> {
	const binding = input.toolCallBinding;
	if (
		!binding?.toolCallId ||
		!Number.isSafeInteger(binding.attempt) ||
		binding.attempt < 1 ||
		!input.toolUseId
	)
		throw new Error("NarratorSend requires exact tool execution receipt");
	const [receipt] = await db
		.select()
		.from(narratorToolCalls)
		.where(
			and(
				eq(narratorToolCalls.id, binding.toolCallId),
				eq(narratorToolCalls.narratorId, input.callerNarratorId),
				eq(narratorToolCalls.toolUseId, input.toolUseId),
				eq(narratorToolCalls.executionAttempt, binding.attempt),
			),
		)
		.limit(1);
	const args = receipt?.inputJson as Record<string, unknown> | null;
	if (
		!receipt ||
		receipt.toolName !== "NarratorSend" ||
		receipt.executionIdentityVersion !== 1 ||
		receipt.executionOriginToolCallId !== null ||
		!["running", "success"].includes(receipt.status) ||
		!receipt.permissionDecidedAt ||
		!["auto", "user", "reflection"].includes(receipt.permissionDecidedBy ?? "") ||
		receipt.permissionDenyMessage !== null ||
		args?.id !== input.id ||
		args?.message !== input.message
	)
		throw new Error("NarratorSend execution receipt is missing, stale or not approved");
}
async function targetForSend(
	id: string,
	principal: NarratorPrincipal,
	sourceId: string,
): Promise<PeerRow> {
	const [target] = await db.select().from(narrators).where(eq(narrators.id, id)).limit(1);
	if (
		id === sourceId ||
		!ordinary(target) ||
		!(await canReadNarrator(target, principal)) ||
		!(await canWriteNarrator(target, principal))
	)
		throw new Error("Peer narrator unavailable");
	await assertOrdinaryDomain(target);
	return target;
}
/** Resolve a trusted peer envelope; all durable sending is owned by session.sendMessage. */
export async function authorizePeerNarratorMessage(
	input: SendPeerNarratorMessageInput,
): Promise<import("./narrator-session").NarratorMessageSendInput & { kind: "agent" }> {
	assertNotCancelled(input.signal);
	if (
		!input.id ||
		input.id.length > 256 ||
		input.id !== input.id.trim() ||
		typeof input.message !== "string" ||
		!input.message.trim() ||
		Buffer.byteLength(input.message, "utf8") > 256 * 1024
	)
		throw new Error("Invalid peer id or message (maximum 256 KiB UTF-8)");
	const { principal } = await caller(input, true);
	await targetForSend(input.id, principal, input.callerNarratorId);
	await assertSendReceipt(input);
	// Recheck after asynchronous ACL/receipt reads: captured policy is not live authority.
	const { source } = await caller(input, true);
	await targetForSend(input.id, principal, source.id);
	assertNotCancelled(input.signal);
	return {
		kind: "agent",
		narratorId: input.id,
		message: input.message,
		sender: {
			id: source.id,
			title: source.title,
			label: source.handle ?? source.title ?? source.id,
			isParent: false,
		},
		toolUseId: input.toolUseId,
		toolCallBinding: { ...input.toolCallBinding },
		userId: input.userId,
		locale: input.locale,
		signal: input.signal,
	};
}
