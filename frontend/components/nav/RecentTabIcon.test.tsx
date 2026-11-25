import { expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import navEn from "../../locales/en/nav.json";
import { NarratorStatusIcon } from "./NarratorStatusIcon";
import { getNarratorStatusIconColor } from "./narrator-status-icon-logic";
import { RecentTabIcon } from "./RecentTabIcon";

type Source = ComponentProps<typeof RecentTabIcon>["tab"];
function renderIcon(tab: Source) {
	return parseHTML(
		renderToStaticMarkup(
			<MantineProvider>
				<RecentTabIcon tab={tab} size={16} />
			</MantineProvider>,
		),
	).document;
}

test.each([
	{ status: "idle", substatus: [] },
	{ status: "working", substatus: [] },
	{ status: "waiting", substatus: [] },
	{ status: "idle", substatus: ["unread"] },
	{ status: "working", substatus: ["planning", "reasoning"] },
	{ status: "idle", substatus: ["error"] },
])("shared narrator icon preserves RecentTabs status $status / $substatus", (sample) => {
	const substatus: string[] = [...sample.substatus];
	const state = { status: sample.status, substatus };
	const actual = renderIcon({ id: "session", type: "narrator", ...state });
	const expected = parseHTML(
		renderToStaticMarkup(
			<MantineProvider>
				<NarratorStatusIcon size={16} {...state} />
			</MantineProvider>,
		),
	).document;
	expect(actual.querySelector("svg")?.outerHTML).toBe(expected.querySelector("svg")?.outerHTML);
	expect(actual.querySelector("[data-tab-shape]")?.getAttribute("data-tab-shape")).toBe(
		expected.querySelector("[data-tab-shape]")?.getAttribute("data-tab-shape"),
	);
	expect(actual.querySelector(".tabler-icon-brain") !== null).toBe(
		state.substatus.includes("reasoning"),
	);
});

test.each([
	"idle",
	"working",
	"waiting",
])("shared subagent icon remains a robot with the RecentTabs %s color", (status) => {
	const tab: Source = { id: "child", type: "subagent", status };
	const document = renderIcon(tab);
	expect(document.querySelector(".tabler-icon-robot")?.getAttribute("stroke")).toBe(
		getNarratorStatusIconColor(tab) ?? "currentColor",
	);
	expect(document.querySelector(".tabler-icon-message-circle")).toBeNull();
	expect(document.querySelector("[data-tab-shape]")).toBeNull();
});

test("subagent reasoning, draft and scheduled markers are retained without a bubble knockout", () => {
	const document = renderIcon({
		id: "child",
		type: "subagent",
		status: "waiting",
		substatus: ["reasoning"],
		hasDraft: true,
		isScheduled: true,
	});
	for (const glyph of ["robot", "brain", "pencil", "clock"])
		expect(document.querySelector(`.tabler-icon-${glyph}`)).not.toBeNull();
	expect(document.querySelector("[data-tab-shape]")).toBeNull();
});

test("narrator background counters and draft markers still reach the shared bubble", () => {
	const document = renderIcon({
		id: "session",
		type: "narrator",
		status: "idle",
		activeBackgroundTaskCount: 1,
		hasDraft: true,
	});
	expect(document.querySelector('[data-tab-background-active="true"]')).not.toBeNull();
	expect(document.querySelector(".tabler-icon-pencil")).not.toBeNull();
});

test("project tabs remain folders", () => {
	expect(
		renderIcon({ id: "project", type: "project" }).querySelector(".tabler-icon-folder"),
	).not.toBeNull();
});

test("a team icon shows the coordinator status and only badges known pending approvals", async () => {
	const i18n = createInstance();
	await i18n.init({ lng: "en", resources: { en: { nav: navEn } } });
	for (const pendingApprovalCount of [undefined, null, 2]) {
		const { document } = parseHTML(
			renderToStaticMarkup(
				<I18nextProvider i18n={i18n}>
					<MantineProvider>
						<RecentTabIcon
							tab={{ id: "coordinator", type: "team", status: "waiting", pendingApprovalCount }}
							size={16}
						/>
					</MantineProvider>
				</I18nextProvider>,
			),
		);
		expect(document.querySelector(".tabler-icon-users-group")).not.toBeNull();
		expect(document.querySelector("[data-tab-shape]")?.getAttribute("data-tab-shape")).toBe(
			renderIcon({ id: "coordinator", type: "narrator", status: "waiting" })
				.querySelector("[data-tab-shape]")
				?.getAttribute("data-tab-shape"),
		);
		const pending = document.querySelector('[data-testid="team-tab-pending"]');
		if (pendingApprovalCount === 2) expect(pending?.textContent).toBe("2");
		else expect(pending).toBeNull();
	}
});
