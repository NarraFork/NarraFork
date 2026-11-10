import { describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { OutlineBlockViewResponse, OutlineViewBlock } from "@shared/outline-api";
import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options
				? `${key}:${Object.entries(options)
						.map(([name, value]) => `${name}=${value}`)
						.join(",")}`
				: key,
	}),
}));
mock.module("@tanstack/react-router", () => ({
	useNavigate: () => () => {},
	Link: ({
		to,
		params,
		search,
		children,
		className,
		"aria-label": ariaLabel,
	}: {
		to: string;
		params: Record<string, string>;
		search?: Record<string, unknown>;
		children?: ReactNode;
		className?: string;
		"aria-label"?: string;
	}) => {
		let href = to;
		for (const [key, value] of Object.entries(params)) href = href.replace(`$${key}`, value);
		const query = new URLSearchParams(search as Record<string, string>).toString();
		return (
			<a href={query ? `${href}?${query}` : href} className={className} aria-label={ariaLabel}>
				{children}
			</a>
		);
	},
}));
mock.module("../narrator/markdown/MarkdownContent", () => ({
	MarkdownContent: ({ text }: { text: string }) => <div data-markdown="">{text}</div>,
}));

const { InProgressList, OutlineBlockTree } = await import("./OutlineBlockTree");
const { needsMarkdown } = await import("./OutlineBlockBody");
const { OutlineNavProvider } = await import("./outline-nav");
const { outlineRouterLink } = await import("../../lib/outline-router");

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

function view(blocks: OutlineViewBlock[], extra: Partial<OutlineBlockViewResponse> = {}) {
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
			canWrite: false,
		},
		pageId: "root",
		rootId: "root",
		seq: 3,
		current: true,
		view: "facts",
		path: [],
		blocks,
		hiddenByBudget: 0,
		hiddenByView: 0,
		pageTruncated: false,
		pageBlocks: 3,
		...extra,
	} satisfies OutlineBlockViewResponse;
}

const NO_FOLD = { expanded: new Set<string>(), collapsed: new Set<string>() };

function render(node: ReactNode, routed = true): string {
	return renderToStaticMarkup(
		<MantineProvider>
			<OutlineNavProvider
				onNavigate={() => {}}
				{...(routed ? { renderLink: outlineRouterLink } : {})}
			>
				{node}
			</OutlineNavProvider>
		</MantineProvider>,
	);
}

describe("OutlineBlockTree", () => {
	test("rows link to focus their block, keeping the time and view; hidden blocks get a link", () => {
		const html = render(
			<OutlineBlockTree
				view={view([
					block("root", ["a"]),
					block("a", ["b"], { hidden: 4, openTasks: 2, tags: ["design"], alias: "a-alias" }),
					block("b", [], {
						content: "**bold** body",
						task: { status: "done", assignee: "human:alice", due: null, depends: [] },
					}),
				])}
				fold={NO_FOLD}
				search={{ asOf: 2, view: "all" }}
				onFold={() => {}}
			/>,
		);
		expect(html).toContain('href="/outline/space/a?asOf=2&amp;view=all"');
		expect(html).toContain("page.more:count=4");
		expect(html).toContain("page.inProgress:count=2");
		expect(html).toContain("#design");
		expect(html).toContain("page.alias:alias=a-alias");
		expect(html).toContain("@human:alice");
		expect(html).toContain('data-done="true"');
		expect(html).toContain('<div data-markdown="">**bold** body</div>');
		expect(html).toContain("Block a");
		expect(html).not.toContain(">Block root<");
	});

	test("a collapsed block hides its subtree and its more-link", () => {
		const html = render(
			<OutlineBlockTree
				view={view([block("root", ["a"]), block("a", ["b"], { hidden: 4 }), block("b")])}
				fold={{ expanded: new Set(), collapsed: new Set(["a"]) }}
				search={{}}
				onFold={() => {}}
			/>,
		);
		expect(html).toContain("Block a");
		expect(html).not.toContain("page.more");
		expect(html).toContain('aria-expanded="false"');
		// Folded: the arrow points right and the bullet keeps its halo, as in the live editor.
		const doc = parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;
		// Its child is not a row: one preview line says what is under it.
		expect(doc.querySelector('[data-block-id="b"]')).toBeNull();
		expect(doc.querySelector('[data-fold-of="a"]')?.textContent).toBe("Block b");
		const row = doc.querySelector('[data-block-id="a"]');
		expect(row?.querySelector("svg")?.getAttribute("class")?.split(" ")).toContain(
			"tabler-icon-chevron-right",
		);
		expect(row?.querySelector('[data-collapsed="true"]')).not.toBeNull();
	});

	test("without a link renderer (a dock panel), focus links are plain anchors", () => {
		const html = render(
			<OutlineBlockTree
				view={view([block("root", ["a"]), block("a")])}
				fold={NO_FOLD}
				search={{ view: "all" }}
				onFold={() => {}}
			/>,
			false,
		);
		expect(html).toContain('href="#outline/space/a"');
		expect(html).not.toContain('href="/outline/space/a');
	});

	test("a question put to a person is marked as one, on the page and in the in-progress list (review S9)", () => {
		const html = render(
			<OutlineBlockTree
				view={view(
					[
						block("root", ["q", "w", "t"]),
						block("q", [], { question: { state: "open", proceed: false } }),
						block("w", [], { question: { state: "withdrawn", proceed: false } }),
						block("t", [], {
							task: { status: "todo", assignee: null, due: null, depends: [] },
						}),
					],
					{ view: "all" },
				)}
				fold={NO_FOLD}
				search={{ view: "all" }}
				onFold={() => {}}
			/>,
		);
		const doc = parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;
		const mark = (id: string) =>
			doc.querySelector(`[data-block-id="${id}"] [data-testid="outline-question-mark"]`);
		expect(mark("q")?.getAttribute("data-state")).toBe("open");
		expect(mark("q")?.getAttribute("aria-label")).toBe("page.question.open");
		expect(mark("w")?.getAttribute("data-state")).toBe("withdrawn");
		expect(mark("t")).toBeNull();
		expect(doc.querySelector('[data-block-id="t"] [aria-label="page.task.todo"]')).not.toBeNull();
		// The icons the live editor's frame draws too (`outline-icons.ts`).
		const iconOf = (id: string) =>
			doc
				.querySelector(`[data-block-id="${id}"] [role="img"] svg`)
				?.getAttribute("class")
				?.split(" ");
		expect(iconOf("t")).toContain("tabler-icon-circle");
		expect(iconOf("t")).toContain("nf-status");
		expect(iconOf("q")).toContain("tabler-icon-help-circle");

		const list = render(
			<InProgressList
				block={block("a", [], {
					openTasks: 2,
					inProgress: [
						{
							id: "q",
							sid: "s-q",
							title: "Which format?",
							status: "todo",
							assignee: null,
							waiting: false,
							question: true,
						},
						{
							id: "t",
							sid: "s-t",
							title: "Ship it",
							status: "doing",
							assignee: null,
							waiting: false,
						},
					],
				})}
				spaceId="space"
				search={{}}
			/>,
		);
		const items = parseHTML(`<!doctype html><html><body>${list}</body></html>`).document;
		const links = [...items.querySelectorAll("a")];
		expect(links.map((a) => !!a.querySelector('[data-testid="outline-question-mark"]'))).toEqual([
			true,
			false,
		]);
		expect(links[1]?.querySelector('[aria-label="page.task.doing"]')).not.toBeNull();
	});

	test("one marker per row: a task or a question has no bullet, and a focus handle instead", () => {
		const html = render(
			<OutlineBlockTree
				view={view(
					[
						block("root", ["p", "t", "q"]),
						block("p", ["c"]),
						block("c"),
						block("t", ["n"], {
							task: { status: "doing", assignee: null, due: null, depends: [] },
						}),
						block("n"),
						block("q", [], { question: { state: "open", proceed: false } }),
					],
					{ view: "all" },
				)}
				fold={{ expanded: new Set(), collapsed: new Set(["t"]) }}
				search={{ view: "all" }}
				onFold={() => {}}
			/>,
		);
		const doc = parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;
		const parts = (id: string) => {
			const row = doc.querySelector(`[data-block-id="${id}"]`);
			return {
				marker: row?.getAttribute("data-marker"),
				arrow: row?.querySelector("button[aria-expanded]") !== null,
				bullet: row?.querySelector("[data-collapsed]") !== null,
				icons: row?.querySelectorAll('[role="img"]').length,
				// Links that focus the block (the bullet, or the handle that stands in for it).
				focus: [...(row?.querySelectorAll('a[aria-label="page.focus"]') ?? [])].map((a) =>
					a.getAttribute("href"),
				),
			};
		};
		// A plain row: arrow + bullet; the bullet focuses.
		expect(parts("p")).toEqual({
			marker: "bullet",
			arrow: true,
			bullet: true,
			icons: 0,
			focus: ["/outline/space/p?view=all"],
		});
		// A task: arrow + checkbox, no bullet; focusing is still one link away.
		expect(parts("t")).toEqual({
			marker: "task",
			arrow: true,
			bullet: false,
			icons: 1,
			focus: ["/outline/space/t?view=all"],
		});
		// A question: its mark only (no children, so no arrow).
		expect(parts("q")).toEqual({
			marker: "question",
			arrow: false,
			bullet: false,
			icons: 1,
			focus: ["/outline/space/q?view=all"],
		});
	});

	test("a subagent report's container line reads as a report, without generation or UTC", () => {
		const stored = "报告（第 2 代 · 2026-11-09 17:38 UTC）";
		const html = render(
			<OutlineBlockTree
				view={view([
					block("root", ["r", "x"]),
					block("r", [], { content: stored }),
					block("x", [], { content: "报告（第 2 代）不是报告行" }),
				])}
				fold={NO_FOLD}
				search={{}}
				onFold={() => {}}
			/>,
		);
		const doc = parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;
		const line = doc.querySelector('[data-block-id="r"] [data-testid="outline-report-line"]');
		expect(line?.textContent).toStartWith("reportLine.title · ");
		expect(line?.textContent).not.toContain("UTC");
		expect(line?.textContent).not.toContain("代");
		// The stored text is still there to read (a tooltip), and anything else is left alone.
		expect(line?.getAttribute("title")).toBe(stored);
		expect(doc.querySelector('[data-block-id="x"]')?.textContent).toContain(
			"报告（第 2 代）不是报告行",
		);
		expect(doc.querySelector('[data-block-id="x"] [data-testid="outline-report-line"]')).toBeNull();
	});

	test("an empty facts view says the process is hidden", () => {
		const html = render(
			<OutlineBlockTree
				view={view([block("root")], { hiddenByView: 3 })}
				fold={NO_FOLD}
				search={{}}
				onFold={() => {}}
			/>,
		);
		expect(html).toContain("page.factsEmpty");
	});
});

describe("block bodies", () => {
	test("plain sentences skip the markdown renderer", () => {
		expect(needsMarkdown("A plain sentence, with commas.")).toBe(false);
		expect(needsMarkdown("中文的句子。")).toBe(false);
		expect(needsMarkdown("Has **bold**")).toBe(true);
		expect(needsMarkdown("See [[K/abc]]")).toBe(true);
		expect(needsMarkdown("Visit https://example.com")).toBe(true);
		expect(needsMarkdown("- item")).toBe(true);
		expect(needsMarkdown("1. first")).toBe(true);
		expect(needsMarkdown("`code`")).toBe(true);
	});
});

describe("OutlineBlockTree: the default view of a task page", () => {
	const task = (status: "todo" | "doing" | "done" | "cancelled") => ({
		task: { status, assignee: null, due: null, depends: [] },
	});
	const REPORT = "Report (generation 2 · 2026-11-09 17:38 UTC)";
	const page = () =>
		view(
			[
				block("root", ["doing", "done", "bare", "gone", "fact"]),
				block("doing", ["note", "leaf", "report", "ask"], {
					...task("doing"),
					content: "Ship the fold",
				}),
				block("done", ["sub", "result"], { ...task("done"), content: "Wire the store" }),
				block("bare", ["baresub"], { ...task("done"), content: "Nothing written" }),
				block("gone", ["why"], { ...task("cancelled"), content: "Dropped idea" }),
				block("fact", ["factkid"], { content: "A fact" }),
				block("note", ["n1", "n2", "n3"], { content: "First note" }),
				block("leaf", [], { content: "A lone note" }),
				block("report", ["rh"], { content: REPORT, reportFrom: "scout-1" }),
				block("ask", ["askctx"], { content: "Which way?" }),
				block("sub", [], { ...task("done"), content: "A subtask" }),
				block("result", ["evidence"], { content: "Both stores **write** the column" }),
				block("baresub", [], { ...task("done"), content: "Only a subtask" }),
				block("why", [], { content: "Superseded" }),
				block("factkid", [], { content: "Under a fact" }),
				block("n1", ["n1a"], { content: "Detail one\nsecond line" }),
				block("n2", [], { content: "Detail two" }),
				block("n3", [], { content: "Detail three" }),
				block("rh", ["rp", "rq"], { content: "## Findings" }),
				block("askctx", [], { content: "Context", question: { state: "open", proceed: false } }),
				block("evidence", [], { content: "store.ts:12", pending: ["chg"] }),
				block("n1a", [], {
					content: "Deep",
					lock: {
						blockId: "n1a",
						by: { kind: "human", id: "u", name: "alice" },
						delegate: null,
						versionSeq: 1,
						canUnlock: false,
					},
				}),
				block("rp", [], { content: "The summary paragraph." }),
				block("rq", [], { content: "More." }),
			],
			{ view: "all" },
		);
	const dom = (fold = NO_FOLD, v = page()) => {
		const html = render(<OutlineBlockTree view={v} fold={fold} search={{}} onFold={() => {}} />);
		return parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;
	};
	const rowIds = (doc: Document) =>
		[...doc.querySelectorAll("[data-block-id]")].map((el) => el.getAttribute("data-block-id"));
	const preview = (doc: Document, id: string) => doc.querySelector(`[data-fold-of="${id}"]`);

	test("open tasks show one level; finished tasks, reports and details are one line each", () => {
		const doc = dom();
		expect(rowIds(doc)).toEqual([
			"doing",
			"note",
			"leaf",
			"report",
			"ask",
			// A question waiting for an answer is never folded away by default.
			"askctx",
			"done",
			"bare",
			"gone",
			"fact",
			"factkid",
		]);
		const state = (id: string) =>
			doc.querySelector(`[data-block-id="${id}"]`)?.getAttribute("data-fold");
		expect(state("doing")).toBe("open");
		expect(state("done")).toBe("closed");
		expect(state("report")).toBe("closed");
		expect(state("note")).toBe("closed");
		expect(state("fact")).toBe("open");
		// A block without children has no arrow and no state.
		expect(state("leaf")).toBeNull();
		expect(doc.querySelector('[data-block-id="leaf"] [data-fold-toggle]')).toBeNull();
	});

	test("the preview lines: first line of the first block, and how much more", () => {
		const doc = dom();
		const parts = (id: string) => ({
			kind: preview(doc, id)?.getAttribute("data-fold-preview"),
			text: preview(doc, id)?.querySelector("[data-fold-preview-text]")?.textContent,
			label: preview(doc, id)?.querySelector("[data-fold-preview-label]")?.textContent ?? null,
		});
		// A note's details: the first line only, and the other children counted.
		expect(parts("note")).toEqual({
			kind: "details",
			text: "Detail one",
			label: "fold.more:count=2",
		});
		// A finished task: its first note (not its subtask), as plain text.
		expect(parts("done")).toEqual({
			kind: "result",
			text: "Both stores write the column",
			label: "fold.more:count=1",
		});
		expect(parts("gone")).toEqual({ kind: "result", text: "Superseded", label: null });
		// A report: its first paragraph (under its first heading), and every block counted.
		expect(parts("report")).toEqual({
			kind: "report",
			text: "The summary paragraph.",
			label: "fold.reportAll:count=3",
		});
		// One child with nothing more: the line alone (here: closed by the reader).
		const closed = dom({ expanded: new Set(), collapsed: new Set(["ask"]) });
		expect(preview(closed, "ask")?.querySelector("[data-fold-preview-text]")?.textContent).toBe(
			"Context",
		);
		expect(preview(closed, "ask")?.querySelector("[data-fold-preview-label]")).toBeNull();
		expect(preview(doc, "ask")).toBeNull();
		// A finished task with only subtasks: its title is all there is.
		expect(preview(doc, "bare")).toBeNull();
		expect(preview(doc, "doing")).toBeNull();
		expect(preview(doc, "fact")).toBeNull();
		// A preview is a control with a name that says what it opens.
		const line = preview(doc, "note");
		expect(line?.getAttribute("role")).toBe("button");
		expect(line?.getAttribute("tabindex")).toBe("0");
		expect(line?.getAttribute("aria-expanded")).toBe("false");
		expect(line?.getAttribute("aria-label")).toBe(
			"fold.showInside: Detail one (fold.more:count=2)",
		);
	});

	test("the report line says who wrote it, when the server told", () => {
		const doc = dom();
		const line = doc.querySelector('[data-block-id="report"] [data-testid="outline-report-line"]');
		expect(line?.textContent).toContain("reportLine.title");
		expect(line?.textContent).toContain("reportLine.from:name=scout-1");
		// The arrow's name is the line as read, not the stored text.
		expect(
			doc.querySelector('[data-block-id="report"] [data-fold-toggle]')?.getAttribute("aria-label"),
		).toContain("reportLine.title");
	});

	test("every row with something folded inside has its quick control, drawn always", () => {
		const doc = dom();
		const quick = (id: string) =>
			doc
				.querySelector(`[data-block-id="${id}"] [data-fold-subtree]`)
				?.getAttribute("data-fold-subtree") ?? null;
		expect(quick("doing")).toBe("expand");
		expect(quick("note")).toBe("expand");
		expect(quick("done")).toBe("expand");
		expect(quick("report")).toBe("expand");
		expect(quick("fact")).toBeNull();
		expect(quick("leaf")).toBeNull();
		const control = doc.querySelector('[data-block-id="note"] [data-fold-subtree]');
		expect(control?.getAttribute("aria-label")).toBe("fold.subtree:title=First note");
		expect(control?.getAttribute("aria-expanded")).toBe("false");
		expect(control?.getAttribute("title")).toBe("fold.subtreeExpand");
		// Everything inside open: it offers the default view again.
		const opened = dom({ expanded: new Set(["note", "n1"]), collapsed: new Set() });
		const now = opened.querySelector('[data-block-id="note"] [data-fold-subtree]');
		expect(now?.getAttribute("data-fold-subtree")).toBe("collapse");
		expect(now?.getAttribute("aria-expanded")).toBe("true");
		expect(now?.getAttribute("title")).toBe("fold.subtreeCollapse");
		expect(rowIds(opened)).toContain("n1a");
	});

	test("a closed row counts the question, the pending change and the lock it hides", () => {
		const doc = dom();
		const hidden = (id: string) =>
			[...doc.querySelectorAll(`[data-block-id="${id}"] [data-testid="outline-fold-hidden"]`)].map(
				(el) => `${el.getAttribute("data-kind")}:${el.getAttribute("aria-label")}`,
			);
		// The question's row is on screen: nothing counts it.
		expect(hidden("ask")).toEqual([]);
		expect(hidden("done")).toEqual(["pending:fold.hiddenPending:count=1"]);
		expect(hidden("note")).toEqual(["locked:fold.hiddenLocked:count=1"]);
		expect(hidden("doing")).toEqual([]);
		// The marks are the single source's chips (an icon on the state's colour), never a glyph.
		const chip = doc.querySelector('[data-block-id="note"] [data-testid="outline-fold-hidden"]');
		expect(chip?.getAttribute("data-status-chip")).toBe("locked");
		expect(chip?.querySelector("svg")).not.toBeNull();
		expect(chip?.textContent).toBe("1");
		// The reader closes above the question: the row counts it, and the count is a control
		// (it opens the question and where it is answered).
		const asked = dom({ expanded: new Set(), collapsed: new Set(["ask"]) });
		const count = asked.querySelector('[data-block-id="ask"] [data-testid="outline-fold-hidden"]');
		expect(count?.getAttribute("data-kind")).toBe("question");
		expect(count?.getAttribute("aria-label")).toBe("fold.hiddenQuestion:count=1");
		expect(count?.tagName).toBe("BUTTON");
		// The other counts say what is there; they are not controls.
		expect(chip?.tagName).not.toBe("BUTTON");
		// Closing the task above moves all three up to it; opening a row moves its count down.
		const closed = dom({ expanded: new Set(), collapsed: new Set(["doing"]) });
		expect(
			[
				...closed.querySelectorAll('[data-block-id="doing"] [data-testid="outline-fold-hidden"]'),
			].map((el) => el.getAttribute("data-kind")),
		).toEqual(["question", "locked"]);
		const opened = dom({ expanded: new Set(["done"]), collapsed: new Set() });
		expect(
			opened.querySelector('[data-block-id="done"] [data-testid="outline-fold-hidden"]'),
		).toBeNull();
		expect(
			opened
				.querySelector('[data-block-id="result"] [data-testid="outline-fold-hidden"]')
				?.getAttribute("data-kind"),
		).toBe("pending");
	});

	test("the page's control: expand all, then back to the default view; none on a page of facts", () => {
		const doc = dom();
		const all = doc.querySelector('[data-testid="outline-fold-all"]');
		expect(all?.getAttribute("data-fold-all")).toBe("expand");
		expect(all?.textContent).toBe("fold.expandAll");
		const everything = {
			expanded: new Set(["done", "bare", "gone", "note", "n1", "report", "rh", "result"]),
			collapsed: new Set<string>(),
		};
		const open = dom(everything);
		expect(rowIds(open).length).toBe(page().blocks.length - 1);
		expect(open.querySelector('[data-testid="outline-fold-all"]')?.textContent).toBe(
			"fold.collapseAll",
		);
		expect(open.querySelector("[data-fold-preview]")).toBeNull();
		const facts = dom(NO_FOLD, view([block("root", ["a"]), block("a", ["b"]), block("b")]));
		expect(facts.querySelector('[data-testid="outline-fold-all"]')).toBeNull();
	});

	test("a view focused under a task folds its blocks as details", () => {
		const blocks = [
			block("root", ["a"]),
			block("a", ["b"], { content: "Top" }),
			block("b", [], { content: "Under" }),
		];
		expect(rowIds(dom(NO_FOLD, view(blocks)))).toEqual(["a", "b"]);
		expect(rowIds(dom(NO_FOLD, view(blocks, { rootInTask: true })))).toEqual(["a"]);
	});
});
