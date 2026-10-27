/**
 * The outline surface as a self-contained component: what it shows comes from props, links go
 * through the host's renderer (or plain anchors), and nothing under `components/outline/` reaches
 * for the router or listens on the whole document (dock panels host it beside a composer).
 */
import { describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MantineProvider } from "@mantine/core";
import type { OutlineBlockViewResponse, OutlineViewBlock } from "@shared/outline-api";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
mock.module("../narrator/markdown/MarkdownContent", () => ({
	MarkdownContent: ({ text }: { text: string }) => <div data-markdown="">{text}</div>,
}));
mock.module("./editor/OutlineEditor", () => ({
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
const reads: unknown[] = [];
const idle = { data: undefined, isLoading: false, isError: false, isSuccess: true };
mock.module("../../hooks/useOutline", () => ({
	useOutlineEnabled: () => ({ enabled: true, loading: false }),
	useOutlineBlock: (...args: unknown[]) => {
		reads.push(args);
		return { data: shown, isLoading: false, error: null };
	},
	useOutlinePageLive: () => {},
	useOutlineBacklinks: () => idle,
	useOutlineBlockHistory: () => ({ ...idle, hasNextPage: false }),
	useOutlineTimeline: () => ({ ...idle, hasNextPage: false }),
	useRevertOutlineCommit: () => ({ mutate: () => {}, isPending: false }),
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
		...extra,
	};
}

function render(node: ReactNode): string {
	return renderToStaticMarkup(<MantineProvider>{node}</MantineProvider>);
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
