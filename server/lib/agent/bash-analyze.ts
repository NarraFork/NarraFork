/**
 * 基于 tree-sitter AST 的 Bash 命令分析模块
 *
 * 解析 bash 命令字符串，提取所有子命令、文件路径，
 * 并根据白名单 + 危险模式检测判断是否可以自动放行。
 */

import embeddedBashWasm from "tree-sitter-bash/tree-sitter-bash.wasm" with { type: "file" };

// Embed WASM files for compiled single-executable mode.
// `import ... with { type: "file" }` makes Bun include these in $bunfs.
// At runtime we prefer the embedded path; fall back to require.resolve for dev.
import embeddedTreeSitterWasm from "web-tree-sitter/tree-sitter.wasm" with { type: "file" };
import { resolvePath, toForwardSlash } from "../platform-path";

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
	/** Chapter 模式下检测到的 git 分支违规操作（切换分支、修改其他分支等） */
	gitBranchViolations: string[];
	/** 是否包含写操作（如 biome --write）— 只在 acceptEdits 模式下允许 */
	hasWriteOperation: boolean;
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
	"tree",
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
	// 包执行器（仅允许严格白名单场景，具体由 CONDITIONAL_COMMANDS 进一步约束）
	"npx",
	"bunx",
	// 包管理工具（只读子命令由 CONDITIONAL_COMMANDS 放行，危险子命令拦截）
	"npm",
	"bun",
	"yarn",
	"pnpm",
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
	// 间接执行（危险参数由 CONDITIONAL_COMMANDS 检测）
	"xargs",
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
	"podman",
	"podman-compose",
	"kubectl",
	// 间接命令执行
	// xargs 移至 CONDITIONAL_COMMANDS 进行递归分析
	// 脚本解释器（可 -e/-c 执行任意代码）
	"perl",
	"ruby",
	"lua",
	"php",
	// 运行时 / 构建/包管理工具（可直接或间接执行项目/远程代码）
	// npm/bun/yarn/pnpm 移至 CONDITIONAL_COMMANDS 以允许只读子命令（ls/list/view 等）
	"node",
	"python",
	"python3",
	"go",
	"cargo",
	"pip",
	"pip3",
	"make",
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
 * npx/bunx 可执行的受控白名单包。
 * 注意：这里只是第一层筛选，仍需通过参数/来源校验。
 */
const SAFE_PACKAGE_RUNNERS = new Set([
	// 类型检查 / 编译
	"tsc",
	"typescript",
	// Lint / 格式化
	"biome",
	"@biomejs/biome",
	"prettier",
	"eslint",
]);

/** 允许通过 npx/bunx 的命令参数（仅只读/检查类）。 */
const SAFE_PACKAGE_ARGS = new Set([
	"check",
	"--check",
	"--noEmit",
	"--write=false",
	"--version",
	"-v",
]);

/** Biome 特定的只读参数前缀 */
const BIOME_SAFE_ARG_PREFIXES = [
	"--max-diagnostics",
	"--diagnostic-level",
	"--colors",
	"--no-colors",
	"--use-server",
	"--verbose",
	"--log-level",
	"--log-kind",
	"--config-path",
	"--reporter",
	"--formatter-enabled",
	"--linter-enabled",
	"--organize-imports-enabled",
	"--assists-enabled",
	"--stdin-file-path",
	"--vcs-enabled",
	"--vcs-client-kind",
	"--vcs-use-ignore-file",
	"--vcs-root",
	"--vcs-default-branch",
	"--files-max-size",
	"--files-ignore-unknown",
	"--indent-style",
	"--indent-width",
	"--line-ending",
	"--line-width",
	"--json-formatter-enabled",
	"--json-formatter-indent-style",
	"--json-formatter-indent-width",
	"--json-formatter-line-ending",
	"--json-formatter-line-width",
	"--javascript-formatter-enabled",
	"--javascript-formatter-indent-style",
	"--javascript-formatter-indent-width",
	"--javascript-formatter-line-ending",
	"--javascript-formatter-line-width",
];

/** Biome 写操作参数 — 只在 acceptEdits 模式下允许 */
const BIOME_WRITE_ARG_PREFIXES = [
	"--write", // 格式化并写入文件
	"--fix", // 修复 lint 错误
	"--unsafe", // 应用不安全的修复
];

/** TypeScript 特定的只读参数前缀 */
const TSC_SAFE_ARG_PREFIXES = [
	"--pretty",
	"--listFiles",
	"--listFilesOnly",
	"--explainFiles",
	"--showConfig",
	"--traceResolution",
	"--diagnostics",
	"--extendedDiagnostics",
	"--generateTrace",
	"--sourceMap",
	"--inlineSourceMap",
	"--rootDir",
	"--removeComments",
	"--importHelpers",
	"--downlevelIteration",
	"--isolatedModules",
	"--strict",
	"--noImplicitAny",
	"--strictNullChecks",
	"--strictFunctionTypes",
	"--strictBindCallApply",
	"--strictPropertyInitialization",
	"--noImplicitThis",
	"--alwaysStrict",
	"--noUnusedLocals",
	"--noUnusedParameters",
	"--noImplicitReturns",
	"--noFallthroughCasesInSwitch",
	"--noUncheckedIndexedAccess",
	"--noImplicitOverride",
	"--allowUnusedLabels",
	"--allowUnreachableCode",
	"--skipLibCheck",
	"--skipDefaultLibCheck",
	"--moduleResolution",
	"--module",
	"--target",
	"--lib",
	"--jsx",
	"--jsxFactory",
	"--jsxFragmentFactory",
	"--jsxImportSource",
	"--experimentalDecorators",
	"--emitDecoratorMetadata",
	"--resolveJsonModule",
	"--esModuleInterop",
	"--allowSyntheticDefaultImports",
	"--forceConsistentCasingInFileNames",
	"--allowJs",
	"--checkJs",
	"--maxNodeModuleJsDepth",
	"--types",
	"--typeRoots",
	"--paths",
	"--baseUrl",
	"--rootDirs",
	"--preserveSymlinks",
	"--charset",
	"--newLine",
	"--useDefineForClassFields",
	"--preserveConstEnums",
	"--preserveValueImports",
	"--assumeChangesOnlyAffectDirectDependencies",
];

/** TypeScript 写操作参数 — 只在 acceptEdits 模式下允许 */
const TSC_WRITE_ARG_PREFIXES = [
	"--incremental",
	"--tsBuildInfoFile",
	"--composite",
	"--declaration",
	"--declarationMap",
	"--emitDeclarationOnly",
	"--declarationDir",
	"--outDir",
	"--outFile",
];

/** 会触发远程拉包或动态来源的高风险参数。 */
const PACKAGE_RUNNER_DANGEROUS_FLAGS = new Set([
	"-p",
	"--package",
	"--registry",
	"--userconfig",
	"--ignore-existing",
]);

/** 包执行器分类结果 */
interface PackageRunnerClassification {
	/** 错误描述，null 表示安全 */
	error: string | null;
	/** 是否包含写操作 */
	hasWriteOperation: boolean;
}

/**
 * 对 npx/bunx 执行的命令进行递归分类。
 * 严格模式：仅允许受控白名单包 + 只读参数 + 非远程来源。
 */
function classifyPackageRunner(tokens: string[], runner: string): PackageRunnerClassification {
	let i = 1;
	while (i < tokens.length && tokens[i].startsWith("-")) {
		const flag = tokens[i];
		if (PACKAGE_RUNNER_DANGEROUS_FLAGS.has(flag)) {
			return {
				error: `${runner} ${flag} (dynamic package source not allowed)`,
				hasWriteOperation: false,
			};
		}
		// --package/-p 带参数（虽然上面已拦截，保留健壮性）
		if (flag === "--package" || flag === "-p") {
			i += 2;
			continue;
		}
		i++;
	}
	const execCmd = tokens[i];
	if (!execCmd) {
		return { error: `${runner} (no explicit command)`, hasWriteOperation: false };
	}

	// 禁止 URL / git / file 协议来源
	if (
		execCmd.includes("://") ||
		execCmd.startsWith("git+") ||
		execCmd.startsWith("file:") ||
		execCmd.startsWith("http:") ||
		execCmd.startsWith("https:")
	) {
		return { error: `${runner} ${execCmd} (remote source not allowed)`, hasWriteOperation: false };
	}

	// 禁止非固定版本（如 @latest, @next）
	const unstableTagPattern = /@(latest|next|canary|beta|alpha|rc)$/i;
	if (unstableTagPattern.test(execCmd)) {
		return {
			error: `${runner} ${execCmd} (unstable package tag not allowed)`,
			hasWriteOperation: false,
		};
	}

	// 提取包名（去除 @scope/pkg@version 里的版本部分）
	const packageName = execCmd.startsWith("@")
		? execCmd.split("@").slice(0, 2).join("@")
		: execCmd.split("@")[0];

	if (!SAFE_PACKAGE_RUNNERS.has(packageName)) {
		return { error: `${runner} ${execCmd} (package not in allowlist)`, hasWriteOperation: false };
	}

	const isBiome = packageName === "biome" || packageName === "@biomejs/biome";
	const isTsc = packageName === "tsc" || packageName === "typescript";

	let hasWriteOperation = false;

	const cmdArgs = tokens.slice(i + 1);
	for (const arg of cmdArgs) {
		if (arg.startsWith("--config") || arg.startsWith("--plugin") || arg.startsWith("--require")) {
			return {
				error: `${runner} ${execCmd} ${arg} (dynamic code loading flag)`,
				hasWriteOperation: false,
			};
		}
		if (arg.startsWith("-")) {
			// 检查是否在通用白名单中
			if (SAFE_PACKAGE_ARGS.has(arg)) {
				continue;
			}
			// Biome 特定参数：检查前缀匹配（支持 --max-diagnostics=200 格式）
			if (isBiome) {
				const argName = arg.split("=")[0];
				// 检查只读参数
				if (BIOME_SAFE_ARG_PREFIXES.some((prefix) => argName === prefix)) {
					continue;
				}
				// 检查写操作参数
				if (BIOME_WRITE_ARG_PREFIXES.some((prefix) => argName === prefix)) {
					hasWriteOperation = true;
					continue;
				}
			}
			// TypeScript 特定参数：检查前缀匹配
			if (isTsc) {
				const argName = arg.split("=")[0];
				if (TSC_SAFE_ARG_PREFIXES.some((prefix) => argName === prefix)) {
					continue;
				}
				if (TSC_WRITE_ARG_PREFIXES.some((prefix) => argName === prefix)) {
					hasWriteOperation = true;
					continue;
				}
			}
			return {
				error: `${runner} ${execCmd} ${arg} (flag not in safe allowlist)`,
				hasWriteOperation: false,
			};
		}
		// 非 flag 参数（子命令/目标路径）
		// - 允许只读子命令：check, version
		// - 允许当前目录：.
		// - Biome/tsc 允许文件路径参数（只读检查操作）
		if (arg === "check" || arg === "version" || arg === ".") continue;
		if (isBiome || isTsc) {
			// Biome/tsc 接受文件路径作为检查目标，这是只读操作
			// 路径安全性由外层的 isInsideWorktree 检查保证
			continue;
		}
		return {
			error: `${runner} ${execCmd} ${arg} (argument not in safe allowlist)`,
			hasWriteOperation: false,
		};
	}

	return { error: null, hasWriteOperation };
}

/**
 * 条件安全命令 — 在白名单中但某些参数组合是危险的。
 * key: 命令名, value: 危险参数检测函数
 */
const CONDITIONAL_COMMANDS: Record<string, (tokens: string[], fullText: string) => string | null> =
	{
		// git — 大部分子命令安全，但部分写操作有破坏性
		git: (tokens) => {
			const sub = tokens[1];
			if (!sub) return null;

			// push --force / -f / --force-with-lease / --mirror / --delete
			if (sub === "push") {
				if (
					tokens.some(
						(t) => t === "--force" || t === "-f" || t === "--force-with-lease" || t === "--mirror",
					)
				)
					return "git push --force (rewrites remote history)";
				if (tokens.some((t) => t === "--delete" || t === "-d"))
					return "git push --delete (deletes remote ref)";
				return null;
			}
			// reset --hard
			if (sub === "reset" && tokens.some((t) => t === "--hard"))
				return "git reset --hard (discards uncommitted changes)";
			// clean -f / -fd / -fdx
			if (sub === "clean") return "git clean (removes untracked files)";
			// checkout -- (discard changes) — only when restoring files, not switching branches
			if (sub === "checkout" && tokens.includes("--"))
				return "git checkout -- (discards working tree changes)";
			// rebase (interactive or not — rewrites history)
			if (sub === "rebase") return "git rebase (rewrites commit history)";
			// merge (can cause conflicts / alter branch state)
			if (sub === "merge") return "git merge (alters branch state)";
			// filter-branch / filter-repo (mass history rewrite)
			if (sub === "filter-branch" || sub === "filter-repo")
				return `git ${sub} (mass history rewrite)`;
			// reflog expire
			if (sub === "reflog" && tokens.includes("expire"))
				return "git reflog expire (destroys recovery points)";
			// gc with aggressive prune
			if (sub === "gc" && tokens.some((t) => t.startsWith("--prune")))
				return "git gc --prune (permanently removes objects)";
			// branch -D (force delete)
			if (sub === "branch" && tokens.some((t) => t === "-D" || t === "--delete" || t === "-d"))
				return "git branch delete";
			// submodule deinit
			if (sub === "submodule" && tokens.includes("deinit")) return "git submodule deinit";
			// worktree remove
			if (sub === "worktree" && tokens.includes("remove")) return "git worktree remove";

			return null;
		},
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
		// npm — 只读子命令放行，写操作/脚本执行拦截
		npm: (tokens) => {
			if (tokens.includes("exec")) return "npm exec (executes arbitrary package)";
			const sub = tokens[1];
			if (!sub) return null; // bare `npm` — safe (shows help)
			// 只读子命令 — 安全
			const npmReadOnly = new Set([
				"ls",
				"list",
				"ll",
				"la",
				"view",
				"info",
				"show",
				"outdated",
				"search",
				"find",
				"help",
				"config",
				"get",
				"prefix",
				"root",
				"bin",
				"version",
				"--version",
				"-v",
				"explain",
				"why",
				"fund",
				"audit",
				"doctor",
				"ping",
				"whoami",
				"token",
				"pack",
				"diff",
				"pkg",
				"query",
				"completion",
				"explore",
			]);
			if (npmReadOnly.has(sub)) return null;
			// 危险子命令
			if (sub === "run" || sub === "run-script") return `npm ${sub} (runs project script)`;
			if (sub === "test" || sub === "start" || sub === "stop" || sub === "restart")
				return `npm ${sub} (runs project script)`;
			if (sub === "install" || sub === "i" || sub === "ci" || sub === "add")
				return `npm ${sub} (installs packages)`;
			if (sub === "uninstall" || sub === "remove" || sub === "rm" || sub === "un" || sub === "r")
				return `npm ${sub} (removes packages)`;
			if (sub === "update" || sub === "up" || sub === "upgrade")
				return `npm ${sub} (updates packages)`;
			if (sub === "publish") return "npm publish (publishes package)";
			if (sub === "link" || sub === "ln") return `npm ${sub} (creates symlink)`;
			if (sub === "prune") return "npm prune (removes extraneous packages)";
			if (sub === "rebuild" || sub === "rb") return `npm ${sub} (rebuilds packages)`;
			if (sub === "cache" && tokens.includes("clean")) return "npm cache clean";
			// 未知子命令 — 保守拦截
			return `npm ${sub} (unknown npm subcommand)`;
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
		// bun — 只读子命令放行，脚本执行/-e 拦截
		bun: (tokens) => {
			if (tokens.includes("-e") || tokens.includes("--eval")) return "bun with -e flag";
			const sub = tokens[1];
			if (!sub) return null; // bare `bun` — safe (shows help)
			// 版本/帮助 flags
			if (sub === "--version" || sub === "-v" || sub === "--help" || sub === "-h") return null;
			// 只读子命令
			const bunReadOnly = new Set(["pm", "--version", "-v", "--help", "-h", "--revision"]);
			if (bunReadOnly.has(sub)) return null;
			// 危险子命令
			if (sub === "run") return "bun run (runs project script)";
			if (sub === "test") return "bun test (runs project tests)";
			if (sub === "install" || sub === "i" || sub === "add")
				return `bun ${sub} (installs packages)`;
			if (sub === "remove" || sub === "rm") return `bun ${sub} (removes packages)`;
			if (sub === "update") return "bun update (updates packages)";
			if (sub === "link") return "bun link (creates symlink)";
			if (sub === "build") return "bun build (bundles code)";
			if (sub === "init") return "bun init (initializes project)";
			if (sub === "create") return "bun create (scaffolds project)";
			if (sub === "upgrade") return "bun upgrade (upgrades bun itself)";
			if (sub === "patch") return "bun patch (patches packages)";
			// 未知子命令 — 可能是脚本名（bun <script>），保守拦截
			return `bun ${sub} (unknown bun subcommand)`;
		},
		// find -exec / -execdir — 提取被执行的命令进行递归分类
		find: (tokens) => {
			if (tokens.some((t) => t === "-delete")) return "find with -delete (removes files)";

			const execFlags = ["-exec", "-execdir", "-ok", "-okdir"];
			for (const flag of execFlags) {
				const idx = tokens.indexOf(flag);
				if (idx < 0) continue;

				// -exec 后面到 \; 或 + 之间的 tokens 就是被执行的命令
				const execCmd = tokens[idx + 1];
				if (!execCmd) return `find with ${flag} (empty command)`;

				// 递归分类：被执行的命令是否危险
				if (ALWAYS_ASK_COMMANDS.has(execCmd)) return `find ${flag} ${execCmd} (dangerous command)`;

				// 检查条件安全命令的危险参数
				if (execCmd in CONDITIONAL_COMMANDS) {
					// 提取 -exec 后面到终止符之间的完整 tokens
					const endIdx = tokens.findIndex((t, i) => i > idx && (t === ";" || t === "+"));
					const subTokens = tokens.slice(idx + 1, endIdx > 0 ? endIdx : undefined);
					const danger = CONDITIONAL_COMMANDS[execCmd](subTokens, subTokens.join(" "));
					if (danger) return `find ${flag} → ${danger}`;
				}

				// 被执行的命令在白名单中 — 安全
				if (SAFE_COMMANDS.has(execCmd)) return null;

				// 未知命令 — 保守拦截
				return `find ${flag} ${execCmd} (unknown command)`;
			}
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
		// xargs — 递归分析被执行的命令
		xargs: (tokens) => {
			// 跳过 xargs 自身的 flags
			const xargsFlags = new Set([
				"-0",
				"--null",
				"-d",
				"--delimiter",
				"-n",
				"--max-args",
				"-P",
				"--max-procs",
				"-I",
				"-i",
				"--replace",
				"-L",
				"--max-lines",
				"-s",
				"--max-chars",
				"-t",
				"--verbose",
				"-p",
				"--interactive",
				"-r",
				"--no-run-if-empty",
				"--show-limits",
			]);
			const flagsWithValue = new Set([
				"-d",
				"--delimiter",
				"-n",
				"--max-args",
				"-P",
				"--max-procs",
				"-I",
				"-i",
				"--replace",
				"-L",
				"--max-lines",
				"-s",
				"--max-chars",
			]);
			let i = 1;
			while (i < tokens.length) {
				const t = tokens[i];
				if (t.startsWith("-") && xargsFlags.has(t)) {
					i++;
					if (flagsWithValue.has(t) && i < tokens.length) i++; // skip value
				} else if (t.startsWith("-")) {
					i++; // unknown flag, skip
				} else {
					break;
				}
			}
			const execCmd = tokens[i];
			// xargs 默认执行 echo — 安全
			if (!execCmd) return null;

			if (ALWAYS_ASK_COMMANDS.has(execCmd)) return `xargs ${execCmd} (dangerous command)`;
			if (execCmd in CONDITIONAL_COMMANDS) {
				const subTokens = tokens.slice(i);
				const danger = CONDITIONAL_COMMANDS[execCmd](subTokens, subTokens.join(" "));
				if (danger) return `xargs → ${danger}`;
				return null;
			}
			if (SAFE_COMMANDS.has(execCmd)) return null;
			return `xargs ${execCmd} (unknown command)`;
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
		// yarn — 只读子命令放行，脚本执行拦截
		yarn: (tokens) => {
			const sub = tokens[1];
			if (!sub) return null;
			// 只读子命令
			const yarnReadOnly = new Set([
				"list",
				"info",
				"why",
				"outdated",
				"config",
				"--version",
				"-v",
				"--help",
				"-h",
				"audit",
				"licenses",
				"bin",
				"versions",
				"policies",
				"workspaces",
			]);
			if (yarnReadOnly.has(sub)) return null;
			// 危险子命令
			if (sub === "run") return "yarn run (runs project script)";
			if (sub === "test" || sub === "start" || sub === "stop")
				return `yarn ${sub} (runs project script)`;
			if (sub === "add") return "yarn add (installs packages)";
			if (sub === "remove") return "yarn remove (removes packages)";
			if (sub === "install") return "yarn install (installs all packages)";
			if (sub === "upgrade" || sub === "up") return `yarn ${sub} (updates packages)`;
			if (sub === "link") return "yarn link (creates symlink)";
			if (sub === "publish") return "yarn publish (publishes package)";
			if (sub === "cache" && tokens.includes("clean")) return "yarn cache clean";
			// yarn <script-name> 也是 run 的隐式别名，但无法区分子命令和脚本名
			// 保守处理：未知子命令拦截
			return `yarn ${sub} (unknown yarn subcommand)`;
		},
		// pnpm — 只读子命令放行，脚本执行拦截
		pnpm: (tokens) => {
			const sub = tokens[1];
			if (!sub) return null;
			// 只读子命令
			const pnpmReadOnly = new Set([
				"list",
				"ls",
				"ll",
				"la",
				"why",
				"outdated",
				"audit",
				"config",
				"--version",
				"-v",
				"--help",
				"-h",
				"root",
				"bin",
				"store",
			]);
			if (pnpmReadOnly.has(sub)) return null;
			// 危险子命令
			if (sub === "run") return "pnpm run (runs project script)";
			if (sub === "test" || sub === "start" || sub === "stop")
				return `pnpm ${sub} (runs project script)`;
			if (sub === "add" || sub === "install" || sub === "i")
				return `pnpm ${sub} (installs packages)`;
			if (sub === "remove" || sub === "rm" || sub === "un" || sub === "uninstall")
				return `pnpm ${sub} (removes packages)`;
			if (sub === "update" || sub === "up") return `pnpm ${sub} (updates packages)`;
			if (sub === "link" || sub === "ln") return `pnpm ${sub} (creates symlink)`;
			if (sub === "publish") return "pnpm publish (publishes package)";
			if (sub === "rebuild" || sub === "rb") return `pnpm ${sub} (rebuilds packages)`;
			if (sub === "prune") return "pnpm prune (removes extraneous packages)";
			return `pnpm ${sub} (unknown pnpm subcommand)`;
		},
		// npx/bunx — 包执行器，递归检查被执行的命令
		npx: (tokens) => classifyPackageRunner(tokens, "npx").error,
		bunx: (tokens) => classifyPackageRunner(tokens, "bunx").error,
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
	const Parser = (TreeSitter.Parser ?? TreeSitter.default) as TreeSitterParserCtor;
	type TreeSitterModuleLike = {
		Language?: { load(path: string): Promise<unknown> };
		default?: { Language?: { load(path: string): Promise<unknown> } };
	};
	type TreeSitterParserCtor = {
		init(options: { locateFile(): string }): Promise<void>;
		new (): {
			setLanguage(language: unknown): void;
			parse(input: string): { rootNode: TreeSitterNode };
		};
	};
	const treeSitterLike = TreeSitter as TreeSitterModuleLike;
	const Language = treeSitterLike.Language ?? treeSitterLike.default?.Language;
	if (!Language) {
		throw new Error("web-tree-sitter Language API is unavailable");
	}

	const treeSitterWasmPath =
		embeddedTreeSitterWasm ?? require.resolve("web-tree-sitter/tree-sitter.wasm");
	await Parser.init({
		locateFile() {
			return treeSitterWasmPath;
		},
	});

	const bashWasmPath =
		embeddedBashWasm ?? require.resolve("tree-sitter-bash/tree-sitter-bash.wasm");
	const bashLanguage = await Language.load(bashWasmPath);

	const parser = new Parser();
	parser.setLanguage(bashLanguage);
	return parser as unknown as TreeSitterParser;
}

// ── 辅助函数 ─────────────────────────────────────────────

/** 检测命令是否使用绝对路径或相对路径执行 */
function isPathExecution(cmdName: string): boolean {
	const fwd = toForwardSlash(cmdName);
	// Unix absolute, relative, or Windows drive-letter absolute (e.g. C:/...)
	return (
		fwd.startsWith("/") ||
		fwd.startsWith("./") ||
		fwd.startsWith("../") ||
		/^[a-zA-Z]:[\\/]/.test(cmdName)
	);
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

/** 从 fullText 中提取重定向目标路径（>, >>, 2>, &> 等） */
const REDIRECT_REGEX = /(?:>>|[012]>|&>|>\|?)[ \t]*([^\s;|&)]+)/g;

function extractRedirectTargets(fullText: string, cwd: string): string[] {
	const paths: string[] = [];
	for (const match of fullText.matchAll(REDIRECT_REGEX)) {
		const target = match[1];
		// 忽略 /dev/null 等特殊设备
		if (target.startsWith("/dev/")) continue;
		paths.push(resolvePath(cwd, target));
	}
	return paths;
}

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
			paths.push(resolvePath(cwd, arg));
		}
		return paths;
	}

	if (cmdName === "find") {
		// find [path...] [expression] — 路径在表达式之前
		for (const arg of args) {
			if (arg.startsWith("-") || arg.startsWith("(") || arg.startsWith("!")) break;
			paths.push(resolvePath(cwd, arg));
		}
		return paths;
	}

	// 通用：跳过 flag 和 chmod 模式
	for (const arg of args) {
		if (arg.startsWith("-")) continue;
		if (cmdName === "chmod" && arg.startsWith("+")) continue;
		paths.push(resolvePath(cwd, arg));
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

/** Windows 系统关键路径（小写，正斜杠格式） */
const WINDOWS_CATASTROPHIC_SUFFIXES = [
	"/windows",
	"/windows/system32",
	"/program files",
	"/program files (x86)",
];

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
	const normalized = toForwardSlash(p).replace(/\/+$/, "") || "/";
	if (CATASTROPHIC_PATHS.has(normalized)) return true;
	// Windows: check drive roots (e.g. "C:/") and system directories
	const lower = normalized.toLowerCase();
	if (/^[a-z]:$/.test(lower) || /^[a-z]:\/$/.test(lower)) return true;
	return WINDOWS_CATASTROPHIC_SUFFIXES.some(
		(suffix) => lower.endsWith(suffix) && /^[a-z]:/.test(lower),
	);
}

// ── Chapter 模式 Git 分支违规检测 ─────────────────────────

/**
 * Git 纯只读子命令 — 在 chapter 模式下始终允许。
 * 这些命令不会产生任何写入副作用。
 */
const GIT_READONLY_SUBCOMMANDS = new Set([
	"status",
	"log",
	"diff",
	"show",
	"blame",
	"shortlog",
	"describe",
	"rev-parse",
	"rev-list",
	"ls-files",
	"ls-tree",
	"ls-remote",
	"cat-file",
	"name-rev",
	"reflog", // 查看 reflog（expire 已在 CONDITIONAL 中拦截）
	"for-each-ref",
	"count-objects",
	"fsck",
	"verify-pack",
	"hash-object",
	"symbolic-ref",
]);

/**
 * 当前分支安全操作 — 只影响当前分支的工作区/暂存区/提交/本地配置。
 * 在 chapter 模式下允许，因为不会影响其他分支。
 * 注意：部分命令有写入副作用（如 stash/config/remote），但不涉及分支变更。
 */
const GIT_CURRENT_BRANCH_SAFE = new Set([
	"add",
	"commit",
	"restore",
	"rm",
	"mv",
	"apply",
	"cherry-pick",
	"am",
	"notes",
	"bisect",
	"grep",
	"archive",
	"bundle",
	"format-patch",
	"send-email",
	"request-pull",
	"svn",
	"init",
	"clone",
	"fetch",
	"pull",
	"submodule",
	"stash", // push/pop/drop 有副作用，但不影响分支
	"config", // 可写入 .git/config，但不影响分支
	"remote", // add/remove 修改远程配置，但不影响分支
]);

/**
 * 检测 chapter 模式下的 git 分支违规操作。
 * 返回违规描述列表（空列表 = 无违规）。
 *
 * 在 chapter 模式下，agent 只能在当前分支上工作，禁止：
 * - 切换分支（checkout <branch>, switch, worktree add）
 * - 创建/删除分支（branch <name>, branch -d/-D）
 * - 推送到其他分支（push origin <src>:<dst>）
 * - 修改其他分支的历史（rebase <other-branch>, merge, reset 到其他分支）
 * - 强制推送（push --force）
 */
function detectGitBranchViolations(commands: BashAnalysis["commands"]): string[] {
	const violations: string[] = [];

	for (const cmd of commands) {
		const tokens = cmd.tokens;
		if (tokens[0] !== "git") continue;

		const sub = tokens[1];
		if (!sub) continue;

		// 只读命令 — 始终安全
		if (GIT_READONLY_SUBCOMMANDS.has(sub)) continue;

		// 当前分支安全写操作 — 允许
		if (GIT_CURRENT_BRANCH_SAFE.has(sub)) continue;

		// ── 逐个检测可能影响分支的命令 ──

		// checkout: 只允许 checkout -- <file>（恢复文件），禁止切换分支
		if (sub === "checkout") {
			// checkout -- <file> 是恢复文件，不是切换分支（虽然有风险，但不违反分支限制）
			if (tokens.includes("--")) continue;
			// checkout -b <branch> 创建新分支
			if (tokens.some((t) => t === "-b" || t === "-B"))
				violations.push("git checkout -b (creates new branch)");
			else violations.push("git checkout (switches branch)");
			continue;
		}

		// switch: 专门用于切换分支
		if (sub === "switch") {
			violations.push("git switch (switches branch)");
			continue;
		}

		// branch: 查看分支列表是安全的，但创建/删除分支不行
		if (sub === "branch") {
			// 纯 `git branch` 或 `git branch -a/-r/--list/-v/--verbose` 是只读
			const readonlyFlags = new Set([
				"-a",
				"--all",
				"-r",
				"--remotes",
				"--list",
				"-v",
				"--verbose",
				"-vv",
				"--no-color",
				"--color",
			]);
			// 这些 flag 后面跟一个值参数（不是分支名）
			const flagsWithValue = new Set([
				"--sort",
				"--format",
				"--contains",
				"--no-contains",
				"--merged",
				"--no-merged",
				"--points-at",
			]);
			const args = tokens.slice(2);
			let hasWriteFlag = false;
			const nonFlagArgs: string[] = [];
			let skipNext = false;
			for (let i = 0; i < args.length; i++) {
				if (skipNext) {
					skipNext = false;
					continue;
				}
				const arg = args[i];
				if (arg.startsWith("-")) {
					// Check if it's a flag with value (--contains=X or --contains X)
					const eqIdx = arg.indexOf("=");
					const flagName = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;
					if (flagsWithValue.has(flagName)) {
						if (eqIdx < 0) skipNext = true; // next arg is the value
					} else if (!readonlyFlags.has(arg)) {
						hasWriteFlag = true;
					}
				} else {
					nonFlagArgs.push(arg);
				}
			}
			// 如果有非 flag 参数（分支名）或写 flag（-d/-D/-m/-M/-c/-C），则是写操作
			if (nonFlagArgs.length > 0 || hasWriteFlag) {
				const flags = args.filter((t) => t.startsWith("-"));
				if (flags.some((f) => f === "-d" || f === "-D" || f === "--delete"))
					violations.push("git branch -d/-D (deletes branch)");
				else if (flags.some((f) => f === "-m" || f === "-M" || f === "--move"))
					violations.push("git branch -m/-M (renames branch)");
				else if (flags.some((f) => f === "-c" || f === "-C" || f === "--copy"))
					violations.push("git branch -c/-C (copies branch)");
				else if (nonFlagArgs.length > 0) violations.push("git branch <name> (creates new branch)");
			}
			continue;
		}

		// push: 禁止 --force 和推送到非当前分支的 refspec
		if (sub === "push") {
			const pushFlags = tokens.slice(2);
			if (pushFlags.some((t) => t === "--force" || t === "-f" || t === "--force-with-lease"))
				violations.push("git push --force (may overwrite other branches)");
			if (pushFlags.some((t) => t === "--delete" || t === "-d"))
				violations.push("git push --delete (deletes remote branch)");
			// push --all / --mirror 推送所有分支/引用
			if (pushFlags.some((t) => t === "--all" || t === "--mirror"))
				violations.push("git push --all/--mirror (pushes all branches)");
			// 检查 refspec src:dst 格式 — 可能推送到其他分支
			const pushArgs = pushFlags.filter((t) => !t.startsWith("-"));
			// pushArgs: [remote, refspec...]
			for (const arg of pushArgs.slice(1)) {
				if (arg.includes(":")) {
					violations.push(`git push with refspec '${arg}' (may target other branch)`);
				}
			}
			continue;
		}

		// merge: 禁止（会改变当前分支状态，且涉及其他分支）
		if (sub === "merge") {
			violations.push("git merge (merges another branch into current)");
			continue;
		}

		// rebase: 禁止（重写历史，可能涉及其他分支）
		if (sub === "rebase") {
			violations.push("git rebase (rewrites branch history)");
			continue;
		}

		// reset: `git reset [file]` / `git reset HEAD [file]` (unstage) 是安全的，
		// 但 `git reset --hard/--soft/--mixed` 会改变分支状态
		if (sub === "reset") {
			const resetArgs = tokens.slice(2);
			const dangerousResetFlags = ["--hard", "--soft", "--mixed", "--merge", "--keep"];
			if (resetArgs.some((t) => dangerousResetFlags.includes(t))) {
				violations.push("git reset --hard/--soft/--mixed (alters branch state)");
			}
			// 纯 `git reset` (unstage all) 或 `git reset -- file` (unstage file) 是安全的
			continue;
		}

		// clean: 允许（只影响工作区，不影响分支）
		if (sub === "clean") continue;

		// worktree: 禁止 add（创建新 worktree 关联其他分支）
		if (sub === "worktree") {
			if (tokens.includes("add"))
				violations.push("git worktree add (creates worktree for another branch)");
			if (tokens.includes("remove")) violations.push("git worktree remove (removes worktree)");
			// list/prune 是安全的
			continue;
		}

		// filter-branch / filter-repo: 禁止
		if (sub === "filter-branch" || sub === "filter-repo") {
			violations.push(`git ${sub} (mass history rewrite)`);
			continue;
		}

		// tag: 纯 `git tag` / `git tag -l` 列出标签是只读的，
		// `git tag <name>` 创建标签 / `git tag -d` 删除标签需要拦截
		if (sub === "tag") {
			const tagFlags = tokens.slice(2);
			// -l/--list 后面的参数是 pattern，不是 tag 名
			const isListMode = tagFlags.some((t) => t === "-l" || t === "--list");
			if (isListMode) continue;
			// -n<num> / --contains / --sort 等也是只读查询
			const tagArgs = tagFlags.filter((t) => !t.startsWith("-"));
			if (
				tagArgs.length > 0 ||
				tagFlags.some((t) => t === "-d" || t === "--delete" || t === "-a" || t === "-s")
			)
				violations.push("git tag (creates/deletes tags)");
			continue;
		}

		// gc: 允许（维护操作，不影响分支）
		if (sub === "gc") continue;

		// 其他未知 git 子命令 — 保守拒绝
		violations.push(`git ${sub} (unknown git subcommand in chapter mode)`);
	}

	return violations;
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
					if (arg === "/" || arg === "/*" || arg === "~" || arg === "$HOME" || arg === `\${HOME}`) {
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
 * @param isChapter 是否在 chapter 模式下运行（启用 git 分支限制）
 */
export async function analyzeBashCommand(
	command: string,
	cwd: string,
	isChapter = false,
): Promise<BashAnalysis> {
	const parser = await getParser();
	const tree = parser.parse(command);

	const commands: BashAnalysis["commands"] = [];
	const filePaths: string[] = [];
	const nonWhitelisted: string[] = [];
	const dangerousPatterns: string[] = [];
	let hasWriteOperation = false;

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
			// 写操作标记
			if (PATH_COMMANDS_WRITE.has(cmdName)) {
				hasWriteOperation = true;
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
			// 写操作标记
			if (PATH_COMMANDS_WRITE.has(cmdName)) {
				hasWriteOperation = true;
			}
			// 检查包执行器的写操作标志
			if (cmdName === "npx" || cmdName === "bunx") {
				const classification = classifyPackageRunner(tokens, cmdName);
				if (classification.hasWriteOperation) {
					hasWriteOperation = true;
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
			// 写操作标记（mkdir, cp, mv, touch 等）
			if (PATH_COMMANDS_WRITE.has(cmdName)) {
				hasWriteOperation = true;
			}
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

	// 重定向检测：遍历所有 redirected_statement 节点，提取目标路径并标记写操作
	for (const redir of tree.rootNode.descendantsOfType("redirected_statement")) {
		const redirectTargets = extractRedirectTargets(redir.text, cwd);
		if (redirectTargets.length > 0) {
			hasWriteOperation = true;
			filePaths.push(...redirectTargets);
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

	// Chapter 模式下的 git 分支违规检测
	const gitBranchViolations = isChapter ? detectGitBranchViolations(commands) : [];

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
		gitBranchViolations,
		hasWriteOperation,
	};
}

// ── 导出供测试使用 ───────────────────────────────────────

export {
	SAFE_COMMANDS,
	ALWAYS_ASK_COMMANDS,
	PATH_COMMANDS,
	CONDITIONAL_COMMANDS,
	DANGEROUS_ENV_VARS,
	GIT_READONLY_SUBCOMMANDS,
	GIT_CURRENT_BRANCH_SAFE,
	PS_SAFE_CMDLETS,
	PS_ALWAYS_ASK_CMDLETS,
};

// ── PowerShell 命令分析 ──────────────────────────────────

/**
 * PowerShell 安全 cmdlet — 只读/无副作用操作，可自动放行。
 * 包含完整 cmdlet 名和常用别名。
 */
const PS_SAFE_CMDLETS = new Set([
	// 文件浏览（只读）
	"get-childitem",
	"gci",
	"dir",
	"ls",
	"get-content",
	"gc",
	"cat",
	"type",
	"get-item",
	"gi",
	"get-itemproperty",
	"gp",
	"test-path",
	"resolve-path",
	"split-path",
	"join-path",
	"convert-path",
	// 搜索
	"select-string",
	"sls",
	// 输出
	"write-output",
	"echo",
	"write-host",
	"write-verbose",
	"write-debug",
	"write-warning",
	"out-string",
	"out-null",
	"format-list",
	"fl",
	"format-table",
	"ft",
	"format-wide",
	"fw",
	// 系统信息（只读）
	"get-date",
	"get-location",
	"gl",
	"pwd",
	"get-command",
	"gcm",
	"get-alias",
	"gal",
	"get-help",
	"help",
	"get-host",
	"get-process",
	"gps",
	"ps",
	"get-variable",
	"gv",
	"get-module",
	"gmo",
	"get-executionpolicy",
	"get-culture",
	"get-uiculture",
	// 文本处理（只读）
	"select-object",
	"select",
	"where-object",
	"where",
	"?",
	"foreach-object",
	"foreach",
	"%",
	"sort-object",
	"sort",
	"group-object",
	"group",
	"measure-object",
	"measure",
	"compare-object",
	"diff",
	"compare",
	// 类型转换
	"convertto-json",
	"convertfrom-json",
	"convertto-csv",
	"convertfrom-csv",
	"convertto-xml",
	"convertto-html",
	// 版本控制（git 通过 PowerShell 调用）
	"git",
	// 数学
	"get-random",
	// 路径工具
	"get-psdrive",
]);

/**
 * PowerShell 危险 cmdlet — 始终需要用户确认。
 */
const PS_ALWAYS_ASK_CMDLETS = new Set([
	// 删除
	"remove-item",
	"ri",
	"rm",
	"rmdir",
	"del",
	"erase",
	"rd",
	"clear-content",
	"clc",
	"clear-item",
	"cli",
	"clear-itemproperty",
	"clp",
	// 文件写入
	"set-content",
	"sc",
	"add-content",
	"ac",
	"out-file",
	// 文件操作
	"copy-item",
	"cp",
	"copy",
	"cpi",
	"move-item",
	"mv",
	"move",
	"mi",
	"rename-item",
	"ren",
	"rni",
	"new-item",
	"ni",
	"mkdir",
	"md",
	// 进程管理
	"stop-process",
	"kill",
	"spps",
	"start-process",
	"saps",
	"start",
	// 代码执行
	"invoke-expression",
	"iex",
	"invoke-command",
	"icm",
	"start-job",
	"sajb",
	// 网络（可能下载执行）
	"invoke-webrequest",
	"iwr",
	"curl",
	"wget",
	"invoke-restmethod",
	"irm",
	// 服务管理
	"start-service",
	"sasv",
	"stop-service",
	"spsv",
	"restart-service",
	"set-service",
	// 注册表
	"set-itemproperty",
	"sp",
	"new-itemproperty",
	"remove-itemproperty",
	"rp",
	// 权限
	"set-acl",
	"set-executionpolicy",
	// 脚本执行
	"powershell",
	"pwsh",
	"cmd",
	"cmd.exe",
	// 包管理
	"install-module",
	"install-package",
	"install-script",
	// 运行时（npm/bun/yarn/pnpm 由 SAFE_COMMANDS + CONDITIONAL_COMMANDS 处理）
	"node",
	"python",
	"python3",
	// 系统控制
	"restart-computer",
	"stop-computer",
]);

/**
 * PowerShell 灾难性命令模式 — 即使 bypassPermissions 也必须拒绝。
 */
const PS_CATASTROPHIC_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{
		pattern: /remove-item\s+.*-recurse.*[/\\]\s*$/i,
		reason: "Remove-Item -Recurse on root path",
	},
	{
		pattern: /remove-item\s+.*-recurse.*\$env:systemroot/i,
		reason: "Remove-Item -Recurse on system root",
	},
	{
		pattern: /format-volume/i,
		reason: "Format-Volume (disk format)",
	},
	{
		pattern: /clear-disk/i,
		reason: "Clear-Disk (disk wipe)",
	},
	{
		pattern: /restart-computer\s*.*-force/i,
		reason: "Restart-Computer -Force",
	},
	{
		pattern: /stop-computer\s*.*-force/i,
		reason: "Stop-Computer -Force",
	},
];

/**
 * 基于正则的 PowerShell 命令分析。
 * 不使用 AST 解析器，而是通过 token 化和模式匹配来分类命令。
 */
export function analyzePowerShellCommand(
	command: string,
	_cwd: string,
	isChapter = false,
): BashAnalysis {
	const commands: BashAnalysis["commands"] = [];
	const filePaths: string[] = [];
	const nonWhitelisted: string[] = [];
	const dangerousPatterns: string[] = [];
	let hasWriteOperation = false;

	// 灾难性命令检测
	let catastrophicReason: string | undefined;
	for (const { pattern, reason } of PS_CATASTROPHIC_PATTERNS) {
		if (pattern.test(command)) {
			catastrophicReason = reason;
			break;
		}
	}

	// 将命令按 ; 和 && 和 || 分割为子命令（不按 | 分割，因为 PowerShell 管道很常见）
	const subCommands = command
		.split(/\s*(?:;|&&|\|\|)\s*/)
		.map((s) => s.trim())
		.filter(Boolean);

	for (const sub of subCommands) {
		// 提取管道中的每个命令
		const pipeSegments = splitPowerShellPipeline(sub);

		for (const segment of pipeSegments) {
			const tokens = tokenizePowerShell(segment);
			if (tokens.length === 0) continue;

			commands.push({ tokens, text: segment, fullText: sub });

			const cmdName = tokens[0];
			const cmdLower = cmdName.toLowerCase();

			// 检查是否是 git 命令（PowerShell 中也可以直接调用 git）
			if (cmdLower === "git") {
				if (cmdLower in CONDITIONAL_COMMANDS) {
					const danger = CONDITIONAL_COMMANDS[cmdLower](tokens, sub);
					if (danger) {
						if (!nonWhitelisted.includes(cmdName)) nonWhitelisted.push(cmdName);
						dangerousPatterns.push(danger);
					}
				}
				continue;
			}

			// PowerShell 安全 cmdlet
			if (PS_SAFE_CMDLETS.has(cmdLower)) {
				continue;
			}

			// PowerShell 危险 cmdlet
			if (PS_ALWAYS_ASK_CMDLETS.has(cmdLower)) {
				if (!nonWhitelisted.includes(cmdName)) nonWhitelisted.push(cmdName);
				if (
					cmdLower === "set-content" ||
					cmdLower === "sc" ||
					cmdLower === "add-content" ||
					cmdLower === "ac" ||
					cmdLower === "out-file"
				) {
					hasWriteOperation = true;
				}
				continue;
			}

			// 检查 bunx/npx（PowerShell 中也可以调用）
			if (cmdLower === "bunx" || cmdLower === "npx") {
				if (cmdLower in CONDITIONAL_COMMANDS) {
					const danger = CONDITIONAL_COMMANDS[cmdLower](tokens, sub);
					if (danger) {
						if (!nonWhitelisted.includes(cmdName)) nonWhitelisted.push(cmdName);
						dangerousPatterns.push(danger);
					}
				} else if (!SAFE_COMMANDS.has(cmdLower)) {
					if (!nonWhitelisted.includes(cmdName)) nonWhitelisted.push(cmdName);
				}
				continue;
			}

			// 检查是否是 bash 白名单中的命令（PowerShell 也能调用外部程序）
			if (SAFE_COMMANDS.has(cmdLower)) {
				if (cmdLower in CONDITIONAL_COMMANDS) {
					const danger = CONDITIONAL_COMMANDS[cmdLower](tokens, sub);
					if (danger) {
						if (!nonWhitelisted.includes(cmdName)) nonWhitelisted.push(cmdName);
						dangerousPatterns.push(danger);
					}
				}
				continue;
			}

			if (ALWAYS_ASK_COMMANDS.has(cmdLower)) {
				if (!nonWhitelisted.includes(cmdName)) nonWhitelisted.push(cmdName);
				continue;
			}

			// 未知命令 — 需要确认
			if (!nonWhitelisted.includes(cmdName)) {
				nonWhitelisted.push(cmdName);
			}
		}
	}

	// Pipe-to-shell 检测（PowerShell 版本）
	if (/\|\s*(powershell|pwsh|cmd|bash|sh|iex|invoke-expression)\b/i.test(command)) {
		const match = command.match(/\|\s*(powershell|pwsh|cmd|bash|sh|iex|invoke-expression)\b/i);
		if (match) {
			dangerousPatterns.push(`pipe to ${match[1]}`);
			if (!nonWhitelisted.includes(match[1])) nonWhitelisted.push(match[1]);
		}
	}

	// 环境变量注入检测（PowerShell 版本）
	const hasEnvInjection = /\$env:(LD_PRELOAD|NODE_OPTIONS|BASH_ENV|PROMPT_COMMAND)\b/i.test(
		command,
	);
	if (hasEnvInjection && nonWhitelisted.length === 0) {
		nonWhitelisted.push("(env injection)");
	}

	// Chapter 模式下的 git 分支违规检测
	const gitBranchViolations = isChapter ? detectGitBranchViolations(commands) : [];

	return {
		commands,
		filePaths,
		allWhitelisted:
			nonWhitelisted.length === 0 && dangerousPatterns.length === 0 && !hasEnvInjection,
		nonWhitelisted,
		dangerousPatterns,
		hasEnvInjection,
		isCatastrophic: catastrophicReason !== undefined,
		catastrophicReason,
		gitBranchViolations,
		hasWriteOperation,
	};
}

/**
 * 简单的 PowerShell 命令 token 化。
 * 按空格分割，但尊重引号内的空格。
 */
function tokenizePowerShell(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			current += ch;
		} else if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			current += ch;
		} else if ((ch === " " || ch === "\t") && !inSingle && !inDouble) {
			if (current) {
				tokens.push(current);
				current = "";
			}
		} else {
			current += ch;
		}
	}
	if (current) tokens.push(current);
	return tokens;
}

/**
 * Split a PowerShell command by pipe operator, respecting quotes and parentheses.
 */
function splitPowerShellPipeline(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let parenDepth = 0;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			current += ch;
		} else if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			current += ch;
		} else if (ch === "(" && !inSingle && !inDouble) {
			parenDepth++;
			current += ch;
		} else if (ch === ")" && !inSingle && !inDouble) {
			parenDepth = Math.max(0, parenDepth - 1);
			current += ch;
		} else if (ch === "|" && !inSingle && !inDouble && parenDepth === 0) {
			const trimmed = current.trim();
			if (trimmed) segments.push(trimmed);
			current = "";
		} else {
			current += ch;
		}
	}
	const trimmed = current.trim();
	if (trimmed) segments.push(trimmed);
	return segments;
}

/**
 * 统一的命令分析入口 — 根据 shell 类型选择合适的分析器。
 * @param shellType 当前使用的 shell 类型
 */
export async function analyzeShellCommand(
	command: string,
	cwd: string,
	shellType: "bash" | "powershell" | "cmd",
	isChapter = false,
): Promise<BashAnalysis> {
	if (shellType === "powershell") {
		return analyzePowerShellCommand(command, cwd, isChapter);
	}
	// bash 和 cmd 都使用 bash 分析器（cmd 上的命令通常也是 unix-like 工具）
	return analyzeBashCommand(command, cwd, isChapter);
}
