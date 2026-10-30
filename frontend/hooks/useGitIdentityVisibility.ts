/**
 * 哪些界面显示 Git 提交身份入口。
 *
 * 这是「本人在账号上想看到什么」的显示偏好，跟账号走而不是跟浏览器走：身份本身存在服务端并按
 * 用户 × 会话绑定，这里只决定入口出现在哪些界面。存进 `user_preferences`，同一账号换浏览器、
 * 换设备都一致；默认全部关闭，两个开关互相独立。
 */

import { useUpdateUserPreferences, useUserPreferences } from "./useUserPreferences";

export interface GitIdentityVisibility {
	/** 叙述者列表（左侧边栏）中会话的右键菜单。 */
	contextMenu: boolean;
	/** 新建会话弹窗右侧、默认模型下方。 */
	createModal: boolean;
}

export interface GitIdentityVisibilitySource {
	gitIdentityContextMenu?: boolean | null;
	gitIdentityCreateModal?: boolean | null;
}

/** 缺失（还没加载、或该账号没有偏好行）一律按关闭处理，两个开关互不影响。 */
export function gitIdentityVisibilityFrom(
	source: GitIdentityVisibilitySource | null | undefined,
): GitIdentityVisibility {
	return {
		contextMenu: source?.gitIdentityContextMenu ?? false,
		createModal: source?.gitIdentityCreateModal ?? false,
	};
}

export function useGitIdentityVisibility(): GitIdentityVisibility & {
	setContextMenu: (value: boolean) => void;
	setCreateModal: (value: boolean) => void;
} {
	const { data } = useUserPreferences();
	const update = useUpdateUserPreferences();

	return {
		...gitIdentityVisibilityFrom(data),
		setContextMenu: (value) => update.mutate({ gitIdentityContextMenu: value }),
		setCreateModal: (value) => update.mutate({ gitIdentityCreateModal: value }),
	};
}
