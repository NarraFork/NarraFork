/**
 * 基于 tree-sitter AST 的 Bash 命令分析模块
 *
 * 解析 bash 命令字符串，提取所有子命令、文件路径，
 * 并根据白名单 + 危险模式检测判断是否可以自动放行。
 */
import { resolve } from "node:path";

// ── 类型定义 ──────────────────────────────────────────────

export interface BashAnalysis {
	/** 解析出的每条子命令 */
	commands: Array<{
		/** 命令 token 列表，如 ["git", "checkout"] */
		tokens: string[];
		/** 命令节点文本 */
		text: string;
		/** 包含重定向的完整文本 */
		fullText: string;
	}>;
	/** 文件操作命令中提取的路径参数 */
	filePaths: string[];
	/** 是否所有命令都在白名单中 */
	allWhitelisted: boolean;
	/** 不在白名单中的命令名列表 */
	nonWhitelisted: string[];
	/** 检测到的危险模式描述 */
	dangerousPatterns: string[];
	/** 是否检测到环境变量注入 */
	hasEnvInjection: boolean;
	/** 是否为灾难性命令 — 即使 bypassPermissions 也必须 deny + 终止 loop */
	isCatastrophic: boolean;
	/** 灾难性命令的原因描述 */
	catastrophicReason?: string;
}

// ── 白名单 ────────────────────────────────────────────────

/**
 * 纯只读 / 无副作用命令 — 可自动放行。
 * 注意：任何能执行子命令、写文件、或加载动态库的命令都不应在此列表中。
 */
const SAFE_COMMANDS = new Set([
	// 版本控制
	"git",
	// 文件浏览（只读）
	"ls",
	"pwd",
	"cat",
	"head",
	"tail",
	"wc",
	"less",
	"more",
	// 搜索（只读）
	"grep",
	"rg",
	"ag",
	"fd",
	// 输出
	"echo",
	"printf",
	// 路径工具（只读）
	"basename",
	"dirname",
	"realpath",
	"readlink",
	// 文件信息（只读）
	"stat",
	"file",
	"which",
	"type",
	"command",
	// 系统信息（只读）
	"date",
	"whoami",
	"uname",
	"hostname",
	"id",
	"uptime",
	// 文本处理（只读，无 -i）
	"sort",
	"uniq",
	"diff",
	"tr",
	"cut",
	"paste",
	"column",
	"rev",
	"tac",
	"nl",
	"seq",
	"yes",
	// 类型检查工具
	"tsc",
	"eslint",
	"prettier",
	"biome",
	// shell 内建（无副作用）
	"test",
	"true",
	"false",
	"[",
	"[[",
	// 目录操作
	"cd",
	"pushd",
	"popd",
	// 环境查看（只读）
	"printenv",
	// JSON
	"jq",
	// 运行时 / 构建工具（危险参数由 CONDITIONAL_COMMANDS 检测）
	"node",
	"python",
	"python3",
	"go",
	"cargo",
	"bun",
	"bunx",
	"npm",
	"npx",
	"yarn",
	"pnpm",
	"pip",
	"pip3",
	"make",
	// 文件操作（路径由 PATH_COMMANDS 提取，外部路径由 isInsideWorktree 拦截）
	"cp",
	"mv",
	"mkdir",
	"touch",
	// 网络（pipe-to-shell 由 detectPipeToShell 检测）
	"curl",
	"wget",
	// 文本处理（危险参数由 CONDITIONAL_COMMANDS 检测）
	"sed",
	"awk",
	"gawk",
	"find",
	// 压缩
	"tar",
	"zip",
	"unzip",
	"gzip",
	"gunzip",
]);

/** 始终需要用户确认的命令 */
const ALWAYS_ASK_COMMANDS = new Set([
	// 删除
	"rm",
	"rmdir",
	"shred",
	// 权限提升
	"sudo",
	"su",
	"doas",
	"pkexec",
	// 权限修改
	"chmod",
	"chown",
	"chgrp",
	// 进程管理
	"kill",
	"killall",
	"pkill",
	// 磁盘/分区
	"dd",
	"mkfs",
	"fdisk",
	"parted",
	"mount",
	"umount",
	// 系统控制
	"reboot",
	"shutdown",
	"halt",
	"poweroff",
	"systemctl",
	"service",
	// 防火墙
	"iptables",
	"ip6tables",
	"nft",
	"ufw",
	// 代码执行
	"eval",
	"exec",
	// Shell 嵌套执行 — 可以 -c 执行任意命令或通过 pipe/heredoc 接收恶意输入
	"bash",
	"sh",
	"zsh",
	"fish",
	"dash",
	"ksh",
	"csh",
	"tcsh",
	// 间接命令执行
	"env",
	"nohup",
	"timeout",
	"strace",
	"ltrace",
	"nice",
	"ionice",
	"chroot",
	// 远程执行
	"ssh",
	"scp",
	"rsync",
	// 容器（可挂载宿主文件系统）
	"docker",
	"docker-compose",
	"podman",
	"kubectl",
	// 间接命令执行
	"xargs",
	// 脚本解释器（可 -e/-c 执行任意代码）
	"perl",
	"ruby",
	"lua",
	"php",
	// source / dot（执行外部脚本）
	"source",
	".",
	// 别名（可重定义命令语义）
	"alias",
	"unalias",
	// crontab
	"crontab",
	"at",
	"batch",
]);

/**
 * 条件安全命令 — 在白名单中但某些参数组合是危险的。
 * key: 命令名, value: 危险参数检测函数
 */
const CONDITIONAL_COMMANDS: Record<string, (tokens: string[], fullText: string) => string | null> =
	{
		// node -e / --eval / --input-type / -p 可以执行任意 JS
		node: (tokens) => {
			const dangerous = ["-e", "--eval", "-p", "--print", "-"];
			if (tokens.some((t) => dangerous.includes(t) || t.startsWith("--input-type")))
				return "node with code execution flag";
			return null;
		},
		// python/python3 -c 可以执行任意代码
		python: (tokens) => {
			if (tokens.includes("-c") || tokens.includes("-")) return "python with -c flag";
			return null;
		},
		python3: (tokens) => {
			if (tokens.includes("-c") || tokens.includes("-")) return "python3 with -c flag";
			return null;
		},
		// npm/npx — postinstall 脚本可以执行任意代码，但这是正常开发流程
		// 只拦截明确的 exec
		npm: (tokens) => {
			if (tokens.includes("exec")) return "npm exec";
			return null;
		},
		// pip install 可以执行 setup.py
		pip: (tokens) => {
			if (
				tokens.includes("install") &&
				tokens.some((t) => t.startsWith("--target") || t.startsWith("-t"))
			)
				return "pip install with custom target";
			return null;
		},
		pip3: (tokens) => {
			if (
				tokens.includes("install") &&
				tokens.some((t) => t.startsWith("--target") || t.startsWith("-t"))
			)
				return "pip3 install with custom target";
			return null;
		},
		// go run 可以执行任意代码
		go: (tokens) => {
			if (tokens.includes("run")) return "go run";
			return null;
		},
		// cargo run 可以执行任意代码
		cargo: (tokens) => {
			if (tokens.includes("run")) return "cargo run";
			return null;
		},
		// bun run 可以执行任意代码（但 bun run dev 等是正常开发流程）
		// bun -e 可以执行任意代码
		bun: (tokens) => {
			if (tokens.includes("-e") || tokens.includes("--eval")) return "bun with -e flag";
			return null;
		},
		bunx: (_tokens) => null,
		// find -exec / -execdir 可以执行任意命令
		find: (tokens) => {
			if (tokens.some((t) => t === "-exec" || t === "-execdir" || t === "-ok" || t === "-okdir"))
				return "find with -exec";
			return null;
		},
		// sed -i 可以修改文件
		sed: (tokens) => {
			if (tokens.includes("-i") || tokens.some((t) => t.startsWith("-i")))
				return "sed with -i (in-place edit)";
			return null;
		},
		// awk 可以通过 system() 执行命令
		awk: (_tokens, fullText) => {
			if (fullText.includes("system(") || fullText.includes("| getline"))
				return "awk with system()/getline";
			return null;
		},
		gawk: (_tokens, fullText) => {
			if (fullText.includes("system(") || fullText.includes("| getline"))
				return "gawk with system()/getline";
			return null;
		},
		// tee 可以写入任意文件
		tee: (_tokens) => {
			// tee 总是写文件，标记为危险
			return "tee (writes to files)";
		},
		// curl/wget — 下载本身不危险，但 pipe 到 shell 是（在 pipeline 检测中处理）
		curl: (_tokens) => null,
		wget: (_tokens) => null,
		// tar 可以覆盖文件
		tar: (tokens) => {
			if (
				tokens.some(
					(t) =>
						t === "-x" ||
						t === "--extract" ||
						// 短选项组合如 xzf, xf, -xzf
						(t.startsWith("-") && t.includes("x")) ||
						(!t.startsWith("-") && t !== "tar" && /^[a-zA-Z]*x[a-zA-Z]*$/.test(t)),
				)
			)
				return "tar extract (may overwrite files)";
			return null;
		},
		// cp/mv/mkdir/touch — 文件操作，保留在条件安全中
		cp: (_tokens) => null,
		mv: (_tokens) => null,
		mkdir: (_tokens) => null,
		touch: (_tokens) => null,
		// make — 可以执行任意命令，但是正常开发流程
		make: (_tokens) => null,
		// diff — 只读
		diff: (_tokens) => null,
		// zip/unzip/gzip/gunzip — 压缩解压
		zip: (_tokens) => null,
		unzip: (_tokens) => null,
		gzip: (_tokens) => null,
		gunzip: (_tokens) => null,
		// yarn/pnpm — 包管理器
		yarn: (_tokens) => null,
		pnpm: (_tokens) => null,
		npx: (_tokens) => null,
	};

/** 需要提取路径参数的命令（写操作） */
const PATH_COMMANDS_WRITE = new Set(["rm", "cp", "mv", "mkdir", "touch", "chmod", "chown"]);

/** 需要提取路径参数的命令（读操作 + 目录浏览） */
const PATH_COMMANDS_READ = new Set([
	"cd",
	"cat",
	"ls",
	"head",
	"tail",
	"less",
	"more",
	"stat",
	"file",
	"find",
	"grep",
	"rg",
	"ag",
	"fd",
	"wc",
]);

/** 所有需要路径提取的命令 */
const PATH_COMMANDS = new Set([...PATH_COMMANDS_WRITE, ...PATH_COMMANDS_READ]);

/** 危险的环境变量前缀 */
const DANGEROUS_ENV_VARS = new Set([
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH",
	"PYTHONPATH",
	"NODE_OPTIONS",
	"NODE_PATH",
	"PERL5LIB",
	"RUBYLIB",
	"CLASSPATH",
	"BASH_ENV",
	"ENV",
	"PROMPT_COMMAND",
]);

/** Shell 命令名集合，用于检测 pipe-to-shell 模式 */
const SHELL_COMMANDS = new Set(["bash", "sh", "zsh", "fish", "dash", "ksh", "csh", "tcsh"]);

// ── Parser 单例 ───────────────────────────────────────────

type TreeSitterParser = {
	parse(input: string): { rootNode: TreeSitterNode };
};

type TreeSitterNode = {
	type: string;
	text: string;
	childCount: number;
	child(index: number): TreeSitterNode | null;
	parent: TreeSitterNode | null;
	descendantsOfType(type: string): TreeSitterNode[];
};

let parserPromise: Promise<TreeSitterParser> | null = null;

async function getParser(): Promise<TreeSitterParser> {
	if (parserPromise) return parserPromise;
	parserPromise = initParser();
	return parserPromise;
}

async function initParser(): Promise<TreeSitterParser> {
	const TreeSitter = await import("web-tree-sitter");
	const Parser = TreeSitter.Parser ?? TreeSitter.default;
	const Language = TreeSitter.Language ?? (TreeSitter.default as any)?.Language;

	const treeSitterWasmPath = require.resolve("web-tree-sitter/tree-sitter.wasm");
	await Parser.init({
		locateFile() {
			return treeSitterWasmPath;
		},
	});

	const bashWasmPath = require.resolve("tree-sitter-bash/tree-sitter-bash.wasm");
	const bashLanguage = await Language.load(bashWasmPath);

	const parser = new Parser();
	parser.setLanguage(bashLanguage);
	return parser as unknown as TreeSitterParser;
}

// ── 辅助函数 ─────────────────────────────────────────────

/** 检测命令是否使用绝对路径或相对路径执行 */
function isPathExecution(cmdName: string): boolean {
	return cmdName.startsWith("/") || cmdName.startsWith("./") || cmdName.startsWith("../");
}

/** 检测 pipeline 中是否存在 pipe-to-shell 模式 */
function detectPipeToShell(rootNode: TreeSitterNode): string[] {
	const patterns: string[] = [];
	const pipelines = rootNode.descendantsOfType("pipeline");
	for (const pipeline of pipelines) {
		// 获取 pipeline 中的所有 command 节点（直接子节点）
		const commands: TreeSitterNode[] = [];
		for (let i = 0; i < pipeline.childCount; i++) {
			const child = pipeline.child(i);
			if (!child) continue;
			if (child.type === "command" || child.type === "redirected_statement") {
				commands.push(child);
			}
		}
		if (commands.length < 2) continue;

		// 检查最后一个命令是否是 shell
		const lastCmd = commands[commands.length - 1];
		const lastCmdNode =
			lastCmd.type === "redirected_statement" ? lastCmd.descendantsOfType("command")[0] : lastCmd;
		if (!lastCmdNode) continue;

		const firstChild = lastCmdNode.child(0);
		if (firstChild?.type === "command_name") {
			const name = firstChild.text;
			if (
				SHELL_COMMANDS.has(name) ||
				name === "python" ||
				name === "python3" ||
				name === "node" ||
				name === "perl" ||
				name === "ruby"
			) {
				patterns.push(`pipe to ${name}`);
			}
		}
	}
	return patterns;
}

/** 检测环境变量注入 */
function detectEnvInjection(rootNode: TreeSitterNode): string[] {
	const patterns: string[] = [];
	const assignments = rootNode.descendantsOfType("variable_assignment");
	for (const assignment of assignments) {
		// variable_assignment 的 parent 是 command → 这是命令前缀环境变量
		if (assignment.parent?.type === "command") {
			const varName = assignment.text.split("=")[0];
			if (DANGEROUS_ENV_VARS.has(varName)) {
				patterns.push(`dangerous env var: ${varName}`);
			}
		}
	}
	return patterns;
}

/**
 * 从命令 tokens 中提取文件/目录路径参数。
 * 跳过 flag（-xxx）、chmod 模式（+x）、以及已知的非路径参数。
 */
const GREP_LIKE_FLAGS_WITH_VALUE = new Set([
	"-e",
	"-f",
	"--regexp",
	"--file",
	"-m",
	"--max-count",
	"-A",
	"-B",
	"-C",
	"--after-context",
	"--before-context",
	"--context",
	"--include",
	"--exclude",
	"--exclude-dir",
	"-t",
	"--type",
	"-T",
	"--type-not", // rg/ag
]);

function extractPathArgs(cmdName: string, tokens: string[], cwd: string): string[] {
	const paths: string[] = [];
	const args = tokens.slice(1);

	if (cmdName === "grep" || cmdName === "rg" || cmdName === "ag" || cmdName === "fd") {
		// grep pattern [file/dir...] — 第一个非 flag 参数是 pattern，之后的是路径
		let patternSeen = false;
		let skipNext = false;
		for (const arg of args) {
			if (skipNext) {
				skipNext = false;
				continue;
			}
			if (arg.startsWith("-")) {
				if (GREP_LIKE_FLAGS_WITH_VALUE.has(arg)) skipNext = true;
				continue;
			}
			if (!patternSeen) {
				patternSeen = true;
				continue;
			} // skip pattern
			paths.push(resolve(cwd, arg));
		}
		return paths;
	}

	if (cmdName === "find") {
		// find [path...] [expression] — 路径在表达式之前
		for (const arg of args) {
			if (arg.startsWith("-") || arg.startsWith("(") || arg.startsWith("!")) break;
			paths.push(resolve(cwd, arg));
		}
		return paths;
	}

	// 通用：跳过 flag 和 chmod 模式
	for (const arg of args) {
		if (arg.startsWith("-")) continue;
		if (cmdName === "chmod" && arg.startsWith("+")) continue;
		paths.push(resolve(cwd, arg));
	}
	return paths;
}

// ── 灾难性命令检测 ────────────────────────────────────────

/** 系统关键路径 — 对这些路径的递归删除/覆盖是灾难性的 */
const CATASTROPHIC_PATHS = new Set([
	"/",
	"/bin",
	"/boot",
	"/dev",
	"/etc",
	"/home",
	"/lib",
	"/lib64",
	"/opt",
	"/proc",
	"/root",
	"/run",
	"/sbin",
	"/srv",
	"/sys",
	"/tmp",
	"/usr",
	"/var",
]);

/** 块设备前缀 */
const BLOCK_DEVICE_PREFIXES = [
	"/dev/sd",
	"/dev/hd",
	"/dev/nvme",
	"/dev/vd",
	"/dev/xvd",
	"/dev/mmcblk",
	"/dev/loop",
];

function isBlockDevice(path: string): boolean {
	if (
		path === "/dev/null" ||
		path === "/dev/zero" ||
		path === "/dev/urandom" ||
		path === "/dev/random"
	)
		return false;
	return BLOCK_DEVICE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function isCatastrophicPath(p: string): boolean {
	const normalized = p.replace(/\/+$/, "") || "/";
	return CATASTROPHIC_PATHS.has(normalized);
}

/**
 * 检测灾难性命令 — 不可逆的系统级破坏操作。
 * 返回 null 表示安全，否则返回原因描述。
 */
function detectCatastrophic(commands: BashAnalysis["commands"], rawCommand: string): string | null {
	for (const cmd of commands) {
		const [name, ...args] = cmd.tokens;
		const fullText = cmd.fullText;

		// ── rm -rf / 系列 ──
		if (name === "rm") {
			const hasRecursive = args.some(
				(a) => a === "-r" || a === "-rf" || a === "-fr" || (a.startsWith("-") && a.includes("r")),
			);
			if (hasRecursive) {
				for (const arg of args) {
					if (arg.startsWith("-")) continue;
					// rm -rf /, /*, ~, $HOME
					if (arg === "/" || arg === "/*" || arg === "~" || arg === "$HOME" || arg === "${HOME}") {
						return `rm recursive on critical path: ${arg}`;
					}
					if (isCatastrophicPath(arg)) {
						return `rm recursive on system directory: ${arg}`;
					}
				}
			}
			// rm without -r but targeting / or system dirs
			for (const arg of args) {
				if (arg.startsWith("-")) continue;
				if (arg === "/" || arg === "/*") {
					return `rm on root: ${arg}`;
				}
			}
		}

		// ── dd 写入块设备 ──
		if (name === "dd") {
			const ofArg = args.find((a) => a.startsWith("of="));
			if (ofArg) {
				const target = ofArg.slice(3);
				if (isBlockDevice(target)) {
					return `dd write to block device: ${target}`;
				}
				if (target === "/" || isCatastrophicPath(target)) {
					return `dd write to system path: ${target}`;
				}
			}
		}

		// ── mkfs 格式化 ──
		if (name === "mkfs" || name?.startsWith("mkfs.")) {
			return `filesystem format: ${cmd.text}`;
		}

		// ── chmod/chown -R on / ──
		if (name === "chmod" || name === "chown" || name === "chgrp") {
			const hasRecursive = args.some((a) => a === "-R" || a === "--recursive");
			if (hasRecursive) {
				for (const arg of args) {
					if (arg.startsWith("-") || arg.startsWith("+")) continue;
					// 跳过 mode 参数 (如 777, u+x)
					if (/^[0-7]{3,4}$/.test(arg) || /^[ugoa]/.test(arg)) continue;
					if (arg === "/" || isCatastrophicPath(arg)) {
						return `${name} -R on system directory: ${arg}`;
					}
				}
			}
		}

		// ── 重定向到块设备 ──
		if (fullText) {
			const redirectMatch = fullText.match(/>\s*(\/dev\/\S+)/);
			if (redirectMatch && isBlockDevice(redirectMatch[1])) {
				return `redirect to block device: ${redirectMatch[1]}`;
			}
		}

		// ── shutdown/reboot/halt/poweroff ──
		if (name === "shutdown" || name === "reboot" || name === "halt" || name === "poweroff") {
			return `system power control: ${name}`;
		}
	}

	// ── fork bomb 检测（原始文本匹配）──
	const forkBombPatterns = [
		/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, // :(){:|:&};:
		/bomb\(\)\s*\{\s*bomb\s*\|\s*bomb\s*&\s*\}/, // bomb(){bomb|bomb&}
		/\.\/\S+\s*&\s*\.\/\S+/, // ./a & ./a (self-replicating)
	];
	for (const pattern of forkBombPatterns) {
		if (pattern.test(rawCommand)) {
			return "fork bomb detected";
		}
	}

	return null;
}

// ── 核心分析函数 ──────────────────────────────────────────

/**
 * 分析 bash 命令字符串，返回命令列表、路径和白名单状态。
 */
export async function analyzeBashCommand(command: string, cwd: string): Promise<BashAnalysis> {
	const parser = await getParser();
	const tree = parser.parse(command);

	const commands: BashAnalysis["commands"] = [];
	const filePaths: string[] = [];
	const nonWhitelisted: string[] = [];
	const dangerousPatterns: string[] = [];

	for (const node of tree.rootNode.descendantsOfType("command")) {
		if (!node) continue;

		// 包含重定向的完整文本
		const fullText = node.parent?.type === "redirected_statement" ? node.parent.text : node.text;

		const tokens: string[] = [];
		for (let i = 0; i < node.childCount; i++) {
			const child = node.child(i);
			if (!child) continue;
			if (
				child.type !== "command_name" &&
				child.type !== "word" &&
				child.type !== "string" &&
				child.type !== "raw_string" &&
				child.type !== "concatenation" &&
				child.type !== "simple_expansion" &&
				child.type !== "expansion"
			) {
				continue;
			}
			tokens.push(child.text);
		}

		if (tokens.length === 0) continue;

		commands.push({ tokens, text: node.text, fullText });

		const cmdName = tokens[0];

		// 1. 绝对路径 / 相对路径执行 — 始终需要确认
		if (isPathExecution(cmdName)) {
			if (!nonWhitelisted.includes(cmdName)) {
				nonWhitelisted.push(cmdName);
			}
			dangerousPatterns.push(`path execution: ${cmdName}`);
			continue;
		}

		// 2. ALWAYS_ASK 命令
		if (ALWAYS_ASK_COMMANDS.has(cmdName)) {
			if (!nonWhitelisted.includes(cmdName)) {
				nonWhitelisted.push(cmdName);
			}
			// 路径提取（即使命令被拦截，也需要记录路径用于 UI 展示）
			if (PATH_COMMANDS.has(cmdName)) {
				filePaths.push(...extractPathArgs(cmdName, tokens, cwd));
			}
			continue;
		}

		// 3. 条件安全命令 — 检查危险参数
		if (cmdName in CONDITIONAL_COMMANDS) {
			const danger = CONDITIONAL_COMMANDS[cmdName](tokens, fullText);
			if (danger) {
				if (!nonWhitelisted.includes(cmdName)) {
					nonWhitelisted.push(cmdName);
				}
				dangerousPatterns.push(danger);
			}
			// 即使条件安全命令没有危险参数，如果不在 SAFE_COMMANDS 中也需要标记
			else if (!SAFE_COMMANDS.has(cmdName)) {
				if (!nonWhitelisted.includes(cmdName)) {
					nonWhitelisted.push(cmdName);
				}
			}
			// 路径提取（条件安全命令中的文件操作）
			if (PATH_COMMANDS.has(cmdName)) {
				filePaths.push(...extractPathArgs(cmdName, tokens, cwd));
			}
			continue;
		}

		// 4. SAFE_COMMANDS — 放行
		if (SAFE_COMMANDS.has(cmdName)) {
			// 路径提取
			if (PATH_COMMANDS.has(cmdName)) {
				filePaths.push(...extractPathArgs(cmdName, tokens, cwd));
			}
			continue;
		}

		// 5. 未知命令 — 需要确认
		if (!nonWhitelisted.includes(cmdName)) {
			nonWhitelisted.push(cmdName);
		}
	}

	// 全局模式检测
	const pipePatterns = detectPipeToShell(tree.rootNode);
	dangerousPatterns.push(...pipePatterns);
	if (pipePatterns.length > 0) {
		// pipe-to-shell 模式中的 shell 命令已经在 ALWAYS_ASK 中了，
		// 但如果上游命令（如 curl）本身是安全的，整体仍然需要标记
		for (const p of pipePatterns) {
			const shellName = p.replace("pipe to ", "");
			if (!nonWhitelisted.includes(shellName)) {
				nonWhitelisted.push(shellName);
			}
		}
	}

	const envPatterns = detectEnvInjection(tree.rootNode);
	dangerousPatterns.push(...envPatterns);
	const hasEnvInjection = envPatterns.length > 0;
	// 环境变量注入使整个命令不安全
	if (hasEnvInjection && nonWhitelisted.length === 0) {
		nonWhitelisted.push("(env injection)");
	}

	// 灾难性命令检测
	const catastrophicReason = detectCatastrophic(commands, command);

	return {
		commands,
		filePaths,
		allWhitelisted:
			nonWhitelisted.length === 0 && dangerousPatterns.length === 0 && !hasEnvInjection,
		nonWhitelisted,
		dangerousPatterns,
		hasEnvInjection,
		isCatastrophic: catastrophicReason !== null,
		catastrophicReason: catastrophicReason ?? undefined,
	};
}

// ── 导出供测试使用 ───────────────────────────────────────

export {
	SAFE_COMMANDS,
	ALWAYS_ASK_COMMANDS,
	PATH_COMMANDS,
	CONDITIONAL_COMMANDS,
	DANGEROUS_ENV_VARS,
};
