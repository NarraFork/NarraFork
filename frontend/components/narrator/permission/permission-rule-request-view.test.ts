import { describe, expect, test } from "bun:test";
import en from "@frontend/locales/en/narrator.json";
import enSettings from "@frontend/locales/en/settings.json";
import zh from "@frontend/locales/zh-CN/narrator.json";
import zhSettings from "@frontend/locales/zh-CN/settings.json";
import type { PendingPermission } from "@frontend/types/narrator";
import { readPermissionRuleReceipt } from "./PermissionRuleResultNotice";
import { permissionRuleRequestView } from "./permission-rule-request-view";

const request = (input: Record<string, unknown>): PendingPermission => ({
	id: "request",
	toolName: "RequestPermissionRule",
	ownerNarratorId: "owner",
	inputJson: { scope: "narrator", reason: "Required to run checks", ...input },
	executionDeviceId: "frozen-device",
	executionCwd: "/original",
});
describe("permission rule request display", () => {
	test.each([
		{ ruleType: "directoryWhitelist", path: "/repo", accessLevel: "readOnly" },
		{ ruleType: "directoryBlacklist", path: "/secrets", denyLevel: "denyWrite" },
		{ ruleType: "commandWhitelist", pattern: "bun test *" },
		{ ruleType: "commandBlacklist", pattern: "rm *" },
	])("$ruleType preserves exact scope, device and subject, with bilingual wording", (input) => {
		const view = permissionRuleRequestView(request(input));
		expect(view).toMatchObject({
			ruleType: input.ruleType,
			scope: "narrator",
			narratorId: "owner",
			deviceId: "frozen-device",
			reason: "Required to run checks",
		});
		expect(view?.path ?? view?.pattern).toBe("path" in input ? input.path : input.pattern);
		expect(
			en.permissionRuleRequest[input.ruleType as keyof typeof en.permissionRuleRequest],
		).toBeTruthy();
		expect(
			zh.permissionRuleRequest[input.ruleType as keyof typeof zh.permissionRuleRequest],
		).toBeTruthy();
	});
	test("execution binding overrides a misleading live/explicit device and reason is bounded", () => {
		const view = permissionRuleRequestView(
			request({
				ruleType: "directoryWhitelist",
				path: "/repo",
				device: "another-device",
				reason: "x".repeat(3000),
			}),
		);
		expect(view?.deviceId).toBe("frozen-device");
		expect(view?.reason?.length).toBe(2000);
	});
	test.each([
		"readOnly",
		"readWrite",
		"full",
		"denyWrite",
		"denyAll",
	])("directory level %s has wording in both languages", (access) => {
		expect(en.permissionRuleRequest[access as keyof typeof en.permissionRuleRequest]).toBeTruthy();
		expect(zh.permissionRuleRequest[access as keyof typeof zh.permissionRuleRequest]).toBeTruthy();
	});
	test("request wording never claims activation", () => {
		expect(en.permissionRuleRequest.title).toContain("not active yet");
		expect(zh.permissionRuleRequest.title).toContain("尚未生效");
		expect(permissionRuleRequestView({ ...request({}), toolName: "Write" })).toBeNull();
	});
	test("setting explains administrator-only, default-off, bypass-mode and independent strict reflection", () => {
		expect(enSettings.permissionRuleAutoApproveDesc).toContain("off by default");
		expect(enSettings.permissionRuleAutoApproveDesc).toContain("strict reflection");
		expect(zhSettings.permissionRuleAutoApproveDesc).toContain("仅管理员");
		expect(zhSettings.permissionRuleAutoApproveDesc).toContain("全部允许");
		expect(zhSettings.permissionRuleAutoApproveDesc).toContain("不受普通危险反思级别影响");
	});
});
describe("rule activation receipts", () => {
	const base = {
		requestId: "r",
		scope: "narrator",
		deviceId: "frozen-device",
		ruleId: "rule",
		approvalSource: "user",
		approvalUserId: "approver",
		rule: { ruleType: "commandWhitelist", pattern: "bun test *" },
	};
	test.each([
		"applied",
		"alreadyExists",
	])("%s shows exact rule and approval provenance", (status) => {
		expect(readPermissionRuleReceipt(JSON.stringify({ ...base, status }))).toMatchObject({
			...base,
			status,
		});
	});
	test.each([
		"pending",
		"approved",
		"denied",
		"failed",
	])("%s is never represented as active", (status) => {
		expect(readPermissionRuleReceipt({ ...base, status })).toBeNull();
	});
	test("malformed, large, missing-scope and missing-device output is not promoted", () => {
		expect(readPermissionRuleReceipt("{")).toBeNull();
		expect(readPermissionRuleReceipt("x".repeat(32_001))).toBeNull();
		expect(readPermissionRuleReceipt({ ...base, status: "applied", scope: "global" })).toBeNull();
		expect(
			readPermissionRuleReceipt({ ...base, status: "applied", deviceId: undefined }),
		).toBeNull();
	});
});
