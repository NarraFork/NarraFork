import { describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { OutlineBlockViewResponse, OutlineViewBlock } from "@shared/outline-api";
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

const { OutlineBlockTree } = await import("./OutlineBlockTree");
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
				collapsed={new Set()}
				search={{ asOf: 2, view: "all" }}
				onToggle={() => {}}
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
				collapsed={new Set(["a"])}
				search={{}}
				onToggle={() => {}}
			/>,
		);
		expect(html).toContain("Block a");
		expect(html).not.toContain("Block b");
		expect(html).not.toContain("page.more");
		expect(html).toContain('aria-expanded="false"');
	});

	test("without a link renderer (a dock panel), focus links are plain anchors", () => {
		const html = render(
			<OutlineBlockTree
				view={view([block("root", ["a"]), block("a")])}
				collapsed={new Set()}
				search={{ view: "all" }}
				onToggle={() => {}}
			/>,
			false,
		);
		expect(html).toContain('href="#outline/space/a"');
		expect(html).not.toContain('href="/outline/space/a');
	});

	test("an empty facts view says the process is hidden", () => {
		const html = render(
			<OutlineBlockTree
				view={view([block("root")], { hiddenByView: 3 })}
				collapsed={new Set()}
				search={{}}
				onToggle={() => {}}
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
