/**
 * Story-network events must reach every connected client over WS.
 *
 * These nine events (`chapter:created`, `chapter:forked`, `chapter:merged`, …) were
 * being emitted on the bus and consumed by `useChapters`, but nothing bridged the
 * `chapter:`/`dependency:`/`exploration:`/`review:` prefixes to the socket, so the
 * graph only redrew on its 60 s fallback poll. Asserted at the broadcast boundary
 * because that gap is invisible from either side alone: the emitter looked correct
 * and the subscriber looked correct.
 *
 * Also pins the exclusions, which is the half of a prefix-matched bridge that no
 * other test can see. `chapter:files_changed` and `chapter:external_change_recorded`
 * fire on the worktree watcher's tick and carry a host `worktreePath`;
 * `chapter:conflict` carries one merge's conflicting paths. Folding any of them into
 * the bridge means steady background traffic or handing every open session data
 * scoped to one project — and `broadcastToAll` filters by nothing, so neither shows
 * up as a failure anywhere else.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { eventBus } = await import("../../lib/event-bus");
const { getNarratorConnections, handleNarratorWS } = await import("../narrator-ws");

type SentMessage = Record<string, unknown>;
type FakeNarratorWS = Parameters<typeof handleNarratorWS.open>[0];

const openedConnections: FakeNarratorWS[] = [];

/**
 * A connection with NO narrator subscriptions: graph topology is project-global, so
 * a client watching the story network must receive these frames without having
 * subscribed to any particular narrator.
 */
function openFakeWs() {
	const sent: SentMessage[] = [];
	const ws = {
		data: {
			channel: "narrator" as const,
			connectedAt: Date.now(),
			lastPongAt: Date.now(),
			subscribedNarrators: new Set<string>(),
			catchingUpNarrators: new Map(),
			catchUpBuffers: new Map(),
		},
		send(payload: string) {
			sent.push(JSON.parse(payload) as SentMessage);
		},
	} as unknown as FakeNarratorWS;
	handleNarratorWS.open(ws);
	openedConnections.push(ws);
	return { ws, sent };
}

let client: ReturnType<typeof openFakeWs>;

beforeEach(() => {
	client = openFakeWs();
});

afterEach(() => {
	for (const ws of openedConnections.splice(0)) handleNarratorWS.close(ws);
	getNarratorConnections().clear();
	cleanDb(sqlite);
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	sqlite.close();
});

describe("story-network graph event WS bridge", () => {
	it("forwards the chapter lifecycle events the graph subscribes to", () => {
		// Exactly the `chapter:`-prefixed members of CHAPTER_GRAPH_REFRESH_EVENTS in
		// frontend/hooks/useChapters.ts — the contract this bridge exists to satisfy.
		eventBus.emit({ type: "chapter:created", chapterId: "chapter-1", projectId: "project-1" });
		eventBus.emit({
			type: "chapter:forked",
			chapterId: "chapter-2",
			parentId: "chapter-1",
			projectId: "project-1",
		});
		eventBus.emit({ type: "chapter:merged", sourceId: "chapter-2", targetId: "chapter-1" });
		eventBus.emit({ type: "chapter:dormant", chapterId: "chapter-1" });
		eventBus.emit({ type: "chapter:woken", chapterId: "chapter-1" });
		eventBus.emit({ type: "chapter:abandoned", chapterId: "chapter-2", projectId: "project-1" });

		expect(client.sent.map((m) => m.type)).toEqual([
			"chapter:created",
			"chapter:forked",
			"chapter:merged",
			"chapter:dormant",
			"chapter:woken",
			"chapter:abandoned",
		]);
	});

	it("preserves the projectId the client uses to scope graph invalidation", () => {
		// `shouldRefreshProjectGraphForEvent` compares `event.projectId` against the
		// open project; dropping the field would make one project's fork redraw all of
		// them (it treats a missing projectId as "may concern me").
		eventBus.emit({ type: "chapter:created", chapterId: "chapter-1", projectId: "project-1" });

		expect(client.sent).toEqual([
			{ type: "chapter:created", chapterId: "chapter-1", projectId: "project-1" },
		]);
	});

	it("forwards dependency, review, and exploration events", () => {
		eventBus.emit({
			type: "dependency:created",
			edgeId: "edge-1",
			sourceId: "chapter-1",
			targetId: "chapter-2",
		});
		eventBus.emit({
			type: "dependency:removed",
			edgeId: "edge-1",
			sourceId: "chapter-1",
			targetId: "chapter-2",
		});
		eventBus.emit({
			type: "review:created",
			reviewChapterId: "review-1",
			sourceChapterId: "chapter-1",
		});
		eventBus.emit({
			type: "review:concluded",
			reviewChapterId: "review-1",
			sourceChapterId: "chapter-1",
		});
		eventBus.emit({ type: "exploration:created", groupId: "group-1", chapterIds: ["chapter-1"] });

		expect(client.sent.map((m) => m.type)).toEqual([
			"dependency:created",
			"dependency:removed",
			"review:created",
			"review:concluded",
			"exploration:created",
		]);
	});

	it("reaches every connection, since the graph is not narrator-scoped", () => {
		const second = openFakeWs();
		eventBus.emit({ type: "chapter:dormant", chapterId: "chapter-1" });

		expect(client.sent).toHaveLength(1);
		expect(second.sent).toHaveLength(1);
	});

	it("does not broadcast one merge's conflicting filenames to every session", () => {
		// `chapter:conflict` matches the `chapter:` prefix but is not graph topology: the
		// outcome arrives as `chapter:merged`, no client subscribes to it, and the merge UI
		// learns about conflicts from its own HTTP response and the narrator-scoped
		// `merge:conflict` events. `broadcastToAll` is not scoped by project or user, so
		// forwarding it would hand every open session the paths of a merge it has nothing
		// to do with.
		eventBus.emit({
			type: "chapter:conflict",
			sourceId: "chapter-2",
			targetId: "chapter-1",
			files: ["src/secret-feature.ts", "config/prod.yml"],
		});

		expect(client.sent).toEqual([]);
	});

	it("does not broadcast worktree file activity or host paths", () => {
		eventBus.emit({
			type: "chapter:files_changed",
			chapterId: "chapter-1",
			worktreePath: "/home/someone/project/.worktrees/chapter-1",
		});
		eventBus.emit({
			type: "chapter:external_change_recorded",
			chapterId: "chapter-1",
			worktreePath: "/home/someone/project/.worktrees/chapter-1",
			treeHash: "abc123",
			narratorId: "narrator-1",
		});

		expect(client.sent).toEqual([]);
	});

	it("still forwards commit count changes, which do alter the rendered node", () => {
		eventBus.emit({ type: "chapter:commits_updated", chapterId: "chapter-1", newCount: 3 });

		expect(client.sent).toEqual([
			{ type: "chapter:commits_updated", chapterId: "chapter-1", newCount: 3 },
		]);
	});

	it("leaves unrelated event families alone", () => {
		eventBus.emit({ type: "device:changed", deviceId: "device-1" });
		eventBus.emit({ type: "mcp:server_error", serverId: "s-1", name: "s", error: "boom" });

		expect(client.sent).toEqual([]);
	});
});
