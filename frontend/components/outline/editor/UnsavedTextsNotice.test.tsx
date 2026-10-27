/**
 * The notices the person sees when typing did not reach a page or a page found no room (review
 * of round 4): texts the tab's limits pushed out are counted on their page; adding back that may
 * already be on the page says so and is offered only as "add again anyway"; while it is on its way
 * it cannot be clicked twice; a page refused for lack of room says when the hidden pages still
 * waiting for typing to be acknowledged let go.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) =>
			params ? `${key}${JSON.stringify(params)}` : key,
	}),
}));

const { UnsavedTextsNotice } = await import("./UnsavedTextsNotice");
const { TabLimitNotice } = await import("./TabLimitNotice");
const { clearUnsavedTextsForTests, keepUnsavedTexts, markUnsavedAdding, unsavedTextsOf } =
	await import("./unsaved-texts");
const { acquireLiveSession, releaseLiveSession, retainLiveSession } = await import(
	"./live-sessions"
);
type LiveClient = import("./live-client").LiveClient;
type LiveTransport = import("./live-client").LiveTransport;

const html = (node: ReactNode) => renderToStaticMarkup(<MantineProvider>{node}</MantineProvider>);

afterEach(() => clearUnsavedTextsForTests());

describe("the unsaved-text notice", () => {
	test("texts the limits pushed out are counted on their page, even with none left", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			keepUnsavedTexts([
				{ pageId: "pageA", blockId: "blockA1xx", text: "words on A", reason: "not_sent" },
			]);
			keepUnsavedTexts([
				{ pageId: "pageB", blockId: "blockB1xx", text: "x".repeat(300 * 1024), reason: "refused" },
			]);
		} finally {
			warn.mockRestore();
		}
		const a = html(<UnsavedTextsNotice pageId="pageA" />);
		expect(a).toContain('data-testid="outline-unsaved-dropped"');
		expect(a).toContain(
			"editor.unsavedDropped{&quot;count&quot;:1,&quot;entries&quot;:50,&quot;kb&quot;:256}",
		);
		expect(a).not.toContain("editor.unsavedTitle");
		expect(html(<UnsavedTextsNotice pageId="pageB" />)).not.toContain("outline-unsaved-dropped");
	});

	test("adding back that may be on the page already says so; one on its way cannot be clicked", () => {
		keepUnsavedTexts([
			{
				pageId: "pageA",
				blockId: "blockA1xx",
				text: "gone block's words",
				reason: "moved_away",
				restore: { parentId: "pageA", task: null },
			},
		]);
		const id = unsavedTextsOf("pageA")[0]?.id as string;
		const client = { pageId: "pageA", ready: true, editable: true } as unknown as LiveClient;
		const plain = html(<UnsavedTextsNotice pageId="pageA" client={client} />);
		expect(plain).toContain(">editor.restoreUnsaved<");
		expect(plain).not.toContain("outline-unsaved-maybe-added");
		markUnsavedAdding(id, "sending");
		const sending = html(<UnsavedTextsNotice pageId="pageA" client={client} />);
		expect(sending).toContain(">editor.unsavedAdding<");
		expect(sending).toMatch(
			/<button[^>]*disabled=""[^>]*data-testid="outline-unsaved-restore"|<button[^>]*data-testid="outline-unsaved-restore"[^>]*disabled=""/,
		);
		markUnsavedAdding(id, "unknown");
		const unknown = html(<UnsavedTextsNotice pageId="pageA" client={client} />);
		expect(unknown).toContain('data-testid="outline-unsaved-maybe-added"');
		expect(unknown).toContain("editor.unsavedMaybeAdded");
		expect(unknown).toContain(">editor.restoreUnsavedAgain<");
		expect(unknown).not.toContain(">editor.restoreUnsaved<");
	});
});

describe("the tab-limit notice", () => {
	/** A socket that is down: sessions wait offline. */
	function offline(): LiveTransport {
		const handles = new Set<number>();
		return {
			connected: false,
			send: () => false,
			onFrame: () => () => {},
			onConnectionChange: () => () => {},
			allocateHandle() {
				for (let h = 1; h < 256; h++) {
					if (!handles.has(h)) {
						handles.add(h);
						return h;
					}
				}
				return null;
			},
			releaseHandle: (h: number) => {
				handles.delete(h);
			},
		};
	}

	test("says how many hidden pages wait for typing to be acknowledged, and how long at most", () => {
		const transport = offline();
		expect(html(<TabLimitNotice transport={transport} onRetry={() => {}} />)).not.toContain(
			"outline-tab-limit-waiting",
		);
		const shared = acquireLiveSession(transport, "page-0000001", "edit");
		if (!shared) throw new Error("no session");
		retainLiveSession(shared);
		shared.client.seed([
			{ id: "page-0000001", parentId: null, sid: "p1", content: "Page", task: null, childIds: [] },
		]);
		shared.client.commit({
			ops: [],
			bodies: [{ id: "page-0000001", md: "Page typed" }],
			kind: "typing",
			blockId: "page-0000001",
			selBefore: null,
			selAfter: null,
			view: null,
		});
		releaseLiveSession(shared);
		const shown = html(<TabLimitNotice transport={transport} onRetry={() => {}} />);
		expect(shown).toContain("editor.tabLimit{&quot;count&quot;:8}");
		expect(shown).toContain('data-testid="outline-tab-limit-waiting"');
		expect(shown).toMatch(
			/editor\.tabLimitWaiting\{&quot;count&quot;:1,&quot;seconds&quot;:(119|120)\}/,
		);
	});
});
