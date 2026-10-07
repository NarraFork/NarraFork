import { beforeAll, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { classifyToolDetail } from "@shared/pretext-layout/tool-detail";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { getCategory, getSummary } from "../../tool-call/tool-display";
import { installCanvasStub } from "../measure/test-canvas-stub";

let measureToolCall: typeof import("../measure/measure-tool-call").measureToolCall;
let RenderToolCall: typeof import("./RenderToolCall").RenderToolCall;
beforeAll(async () => {
	installCanvasStub();
	measureToolCall = (await import("../measure/measure-tool-call")).measureToolCall;
	RenderToolCall = (await import("./RenderToolCall")).RenderToolCall;
});

for (const toolName of [
	"Worktree",
	"CreateWorktree",
	"AttachWorktree",
	"GetWorktreeOperation",
	"SwitchWorkingDirectory",
]) {
	test(`${toolName} paints plain custom rows through the real measure/render chain`, () => {
		const inputJson =
			toolName !== "SwitchWorkingDirectory"
				? { action: "create", destinationPath: "/repo/new", branch: { name: "fix/new" } }
				: { target: { cwd: "/repo/new" } };
		const outputJson =
			toolName !== "SwitchWorkingDirectory"
				? {
						_text: JSON.stringify({
							outcome: "created",
							worktree: { path: "/repo/new", branch: "refs/heads/fix/new" },
						}),
					}
				: {
						_text: JSON.stringify({
							changed: true,
							previous: { cwd: "/repo/old" },
							current: { cwd: "/repo/new", workspaceKey: "private-key" },
						}),
					};
		const category = getCategory(toolName);
		expect(category).toBe("workspace");
		if (category !== "workspace") throw new Error("Workspace category missing");
		const measured = measureToolCall(
			{
				toolName,
				summary: getSummary(toolName, inputJson),
				category,
				status: "success",
				detail: classifyToolDetail({
					previewId: toolName,
					toolName,
					category,
					inputJson,
					outputJson,
				}),
			},
			600,
			5,
		);
		const html = renderToStaticMarkup(
			<MantineProvider forceColorScheme="dark">
				<RenderToolCall measured={measured} />
			</MantineProvider>,
		);
		const { document } = parseHTML(html);
		expect(document.textContent ?? html).toContain("/repo/new");
		expect(html).not.toContain("private-key");
		expect(document.querySelectorAll(".mantine-Badge-root")).toHaveLength(0);
		expect(measured.detail?.height).toBeGreaterThan(0);
	});
}
