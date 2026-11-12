/**
 * The outline surface as a self-contained component: what it shows comes from props, links go
 * through the host's renderer (or plain anchors), and nothing under `components/outline/` reaches
 * for the router or listens on the whole document (dock panels host it beside a composer).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MantineProvider } from "@mantine/core";
import type {
	OutlineBlockViewResponse,
	OutlineQuestionGroupResponse,
	OutlineViewBlock,
} from "@shared/outline-api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NarratorPanelVisibilityProvider } from "../narrator/narrator-panel-visibility";

mock.module("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
mock.module("../narrator/markdown/MarkdownContent", () => ({
	MarkdownContent: ({ text }: { text: string }) => <div data-markdown="">{text}</div>,
}));
mock.module("./editor/OutlineEditor", () => ({
	seedLiveSession: () => {},
	OutlineEditor: (props: { pageId: string; focusId: string; lens: string; canWrite: boolean }) => (
		<div
			data-editor={props.pageId}
			data-focus={props.focusId}
			data-lens={props.lens}
			data-write={String(props.canWrite)}
		/>
	),
}));

let shown: OutlineBlockViewResponse | undefined;
let questions: OutlineQuestionGroupResponse | undefined;
const questionReads: Array<string | null> = [];
const reads: unknown[] = [];
beforeEach(() => {
	questions = undefined;
	questionReads.length = 0;
});
const idle = { data: undefined, isLoading: false, isError: false, isSuccess: true };
mock.module("../../hooks/useOutline", () => ({
	useOutlineEnabled: () => ({ enabled: true, loading: false }),
	useOutlineBlock: (...args: unknown[]) => {
		reads.push(args);
		return { data: shown, isLoading: false, error: null };
	},
	useOutlinePageLive: () => {},
	// The breadcrumbs' project crumb (a session space's parent).
	useOutlineSpace: () => idle,
	useOutlineViewStateSync: () => {},
	useOutlineSearch: () => idle,
	useOutlineSeed: () => idle,
	prefetchOutlineSeed: () => {},
	useOutlineBacklinks: () => idle,
	useOutlineBlockHistory: () => ({ ...idle, hasNextPage: false }),
	useOutlineTimeline: () => ({ ...idle, hasNextPage: false }),
	useRevertOutlineCommit: () => ({ mutate: () => {}, isPending: false }),
	useOutlinePagePending: () => idle,
	useOutlineReportAuthors: () => idle,
	useOutlinePendingDetail: () => idle,
	useDecideOutlinePending: () => ({ mutate: () => {}, isPending: false }),
	useOutlineLock: () => ({ mutate: () => {}, isPending: false }),
	// The main content uses the same questions form as the inbox.
	invalidateOutlineSpace: () => {},
	useOutlineQuestions: (id: string | null) => {
		questionReads.push(id);
		return { ...idle, data: id ? questions : undefined };
	},
	useOutlineQuestionGroups: (ids: readonly string[]) =>
		ids.map(() => ({ ...idle, data: questions })),
	useOutlineQuestionsLive: () => {},
	useAnswerOutlineQuestions: () => ({ mutate: () => {}, isPending: false }),
	useOutlineDigest: () => idle,
	useMarkOutlineDigestSeen: () => ({ mutate: () => {}, isPending: false }),
	useMarkOutlineReportsSeen: () => ({ mutate: () => {}, isPending: false }),
}));

const { OutlineSurface } = await import("./OutlineSurface");

function block(id: string, childIds: string[] = [], extra: Partial<OutlineViewBlock> = {}) {
	return {
		id,
		sid: `s-${id}`,
		parentId: null,
		content: `Block ${id}`,
		task: null,
		alias: null,
		tags: [],
		childIds,
		hidden: 0,
		processHidden: 0,
		openTasks: 0,
		inProgress: [],
		lock: null,
		pending: [],
		...extra,
	} satisfies OutlineViewBlock;
}

function pageView(extra: Partial<OutlineBlockViewResponse> = {}): OutlineBlockViewResponse {
	return {
		space: {
			id: "space",
			key: "K",
			kind: "project",
			projectId: "p",
			narratorId: null,
			label: "P",
			mine: false,
			orphaned: false,
			lastSeq: 3,
			canWrite: true,
		},
		pageId: "page",
		rootId: "a",
		seq: 3,
		current: true,
		view: "facts",
		path: [{ id: "page", sid: "s-page", title: "The page" }],
		blocks: [block("a", ["b"]), block("b")],
		hiddenByBudget: 0,
		hiddenByView: 0,
		pageTruncated: false,
		pageBlocks: 3,
		...extra,
	};
}

function questionGroup(rootId = "a", isQuestion = true): OutlineQuestionGroupResponse {
	return {
		group: {
			blockId: rootId,
			spaceId: "space",
			spaceKey: "K",
			pageId: "page",
			title: `Block ${rootId}`,
			isQuestion,
		},
		questions: [
			{
				blockId: "a",
				spaceId: "space",
				sid: "s-a",
				address: "K/s-a",
				parentId: "task",
				alias: null,
				text: "Which format should we export?",
				options: ["CSV", "JSON"],
				recommend: { option: 2, text: null, reason: null },
				proceed: false,
				state: "open",
				to: { userId: "alice", name: "Alice" },
				answer: null,
				askedBy: { narratorId: "agent", title: "Worker", hidden: false },
				createdAt: "2026-11-03T00:00:00.000Z",
				canAnswer: true,
				versionSeq: 3,
			},
		],
		truncated: false,
	};
}

function questionView(): OutlineBlockViewResponse {
	return pageView({
		blocks: [
			block("a", [], {
				content: "Which format should we export?",
				question: { state: "open", proceed: false },
			}),
		],
	});
}

function render(node: ReactNode): string {
	return renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<MantineProvider>{node}</MantineProvider>
		</QueryClientProvider>,
	);
}

describe("OutlineSurface", () => {
	test("the current page is the live editor, focused on the surface's block", () => {
		shown = pageView();
		const html = render(
			<OutlineSurface spaceId="space" blockId="a" onNavigate={() => {}} layout="panel" />,
		);
		expect(html).toContain('data-editor="page"');
		expect(html).toContain('data-focus="a"');
		expect(html).toContain('data-lens="facts"');
		expect(html).toContain('data-layout="panel"');
		// No link renderer: breadcrumbs are plain anchors that navigate through `onNavigate`.
		expect(html).toContain('href="#outline/space/page"');
		expect(html).toContain("The page");
	});

	test("as of a commit it is the read-only tree, linking through the host's renderer", () => {
		shown = pageView({ current: false, seq: 2 });
		const targets: string[] = [];
		const html = render(
			<OutlineSurface
				spaceId="space"
				blockId="a"
				view="all"
				asOf={2}
				onNavigate={() => {}}
				renderLink={({ to, children, ...rest }) => {
					targets.push(JSON.stringify(to));
					return (
						<a {...rest} href={`/x/${to.kind}`}>
							{children}
						</a>
					);
				}}
			/>,
		);
		expect(html).not.toContain("data-editor");
		expect(html).toContain("Block b");
		expect(html).toContain("page.asOfBanner");
		expect(targets).toContain(JSON.stringify({ kind: "home" }));
		expect(targets).toContain(
			JSON.stringify({ kind: "block", spaceId: "space", blockId: "page", view: "all", asOf: 2 }),
		);
		expect(targets).toContain(
			JSON.stringify({ kind: "block", spaceId: "space", blockId: "b", view: "all", asOf: 2 }),
		);
		expect(reads.at(-1)).toEqual(["space", "a", { asOf: 2, view: "all" }]);
	});

	test.each([
		false,
		true,
	])("questions are answerable beside the live editor (compact=%s)", (compact) => {
		shown = questionView();
		questions = questionGroup();
		const html = render(
			<OutlineSurface spaceId="space" blockId="a" onNavigate={() => {}} compact={compact} />,
		);
		const doc = parseHTML(html).document;
		expect(html).toContain('data-editor="page"');
		const section = doc.querySelector('[data-testid="outline-questions-section"]');
		expect(section).not.toBeNull();
		// The editor and the form share the main content, not the side panel or its drawer.
		expect(section?.parentElement).toBe(doc.querySelector("[data-editor]")?.parentElement);
		expect(doc.querySelectorAll('[data-testid="outline-questions-section"]')).toHaveLength(1);
		expect(section?.querySelectorAll('input[type="radio"]')).toHaveLength(2);
		expect(section?.querySelector("textarea")).not.toBeNull();
		// The focused question already has its title in the editor / breadcrumb.
		expect(section?.textContent).not.toContain("Which format should we export?");
	});

	test("a parent task exposes its questions even when its one-block editor read omits children", () => {
		shown = pageView({
			rootId: "task",
			blocks: [block("task", [], { openTasks: 1 })],
		});
		questions = questionGroup("task", false);
		const html = render(
			<OutlineSurface spaceId="space" blockId="task" onNavigate={() => {}} compact />,
		);
		const section = parseHTML(html).document.querySelector(
			'[data-testid="outline-questions-section"]',
		);
		expect(section?.textContent).toContain("Which format should we export?");
		expect(section?.querySelector("textarea")).not.toBeNull();
		expect(questionReads).toContain("task");
	});

	test("the static fallback has the same form without repeating the question title", () => {
		shown = questionView();
		questions = questionGroup();
		const html = render(
			<NarratorPanelVisibilityProvider value={false}>
				<OutlineSurface spaceId="space" blockId="a" onNavigate={() => {}} compact />
			</NarratorPanelVisibilityProvider>,
		);
		const doc = parseHTML(html).document;
		expect(doc.querySelector("[data-editor]")).toBeNull();
		const title = doc.querySelector("h3");
		expect(title?.textContent).toBe("Which format should we export?");
		const section = doc.querySelector('[data-testid="outline-questions-section"]');
		expect(section?.parentElement).toBe(title?.parentElement?.parentElement);
		expect(section?.textContent).not.toContain("Which format should we export?");
		expect(section?.querySelector("textarea")).not.toBeNull();
	});

	test.each([
		false,
		true,
	])("history never fetches or renders the current answer form (current=%s)", (current) => {
		shown = { ...questionView(), current };
		questions = questionGroup();
		const html = render(
			<OutlineSurface spaceId="space" blockId="a" asOf={2} onNavigate={() => {}} />,
		);
		expect(html).not.toContain('data-testid="outline-questions-section"');
		expect(questionReads).toEqual([]);
	});

	test("a retained read for the previous focus never offers its answer form", () => {
		shown = questionView();
		questions = questionGroup();
		const html = render(<OutlineSurface spaceId="space" blockId="other" onNavigate={() => {}} />);
		expect(html).not.toContain('data-testid="outline-questions-section"');
		expect(questionReads).toEqual([]);
	});

	test("compact (a narrow panel) leaves the side panel out of the layout", () => {
		shown = pageView();
		const wide = render(<OutlineSurface spaceId="space" blockId="a" onNavigate={() => {}} />);
		const narrow = render(
			<OutlineSurface spaceId="space" blockId="a" onNavigate={() => {}} compact />,
		);
		expect(wide).toContain("side.backlinks");
		expect(narrow).not.toContain("side.backlinks");
		expect(narrow).toContain('data-compact="true"');
	});
});

describe("hosting rules", () => {
	const root = new URL(".", import.meta.url).pathname;
	const sources: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|browser-|\.browser\./.test(name)) {
				sources.push(path);
			}
		}
	};
	walk(root);

	test("nothing under components/outline uses the router", () => {
		expect(sources.length).toBeGreaterThan(10);
		const offenders = sources.filter((path) =>
			/from "@tanstack\/react-router"/.test(readFileSync(path, "utf8")),
		);
		expect(offenders).toEqual([]);
	});

	test("nothing under components/outline listens on the window or the document", () => {
		const offenders = sources.filter((path) =>
			/(window|document)\.(addEventListener|onkeydown|onkeyup|onpaste|oncopy)/.test(
				readFileSync(path, "utf8"),
			),
		);
		expect(offenders).toEqual([]);
	});
});
