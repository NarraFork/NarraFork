/**
 * Where a project's origin lives (M, W), read off the request path and cached per repository.
 *
 * Origin is read from the raw configuration (`team-git-write.ts:originTarget`): `remote.origin
 * .url` with only the host's own `pushInsteadOf` / `insteadOf` applied — never git's
 * `get-url --push`, which would apply a `pushurl` or a rewrite the repository's own configuration
 * (agent-writable) sets; those are refused (`unsafe`). It is parsed here: scp-style `[user@]host:path`,
 * `ssh://[user@]host[:port]/path` (`ssh.github.com:443` is github.com) and
 * `http(s)://[userinfo@]host/path` (userinfo dropped, never logged). The host is lowercased and
 * the path must be exactly `owner/repo` (a trailing `/` and `.git` removed).
 *
 * GitHub decides the merge flow (a pull request, `team-merge-pr.ts`) and the default work start
 * (`origin/<base>`). github.com is GitHub by name; another host (a GitHub Enterprise Server) is
 * GitHub only when gh is logged in there or at least knows it (`gh auth status --hostname H --json
 * hosts` lists it). For a GitHub origin the probe then asks, off the request path: is gh installed
 * (`Bun.which`, `gh --version`, 5 s), logged in to that host, and may its account write to the
 * repository (`gh repo view host/owner/repo --json viewerPermission,…`: WRITE, MAINTAIN or ADMIN,
 * not archived) — and which merge methods the repository allows, the viewer's default first. A
 * GitHub origin whose gh cannot do this keeps the PR flow, disabled with the reason ({@link
 * GhAccess}); it never falls back to a local merge.
 *
 * Requests only read the cache ({@link peekHosting}); a miss or a stale entry starts one
 * background read per repository (single-flight) and answers null ("checking") meanwhile. A read
 * is kept 5 minutes; a failed one, or a GitHub origin gh cannot serve, 60 seconds.
 */
import type { TeamPrMergeMethod, TeamWorkStart } from "@shared/project-teams";
import { hotSafe } from "../../lib/hot-safe";
import { logger } from "../../lib/logger";
import {
	GhError,
	type GhRepo,
	ghAuthStatus,
	ghBinary,
	ghRepoView,
	ghVersion,
	isGhRepo,
} from "./team-gh";
import { type OriginTarget, teamRepoGit, UnsafeRemoteConfigError } from "./team-git-write";

/** A parsed remote URL: lowercased host and its `owner/repo` path. */
export interface RemoteLocation {
	host: string;
	owner: string;
	repo: string;
}

/**
 * What gh can do for a GitHub origin: everything the PR flow needs (with the merge methods the
 * repository allows, its default first), or why not.
 */
export type GhAccess =
	| { ok: true; methods: TeamPrMergeMethod[] }
	| {
			ok: false;
			reason:
				| "gh_missing"
				| "gh_logged_out"
				| "gh_no_permission"
				| "gh_repo_archived"
				| "gh_unavailable";
			/** gh's own complaint (no secrets: gh prints none), cut short. */
			message?: string;
	  };

export type ProjectHosting =
	/** `gh`: what gh can do there (absent only from {@link hostingOfUrl}, which runs nothing). */
	| { kind: "github"; host: string; owner: string; repo: string; gh?: GhAccess }
	| { kind: "other"; host: string | null }
	| { kind: "none" }
	/** The push URL could not be read: neither GitHub nor not (merging waits; never local). */
	| { kind: "unknown" }
	/** G: the repository's own configuration redirects origin (a push URL or a rewrite): refused. */
	| { kind: "unsafe"; key: string };

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

/**
 * The default work start: `origin/<base>` when origin is on GitHub, else the local base (an
 * unreadable origin starts locally: nothing is merged from it, and the item's start is recorded).
 */
export function defaultWorkStart(hosting: ProjectHosting): TeamWorkStart {
	return hosting.kind === "github" ? "remote" : "local";
}

// ── gh ──────────────────────────────────────────────────────────────────────

const WRITERS = new Set(["WRITE", "MAINTAIN", "ADMIN"]);

/** What gh can do for a GitHub repository (never throws). */
export async function probeGhAccess(target: GhRepo): Promise<GhAccess> {
	if (state.ghProbe) return state.ghProbe(target);
	if (!isGhRepo(target))
		return { ok: false, reason: "gh_unavailable", message: "Not a repository gh can name" };
	if (!ghBinary()) return { ok: false, reason: "gh_missing" };
	try {
		await ghVersion();
	} catch (error) {
		return { ok: false, reason: "gh_missing", message: messageOf(error) };
	}
	try {
		const auth = await ghAuthStatus(target.host);
		if (!auth.loggedIn) return { ok: false, reason: "gh_logged_out" };
	} catch (error) {
		return { ok: false, reason: "gh_unavailable", message: messageOf(error) };
	}
	try {
		const facts = await ghRepoView(target);
		if (facts.archived) return { ok: false, reason: "gh_repo_archived" };
		if (!facts.permission || !WRITERS.has(facts.permission))
			return { ok: false, reason: "gh_no_permission" };
		return { ok: true, methods: facts.methods };
	} catch (error) {
		return { ok: false, reason: "gh_unavailable", message: messageOf(error) };
	}
}

const messageOf = (error: unknown) =>
	(error instanceof Error ? error.message : String(error)).slice(0, 300);

/**
 * Whether a host that is not github.com is a GitHub Enterprise host: gh knows it (logged in or
 * not). False without gh.
 */
async function isEnterpriseHost(host: string): Promise<boolean> {
	if (state.enterpriseProbe) return state.enterpriseProbe(host);
	if (!ghBinary()) return false;
	try {
		return (await ghAuthStatus(host)).listed;
	} catch (error) {
		if (!(error instanceof GhError)) throw error;
		return false;
	}
}

/** The hosting of a push URL with gh asked (GitHub Enterprise, what gh can do there). */
export async function resolveHosting(url: string | null): Promise<ProjectHosting> {
	const byName = hostingOfUrl(url);
	if (byName.kind === "github") return { ...byName, gh: await probeGhAccess(byName) };
	if (byName.kind !== "other" || !url) return byName;
	const location = parseRemoteUrl(url);
	if (!location || !isGhRepo(location) || !(await isEnterpriseHost(location.host))) return byName;
	const target = { host: location.host, owner: location.owner, repo: location.repo };
	return { kind: "github", ...target, gh: await probeGhAccess(target) };
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

/** How origin is read: its URL as configured, and as the host's rewrites leave it. */
type OriginSource = (repo: string) => Promise<OriginTarget | null>;
/** The tests' stand-in: one URL, both configured and resolved. */
type HostingSource = (repo: string) => Promise<string | null>;

const state = hotSafe("narrafork.teams.hosting", () => ({
	entries: new Map<string, Entry>(),
	source: null as OriginSource | null,
	now: () => Date.now(),
	ghProbe: null as ((target: GhRepo) => Promise<GhAccess>) | null,
	enterpriseProbe: null as ((host: string) => Promise<boolean>) | null,
}));

const readOrigin: OriginSource = (repo) => teamRepoGit(repo).originTarget();

/** Replace how the push URL is read, and the clock (tests); null restores git. Clears the cache. */
export function setHostingSourceForTests(
	source: HostingSource | null,
	now: (() => number) | null = null,
): void {
	state.source = source
		? async (repo) => {
				const url = await source(repo);
				return url ? { url, resolved: url } : null;
			}
		: null;
	state.now = now ?? (() => Date.now());
	state.entries.clear();
}

/**
 * Replace gh's probes (tests): what gh can do for a GitHub repository, and whether a host is a
 * GitHub Enterprise host. Null restores gh. Clears the cache.
 */
export function setGhProbeForTests(
	probe: ((target: GhRepo) => Promise<GhAccess>) | null,
	enterprise: ((host: string) => Promise<boolean>) | null = null,
): void {
	state.ghProbe = probe;
	state.enterpriseProbe = enterprise;
	state.entries.clear();
}

/**
 * A repository's origin now (the same source the hosting is read from): the URL to push to and
 * where it resolves. Throws `UnsafeRemoteConfigError` for a redirected origin.
 */
export function readOriginTarget(repo: string): Promise<OriginTarget | null> {
	return (state.source ?? readOrigin)(repo);
}

/** Forget a repository's hosting (a person changed something): the next read asks again. */
export function forgetHosting(repo: string): void {
	const entry = state.entries.get(repo);
	if (entry && !entry.pending) state.entries.delete(repo);
}

/** Whether a read hosting is one to keep briefly: gh cannot serve a GitHub origin yet. */
const shortLived = (value: ProjectHosting) =>
	(value.kind === "github" && value.gh?.ok === false) || value.kind === "unsafe";

function refresh(repo: string): Promise<ProjectHosting> {
	const entry = state.entries.get(repo);
	if (entry?.pending) return entry.pending;
	const read = readOriginTarget(repo).then(
		(origin) => resolveHosting(origin?.resolved ?? null),
		(error: unknown): ProjectHosting => {
			if (error instanceof UnsafeRemoteConfigError) return { kind: "unsafe", key: error.key };
			throw error;
		},
	);
	const pending = read
		.then((value) => {
			const ttl = shortLived(value) ? FAILURE_TTL_MS : SUCCESS_TTL_MS;
			store(repo, { value, at: state.now(), ttl, pending: null });
			return value;
		})
		.catch((error: unknown) => {
			logger.debug("Team hosting could not be read", {
				error: error instanceof Error ? error.message : String(error),
			});
			// Unreadable is unknown, never "not GitHub": a merge waits (it never falls back to the
			// local flow), and the read is tried again soon.
			const value: ProjectHosting = { kind: "unknown" };
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
