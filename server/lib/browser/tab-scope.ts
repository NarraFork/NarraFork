// 浏览器会话拥有哪些 target。
//
// 隔离 context 整个归一个会话。默认 context 是共享的：有头会话把标签放在这里，才能并进同一个
// 窗口（一个窗口只属于一个 profile）；在用户自己的浏览器里，它还装着用户的标签。会话在其中只拥有
// 自己的根标签和从它打开的弹窗，关闭与弹框处理都不能越过这个范围。

import type { BrowserContext, Target } from "puppeteer-core";

export function isSharedContext(context: BrowserContext): boolean {
	return context.browser().defaultBrowserContext() === context;
}

/** Puppeteer 的 opener() 只查存活 target；创建时保留引用，避免中间弹窗关闭后丢失归属。 */
const openers = new WeakMap<Target, Target>();

/** 必须在新 target 恢复运行前调用，此时 opener 链尚未因 window.close() 断开。 */
export function rememberTargetLineage(target: Target): void {
	for (let current: Target | undefined = target; current; ) {
		const opener: Target | undefined = openers.get(current) ?? current.opener();
		if (opener) openers.set(current, opener);
		current = opener;
	}
}

/** target 自身及其创建时的 opener 链。弱键使已无后代引用的关闭标签可被回收。 */
export function* lineage(target: Target): Generator<Target> {
	rememberTargetLineage(target);
	for (let current: Target | undefined = target; current; current = openers.get(current)) {
		yield current;
	}
}

export function isOpenedFrom(target: Target, root: Target): boolean {
	for (const ancestor of lineage(target)) if (ancestor === root) return true;
	return false;
}

/** 关闭会话拥有的东西：隔离 context 整个关掉；共享 context 只关以 root 为根的标签树。 */
export async function closeTab(context: BrowserContext, root?: Target): Promise<void> {
	if (!root || !isSharedContext(context)) return context.close();
	const owned = context
		.targets()
		.filter((target) => target.type() === "page" && isOpenedFrom(target, root));
	await Promise.all(owned.map(async (target) => (await target.page())?.close()));
}

/**
 * Puppeteer 不公开 CDP target id，重启交接要靠它找回共享 context 里的标签。
 * 与 dialogs.ts 依赖同一个 puppeteer-core 精确版本锁定。
 */
export function targetIdOf(target: Target): string | undefined {
	return (target as Target & { _targetId?: string })._targetId;
}
