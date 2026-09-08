/**
 * truncated-bash-target.test.ts — 截断的 bash 输出在 vlist 纯管线中的标记传递。
 *
 * 链路：projectToolIO（服务端页面预算 8KiB / WS 预算 2000 截断）
 *   → classifyToolDetail（bash 分类器）
 *   → measureToolCall（真实测量，非 stub）
 *   → resolveToolDetailViewTargets（output target 必须带 truncated: true）
 *
 * 以及取回完整 payload 后的反向链路：
 *   classifyBash(完整 outputJson) → target 不再带 truncated（加载完成态）。
 *
 * 行内自动加载 / 全屏取数的接线见 vlist-full-payload-wiring.test.ts。
 */
import { describe, expect, it } from "bun:test";
import { classifyToolDetail } from "@shared/pretext-layout/tool-detail";
import { projectToolIO, TOOL_IO_BUDGETS } from "@shared/pretext-layout/tool-io-projection";
import { DETAIL_CAPS, measureToolCall } from "./measure/measure-tool-call";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { resolveToolDetailViewTargets } from "./vlist-content-view-target";

installCanvasStub();

const WIDTH = 700;

/** 一个 20KB 的 bash 输出（低于 50KB 工具级截断，高于 8KiB 传输预算）。 */
const FULL_OUTPUT = Array.from(
	{ length: 900 },
	(_, i) => `output line ${i} ${"x".repeat(40)}`,
).join("\n");

function pagePayloadOutput() {
	// 服务端 getPretextDocumentPage 路径：projectToolIO with leafBudget = 8KiB。
	return projectToolIO(FULL_OUTPUT, { leafBudget: TOOL_IO_BUDGETS.leaf });
}

describe("复现：截断的 bash 输出在 vlist 的 target 标记", () => {
	it("页面载荷（8KiB 预览）→ output target 带 truncated: true", () => {
		const outputJson = pagePayloadOutput();
		//  sanity：确实被截断成了带标记的叶子
		expect(typeof outputJson).toBe("object");

		const detail = classifyToolDetail({
			toolUseId: "tu_repro",
			toolName: "Bash",
			category: "bash",
			status: "success",
			inputJson: { command: "bun test", description: "run tests" },
			outputJson,
			metadata: null,
			isStreaming: false,
		});
		expect(detail?.kind).toBe("sections");

		const measured = measureToolCall(
			{
				toolName: "Bash",
				summary: "bun test",
				category: "bash",
				status: "success",
				toolUseId: "tu_repro",
				detail,
			},
			WIDTH,
			5,
			{ opened: true },
		);

		const targets = resolveToolDetailViewTargets("tool-tu_repro", measured, {
			sections: { command: "Command", output: "Output" } as never,
		});
		const outputTarget = targets.find((t) => t.model?.source === "output.main");
		expect(outputTarget).toBeDefined();
		expect(outputTarget?.truncated).toBe(true);
		// 盒子高度必须是完整 cap（200px），为滚动加载预留空间
		expect(outputTarget?.text.length).toBe(TOOL_IO_BUDGETS.leaf);
	});

	it("完整 payload 落地后 → target 不再 truncated（加载完成态）", () => {
		const detail = classifyToolDetail({
			toolUseId: "tu_repro",
			toolName: "Bash",
			category: "bash",
			status: "success",
			inputJson: { command: "bun test" },
			outputJson: FULL_OUTPUT,
			metadata: null,
			isStreaming: false,
		});
		const measured = measureToolCall(
			{
				toolName: "Bash",
				summary: "bun test",
				category: "bash",
				status: "success",
				toolUseId: "tu_repro",
				detail,
			},
			WIDTH,
			5,
			{ opened: true },
		);
		const targets = resolveToolDetailViewTargets("tool-tu_repro", measured, {
			sections: { output: "Output" } as never,
		});
		const outputTarget = targets.find((t) => t.model?.source === "output.main");
		expect(outputTarget).toBeDefined();
		expect(outputTarget?.truncated).toBeUndefined();
		// 完整文本必须到达 target（行内盒子可滚到全部内容）
		expect(outputTarget?.text.length).toBe(FULL_OUTPUT.length);
	});

	it("WS 广播载荷（2000 字符预览）→ 同样带 truncated: true", () => {
		const outputJson = projectToolIO(FULL_OUTPUT, {
			leafBudget: 2000,
			markdownBudget: 2000,
		});
		const detail = classifyToolDetail({
			toolUseId: "tu_repro",
			toolName: "Bash",
			category: "bash",
			status: "success",
			inputJson: { command: "bun test" },
			outputJson,
			metadata: null,
			isStreaming: false,
		});
		const measured = measureToolCall(
			{
				toolName: "Bash",
				summary: "bun test",
				category: "bash",
				status: "success",
				toolUseId: "tu_repro",
				detail,
			},
			WIDTH,
			5,
			{ opened: true },
		);
		const targets = resolveToolDetailViewTargets("tool-tu_repro", measured, {
			sections: { output: "Output" } as never,
		});
		const outputTarget = targets.find((t) => t.model?.source === "output.main");
		expect(outputTarget?.truncated).toBe(true);
	});

	it("cap 常量：term 盒子 200px", () => {
		expect(DETAIL_CAPS.term).toBe(200);
	});
});
