/**
 * Where a project's origin lives (M, W), read off the request path and cached per repository.
 *
 * The push URL is read with `git remote get-url --push origin` (it applies `pushurl` and
 * `insteadOf`; raw configuration is never read) and parsed here: scp-style `[user@]host:path`,
 * `ssh://[user@]host[:port]/path` (`ssh.github.com:443` is github.com) and
 * `http(s)://[userinfo@]host/path` (userinfo dropped, never logged). The host is lowercased and
 * the path must be exactly `owner/repo` (a trailing `/` and `.git` removed).
 *
 * This part only tells github.com apart from everything else: GitHub decides the merge flow (a
 * pull request, a later PR) and the default work start (`origin/<base>`). Another host, a GitHub
 * Enterprise host included, counts as "other" until the gh probe of the PR flow can say it is
 * logged in there.
 *
 * Requests only read the cache ({@link peekHosting}); a miss or a stale entry starts one
 * background read per repository (single-flight) and answers null ("checking") meanwhile. A read
 * is kept 5 minutes, a failed one 60 seconds.
 */
import type { TeamWorkStart } from "@shared/project-teams";
import { hotSafe } from "../../lib/hot-safe";
import { logger } from "../../lib/logger";
import { teamRepoGit } from "./team-git-write";

/** A parsed remote URL: lowercased host and its `owner/repo` path. */
export interface RemoteLocation {
	host: string;
	owner: string;
	repo: string;
}

export type ProjectHosting =
	| { kind: "github"; host: string; owner: string; repo: string }
	| { kind: "other"; host: string | null }
	| { kind: "none" };

const GITHUB_HOSTS = new Map([
	["github.com", "github.com"],
	["www.github.com", "github.com"],
	["ssh.github.com", "github.com"],
]);

/** Split `owner/repo[.git][/]` into its two segments, or null for any other path. */
function ownerRepo(path: string): { owner: string; repo: string } | null {
	const trimmed = path
		.replace(/^\/+/, "")
		.replace(/\/+$/, "")
		.replace(/\.git$/i, "");
	const parts = trimmed.split("/");
	if (parts.length !== 2) return null;
	const [owner, repo] = parts;
	if (!owner || !repo || owner === "." || owner === ".." || repo === "." || repo === "..")
		return null;
	return { owner, repo };
}

/** Parse a remote URL as git accepts it; null for a local path or anything unrecognized. */
export function parseRemoteUrl(url: string): RemoteLocation | null {
	const value = url.trim();
	if (!value) return null;
	const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
	if (scheme) {
		const protocol = scheme[1]?.toLowerCase();
		if (protocol !== "ssh" && protocol !== "https" && protocol !== "http" && protocol !== "git")
			return null;
		let parsed: URL;
		try {
			parsed = new URL(value);
		} catch {
			return null;
		}
		const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
		if (!host) return null;
		const path = ownerRepo(decodeURIComponent(parsed.pathname));
		return path ? { host, ...path } : null;
	}
	// scp-like: [user@]host:path — no slash before the colon (that would be a local path).
	const scp = /^(?:[^@/]+@)?([^:/\\]+):(?!\/\/)(.+)$/.exec(value);
	if (!scp?.[1] || !scp[2]) return null;
	// `C:\repo` / `C:/repo` is a Windows path, not a host.
	if (/^[a-z]$/i.test(scp[1])) return null;
	const path = ownerRepo(scp[2]);
	return path ? { host: scp[1].toLowerCase(), ...path } : null;
}

/** github.com (and its ssh-over-443 host) by name; null for any other host. */
export function githubHostOf(host: string): string | null {
	return GITHUB_HOSTS.get(host.toLowerCase()) ?? null;
}

/** What a push URL says about the hosting (no URL: no origin). */
export function hostingOfUrl(url: string | null): ProjectHosting {
	if (!url) return { kind: "none" };
	const location = parseRemoteUrl(url);
	if (!location) return { kind: "other", host: null };
	const github = githubHostOf(location.host);
	return github
		? { kind: "github", host: github, owner: location.owner, repo: location.repo }
		: { kind: "other", host: location.host };
}

/** The default work start: `origin/<base>` when origin is on GitHub, else the local base. */
export function defaultWorkStart(hosting: ProjectHosting): TeamWorkStart {
	return hosting.kind === "github" ? "remote" : "local";
}

// ── The cache ───────────────────────────────────────────────────────────────

const SUCCESS_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 60_000;
const CACHE_MAX = 200;

interface Entry {
	value: ProjectHosting | null;
	at: number;
	ttl: number;
	pending: Promise<ProjectHosting> | null;
}

type HostingSource = (repo: string) => Promise<string | null>;

const state = hotSafe("narrafork.teams.hosting", () => ({
	entries: new Map<string, Entry>(),
	source: null as HostingSource | null,
	now: () => Date.now(),
}));

const readPushUrl: HostingSource = (repo) => teamRepoGit(repo).originPushUrl();

/** Replace how the push URL is read, and the clock (tests); null restores git. Clears the cache. */
export function setHostingSourceForTests(
	source: HostingSource | null,
	now: (() => number) | null = null,
): void {
	state.source = source;
	state.now = now ?? (() => Date.now());
	state.entries.clear();
}

function refresh(repo: string): Promise<ProjectHosting> {
	const entry = state.entries.get(repo);
	if (entry?.pending) return entry.pending;
	const read = (state.source ?? readPushUrl)(repo);
	const pending = read
		.then((url) => {
			const value = hostingOfUrl(url);
			store(repo, { value, at: state.now(), ttl: SUCCESS_TTL_MS, pending: null });
			return value;
		})
		.catch((error: unknown) => {
			logger.debug("Team hosting could not be read", {
				error: error instanceof Error ? error.message : String(error),
			});
			// Unreadable counts as no GitHub (the local flow), and is asked again soon.
			const value: ProjectHosting = { kind: "other", host: null };
			store(repo, { value, at: state.now(), ttl: FAILURE_TTL_MS, pending: null });
			return value;
		});
	store(repo, {
		value: entry?.value ?? null,
		at: entry?.at ?? 0,
		ttl: entry?.ttl ?? 0,
		pending,
	});
	return pending;
}

function store(repo: string, entry: Entry): void {
	state.entries.delete(repo);
	state.entries.set(repo, entry);
	while (state.entries.size > CACHE_MAX) {
		const oldest = state.entries.keys().next().value;
		if (oldest === undefined) break;
		state.entries.delete(oldest);
	}
}

/**
 * The cached hosting of a repository, or null while it is being read. A stale entry is still
 * answered while it is read again in the background.
 */
export function peekHosting(repo: string): ProjectHosting | null {
	const entry = state.entries.get(repo);
	const fresh = entry?.value && state.now() - entry.at < entry.ttl;
	if (!fresh) void refresh(repo);
	return entry?.value ?? null;
}

/** The hosting of a repository, read now when not cached (background jobs only). */
export async function hostingOf(repo: string): Promise<ProjectHosting> {
	const entry = state.entries.get(repo);
	if (entry?.value && state.now() - entry.at < entry.ttl) return entry.value;
	return refresh(repo);
}
