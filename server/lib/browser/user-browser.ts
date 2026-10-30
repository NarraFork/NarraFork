// 连上用户自己的浏览器（默认 profile），让有头会话以新标签出现在用户窗口里。
//
// 唯一可行的入口是 chrome://inspect/#remote-debugging（Edge 为 edge://inspect）里的
// 「允许远程调试」开关：它写进 Local State 并跨重启保留，浏览器随即在默认 profile 上开启调试服务、
// 把端口写进 DevToolsActivePort，且每个连接都要用户在浏览器里点「允许」。命令行
// --remote-debugging-port 做不到：浏览器已在运行时启动参数被转交给原实例而作废，Chrome 136+
// 还会对默认 profile 直接忽略它。

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "puppeteer-core";
import { logger } from "../logger";

/** 等用户在浏览器里点「允许」的时间。 */
const APPROVAL_TIMEOUT_MS = 60_000;
/** 拉起浏览器后等待调试服务就绪的时间。 */
const STARTUP_TIMEOUT_MS = 15_000;
/**
 * 短于此即视为浏览器自动拒绝而非用户点了取消：没有窗口可以挂确认框时（例如 Edge 的启动加速
 * 只在后台常驻），浏览器会立即拒绝连接。
 */
const INSTANT_REJECTION_MS = 1_000;
const RETRY_INTERVAL_MS = 500;

/** 用户是否在 inspect 页打开了「允许远程调试」。 */
async function remoteDebuggingEnabled(userDataDir: string): Promise<boolean> {
	try {
		const state = JSON.parse(await readFile(join(userDataDir, "Local State"), "utf8"));
		return state?.devtools?.remote_debugging?.["user-enabled"] === true;
	} catch {
		return false;
	}
}

/** DevToolsActivePort 首行为端口、次行为 browser target 路径；浏览器崩溃后可能残留过期内容。 */
async function readActiveEndpoint(userDataDir: string): Promise<string | undefined> {
	try {
		const [port, path] = (await readFile(join(userDataDir, "DevToolsActivePort"), "utf8"))
			.split("\n")
			.map((line) => line.trim());
		return port && path ? `ws://127.0.0.1:${port}${path}` : undefined;
	} catch {
		return undefined;
	}
}

async function connectWithin(endpoint: string, timeoutMs: number): Promise<Browser> {
	const puppeteer = await import("puppeteer-core");
	const connecting = puppeteer.default.connect({
		browserWSEndpoint: endpoint,
		// 用户已有的标签不能被套上模拟视口
		defaultViewport: null,
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			// 超时后用户才点允许：把迟到的连接断开，不留悬空连接
			void connecting.then((late) => late.disconnect()).catch(() => {});
			reject(new Error("Timed out waiting for the browser to allow the connection"));
		}, timeoutMs);
	});
	try {
		return await Promise.race([connecting, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** 像用户双击图标一样打开浏览器：默认 profile、不带任何调试参数。 */
function startBrowser(executablePath: string): void {
	const child = spawn(executablePath, [], { detached: true, stdio: "ignore" });
	child.once("error", (error) => {
		logger.warn("Failed to start the user's browser", { error: String(error) });
	});
	child.unref();
}

/**
 * 连上用户自己的浏览器（profile 位于 userDataDir），必要时先把它打开。
 *
 * 没开「允许远程调试」、用户拒绝或超时未确认时返回 undefined，调用方改用独立窗口。
 */
export async function attachUserBrowser(
	executablePath: string,
	userDataDir: string,
): Promise<Browser | undefined> {
	if (!(await remoteDebuggingEnabled(userDataDir))) return undefined;

	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	let started = false;
	for (;;) {
		const endpoint = await readActiveEndpoint(userDataDir);
		const attemptStart = Date.now();
		try {
			if (endpoint) return await connectWithin(endpoint, APPROVAL_TIMEOUT_MS);
		} catch (error) {
			// 确认框真的弹出过（用户拒绝或超时），就尊重这个结果
			if (Date.now() - attemptStart >= INSTANT_REJECTION_MS) {
				logger.info("The user's browser did not allow the connection", { error: String(error) });
				return undefined;
			}
		}
		// 浏览器没开、只在后台常驻，或端口文件已过期：打开一个窗口再重试
		if (!started) {
			startBrowser(executablePath);
			started = true;
		}
		if (Date.now() > deadline) {
			logger.warn("The user's browser did not become reachable for debugging", { userDataDir });
			return undefined;
		}
		await Bun.sleep(RETRY_INTERVAL_MS);
	}
}
