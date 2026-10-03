import { describe, expect, it } from "bun:test";
import en from "../../locales/en/routines.json";
import zh from "../../locales/zh-CN/routines.json";
import { NotificationSendPermissionSwitch } from "../../routes/routines/tool-permissions";

function control(overrides: { allowSend?: boolean; isAdmin?: boolean; pending?: boolean } = {}) {
	const changes: boolean[] = [];
	const element = NotificationSendPermissionSwitch({
		allowSend: false,
		isAdmin: true,
		pending: false,
		t: (key) => key,
		onChange: (checked) => changes.push(checked),
		...overrides,
	});
	return {
		props: element.props,
		changes,
		change: (checked: boolean) => element.props.onChange({ currentTarget: { checked } }),
	};
}

describe("Notification send pre-authorization control", () => {
	it("starts unchecked and immediately forwards administrator changes", () => {
		const view = control();
		expect(view.props.checked).toBe(false);
		expect(view.props.disabled).toBe(false);
		view.change(true);
		view.change(false);
		expect(view.changes).toEqual([true, false]);
	});

	it("reflects saved settings on every render rather than keeping a stale draft", () => {
		expect(control({ allowSend: true }).props.checked).toBe(true);
		expect(control({ allowSend: false }).props.checked).toBe(false);
	});

	it.each([{ isAdmin: false }, { pending: true }])("blocks changes for %j", (state) => {
		const view = control(state);
		expect(view.props.disabled).toBe(true);
		view.change(true);
		expect(view.changes).toEqual([]);
	});

	it("uses matching bilingual permission labels and explicit guardrail descriptions", () => {
		const view = control();
		expect(view.props.label).toBe("tpNotificationAllowSend");
		expect(view.props.description).toBe("tpNotificationAllowSendDesc");
		for (const translation of [en, zh]) {
			expect(translation.tpNotificationAllowSend).toBeTruthy();
			expect(translation.tpNotificationAllowSendDesc).toContain("user_id");
			expect(translation.tpNotificationAllowSendDesc).toContain("username");
		}
		expect(en.tpNotificationAllowSendDesc).toContain("Off by default");
		expect(en.tpNotificationAllowSendDesc).toContain("without approval for each send");
		expect(en.tpNotificationAllowSendDesc).toContain("Read-only and strict plan");
		expect(zh.tpNotificationAllowSendDesc).toContain("默认关闭");
		expect(zh.tpNotificationAllowSendDesc).toContain("无需逐次审批");
		expect(zh.tpNotificationAllowSendDesc).toContain("只读与严格计划");
	});
});
