/**
 * Point-A passive knowledge injection for SUBAGENTS.
 *
 * The gap this covers: point B (tool output) always ran for subagents through `loop.ts`,
 * while point A (the incoming text) was primary-only. A subagent that is typed at on its
 * own page, or `Send`-messaged by its parent or a sibling, receives text nobody has
 * scanned.
 *
 * These are SECURITY tests first. The injected hint carries entry titles and body
 * excerpts, so resolving it under the wrong identity is a disclosure, not a UX bug. The
 * three properties pinned here:
 *
 *   1. an authorized acting user receives the classified entry;
 *   2. an UNAUTHORIZED user does not — dual-axis ACL still applies through this path;
 *   3. NO acting user injects nothing at all, rather than degrading to the anonymous
 *      public baseline.
 *
 * Plus the decision this path had to make: an agent-to-agent message IS scanned, under
 * the acting human's permissions and never the sending agent's.
 *
 * Runs against a real isolated DB under a temp NARRAFORK_HOME (ACL + grant aggregation +
 * the keyword matcher all exercised for real). No `mock.module`: the seams used here are
 * ordinary arguments, and Bun's module mocks are process-wide.
 */
import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { knowledgeGrantRows } from "../../../tests/fixtures/knowledge-grants";
import { db } from "../../db";
import { aclGrants, knowledgeTags, narrators, users } from "../../db/schema";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import { knowledgeService } from "../knowledge-service";
import type { ExecuteLoopOptions } from "../narrator-executor";
import * as narratorExecutor from "../narrator-executor";
import { narratorService } from "../narrator-service";
import { activeNarrators } from "../narrator-session-state";
import {
	clearSubagentBufferedMessages,
	consumeNextBufferedSubagentMessage,
	executeSubagent,
	pushSubagentBufferedMessage,
} from "../subagent-executor";
import {
	getSubagentKnowledgeCycle,
	resolveInjectionUserId,
	scanSubagentTextForKnowledge,
} from "../subagent-knowledge-injection";

const TAG = Date.now();

/** Keyword on a CLASSIFIED entry: only a cleared + compartmented user may see it. */
const SECRET_KW = `subsecretkw${TAG}`;
/** Keyword on an unclassified entry: any resolvable user may see it. */
const PUBLIC_KW = `subpublickw${TAG}`;

let collectionId: string;
let clearedUserId: string; // confidential clearance + the compartment tag
let unclearedUserId: string; // no grants at all
let compartmentTagId: string;
let secretEntryId: string;
let publicEntryId: string;

/** A subagent narrator id + its parent, both real rows so service lookups succeed. */
let subagentId: string;
let parentNarratorId: string;

function nowIso(): string {
	return new Date().toISOString();
}

async function makeUser(label: string): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `${label}-${TAG}-${generateId(4)}`,
		passwordHash: "x",
		role: "user",
		createdAt: nowIso(),
	});
	return id;
}

async function makeNarrator(): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({ id, createdAt: nowIso(), updatedAt: nowIso() });
	return id;
}

beforeAll(async () => {
	clearedUserId = await makeUser("sub-cleared");
	unclearedUserId = await makeUser("sub-uncleared");
	subagentId = await makeNarrator();
	parentNarratorId = await makeNarrator();

	compartmentTagId = generateId();
	await db.insert(knowledgeTags).values({
		id: compartmentTagId,
		name: `sub-compartment-${TAG}`,
		controlled: true,
		createdAt: nowIso(),
	});

	// The cleared user gets BOTH axes: clearance rank and the compartment tag. Granting
	// only one would make an "unauthorized" assertion pass for the wrong reason.
	for (const seed of [
		{
			principalType: "user" as const,
			principalId: clearedUserId,
			grantType: "clearance" as const,
			clearanceLevel: "confidential",
		},
		{
			principalType: "user" as const,
			principalId: clearedUserId,
			grantType: "tag" as const,
			tagId: compartmentTagId,
		},
	]) {
		for (const row of knowledgeGrantRows(seed)) {
			await db.insert(aclGrants).values(row as never);
		}
	}

	const col = await knowledgeService.createCollection({ name: `sub-inject-${TAG}` });
	collectionId = col.id;

	const secret = await knowledgeService.createEntry({
		collectionId,
		title: `Classified charging procedure ${TAG}`,
		content: "the confidential procedure body",
		keywords: [SECRET_KW],
	});
	secretEntryId = secret.id;
	await knowledgeService.updateEntryAcl(secretEntryId, {
		classificationLevel: "confidential",
		controlledTags: [compartmentTagId],
		// No owner: the owner short-circuit would bypass the dual-axis check being tested.
		ownerUserId: null,
	});

	const open = await knowledgeService.createEntry({
		collectionId,
		title: `Open runbook ${TAG}`,
		content: "the unclassified runbook body",
		keywords: [PUBLIC_KW],
	});
	publicEntryId = open.id;
});

/** Run one scan with a fresh cycle, so de-dup never hides a result under test. */
async function scan(opts: {
	text: string;
	turnUserId: string | null | undefined;
	source?: "buffered_message" | "team_message";
	parentId?: string;
}) {
	return scanSubagentTextForKnowledge({
		narratorId: subagentId,
		parentNarratorId: opts.parentId ?? parentNarratorId,
		text: opts.text,
		source: opts.source ?? "buffered_message",
		turnUserId: opts.turnUserId,
		projectId: null,
		cycle: { seq: Number.NaN, ids: new Set<string>() },
		locale: "en",
	});
}

describe("ACL: who may receive an injected entry", () => {
	test("an authorized acting user receives the classified entry", async () => {
		const result = await scan({
			text: `please look into ${SECRET_KW} on this machine`,
			turnUserId: clearedUserId,
		});
		expect(result).not.toBeNull();
		expect(result?.record.hits.map((h) => h.entryId)).toContain(secretEntryId);
		// The hint text is what actually reaches the model.
		expect(result?.content).toContain(secretEntryId);
	});

	test("an UNAUTHORIZED user does not receive it — not the title, not the excerpt", async () => {
		// The regression this guards: a subagent path that scanned without ACL, or that
		// resolved caps from the narrator instead of the user, would leak a confidential
		// entry to any session that happened to mention its keyword.
		const result = await scan({
			text: `please look into ${SECRET_KW} on this machine`,
			turnUserId: unclearedUserId,
		});
		expect(result).toBeNull();
	});

	test("the uncleared user still receives an UNCLASSIFIED entry (denial is targeted)", async () => {
		// Without this, the test above would also pass if injection were simply broken for
		// that user, which would prove nothing about the ACL.
		const result = await scan({
			text: `check the ${PUBLIC_KW} steps`,
			turnUserId: unclearedUserId,
		});
		expect(result?.record.hits.map((h) => h.entryId)).toContain(publicEntryId);
	});

	test("missing ONE axis is still a denial (clearance without the compartment)", async () => {
		const halfUserId = await makeUser("sub-half");
		for (const row of knowledgeGrantRows({
			principalType: "user",
			principalId: halfUserId,
			grantType: "clearance",
			clearanceLevel: "confidential",
		})) {
			await db.insert(aclGrants).values(row as never);
		}
		// Clearance is sufficient, the compartment tag is not held → denied.
		expect(await scan({ text: `about ${SECRET_KW}`, turnUserId: halfUserId })).toBeNull();
		// And the same user does get the unclassified entry, so the denial is about the axis.
		const open = await scan({ text: `about ${PUBLIC_KW}`, turnUserId: halfUserId });
		expect(open?.record.hits.map((h) => h.entryId)).toContain(publicEntryId);
	});
});

describe("ACL: no acting user means no injection", () => {
	test("an unresolvable acting user injects NOTHING, not the public baseline", async () => {
		// `resolveCapsByUserId(null)` is a legitimate anonymous read that returns public
		// entries, so passing null through would publish knowledge into a session nobody is
		// accountable for. The recovery/detached paths are exactly where this happens.
		const orphanParentId = await makeNarrator(); // no activeNarrators entry → no fallback
		expect(
			await scan({
				text: `check the ${PUBLIC_KW} steps`,
				turnUserId: null,
				parentId: orphanParentId,
			}),
		).toBeNull();
		expect(
			await scan({
				text: `check the ${PUBLIC_KW} steps`,
				turnUserId: undefined,
				parentId: orphanParentId,
			}),
		).toBeNull();
	});

	test("a STALE user id degrades to public-only and can never reach a classified entry", async () => {
		// Deliberately NOT the same rule as an absent id. "No userId at all" means nobody is
		// accountable, so nothing is injected (above). A userId that no longer resolves to a
		// row is a different situation — a deleted account, a stale detached run — and
		// `resolveCapsByUserId` answers it platform-wide with the anonymous baseline. The
		// primary loop's point A behaves identically, and diverging here would put a second,
		// conflicting answer to one question in the codebase.
		//
		// What has to hold is the security property, and it does: the anonymous baseline
		// carries rank 0 and no compartment tags, so a stale id cannot escalate. It sees
		// exactly what a logged-out reader may see.
		const classified = await scan({ text: `about ${SECRET_KW}`, turnUserId: "no-such-user" });
		expect(classified).toBeNull();

		const open = await scan({ text: `check the ${PUBLIC_KW} steps`, turnUserId: "no-such-user" });
		expect(open?.record.hits.map((h) => h.entryId)).toEqual([publicEntryId]);
	});
});

describe("acting-user resolution reuses the existing subagent decision", () => {
	test("the turn's own user wins over the parent session's", () => {
		activeNarrators.set(parentNarratorId, { _currentUserId: "parent-user" } as never);
		try {
			expect(resolveInjectionUserId("turn-user", parentNarratorId)).toBe("turn-user");
		} finally {
			activeNarrators.delete(parentNarratorId);
		}
	});

	test("only an omitted legacy user falls back; explicit null stays anonymous", () => {
		// This is the case that matters for a `Send` from the parent and for recovery
		// restarts: the message carries no `createdBy`, but the chain still has a human.
		activeNarrators.set(parentNarratorId, { _currentUserId: clearedUserId } as never);
		try {
			expect(resolveInjectionUserId(null, parentNarratorId)).toBeNull();
			expect(resolveInjectionUserId(undefined, parentNarratorId)).toBe(clearedUserId);
		} finally {
			activeNarrators.delete(parentNarratorId);
		}
	});

	test("neither present resolves to null, which callers must treat as no injection", () => {
		expect(resolveInjectionUserId(null, "not-an-active-narrator")).toBeNull();
	});
});

describe("agent-to-agent messages are scanned under the acting human's permissions", () => {
	test("a sibling's message resolves through the parent session's user, not the sender", async () => {
		// The decision: a team message carries no user of its own, so it resolves as the
		// chain's acting human. The sender being an agent grants nothing — and cannot,
		// because that human's own dual-axis caps still bound the result.
		activeNarrators.set(parentNarratorId, { _currentUserId: clearedUserId } as never);
		try {
			const result = await scan({
				text: `sibling reports a ${SECRET_KW} anomaly`,
				turnUserId: undefined,
				source: "team_message",
			});
			expect(result?.record.hits.map((h) => h.entryId)).toContain(secretEntryId);
		} finally {
			activeNarrators.delete(parentNarratorId);
		}
	});

	test("an explicitly anonymous run cannot inherit the parent's classified access", async () => {
		activeNarrators.set(parentNarratorId, { _currentUserId: clearedUserId } as never);
		try {
			expect(
				await scan({ text: `about ${SECRET_KW}`, turnUserId: null, source: "team_message" }),
			).toBeNull();
		} finally {
			activeNarrators.delete(parentNarratorId);
		}
	});

	test("a sibling's message CANNOT relay an entry the acting human may not read", async () => {
		// The escalation this forbids: an agent that itself learned about a classified entry
		// must not be able to surface it into a session whose human lacks clearance.
		activeNarrators.set(parentNarratorId, { _currentUserId: unclearedUserId } as never);
		try {
			const result = await scan({
				text: `sibling reports a ${SECRET_KW} anomaly`,
				turnUserId: undefined,
				source: "team_message",
			});
			expect(result).toBeNull();
		} finally {
			activeNarrators.delete(parentNarratorId);
		}
	});

	test("the heading distinguishes an incoming message from a tool-output hint", async () => {
		const result = await scan({
			text: `sibling mentions ${PUBLIC_KW}`,
			turnUserId: clearedUserId,
			source: "team_message",
		});
		expect(result?.content).toContain("incoming message");
		// Point B's wording must not be reused: the reader would be told a tool produced it.
		expect(result?.content).not.toContain("latest tool output");
	});
});

describe("compact-cycle de-dup", () => {
	test("an entry already in the cycle set is not injected again", async () => {
		const cycle = { seq: -1, ids: new Set<string>() };
		const first = await scanSubagentTextForKnowledge({
			narratorId: subagentId,
			parentNarratorId,
			text: `first mention of ${PUBLIC_KW}`,
			source: "buffered_message",
			turnUserId: clearedUserId,
			projectId: null,
			cycle,
			locale: "en",
		});
		expect(first?.record.hits.map((h) => h.entryId)).toContain(publicEntryId);
		// The scan records its own hits, so a second message in the same cycle is quiet.
		expect(cycle.ids.has(publicEntryId)).toBe(true);

		const second = await scanSubagentTextForKnowledge({
			narratorId: subagentId,
			parentNarratorId,
			text: `second mention of ${PUBLIC_KW}`,
			source: "buffered_message",
			turnUserId: clearedUserId,
			projectId: null,
			cycle,
			locale: "en",
		});
		expect(second).toBeNull();
	});

	test("the cycle is keyed by narrator, so a continuation reuses the same set", () => {
		// A per-invocation set is the bug this prevents: `resumeSubagent` re-enters
		// `executeSubagent`, and a fresh set there would re-inject everything.
		const a = getSubagentKnowledgeCycle(subagentId);
		a.ids.add("sentinel-entry");
		expect(getSubagentKnowledgeCycle(subagentId).ids.has("sentinel-entry")).toBe(true);
		expect(getSubagentKnowledgeCycle(parentNarratorId).ids.has("sentinel-entry")).toBe(false);
	});
});

describe("nothing to say produces no row", () => {
	test("empty text and keyword-free text both return null", async () => {
		expect(await scan({ text: "   ", turnUserId: clearedUserId })).toBeNull();
		expect(
			await scan({ text: "a message mentioning nothing indexed", turnUserId: clearedUserId }),
		).toBeNull();
	});
});

describe("buffered knowledge hint reaches the resumed executor input", () => {
	async function resumeBufferedMessage(
		officialApi: boolean,
		keyword: string,
		authorized: boolean,
		drainInExecutor = false,
	) {
		const prefix = "buffered_knowledge";
		const model = `${prefix}:claude-sonnet-4`;
		settings.anthropicProviders = [
			{
				id: generateId(),
				name: "Buffered knowledge regression",
				prefix,
				apiKey: "test-only",
				baseUrl: "https://example.invalid/v1",
				defaultModel: "claude-sonnet-4",
				officialApi,
			},
		];
		const narratorId = generateId();
		const toolUseId = generateId();
		await db.insert(narrators).values({
			id: narratorId,
			type: "subagent",
			variant: "subagent:general",
			parentNarratorId,
			traits: ["standalone"],
			model,
			autoContinuationOverride: "off",
			createdAt: nowIso(),
			updatedAt: nowIso(),
		});
		const text = `BUFFERED_REQUEST_MARKER inspect ${keyword}`;
		const userId = authorized ? clearedUserId : unclearedUserId;
		await pushSubagentBufferedMessage(narratorId, text, { createdBy: userId });
		const requests: Pick<ExecuteLoopOptions, "userText" | "history" | "trailingToolResults">[] = [];
		const executor = spyOn(narratorExecutor, "executeAgentLoop").mockImplementation(
			async (input) => {
				requests.push({
					userText: input.userText,
					history: structuredClone(input.history),
					trailingToolResults: structuredClone(input.trailingToolResults),
				});
				return { finalText: "done", hasError: false, shouldUpdateTitle: false };
			},
		);
		try {
			expect(process.env.NARRAFORK_TEST).toBe("1");
			// This is the real drain used by the executor AND runner restart/takeover paths.
			// It scans with real ACL, persists a sys row, and rebuilds real provider history.
			const consumed = drainInExecutor
				? { prompt: "initial dispatch", history: [], trailingToolResults: [], userId: null }
				: await consumeNextBufferedSubagentMessage({
						narratorId,
						parentNarratorId,
						toolUseId,
						model,
						provider: prefix,
						cwd: process.env.HOME as string,
						locale: "en",
					});
			if (!consumed) throw new Error("expected the queued message to be consumed");
			await executeSubagent({
				narratorId,
				parentNarratorId,
				toolUseId,
				subagentType: "general",
				prompt: consumed.prompt,
				initialHistory: consumed.history,
				initialTrailingToolResults: consumed.trailingToolResults,
				userId: consumed.userId,
				cwd: process.env.HOME as string,
				model,
				provider: prefix,
				locale: "en",
				signal: new AbortController().signal,
				systemPrompt: "Test subagent",
			});
			expect(requests).toHaveLength(drainInExecutor ? 2 : 1);
			const request = requests[requests.length - 1];
			const rows = await narratorService.getModelHistorySinceLastCompact(narratorId);
			expect(rows.find((row) => row.role === "user")?.contentText).toBe(text);
			const hint = rows.find((row) => row.role === "sys");
			if (authorized) {
				expect(hint?.contentText).toContain(secretEntryId);
				expect(hint?.parentToolUseId).toBe(toolUseId);
				if (officialApi) {
					expect(request.userText).toBe(text);
					expect(request.history).toContainEqual({ role: "system", content: hint?.contentText });
				} else {
					expect(request.userText).toBe(`${hint?.contentText}\n\n${text}`);
					expect(JSON.stringify(request.history)).not.toContain(secretEntryId);
					expect(JSON.stringify(request).match(/BUFFERED_REQUEST_MARKER/g)).toHaveLength(1);
				}
				expect(JSON.stringify(request).match(/Relevant knowledge-base entries/g)).toHaveLength(1);
			} else {
				// A denied/no-hit scan must not invent current-turn text or replay old input.
				expect(hint).toBeUndefined();
				expect(request.userText).toBe(text);
				expect(JSON.stringify(request)).not.toContain(secretEntryId);
			}
		} finally {
			executor.mockRestore();
			clearSubagentBufferedMessages(narratorId);
		}
	}

	test("compatible Anthropic carries the new sys hint and buffered message into the current turn", () =>
		resumeBufferedMessage(false, SECRET_KW, true));

	test("the executor's own pass-restart drain also carries the extracted hint", () =>
		resumeBufferedMessage(false, SECRET_KW, true, true));

	test("official Anthropic keeps the hint as system history without injecting it twice", () =>
		resumeBufferedMessage(true, SECRET_KW, true));

	test("ACL denial leaves only the buffered user's message", () =>
		resumeBufferedMessage(false, SECRET_KW, false));

	test("a keyword-free message is preserved without a synthetic hint", () =>
		resumeBufferedMessage(false, "no-matching-entry", false));
});
