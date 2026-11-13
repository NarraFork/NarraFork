/**
 * The identity a session follows when it has no pick of its own.
 *
 * 运行时顺序是「会话 → 会话所在的侧栏文件夹 → 全局默认」，所以"未选"未必跟的是全局：
 * 文件夹设过身份时跟的是那一条。这里只判断该跟谁，文案由各自的命名空间提供。
 */
export interface FollowIdentityCandidate {
	name: string;
}

/** `folder`：跟随会话所在文件夹；`default`：跟随全局默认；`none`：两者都没有。 */
export type FollowIdentityKind = "folder" | "default" | "none";

export function followIdentityKind(
	folderIdentity: FollowIdentityCandidate | null | undefined,
	defaultIdentity: FollowIdentityCandidate | null | undefined,
): FollowIdentityKind {
	if (folderIdentity) return "folder";
	if (defaultIdentity) return "default";
	return "none";
}
