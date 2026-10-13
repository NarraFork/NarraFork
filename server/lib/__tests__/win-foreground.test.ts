import { expect, test } from "bun:test";
import { raiseExplorerWindowByTitle } from "../win-foreground";

/**
 * 只验证"找不到窗口时静默返回"这条路径：它会真正走一遍 user32 的 dlopen 与
 * EnumWindows 回调（在 Windows 上），因此能挡住 FFI 类型写错这类低级错误，
 * 又不会激活任何真实窗口去抢焦点。
 */
test("空标题与不存在的窗口都静默返回，不抛异常", () => {
	expect(() => raiseExplorerWindowByTitle("")).not.toThrow();
	expect(() => raiseExplorerWindowByTitle("__narrafork_missing_window_probe__")).not.toThrow();
});
