/**
 * Outline tool cards link their block addresses and their commit, through the real segment →
 * adapter → measure → render chain: inside a host that opens outline panels (a session surface
 * with the outline on) they are outline links (no new tab, the app's mount prefix applied);
 * without one they are plain text, so a card never offers a link nothing can open.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { resetAppBaseForTest } from "@frontend/lib/base-path";
import { OutlineOpenerProvider } from "@frontend/lib/outline-opener";
import { MantineProvider } from "@mantine/core";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageViewerProvider } from "../../../common/ImageViewerProvider";
import { segmentMessages } from "../../message/message-segments";
import type { NarratorMsg } from "../../narrator-panel-types";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { VLIST_REGISTRY } from "../registry";
import { renderElement, resolveRenderExtra } from "../render-registry";
import { type AdapterContext, type AdapterSegment, adaptSegments } from "../segment-adapter";

const disposeCanvasStub = installCanvasStub();
afterAll(() => disposeCanvasStub());

const CTX: AdapterContext = { lod: 5, resolveToolCategory: () => "outline" };
const opener = { open: () => true };

function mountAt(mountUrl: string): void {
	resetAppBaseForTest();
	const g = globalThis as { document?: unknown; location?: unknown };
	g.document = { baseURI: mountUrl };
	g.location = { href: mountUrl, origin: new URL(mountUrl).origin };
}

afterEach(() => {
	resetAppBaseForTest();
	const g = globalThis as { document?: unknown; location?: unknown };
	delete g.document;
	delete g.location;
});

function toolMessage(
	name: string,
	inputJson: unknown,
	text: string,
	metadata: unknown,
): NarratorMsg {
	const outputJson = { _text: text, _metadata: metadata };
	return rowWithElements(
		{
			id: `a-${name}`,
			narratorId: "n1",
			parentToolUseId: null,
			role: "assistant",
			contentText: null,
			toolCalls: [
				{ toolUseId: `tu-${name}`, toolName: name, inputJson, outputJson, status: "completed" },
			],
			createdAt: "2026-10-27T00:00:00Z",
		},
		[
			{
				type: "tool_use",
				id: `tu-${name}`,
				name,
				input: inputJson,
				inputJson,
				outputJson,
				status: "completed",
			},
		],
	) as unknown as NarratorMsg;
}

function renderCard(message: NarratorMsg, withOpener: boolean): Element {
	const segments = segmentMessages([message]) as unknown as AdapterSegment[];
	const specs = adaptSegments(segments, CTX);
	const spec = specs.find((s) => s.kind === "tool-call" || s.kind === "tool-call-group");
	if (!spec) throw new Error(`no tool-call spec, got: ${specs.map((s) => s.kind).join(",")}`);
	const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, 800, 5, spec.opts);
	const extra = resolveRenderExtra(spec);
	extra.narratorId = "n1";
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	const html = renderToStaticMarkup(
		<QueryClientProvider client={queryClient}>
			<MantineProvider forceColorScheme="dark">
				<ImageViewerProvider>
					<OutlineOpenerProvider value={withOpener ? opener : null}>
						{renderElement(spec.kind, measured, extra)}
					</OutlineOpenerProvider>
				</ImageViewerProvider>
			</MantineProvider>
		</QueryClientProvider>,
	);
	const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
	return document.getElementById("r") as unknown as Element;
}

function outlineAnchors(
	root: Element,
): Array<{ href: string; target: string | null; outline: boolean }> {
	return Array.from(root.querySelectorAll("a[href]"))
		.filter((a) => (a.getAttribute("href") ?? "").includes("/outline/"))
		.map((a) => ({
			href: a.getAttribute("href") ?? "",
			target: a.getAttribute("target"),
			outline: a.hasAttribute("data-outline-link"),
		}));
}

const read = toolMessage("OutlineRead", { address: "Ab3dEf9Q" }, "- [Ab3dEf9Q] Auth", {
	tool: "OutlineRead",
	address: "Kx81mPqa/Ab3dEf9Q",
	space: { key: "Kx81mPqa", kind: "project" },
	blocks: 1,
});
const search = toolMessage("OutlineSearch", { query: "auth" }, "1 result", {
	tool: "OutlineSearch",
	results: [{ address: "Kx81mPqa/Qq1Sid00", title: "Token refresh", path: [] }],
});
const edit = toolMessage(
	"OutlineEdit",
	{ edits: [{ set: "Ab3dEf9Q", checkbox: "x" }] },
	"Committed #4",
	{
		tool: "OutlineEdit",
		space: { key: "Kx81mPqa", kind: "project" },
		commit: { id: "c1", seq: 4 },
		edits: [{ op: "set", address: "Kx81mPqa/Ab3dEf9Q" }],
	},
);

describe("outline tool cards", () => {
	it("link the read's address, each hit and the edit's target and commit inside a host", () => {
		mountAt("https://nf.example.com/nf/");
		expect(outlineAnchors(renderCard(read, true))).toContainEqual({
			href: "/nf/outline/ref?a=Kx81mPqa%2FAb3dEf9Q",
			target: null,
			outline: true,
		});
		expect(outlineAnchors(renderCard(search, true))).toContainEqual({
			href: "/nf/outline/ref?a=Kx81mPqa%2FQq1Sid00",
			target: null,
			outline: true,
		});
		const editLinks = outlineAnchors(renderCard(edit, true)).map((a) => a.href);
		expect(editLinks).toContain("/nf/outline/ref?space=Kx81mPqa&commit=4");
		expect(editLinks).toContain("/nf/outline/ref?a=Kx81mPqa%2FAb3dEf9Q");
	});

	it("show the same text without links where nothing can open them", () => {
		mountAt("https://nf.example.com/");
		for (const card of [read, search, edit]) {
			const root = renderCard(card, false);
			expect(outlineAnchors(root)).toEqual([]);
		}
		expect(renderCard(read, false).textContent).toContain("Kx81mPqa/Ab3dEf9Q");
		expect(renderCard(edit, false).textContent).toContain("commit #4");
	});
});
