import { describe, expect, test } from "bun:test";
import { getEffectiveNarratorDisplay, statusRegistry } from "@frontend/lib/status-registry";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { RecentTabBackgroundBubble } from "./RecentTabBackgroundBubble";

function renderBubble(foregroundFilled: boolean) {
	const color = statusRegistry.accentVar(
		getEffectiveNarratorDisplay("idle", foregroundFilled ? ["unread"] : []),
		6,
	);
	const markup = renderToStaticMarkup(
		<MantineProvider>
			<RecentTabBackgroundBubble size={16} color={color} foregroundFilled={foregroundFilled} />
		</MantineProvider>,
	);
	return parseHTML(markup).document;
}

describe("RecentTabs background bubble rendering", () => {
	test("idle unread uses a green filled base and a diagonally clipped blue filled half", () => {
		const document = renderBubble(true);
		const icons = document.querySelectorAll("svg");
		expect(icons).toHaveLength(2);
		expect(icons[0]?.getAttribute("class")).toContain("tabler-icon-message-circle-filled");
		expect(icons[0]?.getAttribute("fill")).toBe("var(--mantine-color-green-6)");
		expect(icons[1]?.getAttribute("class")).toContain("tabler-icon-message-circle-filled");
		expect(icons[1]?.getAttribute("fill")).toBe("var(--mantine-color-blue-6)");
		const overlay = document.querySelector('[data-tab-background-active="true"]');
		expect(overlay?.getAttribute("style")).toContain("clip-path:polygon(0 0, 100% 0, 0 100%)");
		expect(overlay?.querySelector("svg")).toBe(icons[1]);
	});

	test("idle read retains a hollow base while background work stays blue", () => {
		const document = renderBubble(false);
		const icons = document.querySelectorAll("svg");
		expect(icons).toHaveLength(2);
		expect(icons[0]?.getAttribute("class")).not.toContain("message-circle-filled");
		expect(icons[1]?.getAttribute("class")).toContain("message-circle-filled");
		expect(icons[1]?.getAttribute("fill")).toBe("var(--mantine-color-blue-6)");
	});
});
