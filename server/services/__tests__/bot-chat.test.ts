/**
 * bot-chat tests — the properties a bot narrator depends on.
 *
 * 1. **One room per (bot, person), keyed by the person's id.** Opening it twice — or
 *    concurrently, or the bot writing first — must land in the same room, and two
 *    people talking to one bot must never share a room.
 * 2. **A bot room is closed like a DM.** Reading is membership; posting additionally
 *    needs the right to DRIVE the bot, because a post becomes its next input.
 * 3. **The bot speaks only through Send({ user }).** Only a bot narrator is offered the
 *    target and only a bot narrator can use it; its message is attributed to the bot,
 *    not to a stand-in account.
 * 4. **A person's post reaches the bot authored by that person**, quotes and files
 *    included, as literal text, in the room's order — and only a post the bot took is
 *    recorded. The bot's own messages are never fed back to it.
 * 5. **Bot conversations are conversations**: listed with the bot as peer and counted
 *    in the navigation badge.
 * 6. **Nothing waits on a person who can't see it**: a bot can't ask or plan for
 *    approval, and a fork of one is an ordinary narrator.
 *
 * Runs against an isolated DB under a temp NARRAFORK_HOME (see tests/preload.ts).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { chatAttachments, chatMessages, chatRooms, narrators, users } from "../../db/schema";
import { sendTool } from "../../lib/agent/tools/send";
import type { AgentConfig, ToolContext } from "../../lib/agent/types";
import { ForbiddenError, NotFoundError, ValidationError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { BOT_TRAIT, isBotNarrator } from "../../lib/narrator-utils";
import { resolveRuntimePolicy } from "../agent-runtime/policy";

// ── narrator-session double: delivery is observed, never run as a real agent turn ──

interface Accepted {
	narratorId: string;
	text: string;
	userId: string | null | undefined;
	literal: boolean | undefined;
}
const accepted: Accepted[] = [];
const creators: Array<{ username: string } | null | undefined> = [];
/** Set to make the bot refuse what it is handed, as a full queue does. */
let refusal: Error | null = null;
/** Set to hold an admission open, to see whether a later post can overtake it. */
let admissionDelay: ((text: string) => Promise<void>) | null = null;
const realSessionModule = { ...(await import("../narrator-session")) };
mock.module("../narrator-session", () => ({
	...realSessionModule,
	acceptUserMessage: async (
		narratorId: string,
		text: string,
		options: {
			userId?: string | null;
			creator?: { username: string } | null;
			executionIntent?: { literal?: boolean };
		},
	) => {
		await admissionDelay?.(text);
		if (refusal) throw refusal;
		accepted.push({
			narratorId,
			text,
			userId: options.userId,
			literal: options.executionIntent?.literal,
		});
		creators.push(options.creator);
		return { buffered: true, id: generateId(), bufferedAt: new Date().toISOString() };
	},
}));

const { sendAsBot } = await import("../bot-chat");
const {
	assertCanRead,
	buildBotRoomKey,
	CHAT_BOT_MESSAGE_MAX_CHARS,
	createChatAttachment,
	getUnreadSummary,
	hydrateMessageForBroadcast,
	listConversationRooms,
	listMessages,
	postBotMessage,
	postMessage,
	resolveBotRoom,
	resolveNarratorRoom,
} = await import("../chat-service");
const { runtimeBasePrompt } = await import("../agent-runtime/orchestrator");
const { shouldAutoAllowSendWithinScope } = await import("../narrator-permission");
const { narratorService } = await import("../narrator-service");
const { resolveNarratorRuntimePolicy } = await import("../trait-layer-service");

afterAll(() => {
	mock.module("../narrator-session", () => realSessionModule);
	mock.restore();
});

const TAG = Date.now();

let owner: string;
let alice: string;
let bob: string;
let aliceName: string;
/** Anyone may watch and drive it. */
let openBot: string;
/** Anyone may watch it; only the owner may drive it. */
let watchOnlyBot: string;
/** Only the owner may even see it. */
let privateBot: string;
let plainNarrator: string;
/** A bot with a working directory, so files can reach it. */
let fileBot: string;
let fileBotCwd: string;

async function makeUser(label: string): Promise<{ id: string; username: string }> {
	const id = generateId();
	const username = `${label}-${TAG}-${generateId(6)}`;
	await db.insert(users).values({
		id,
		username,
		passwordHash: "x",
		role: "user",
		createdAt: new Date().toISOString(),
	});
	return { id, username };
}

async function makeNarrator(input: {
	title: string;
	traits: string[];
	visibility: "private" | "project" | "public";
	writeAudience: "owner" | "project" | "public";
	cwd?: string;
}): Promise<string> {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id,
		title: input.title,
		traits: input.traits,
		ownerUserId: owner,
		visibility: input.visibility,
		writeAudience: input.writeAudience,
		cwd: input.cwd ?? null,
		createdAt: now,
		updatedAt: now,
	});
	return id;
}

function textFile(name: string, body: string): File {
	return new File([body], name, { type: "text/markdown" });
}

/** What the bot's worktree holds of attached files. */
function attachedCopies(): string[] {
	const dir = join(fileBotCwd, ".narrafork", "attached");
	return existsSync(dir) ? readdirSync(dir) : [];
}

async function roomTexts(roomId: string, userId: string): Promise<string[]> {
	const page = await listMessages({ roomId, userId });
	return page.messages.map((message) => message.contentText);
}

beforeAll(async () => {
	owner = (await makeUser("bot-owner")).id;
	const a = await makeUser("bot-alice");
	alice = a.id;
	aliceName = a.username;
	bob = (await makeUser("bot-bob")).id;
	const bot = [BOT_TRAIT, "standalone"];
	openBot = await makeNarrator({
		title: "Design Bot",
		traits: bot,
		visibility: "public",
		writeAudience: "public",
	});
	watchOnlyBot = await makeNarrator({
		title: "Showcase Bot",
		traits: bot,
		visibility: "public",
		writeAudience: "owner",
	});
	privateBot = await makeNarrator({
		title: "Secret Bot",
		traits: bot,
		visibility: "private",
		writeAudience: "owner",
	});
	plainNarrator = await makeNarrator({
		title: "Plain",
		traits: ["standalone"],
		visibility: "public",
		writeAudience: "public",
	});
	fileBotCwd = mkdtempSync(join(process.env.NARRAFORK_HOME as string, "bot-cwd-"));
	fileBot = await makeNarrator({
		title: "File Bot",
		traits: bot,
		visibility: "public",
		writeAudience: "public",
		cwd: fileBotCwd,
	});
});

// ─── 1. Room identity ─────────────────────────────────────────────────────────

describe("bot room resolution", () => {
	test("is keyed by bot and person id, disjoint from DM keys", () => {
		expect(buildBotRoomKey("n1", "u1")).toBe("bot:n1:u1");
	});

	test("resolving twice, or concurrently, yields one room", async () => {
		const [a, b, c] = await Promise.all([
			resolveBotRoom(openBot, alice),
			resolveBotRoom(openBot, alice),
			resolveBotRoom(openBot, alice),
		]);
		expect(new Set([a.id, b.id, c.id]).size).toBe(1);
		expect(a.kind).toBe("bot");
		expect(a.narratorId).toBe(openBot);
		expect(a.peer).toMatchObject({ id: openBot, username: "Design Bot", isBot: true });
	});

	test("each person gets their own room with the same bot", async () => {
		const forAlice = await resolveBotRoom(openBot, alice);
		const forBob = await resolveBotRoom(openBot, bob);
		expect(forBob.id).not.toBe(forAlice.id);
	});

	test("the bot writing first creates the same room the person later opens", async () => {
		const carol = await makeUser("bot-carol");
		const sent = await postBotMessage({ narratorId: openBot, userId: carol.id, text: "Hello" });
		const opened = await resolveBotRoom(openBot, carol.id);
		expect(opened.id).toBe(sent.roomId);
		expect(opened.unread).toBe(1);
	});

	test("coexists with the narrator's discussion room", async () => {
		const discussion = await resolveNarratorRoom(openBot, alice);
		const conversation = await resolveBotRoom(openBot, alice);
		expect(discussion.kind).toBe("narrator");
		expect(discussion.id).not.toBe(conversation.id);
		// And the discussion room is still the only one of its kind.
		expect((await resolveNarratorRoom(openBot, bob)).id).toBe(discussion.id);
	});

	test("refuses a narrator that is not a bot", async () => {
		await expect(resolveBotRoom(plainNarrator, alice)).rejects.toBeInstanceOf(NotFoundError);
	});

	test("refuses a bot the person cannot see, without creating a room", async () => {
		await expect(resolveBotRoom(privateBot, alice)).rejects.toBeInstanceOf(NotFoundError);
		const phantom = await db.query.chatRooms.findFirst({
			where: eq(chatRooms.dmKey, buildBotRoomKey(privateBot, alice)),
		});
		expect(phantom).toBeUndefined();
	});

	test("canPost reports whether the person may drive the bot", async () => {
		expect((await resolveBotRoom(openBot, alice)).canPost).toBe(true);
		expect((await resolveBotRoom(watchOnlyBot, alice)).canPost).toBe(false);
		expect((await resolveBotRoom(watchOnlyBot, owner)).canPost).toBe(true);
	});
});

// ─── 2. Access ────────────────────────────────────────────────────────────────

describe("bot room access", () => {
	test("only the person in the conversation can read it", async () => {
		const room = await resolveBotRoom(openBot, alice);
		await expect(assertCanRead(room.id, alice)).resolves.toBeDefined();
		await expect(assertCanRead(room.id, bob)).rejects.toBeInstanceOf(NotFoundError);
		// Not even the bot's owner: the transcript, not the room, is the monitor.
		await expect(assertCanRead(room.id, owner)).rejects.toBeInstanceOf(NotFoundError);
	});

	test("posting requires the right to drive the bot", async () => {
		const room = await resolveBotRoom(watchOnlyBot, alice);
		await expect(
			postMessage({ roomId: room.id, senderUserId: alice, text: "hi" }),
		).rejects.toBeInstanceOf(ForbiddenError);
	});

	test("narrowing who may drive a bot stops their posts, not their history", async () => {
		const narrowing = await makeNarrator({
			title: "Narrowing Bot",
			traits: [BOT_TRAIT, "standalone"],
			visibility: "public",
			writeAudience: "public",
		});
		const room = await resolveBotRoom(narrowing, alice);
		await postMessage({ roomId: room.id, senderUserId: alice, text: "before" });
		await db.update(narrators).set({ writeAudience: "owner" }).where(eq(narrators.id, narrowing));
		await expect(
			postMessage({ roomId: room.id, senderUserId: alice, text: "after" }),
		).rejects.toBeInstanceOf(ForbiddenError);
		expect(await roomTexts(room.id, alice)).toEqual(["before"]);
		expect((await resolveBotRoom(narrowing, alice)).canPost).toBe(false);
	});

	test("so does staging a file, which could never be sent", async () => {
		const room = await resolveBotRoom(watchOnlyBot, alice);
		await expect(
			createChatAttachment(room.id, alice, textFile("notes.md", "# hi")),
		).rejects.toBeInstanceOf(ForbiddenError);
	});
});

// ─── 3. The bot's voice ───────────────────────────────────────────────────────

describe("bot messages", () => {
	test("are attributed to the bot, not to a user", async () => {
		const sent = await postBotMessage({ narratorId: openBot, userId: alice, text: "  Hi!  " });
		expect(sent.contentText).toBe("Hi!");
		expect(sent.sender).toMatchObject({ id: openBot, username: "Design Bot", isBot: true });
		const row = await db.query.chatMessages.findFirst({ where: eq(chatMessages.id, sent.id) });
		expect(row?.senderUserId).toBeNull();
		expect(row?.senderNarratorId).toBe(openBot);
		const room = await db.query.chatRooms.findFirst({ where: eq(chatRooms.id, sent.roomId) });
		expect(room?.lastMessageSenderId).toBe(openBot);

		const page = await listMessages({ roomId: sent.roomId, userId: alice });
		expect(page.messages.find((message) => message.id === sent.id)?.sender).toMatchObject({
			id: openBot,
			isBot: true,
		});
		// The live frame is built separately from the page; both must name the bot.
		if (!row) throw new Error("bot message row missing");
		expect((await hydrateMessageForBroadcast(row)).sender).toMatchObject({
			id: openBot,
			isBot: true,
		});
	});

	test("are bounded by the bot message ceiling", async () => {
		await expect(
			postBotMessage({
				narratorId: openBot,
				userId: alice,
				text: "x".repeat(CHAT_BOT_MESSAGE_MAX_CHARS + 1),
			}),
		).rejects.toBeInstanceOf(ValidationError);
	});

	test("a person replying to the bot quotes the bot as author", async () => {
		const sent = await postBotMessage({
			narratorId: openBot,
			userId: alice,
			text: "Option A or B?",
		});
		const reply = await postMessage({
			roomId: sent.roomId,
			senderUserId: alice,
			text: "B",
			replyToMessageId: sent.id,
		});
		expect(reply.replyToSender).toMatchObject({ id: openBot, isBot: true });
		const page = await listMessages({ roomId: sent.roomId, userId: alice });
		expect(page.messages.find((message) => message.id === reply.id)?.replyToSender).toMatchObject({
			id: openBot,
			isBot: true,
		});
	});
});

describe("Send({ user })", () => {
	const ctx = (narratorId: string) =>
		({ narratorId, currentToolUseId: generateId(), locale: "en" }) as ToolContext;

	test("is offered to bots only", () => {
		const policy = resolveRuntimePolicy([]);
		const props = (config: Partial<AgentConfig>) =>
			(sendTool.getRawJsonSchema?.({ runtimePolicy: policy, ...config } as AgentConfig)
				.properties ?? {}) as Record<string, unknown>;
		expect(props({ bot: true }).user).toBeDefined();
		expect(props({ bot: false }).user).toBeUndefined();
		expect(props({}).user).toBeUndefined();
	});

	test("delivers into the person's conversation, found by username", async () => {
		const result = await sendTool.execute({ user: aliceName, message: "Done." }, ctx(openBot));
		expect(result.isError).toBeFalsy();
		// A person is not a session: the card gets a label, never a session link.
		expect(result.metadata?.targets).toEqual([{ label: aliceName, status: "sent" }]);
		const room = await resolveBotRoom(openBot, alice);
		const page = await listMessages({ roomId: room.id, userId: alice });
		expect(page.messages.at(-1)?.contentText).toBe("Done.");
	});

	test("strips native-search citation markers before the person sees them", async () => {
		const marker = "\ue200cite\ue202turn0search0\ue202turn0search3\ue201";
		const result = await sendTool.execute(
			{ user: aliceName, message: `Bun 1.3 ships it.${marker} See [docs](https://bun.sh).` },
			ctx(openBot),
		);
		expect(result.isError).toBeFalsy();
		const room = await resolveBotRoom(openBot, alice);
		const page = await listMessages({ roomId: room.id, userId: alice });
		expect(page.messages.at(-1)?.contentText).toBe("Bun 1.3 ships it. See [docs](https://bun.sh).");

		const onlyMarker = await sendTool.execute({ user: aliceName, message: marker }, ctx(openBot));
		expect(onlyMarker.isError).toBe(true);
	});

	test("accepts an @mention and any letter case", async () => {
		const sent = await sendAsBot({
			narratorId: openBot,
			user: `@${aliceName.toUpperCase()}`,
			message: "ok",
		});
		expect(sent.userId).toBe(alice);
	});

	test("refuses an unknown person", async () => {
		await expect(
			sendAsBot({ narratorId: openBot, user: `nobody-${TAG}`, message: "hi" }),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	test("reaches only people who can open the bot, without opening a room for others", async () => {
		await expect(
			sendAsBot({ narratorId: privateBot, user: aliceName, message: "Your session expired" }),
		).rejects.toBeInstanceOf(ForbiddenError);
		const phantom = await db.query.chatRooms.findFirst({
			where: eq(chatRooms.dmKey, buildBotRoomKey(privateBot, alice)),
		});
		expect(phantom).toBeUndefined();
	});

	test("refuses a narrator that is not a bot, even with a hand-built call", async () => {
		const result = await sendTool.execute({ user: aliceName, message: "hi" }, ctx(plainNarrator));
		expect(result.isError).toBe(true);
		expect(result.output).toContain("Only bot narrators");
	});

	test("cannot be mixed with agent targets or an interrupt", async () => {
		const mixed = await sendTool.execute(
			{ user: aliceName, id: "parent", message: "hi" },
			ctx(openBot),
		);
		expect(mixed.isError).toBe(true);
		const interrupting = await sendTool.execute(
			{ user: aliceName, doInterrupt: true, message: "hi" },
			ctx(openBot),
		);
		expect(interrupting.isError).toBe(true);
	});

	test("never asks for approval from a bot, and is not auto-allowed for others", async () => {
		const input = { user: aliceName, message: "hi" };
		expect(await shouldAutoAllowSendWithinScope(openBot, { traits: [BOT_TRAIT] }, input)).toBe(
			true,
		);
		expect(await shouldAutoAllowSendWithinScope(plainNarrator, { traits: [] }, input)).toBe(false);
	});
});

// ─── 4. Delivery to the bot ───────────────────────────────────────────────────

describe("delivery to the bot", () => {
	test("a person's post becomes the bot's input, authored by that person", async () => {
		accepted.length = 0;
		creators.length = 0;
		const room = await resolveBotRoom(openBot, alice);
		await postMessage({ roomId: room.id, senderUserId: alice, text: "Make it blue" });
		expect(accepted).toEqual([
			{ narratorId: openBot, text: "Make it blue", userId: alice, literal: true },
		]);
		expect(creators[0]?.username).toBe(aliceName);
	});

	test("a reply carries the quoted text ahead of the answer", async () => {
		accepted.length = 0;
		const question = await postBotMessage({
			narratorId: openBot,
			userId: alice,
			text: "Serif or sans?",
		});
		await postMessage({
			roomId: question.roomId,
			senderUserId: alice,
			text: "Sans",
			replyToMessageId: question.id,
		});
		expect(accepted[0]?.text).toBe("> Serif or sans?\n\nSans");
	});

	test("chat text is never a session command", async () => {
		accepted.length = 0;
		const room = await resolveBotRoom(openBot, alice);
		await postMessage({ roomId: room.id, senderUserId: alice, text: "/new draft a poem" });
		expect(accepted[0]).toMatchObject({ text: "/new draft a poem", literal: true });
		expect(
			realSessionModule.parseQueuedNewCommand("/new draft a poem", null, undefined, {
				literal: true,
			}),
		).toBeNull();
		expect(
			realSessionModule.parseQueuedGoalCommand("/goal ship it", null, undefined, {
				literal: true,
			}),
		).toBeNull();
	});

	test("the bot's own messages are never fed back to it", async () => {
		accepted.length = 0;
		await postBotMessage({ narratorId: openBot, userId: alice, text: "Hi" });
		expect(accepted).toHaveLength(0);
	});

	test("talking to an archived bot wakes it, like its own composer would", async () => {
		accepted.length = 0;
		await db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, openBot));
		const room = await resolveBotRoom(openBot, bob);
		await postMessage({ roomId: room.id, senderUserId: bob, text: "Still there?" });
		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, openBot) });
		expect(row?.status).toBe("idle");
		expect(accepted).toHaveLength(1);
	});

	test("files travel with the post into the bot's worktree", async () => {
		accepted.length = 0;
		const room = await resolveBotRoom(fileBot, alice);
		const draft = await createChatAttachment(room.id, alice, textFile("brief.md", "# Brief"));
		await postMessage({
			roomId: room.id,
			senderUserId: alice,
			text: "",
			attachmentIds: [draft.id],
		});
		expect(accepted[0]?.text).toContain("<attached_files>");
		expect(accepted[0]?.text).toContain("brief.md");
		const copies = attachedCopies();
		expect(copies).toHaveLength(1);
		expect(readFileSync(join(fileBotCwd, ".narrafork", "attached", copies[0]), "utf-8")).toBe(
			"# Brief",
		);
	});

	test("a post the bot can't take is refused: nothing recorded, the files left to retry", async () => {
		accepted.length = 0;
		const room = await resolveBotRoom(fileBot, bob);
		const draft = await createChatAttachment(room.id, bob, textFile("plan.md", "# Plan"));
		const before = attachedCopies().length;
		refusal = new ValidationError("Message queue is full");
		try {
			await expect(
				postMessage({
					roomId: room.id,
					senderUserId: bob,
					text: "Here is the plan",
					attachmentIds: [draft.id],
				}),
			).rejects.toThrow("Message queue is full");
		} finally {
			refusal = null;
		}
		expect(await roomTexts(room.id, bob)).not.toContain("Here is the plan");
		expect(attachedCopies()).toHaveLength(before);
		const stillDraft = await db.query.chatAttachments.findFirst({
			where: and(eq(chatAttachments.id, draft.id), isNull(chatAttachments.messageId)),
		});
		expect(stillDraft).toBeDefined();

		// The person sends the same message again, and this time the bot takes it.
		await postMessage({
			roomId: room.id,
			senderUserId: bob,
			text: "Here is the plan",
			attachmentIds: [draft.id],
		});
		expect(await roomTexts(room.id, bob)).toContain("Here is the plan");
		expect(accepted).toHaveLength(1);
	});

	test("a file for a bot with no working directory refuses the post", async () => {
		const room = await resolveBotRoom(openBot, alice);
		const draft = await createChatAttachment(room.id, alice, textFile("x.md", "x"));
		await expect(
			postMessage({ roomId: room.id, senderUserId: alice, text: "", attachmentIds: [draft.id] }),
		).rejects.toBeInstanceOf(ValidationError);
	});

	test("the bot hears posts in the room's order, even when they race", async () => {
		accepted.length = 0;
		const frank = await makeUser("bot-frank");
		const room = await resolveBotRoom(openBot, frank.id);
		// Hold the first admission open: without one-at-a-time delivery the second post
		// would reach the bot first.
		admissionDelay = (text) => (text === "first" ? Bun.sleep(50) : Promise.resolve());
		try {
			await Promise.all([
				postMessage({ roomId: room.id, senderUserId: frank.id, text: "first" }),
				Bun.sleep(5).then(() =>
					postMessage({ roomId: room.id, senderUserId: frank.id, text: "second" }),
				),
			]);
		} finally {
			admissionDelay = null;
		}
		expect(accepted.map((entry) => entry.text)).toEqual(["first", "second"]);
		expect(await roomTexts(room.id, frank.id)).toEqual(["first", "second"]);
	});
});

// ─── 5. Bot conversations are conversations ───────────────────────────────────

describe("listing and badges", () => {
	test("bot rooms are listed with the bot as peer", async () => {
		const dave = await makeUser("bot-dave");
		await postBotMessage({ narratorId: openBot, userId: dave.id, text: "Welcome" });
		const rooms = await listConversationRooms(dave.id);
		expect(rooms).toHaveLength(1);
		expect(rooms[0]).toMatchObject({
			kind: "bot",
			narratorId: openBot,
			peer: { id: openBot, isBot: true },
			unread: 1,
			lastMessagePreview: "Welcome",
		});
	});

	test("a bot writing to someone counts toward their navigation badge", async () => {
		const erin = await makeUser("bot-erin");
		await postBotMessage({ narratorId: openBot, userId: erin.id, text: "One" });
		await postBotMessage({ narratorId: openBot, userId: erin.id, text: "Two" });
		const summary = await getUnreadSummary(erin.id);
		expect(summary.dmTotal).toBe(2);
	});
});

// ─── Narrator side ────────────────────────────────────────────────────────────

describe("bot narrators", () => {
	test("kind=bot creates a standalone narrator with the bot trait", async () => {
		const bot = await narratorService.create({ kind: "bot", title: "Review Bot" });
		expect(isBotNarrator(bot.traits)).toBe(true);
		expect(bot.traits).toContain("standalone");
		expect(bot.title).toBe("Review Bot");
	});

	test("nothing in a bot waits for a person to approve or answer", async () => {
		const bot = await narratorService.create({
			kind: "bot",
			title: "Planner Bot",
			startInPlanMode: true,
		});
		expect(bot.planMode).toBe(false);
		expect(bot.traits).not.toContain("plan");
		const policy = await resolveNarratorRuntimePolicy(bot.id);
		expect(policy.capabilities.askUserQuestion).toBe("disabled");
		expect(policy.capabilities.planApproval).toBe(false);
	});

	test("a fork of a bot is an ordinary narrator", async () => {
		const bot = await narratorService.create({ kind: "bot", title: "Fork Me" });
		const fork = await narratorService.forkNarrator(bot.id, null, { inheritMode: "fresh" });
		expect(isBotNarrator(fork.traits)).toBe(false);
	});

	test("a bot needs a name", async () => {
		await expect(narratorService.create({ kind: "bot" })).rejects.toBeInstanceOf(ValidationError);
	});

	test("the bot protocol follows the persona in the system prompt", () => {
		const policy = resolveRuntimePolicy([]);
		const prompt = runtimeBasePrompt(
			{ systemPrompt: "PERSONA", traits: [BOT_TRAIT] },
			"en",
			policy,
		);
		expect(prompt?.startsWith("PERSONA")).toBe(true);
		expect(prompt).toContain("Send({ user:");
		expect(
			runtimeBasePrompt({ systemPrompt: "PERSONA", traits: [BOT_TRAIT] }, "zh-CN", policy),
		).toContain("Bot 模式");
		expect(runtimeBasePrompt({ systemPrompt: "PERSONA", traits: [] }, "en", policy)).toBe(
			"PERSONA",
		);
	});
});
