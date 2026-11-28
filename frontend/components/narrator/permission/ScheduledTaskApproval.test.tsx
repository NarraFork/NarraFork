import { describe, expect, test } from "bun:test";
import en from "@frontend/locales/en/narrator.json";
import enSchedule from "@frontend/locales/en/scheduledTasks.json";
import zh from "@frontend/locales/zh-CN/narrator.json";
import zhSchedule from "@frontend/locales/zh-CN/scheduledTasks.json";
import type { PendingPermission } from "@frontend/types/narrator";
import { MantineProvider } from "@mantine/core";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { ScheduledTaskApproval, scheduledTaskApprovalView } from "./ScheduledTaskApproval";

const task = {
	name: "Weekly checks",
	cwd: "/work/project",
	projectId: "project-id",
	permissionMode: "bypassPermissions",
	model: "provider:model",
	modelPolicy: "temporary",
	narratorMode: "reuse",
	onBlocked: "wait",
	blockedWaitMinutes: 20,
	maxRunMinutes: 60,
	timezone: "Asia/Shanghai",
	schedule: {
		kind: "repeat",
		rule: { unit: "week", interval: 2, weekdays: [1, 5], times: ["09:30", "16:00"] },
		end: { type: "count", count: 4 },
		anchorAt: "2026-11-01T00:00:00+08:00",
	},
};
const permission: PendingPermission = {
	id: "approval",
	toolName: "ScheduledTask",
	ownerNarratorId: "caller",
	inputJson: {
		_scheduledTaskApproval: {
			version: 1,
			action: "update",
			task,
			before: { ...task, permissionMode: "default" },
			changed: ["permissionMode"],
			elevated: true,
			outsideScope: true,
			occurrences: ["2026-11-16T01:30:00.000Z"],
		},
	},
};

describe("scheduled task approval", () => {
	test("requires a server-resolved versioned preview, not model-authored schedule hints", () => {
		expect(
			scheduledTaskApprovalView({ ...permission, inputJson: { task, elevated: false } }),
		).toBeNull();
		for (const toolName of ["Write", "ScheduledTaskAdmin"])
			expect(scheduledTaskApprovalView({ ...permission, toolName })).toBeNull();
		const view = scheduledTaskApprovalView(permission);
		expect(view).toMatchObject({
			action: "update",
			elevated: true,
			outsideScope: true,
			timezone: "Asia/Shanghai",
			changed: ["permissionMode"],
		});
		expect(view?.schedule).toMatchObject({ end: { type: "count", count: 4 } });
	});

	test("existing targets show resolved names, inherited fields and execution policy changes", async () => {
		const i18n = createInstance();
		await i18n.init({
			lng: "zh-CN",
			resources: { "zh-CN": { narrator: zh, scheduledTasks: zhSchedule } },
		});
		const input = {
			version: 1,
			action: "update",
			task: {
				...task,
				narratorMode: "existing",
				targetNarratorId: "target_2",
				contextPolicy: "clear",
				onBusy: "interrupt",
				busyWaitMinutes: 30,
				requireReport: false,
				systemPrompt: "inherited private prompt",
			},
			before: {
				...task,
				narratorMode: "existing",
				targetNarratorId: "target_1",
				contextPolicy: "keep",
				onBusy: "skip",
				requireReport: true,
			},
			target: { id: "target_2", title: "目标乙" },
			beforeTarget: { id: "target_1", title: "目标甲" },
			inheritedFields: ["permissionMode", "systemPrompt", "planMode"],
			changed: ["targetNarratorId", "contextPolicy", "onBusy", "requireReport"],
		};
		const html = renderToStaticMarkup(
			<I18nextProvider i18n={i18n}>
				<MantineProvider>
					<ScheduledTaskApproval
						permission={{ ...permission, inputJson: { _scheduledTaskApproval: input } }}
					/>
				</MantineProvider>
			</I18nextProvider>,
		);
		for (const text of [
			"目标甲",
			"target_1",
			"目标乙",
			"target_2",
			zhSchedule.contextClearWarning,
			zhSchedule.busyInterruptWarning,
			zh.scheduledTaskApproval.fields.requireReport,
			zhSchedule.yes,
			zhSchedule.no,
		])
			expect(html).toContain(text);
		expect(html).not.toContain("inherited private prompt");
		expect(html).toContain(zh.scheduledTaskApproval.inheritedValue);
	});
	test.each([
		"en",
		"zh-CN",
	])("%s shows full cadence, authority, target and reviewed differences", async (language) => {
		const i18n = createInstance();
		await i18n.init({
			lng: language,
			fallbackLng: "en",
			resources: {
				en: { narrator: en, scheduledTasks: enSchedule },
				"zh-CN": { narrator: zh, scheduledTasks: zhSchedule },
			},
		});
		const html = renderToStaticMarkup(
			<I18nextProvider i18n={i18n}>
				<MantineProvider>
					<ScheduledTaskApproval permission={permission} />
				</MantineProvider>
			</I18nextProvider>,
		);
		for (const text of [
			"Asia/Shanghai",
			"09:30",
			"16:00",
			"/work/project",
			"provider:model",
			"20",
			"60",
		])
			expect(html).toContain(text);
		const locale = language === "en" ? en : zh;
		expect(html).toContain(locale.scheduledTaskApproval.elevatedTitle);
		expect(html).toContain(locale.scheduledTaskApproval.before);
		expect(html).toContain(locale.scheduledTaskApproval.after);
		expect(html).toContain(locale.scheduledTaskApproval.values.default);
		expect(html).toContain(locale.scheduledTaskApproval.values.bypassPermissions);
		expect(html).toContain(language === "en" ? "4 planned occurrences" : "4 次");
	});
});
