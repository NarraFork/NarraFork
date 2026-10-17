/**
 * 是否进入图形化管理器，而不是直接跑 HTTP 服务。
 *
 * 编译后的 Windows exe 双击即开面板；`bun run dev` / `bun run start` 仍直接起服务。
 * 开发面板时显式加 `--manager`。`--serve` 永远是服务进程（管理器拉起的子进程也走它）。
 */
export function shouldRunManager(input: {
	argv: readonly string[];
	platform: string;
	compiled: boolean;
}): boolean {
	if (input.platform !== "win32") return false;
	if (input.argv.includes("--serve")) return false;
	if (input.argv.includes("--manager")) return true;
	return input.compiled;
}
