import { relative, sep } from "node:path";

/**
 * Default paths excluded at the native watcher level.
 *
 * These match NarraFork's actual write-heavy directories and common build/cache
 * output. They are passed to @parcel/watcher's `ignore` option and also used as
 * a second in-process filter because native watcher backends can still surface
 * already-queued events for ignored paths.
 */
export const DEFAULT_EXCLUDES: readonly string[] = [
	"**/.git/**",
	"**/.narrafork/**",
	"**/node_modules/**",
	"**/.next/**",
	"**/dist/**",
	"**/build/**",
	"**/out/**",
	"**/__pycache__/**",
	"**/.cache/**",
	"**/.parcel-cache/**",
	"**/.turbo/**",
	"**/.nuxt/**",
	"**/.output/**",
	"**/.svelte-kit/**",
	"**/target/**",
	"**/.venv/**",
	"**/venv/**",
	"**/vendor/**",
	"**/.gradle/**",
	"**/.idea/**",
	"**/.vscode/**",
	"**/coverage/**",
	"**/.nyc_output/**",
	"**/.pytest_cache/**",
	"**/.mypy_cache/**",
	"**/.ruff_cache/**",
	"**/.tox/**",
	"**/.worktrees/**",
	"**/*.db",
	"**/*.db-wal",
	"**/*.db-shm",
	"**/*.db-journal",
	"**/*.sqlite",
	"**/*.sqlite-wal",
	"**/*.sqlite-shm",
	"**/*.log",
];

const DEFAULT_EXCLUDE_SEGMENTS = new Set([
	".git",
	".narrafork",
	".worktrees",
	"node_modules",
	".next",
	"dist",
	"build",
	"out",
	"__pycache__",
	".cache",
	".parcel-cache",
	".turbo",
	".nuxt",
	".output",
	".svelte-kit",
	"target",
	".venv",
	"venv",
	"vendor",
	".gradle",
	".idea",
	".vscode",
	"coverage",
	".nyc_output",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".tox",
]);

const DEFAULT_EXCLUDE_FILE_SUFFIXES = [
	".db",
	".db-wal",
	".db-shm",
	".db-journal",
	".sqlite",
	".sqlite-wal",
	".sqlite-shm",
	".log",
];

function normalizePathForMatch(path: string): string {
	return path.split(sep).join("/");
}

export function isIgnoredEventPath(rootPath: string, eventPath: string): boolean {
	const rel = normalizePathForMatch(relative(rootPath, eventPath));
	if (!rel || rel === ".") return false;
	if (rel.startsWith("../") || rel === "..") return true;
	const segments = rel.split("/");
	if (segments.some((segment) => DEFAULT_EXCLUDE_SEGMENTS.has(segment))) return true;
	const lower = rel.toLowerCase();
	return DEFAULT_EXCLUDE_FILE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}
