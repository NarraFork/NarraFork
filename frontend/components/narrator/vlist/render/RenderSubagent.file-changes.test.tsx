import { afterAll, describe, expect, it } from "bun:test";
import en from "@frontend/locales/en/narrator.json";
import zh from "@frontend/locales/zh-CN/narrator.json";
import { MantineProvider } from "@mantine/core";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import {
	BLOCK_PADDING_BOTTOM,
	FILE_CHANGE_MAX_ROWS,
	measureSubagentCard,
	type SubagentFileChangesData,
} from "../measure/measure-subagent";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { useVListLabels } from "../useVListLabels";
import { RenderSubagent, type SubagentLabels } from "./RenderSubagent";

const dispose = installCanvasStub();
afterAll(dispose);

type FileRow = SubagentFileChangesData["files"][number];
const FILE: FileRow = {
	subagentNarratorId: "child",
	deviceId: "remote-a",
	workspacePath: "/repo",
	filePath: "same.ts",
	linesAdded: 3,
	linesRemoved: 1,
	editCount: 2,
	outsideParentWorkspace: false,
};
const changes = (over: Partial<SubagentFileChangesData> = {}): SubagentFileChangesData => ({
	files: [FILE],
	totalFiles: 1,
	totalUnmeasured: 0,
	bashTouchedCount: 0,
	countsTruncated: false,
	attributionScope: "legacy_unscoped",
	...over,
});

function card(data: SubagentFileChangesData, expanded = false, folded = false) {
	const measured = measureSubagentCard(
		{
			agentType: "general",
			description: "child",
			isTerminal: true,
			fileChanges: data,
			fileChangesExpanded: expanded,
		},
		800,
		5,
		folded ? { opened: false } : {},
	);
	return {
		measured,
		description: "child",
		fileChanges: data,
		onToggleFileChanges: () => {},
	};
}

function parse(markup: string): HTMLElement {
	const { document } = parseHTML(`<html><body><div id="root">${markup}</div></body></html>`);
	return document.getElementById("root") as unknown as HTMLElement;
}

function render(
	data: SubagentFileChangesData,
	expanded = false,
	folded = false,
	labels?: SubagentLabels,
) {
	const props = card(data, expanded, folded);
	const root = parse(
		renderToStaticMarkup(
			<MantineProvider>
				<RenderSubagent {...props} labels={labels} />
			</MantineProvider>,
		),
	);
	return { root, measured: props.measured };
}

/** The real renderer must spend exactly the measure layer's declared row budget. */
function expectHeightParity(root: HTMLElement, height: number) {
	const block = root.querySelector<HTMLElement>('[data-testid="subagent-file-changes"]');
	expect(block).not.toBeNull();
	if (!block) throw new Error("missing file block");
	expect(Number.parseFloat(block.style.height)).toBe(height);
	let rowsHeight = 0;
	for (const child of Array.from(block.children) as HTMLElement[]) {
		if (child.style.height) rowsHeight += Number.parseFloat(child.style.height);
		else {
			const files = Array.from(child.children) as HTMLElement[];
			rowsHeight += files.reduce((total, file) => total + Number.parseFloat(file.style.height), 0);
			rowsHeight += Math.max(0, files.length - 1) * Number.parseFloat(child.style.gap || "0");
		}
	}
	expect(rowsHeight + BLOCK_PADDING_BOTTOM).toBeCloseTo(height, 5);
}

describe("subagent file-change rendering", () => {
	it("keeps same-path rows on different devices/workspaces independent", () => {
		const files = [FILE, { ...FILE, deviceId: "remote-b" }, { ...FILE, workspacePath: "/other" }];
		const { root, measured } = render(changes({ files, totalFiles: files.length }));
		const rows = [...root.querySelectorAll('[data-testid="subagent-file-change"]')];
		expect(rows).toHaveLength(3);
		expect(new Set(rows.map((row) => row.getAttribute("data-file-identity"))).size).toBe(3);
		expect(
			rows.map((row) => row.querySelector('[data-testid="subagent-file-location"]')?.textContent),
		).toEqual(["remote-a · /repo", "remote-b · /repo", "remote-a · /other"]);
		expectHeightParity(root, measured.fileChangesHeight);
	});

	it.each([undefined, null])("treats %s parent comparison as unknown, never inside", (coverage) => {
		const { root } = render(changes({ files: [{ ...FILE, outsideParentWorkspace: coverage }] }));
		expect(
			root.querySelector('[data-testid="subagent-file-coverage-unknown"]')?.textContent,
		).toContain("coverage unknown");
		expect(root.textContent).not.toContain("outside this workspace");
	});

	it("honestly renders old payloads with missing device/workspace/scope", () => {
		const {
			deviceId: _device,
			workspacePath: _workspace,
			outsideParentWorkspace: _coverage,
			...file
		} = FILE;
		const { attributionScope: _scope, ...payload } = changes({ files: [file] });
		const { root, measured } = render(payload);
		expect(root.textContent).toContain("unknown device · unknown workspace");
		expect(root.textContent).toContain("coverage unknown");
		expect(root.querySelector('[data-testid="subagent-file-changes-legacy"]')?.textContent).toBe(
			"Legacy/unscoped · not per-attempt or net changes",
		);
		expect(root.querySelector('[data-testid="subagent-file-changes-window"]')).toBeNull();
		expectHeightParity(root, measured.fileChangesHeight);
	});

	it("shows known outside, but never claims a known location authorizes undo", () => {
		const outside = render(changes({ files: [{ ...FILE, outsideParentWorkspace: true }] })).root;
		expect(outside.textContent).toContain("outside this workspace");
		expect(outside.querySelector('[data-testid="subagent-file-coverage-unknown"]')).toBeNull();
		const inside = render(changes()).root;
		expect(inside.querySelector('[data-testid="subagent-file-coverage-unknown"]')).toBeNull();
		expect(inside.textContent).not.toContain("will restore");
	});

	it.each([
		{ bashTouchedCount: 4 },
		{ countsTruncated: true },
		{ totalUnmeasured: 2 },
	])("renders summary-only evidence with no file rows: %j", (over) => {
		const { root, measured } = render(changes({ files: [], totalFiles: 0, ...over }));
		expect(root.querySelectorAll('[data-testid="subagent-file-change"]')).toHaveLength(0);
		const summary = root.querySelector<HTMLButtonElement>(
			'[data-testid="subagent-file-changes-overflow"]',
		);
		expect(summary?.textContent?.trim()).not.toBe("");
		expect(summary?.disabled).toBe(true);
		if ("bashTouchedCount" in over) expect(summary?.textContent).toContain("4 touched by shell");
		if ("countsTruncated" in over)
			expect(summary?.textContent).toContain("totals are lower bounds");
		expectHeightParity(root, measured.fileChangesHeight);
	});

	it("shows the requested scope without upgrading it to exact attempt/net evidence", () => {
		const scope = { sourceToolUseId: "parent-call", startedAt: null, completedAt: null };
		const { root, measured } = render(changes({ scope }));
		expect(root.textContent).toContain("Legacy/unscoped");
		expect(root.textContent).toContain("not per-attempt or net changes");
		const window = root.querySelector('[data-testid="subagent-file-changes-window"]');
		expect(window?.textContent).toContain("not verified attempt evidence");
		expect(window?.getAttribute("title")).toContain(JSON.stringify(scope));
		expectHeightParity(root, measured.fileChangesHeight);
	});

	it("keeps list expansion and collapse reachable without affecting the card fold", () => {
		const files = Array.from({ length: 8 }, (_, i) => ({ ...FILE, filePath: `${i}.ts` }));
		const payload = changes({ files, totalFiles: files.length });
		const closed = render(payload);
		expect(closed.root.querySelectorAll('[data-testid="subagent-file-change"]')).toHaveLength(
			FILE_CHANGE_MAX_ROWS,
		);
		const closedToggle = closed.root.querySelector<HTMLButtonElement>(
			'[data-testid="subagent-file-changes-overflow"]',
		);
		expect(closedToggle?.disabled).toBe(false);
		expect(closedToggle?.textContent).toContain("3 more files");
		expect(closedToggle?.getAttribute("aria-expanded")).toBe("false");
		const opened = render(payload, true);
		expect(opened.root.querySelectorAll('[data-testid="subagent-file-change"]')).toHaveLength(8);
		const openedToggle = opened.root.querySelector<HTMLButtonElement>(
			'[data-testid="subagent-file-changes-overflow"]',
		);
		expect(openedToggle?.disabled).toBe(false);
		expect(openedToggle?.textContent).toContain("Show fewer files");
		expect(openedToggle?.getAttribute("aria-expanded")).toBe("true");
		expectHeightParity(closed.root, closed.measured.fileChangesHeight);
		expectHeightParity(opened.root, opened.measured.fileChangesHeight);
		const folded = render(payload, true, true);
		expect(folded.measured.fileChangesHeight).toBe(0);
		expect(folded.root.querySelector('[data-testid="subagent-file-changes"]')).toBeNull();
	});

	it("does not render an empty block, but still discloses server-omitted files", () => {
		const empty = render(changes({ files: [], totalFiles: 0 }));
		expect(empty.measured.fileChangesHeight).toBe(0);
		expect(empty.root.querySelector('[data-testid="subagent-file-changes"]')).toBeNull();
		const omitted = render(changes({ files: [], totalFiles: 3 }));
		expect(omitted.root.textContent).toContain("3 more files");
		expectHeightParity(omitted.root, omitted.measured.fileChangesHeight);
	});

	it("keeps the rendered row budget aligned at non-default typography", async () => {
		const { getTypography, setTypography } = await import("@shared/pretext-layout/typography");
		const original = { ...getTypography() };
		try {
			const baseline = render(changes()).measured.fileChangeRowHeight;
			setTypography({ ...original, fontScalePercent: 150, lineHeightScalePercent: 140 });
			for (const payload of [
				changes(),
				changes({ files: [], totalFiles: 0, countsTruncated: true }),
			]) {
				const { root, measured } = render(payload);
				expect(measured.fileChangeRowHeight).toBeGreaterThan(baseline);
				expectHeightParity(root, measured.fileChangesHeight);
			}
		} finally {
			setTypography(original);
		}
	});

	it("discloses partial measurements even when the available sums are numeric", () => {
		const { root } = render(changes({ files: [{ ...FILE, unmeasuredCount: 1 }] }));
		expect(root.textContent).toContain("lines not measured");
	});

	it.each([
		"en",
		"zh-CN",
	])("injects the real %s labels into every new file-change field", async (language) => {
		const i18n = createInstance();
		await i18n.init({
			lng: language,
			fallbackLng: "en",
			ns: ["narrator", "common"],
			resources: { en: { narrator: en, common: {} }, "zh-CN": { narrator: zh, common: {} } },
		});
		const props = card(
			changes({
				files: [{ ...FILE, deviceId: null, workspacePath: null, outsideParentWorkspace: null }],
				bashTouchedCount: 2,
				totalUnmeasured: 3,
				countsTruncated: true,
				scope: { sourceToolUseId: null },
			}),
		);
		function LocalizedCard() {
			const { renderLabels } = useVListLabels();
			return <RenderSubagent {...props} labels={renderLabels.subagent} />;
		}
		const root = parse(
			renderToStaticMarkup(
				<I18nextProvider i18n={i18n}>
					<MantineProvider>
						<LocalizedCard />
					</MantineProvider>
				</I18nextProvider>,
			),
		);
		const locale = language === "zh-CN" ? zh : en;
		for (const key of [
			"subagentFileChangesLegacy",
			"subagentFileChangesWindow",
			"subagentFileChangesUnknownDevice",
			"subagentFileChangesUnknownWorkspace",
			"subagentFileChangesUnknownCoverage",
			"subagentFileChangesTruncated",
		] as const)
			expect(root.textContent).toContain(locale[key]);
		expect(root.textContent).toContain(locale.subagentFileChangesEdits.replace("{{count}}", "2"));
		expect(root.textContent).toContain(
			locale.subagentFileChangesUnmeasured.replace("{{count}}", "3"),
		);
		expect(root.textContent).not.toContain("{{count}}");
		expectHeightParity(root, props.measured.fileChangesHeight);
	});
});
