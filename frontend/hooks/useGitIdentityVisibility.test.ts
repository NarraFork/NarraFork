import { describe, expect, test } from "bun:test";
import { gitIdentityVisibilityFrom } from "./useGitIdentityVisibility";

const OFF = { contextMenu: false, createModal: false, folderContextMenu: false };

describe("git identity visibility", () => {
	test("偏好缺失时三个入口都关闭", () => {
		expect(gitIdentityVisibilityFrom(undefined)).toEqual(OFF);
		expect(gitIdentityVisibilityFrom(null)).toEqual(OFF);
		expect(gitIdentityVisibilityFrom({})).toEqual(OFF);
	});

	test("三个开关互相独立", () => {
		expect(gitIdentityVisibilityFrom({ gitIdentityContextMenu: true })).toEqual({
			...OFF,
			contextMenu: true,
		});
		expect(gitIdentityVisibilityFrom({ gitIdentityCreateModal: true })).toEqual({
			...OFF,
			createModal: true,
		});
		expect(gitIdentityVisibilityFrom({ gitIdentityFolderContextMenu: true })).toEqual({
			...OFF,
			folderContextMenu: true,
		});
		expect(
			gitIdentityVisibilityFrom({
				gitIdentityContextMenu: true,
				gitIdentityCreateModal: true,
				gitIdentityFolderContextMenu: true,
			}),
		).toEqual({ contextMenu: true, createModal: true, folderContextMenu: true });
	});
});
