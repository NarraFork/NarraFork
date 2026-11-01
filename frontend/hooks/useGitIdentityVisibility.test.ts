import { describe, expect, test } from "bun:test";
import { gitIdentityVisibilityFrom } from "./useGitIdentityVisibility";

describe("git identity visibility", () => {
	test("偏好缺失时两个入口都关闭", () => {
		expect(gitIdentityVisibilityFrom(undefined)).toEqual({
			contextMenu: false,
			createModal: false,
		});
		expect(gitIdentityVisibilityFrom(null)).toEqual({ contextMenu: false, createModal: false });
		expect(gitIdentityVisibilityFrom({})).toEqual({ contextMenu: false, createModal: false });
	});

	test("两个开关互相独立", () => {
		expect(gitIdentityVisibilityFrom({ gitIdentityContextMenu: true })).toEqual({
			contextMenu: true,
			createModal: false,
		});
		expect(gitIdentityVisibilityFrom({ gitIdentityCreateModal: true })).toEqual({
			contextMenu: false,
			createModal: true,
		});
		expect(
			gitIdentityVisibilityFrom({
				gitIdentityContextMenu: true,
				gitIdentityCreateModal: true,
			}),
		).toEqual({ contextMenu: true, createModal: true });
	});
});
