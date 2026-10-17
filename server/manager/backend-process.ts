import { AUTO_LAN_HOST, isWildcardHost, urlHost } from "@shared/server-host";
import { MANAGER_TOKEN_ENV } from "../lib/manager-token";
import { getLanAddresses } from "../lib/net/lan-addresses";
import { isCompiledRuntime } from "../lib/runtime-target";
import { parseServiceLogLine } from "./listen-log";
import { t } from "./manager-i18n";

export type BackendState = "stopped" | "starting" | "running" | "stopping" | "error";

export interface ListenTarget {
	host: string;
	port: number;
	tls: boolean;
}

export interface BackendProcessOptions extends ListenTarget {
	/** 只放进服务子进程的环境变量，不写进面板自己的 process.env。 */
	managerToken: string;
	/** 子进程的每一行输出（已去掉行尾）。 */
	onLine: (line: string) => void;
	/** 状态变化；`detail` 用于异常退出等需要说明的情形。 */
	onState: (state: BackendState, detail?: string) => void;
}

/** 健康检查间隔与启动超时。 */
const READY_POLL_MS = 700;
const READY_TIMEOUT_MS = 90_000;
/** 等待服务自报监听地址的上限；超过后回退到配置端口探测，避免解析失败时一路悬空。 */
const ADDRESS_WAIT_MS = 15_000;
/** 优雅停止之后，进程仍在就结束整棵进程树。 */
const GRACEFUL_STOP_MS = 15_000;

/**
 * 健康检查用的本地探测地址。
 *
 * settings 里的 host 可以是 0.0.0.0 / ::（监听所有网卡）或 auto-lan（监听第一个
 * 局域网地址），它们都不能作为请求目标；IPv6 字面量还要加方括号。修正后才能得到
 * 能真正连通的地址。
 */
function probeHost(host: string): string {
	if (isWildcardHost(host)) return "127.0.0.1";
	if (host === AUTO_LAN_HOST) return getLanAddresses()[0] ?? "127.0.0.1";
	return urlHost(host);
}

/** 探测给定地址上是否已有 NarraFork 服务在响应（供识别外部启动的实例）。 */
export async function probeServiceHealth(
	host: string,
	port: number,
	tls = false,
): Promise<boolean> {
	try {
		const response = await fetch(
			`${tls ? "https" : "http"}://${probeHost(host)}:${port}/api/health`,
			{
				signal: AbortSignal.timeout(1500),
				// 本机自签证书只用于这一次健康检查。
				tls: { rejectUnauthorized: false },
			},
		);
		return response.ok;
	} catch {
		return false;
	}
}

/** 数据目录：直接复用 server 侧实现 —— 环境变量约定只能有一处。 */
export { getNarraforkHome as resolveNarraforkHome } from "../lib/narrafork-home";

export class BackendProcess {
	private child?: Bun.Subprocess<"pipe", "pipe", "pipe">;
	private state: BackendState = "stopped";
	/** 可中断等待的唤醒句柄：stop/dispose 用它立刻结束 waitUntilReady 的 sleep。 */
	private sleepResolve?: () => void;
	private disposed = false;
	private target: ListenTarget;

	constructor(private readonly options: BackendProcessOptions) {
		this.target = { host: options.host, port: options.port, tls: options.tls };
	}

	get current(): BackendState {
		return this.state;
	}

	/** 服务当前监听的端口（未观测到时为配置值）。 */
	get listeningPort(): number {
		return this.probePort();
	}

	/** 服务实际监听的主机名（未解析到时为配置值）。 */
	get listeningHost(): string {
		return this.observedHost ?? this.target.host;
	}

	/** 健康检查和打开面板使用的协议。日志里出现 https 时以日志为准。 */
	get listeningTls(): boolean {
		if (this.observedProtocol) return this.observedProtocol === "https";
		return this.target.tls;
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	/**
	 * 用户改了监听配置。清掉上一次观测，面板立刻按新目标显示；
	 * 服务重绑后的 `running on` 日志会再把实际地址写回来。
	 */
	setTarget(next: ListenTarget): void {
		const changed =
			next.host !== this.target.host ||
			next.port !== this.target.port ||
			next.tls !== this.target.tls;
		this.target = { host: next.host, port: next.port, tls: next.tls };
		if (!changed) return;
		this.observedHost = undefined;
		this.observedPort = 0;
		this.observedProtocol = undefined;
	}

	/** 按当前观测地址做一次健康检查。 */
	checkHealth(): Promise<boolean> {
		return probeServiceHealth(this.listeningHost, this.listeningPort, this.listeningTls);
	}

	private setState(state: BackendState, detail?: string): void {
		this.state = state;
		this.options.onState(state, detail);
	}

	/** 启动后端；已在运行时直接返回。 */
	async start(): Promise<void> {
		if (this.child || this.disposed) return;
		this.lockConflictPid = undefined;
		this.observedHost = undefined;
		this.observedPort = 0;
		this.observedProtocol = undefined;
		this.setState("starting");
		const args = isCompiledRuntime() ? ["--serve"] : ["server/index.ts", "--serve"];
		try {
			this.child = Bun.spawn([process.execPath, ...args], {
				cwd: process.cwd(),
				windowsHide: true,
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					NARRAFORK_MANAGER_MANAGED: "1",
					[MANAGER_TOKEN_ENV]: this.options.managerToken,
				},
			});
		} catch (error) {
			this.setState("error", error instanceof Error ? error.message : String(error));
			return;
		}

		const child = this.child;
		void this.pipeLines(child.stdout, "stdout");
		void this.pipeLines(child.stderr, "stderr");

		void child.exited.then((code) => {
			if (this.child !== child) return;
			this.child = undefined;
			if (this.disposed) return;
			// 主动停止走的是 stop() 的路径；这里只处理"自己退出"。
			this.setState("stopped", code === 0 ? undefined : t("error.exitedWithCode", { code }));
		});

		await this.waitUntilReady();
	}

	/**
	 * 服务实际监听的端口。
	 *
	 * 启动时目标端口被占用的话，服务会自动换一个可用端口（自身 fallback），此时按
	 * 配置端口做健康检查会永远失败、状态卡在"启动中"；以服务输出里的真实地址为准。
	 */
	private observedPort = 0;

	/** 服务实际监听的主机名（`running on` 那一行里的值）。 */
	private observedHost: string | undefined;

	private observedProtocol: "http" | "https" | undefined;

	/**
	 * 实例锁冲突：同一数据目录已有另一个 NarraFork 在运行（服务输出会报出持有者 PID）。
	 * 每次 start() 清空，否则上一次冲突会让随后的启动立刻失败。
	 */
	private lockConflictPid: number | undefined;

	/** 健康检查应使用的端口。 */
	private probePort(): number {
		return this.observedPort > 0 ? this.observedPort : this.target.port;
	}

	/** 从服务输出里解析实际监听地址与实例锁冲突。 */
	private observeListenerAddress(line: string): void {
		const event = parseServiceLogLine(line);
		if (!event) return;
		if (event.kind === "lock") {
			this.lockConflictPid = event.pid;
			return;
		}
		this.observedProtocol = event.protocol;
		this.observedHost = event.host;
		this.observedPort = event.port;
	}

	/** 轮询健康检查直到就绪；超时只报状态，不杀进程（服务可能仍在慢启动）。 */
	private async waitUntilReady(): Promise<void> {
		const deadline = Date.now() + READY_TIMEOUT_MS;
		const startedAt = Date.now();
		while (Date.now() < deadline) {
			// 实例锁冲突：服务会立即退出，直接给出原因，不必等超时。
			if (this.lockConflictPid !== undefined) {
				this.setState("error", t("error.instanceLockConflict", { pid: this.lockConflictPid }));
				return;
			}
			if (!this.child) return;
			// 先等服务自己报告监听地址再探测端口：直接探测会把"已在运行的外部实例"
			// 误当成刚启动的这个（表现为瞬间 running，随后子进程因锁冲突退出）。
			// 等待有上限：地址解析失败时必须回退到配置端口，否则会悬空到启动超时。
			if (this.observedPort <= 0 && Date.now() - startedAt < ADDRESS_WAIT_MS) {
				await this.sleep(READY_POLL_MS);
				continue;
			}
			if (await this.checkHealth()) {
				this.setState("running");
				return;
			}
			await this.sleep(READY_POLL_MS);
		}
		if (this.child) this.setState("error", t("error.readyTimeout"));
	}

	/** 可中断等待：stop/dispose 会立即唤醒，避免启动流程卡在定时器上。 */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.sleepResolve = undefined;
				resolve();
			}, ms);
			this.sleepResolve = () => {
				clearTimeout(timer);
				this.sleepResolve = undefined;
				resolve();
			};
		});
	}

	private interruptSleep(): void {
		this.sleepResolve?.();
	}

	/** 逐块解码子进程输出并按行回调；流结束时冲掉最后的不完整行。 */
	private async pipeLines(
		stream: ReadableStream<Uint8Array> | undefined,
		channel: "stdout" | "stderr",
	): Promise<void> {
		if (!stream) return;
		const decoder = new TextDecoder();
		let buffer = "";
		const reader = stream.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split(/\r?\n/);
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (line.length > 0) {
						// 监听地址走 stdout（logger.info），实例锁冲突走 stderr（未捕获错误），两边都要看。
						this.observeListenerAddress(line);
						this.options.onLine(channel === "stderr" ? `! ${line}` : line);
					}
				}
			}
			if (buffer.length > 0) this.options.onLine(buffer);
		} catch {
			// 子进程被终止时流会中断，属正常路径。
		} finally {
			reader.releaseLock();
		}
	}

	/**
	 * 停止后端并等待进程真正退出。
	 *
	 * `graceful` 时先等进程自己退出（调用方应已请求 HTTP 关闭），超时再结束进程树。
	 */
	async stop(options?: { graceful?: boolean }): Promise<void> {
		const child = this.child;
		if (!child) {
			this.setState("stopped");
			return;
		}
		this.setState("stopping");
		this.child = undefined;
		this.interruptSleep();
		if (options?.graceful) {
			const exited = await Promise.race([
				child.exited.then(() => true),
				this.sleep(GRACEFUL_STOP_MS).then(() => false),
			]);
			if (!exited) this.forceKill(child);
		} else {
			this.forceKill(child);
		}
		await child.exited.catch(() => undefined);
		this.setState("stopped");
	}

	async restart(): Promise<void> {
		await this.stop({ graceful: true });
		await this.start();
	}

	/** 管理器退出时调用：不等待、不回报状态。 */
	dispose(): void {
		this.disposed = true;
		this.interruptSleep();
		const child = this.child;
		this.child = undefined;
		if (child) this.forceKill(child);
	}

	private forceKill(child: Bun.Subprocess): void {
		if (process.platform === "win32" && child.pid) {
			Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(child.pid)], {
				stdout: "ignore",
				stderr: "ignore",
				windowsHide: true,
			});
		}
		try {
			child.kill();
		} catch {
			// 进程已经退出。
		}
	}
}
