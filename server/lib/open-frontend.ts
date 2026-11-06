import { existsSync } from "node:fs";
import { CHROMIUM_PATHS } from "../../shared/browser-paths";
import { IS_MACOS, IS_WINDOWS } from "./platform";
import { settings } from "./settings";
import { shellExecute } from "./shell-exec";

const OPENED_URL = Symbol.for("narrafork.frontendOpenedUrl");
const opened = globalThis as { [OPENED_URL]?: string };

/**
 * Open NarraFork the way `server.openBrowser` asks, once per process and address.
 *
 * Called when the startup page starts listening and again once the server is up, so the browser
 * opens as early as there is something to show; the page then reloads itself into the app. When
 * the server ends up elsewhere (the port was taken, or the LAN host fell back to localhost) the
 * first page has nothing left to talk to, so the new address is opened too. The Windows manager
 * opens the browser itself (it focuses an existing window first), so a server it supervises
 * never does.
 *
 * `explicit` is for a person asking to open it (starting the app again while it runs): "off" only
 * stops the automatic open at startup, the same rule the manager follows.
 *
 * Returns whether a browser is being opened.
 */
export function openFrontendOnce(url: string, options: { explicit?: boolean } = {}): boolean {
	if (process.env.NARRAFORK_MANAGER_MANAGED === "1") return false;
	const mode = settings.server.openBrowser;
	if (mode === "off" && !options.explicit) return false;
	if (opened[OPENED_URL] === url) return false;
	opened[OPENED_URL] = url;
	if (mode === "app") void openAsApp(url);
	else openInBrowser(url);
	return true;
}

/** Open a URL in the user's default browser. */
function openInBrowser(url: string) {
	// Windows 走 ShellExecuteW：不经 cmd start，避免偶尔闪出的控制台窗口。
	if (IS_WINDOWS) {
		if (shellExecute(url)) return;
	}
	try {
		if (IS_MACOS) {
			Bun.spawn(["open", url], { stdio: ["ignore", "ignore", "ignore"] });
		} else if (!IS_WINDOWS) {
			Bun.spawn(["xdg-open", url], { stdio: ["ignore", "ignore", "ignore"] });
		}
	} catch {
		// Not critical — user can open manually
	}
}

async function openAsApp(url: string) {
	// Windows 上 Edge/Chrome 不在 PATH 里（Bun.which 找不到），按标准安装路径探测；
	// 直接 spawn 绝对路径，避免经 cmd start 时参数被重新解析。
	if (IS_WINDOWS) {
		const browser = CHROMIUM_PATHS.find((path) => existsSync(path));
		if (browser) {
			try {
				Bun.spawn([browser, `--app=${url}`], {
					stdio: ["ignore", "ignore", "ignore"],
					windowsHide: true,
				});
				return;
			} catch {
				// 落到默认浏览器兜底
			}
		}
		openInBrowser(url);
		return;
	}

	const candidates: { program: string; args: string[] }[] = IS_MACOS
		? [
				{ program: "open", args: ["-a", "Google Chrome", url, "--args", `--app=${url}`] },
				{ program: "open", args: ["-a", "Microsoft Edge", url, "--args", `--app=${url}`] },
				{ program: "open", args: ["-a", "Chromium", url, "--args", `--app=${url}`] },
			]
		: [
				{ program: "google-chrome", args: [`--app=${url}`] },
				{ program: "google-chrome-stable", args: [`--app=${url}`] },
				{ program: "chromium", args: [`--app=${url}`] },
				{ program: "chromium-browser", args: [`--app=${url}`] },
				{ program: "microsoft-edge", args: [`--app=${url}`] },
			];

	for (const { program, args } of candidates) {
		try {
			const proc = Bun.spawn([program, ...args], {
				stdio: ["ignore", "ignore", "ignore"],
				windowsHide: true,
			});
			// Give it a moment to fail (e.g. command not found)
			const timeout = new Promise<null>((r) => setTimeout(() => r(null), 300));
			const result = await Promise.race([proc.exited, timeout]);
			if (result !== null && result !== 0) continue;
			return;
		} catch {}
	}
	// All --app candidates failed, fall back to default browser
	openInBrowser(url);
}
