/**
 * transaction-atomicity-contract.test.ts — the transaction contract for the dual-database work.
 *
 * WHY THIS EXISTS
 * ---------------
 * Phase 1 was originally scoped as "make every SQLite transaction path async first, then add
 * PostgreSQL". That plan is not merely awkward — it is unsound, and this file is the executable
 * proof plus the gate that keeps the unsound shape out.
 *
 * `bun:sqlite` is synchronous. `Database.transaction(fn)` wraps `fn` in BEGIN/COMMIT and commits
 * when `fn` RETURNS. An `async fn` returns a Promise at its first `await`, so the COMMIT fires
 * there — while the caller still believes it is inside the transaction. Everything after the
 * first `await` executes in autocommit:
 *
 *   - it is NOT rolled back when the callback later throws (silent partial writes), and
 *   - it may execute while a DIFFERENT request's transaction is open on the same connection.
 *
 * Drizzle's bun-sqlite session (`drizzle-orm/bun-sqlite/session.js`) delegates directly to that
 * native call, so it inherits the semantics exactly. Worse: `await tx.insert(...)` yields BEFORE
 * the statement executes, so the native transaction can commit completely EMPTY and the write
 * lands outside it. Nothing reports an error in either case.
 *
 * This is not hypothetical. `server/services/narrator-persistence.ts` already carries a fix for
 * exactly this bug: an async transaction committed the message insert but left the ref insert
 * outside, producing "message without ref" orphans that the frontend surfaced as
 * "Message not found". The fix was to drop to a synchronous native transaction.
 *
 * THE CONTRACT
 * ------------
 *   1. Business entry points may be `async` and return Promises. Async is the CALLER's shape.
 *   2. A SQLite atomic section is STRICTLY SYNCHRONOUS: no `await` between BEGIN and COMMIT,
 *      ever. It is a synchronous callback that reads, decides and writes, then returns.
 *   3. Awaitable work (I/O, git, network, other services) happens BEFORE or AFTER the atomic
 *      section, never inside it.
 *   4. PostgreSQL, when it arrives, gets its own genuinely-async adapter. It does NOT reshape
 *      the SQLite path, because a networked driver's `await` is safe and SQLite's is not.
 *
 * Rule 2 is what this file enforces mechanically. Rules 1/3/4 are design; the behavioral tests
 * below exist so that anyone questioning rule 2 can run it instead of arguing about it.
 *
 * HOW FAR THE MECHANICAL PART REACHES
 * -----------------------------------
 * The gate parses the source and decides per call site. It is conclusive for an inline callback
 * (the body is right there) and NOT conclusive for a callback arriving by reference. An earlier
 * version of this file papered over that second case by claiming the parameter's declared type
 * rejected async callbacks; it does not, and `type-level-claims.probe.ts` compiles the
 * counterexamples to keep that correction from eroding. What actually protects the five
 * forwarding wrappers today is `private` + a bounded set of in-module call sites, so that is what
 * the gate checks, and shapes it cannot resolve (a member reference) are reported rather than
 * skipped. Coverage claims here are meant to be smaller than reality, never larger.
 *
 * WHAT THIS FILE IS NOT
 * ---------------------
 * Not a benchmark, not a migration, and not a claim that async transactions are impossible in
 * general — they are correct and normal for networked drivers. The claim is narrower and
 * verified here: they are unsound for `bun:sqlite`, therefore the SQLite adapter must keep its
 * atomic sections synchronous, therefore Phase 1's "async-first" ordering must be inverted.
 * Nothing here is pre-emptively relaxed for a future PostgreSQL adapter: rule 4 gives it a
 * separate async path, so the SQLite rule does not need loosening to accommodate it.
 *
 * ISOLATION
 * ---------
 * Every database here is `:memory:` or a per-test temp file, constructed locally. This file
 * never imports `server/db`, so it opens no real connection and needs no fixture cleanup.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { parse } from "@babel/parser";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

const rows = sqliteTable("contract_rows", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	v: text("v").notNull(),
});

const CREATE_TABLE =
	"CREATE TABLE contract_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT NOT NULL)";

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** In-memory database + Drizzle handle. No file, no shared state between tests. */
function freshDb() {
	const client = new Database(":memory:");
	client.exec(CREATE_TABLE);
	return {
		client,
		db: drizzle({ client }),
		values: () =>
			(client.prepare("SELECT v FROM contract_rows ORDER BY id").all() as { v: string }[]).map(
				(r) => r.v,
			),
	};
}

/**
 * Whether a transaction is currently open on `client`.
 *
 * `bun:sqlite` exposes this directly as `Database.inTransaction`, which is a side-effect-free
 * read of `sqlite3_get_autocommit()`. Verified against this exact driver version: `false` before
 * and after a transaction, `true` inside a synchronous callback and inside a nested savepoint,
 * `false` again after a raw `BEGIN`/`ROLLBACK` pair.
 *
 * An earlier version of this file probed by attempting a nested `BEGIN` and treating the throw
 * as "in transaction". That probe opened and rolled back a real transaction just to answer the
 * question, and it reported `true` for any failing `BEGIN` — a closed handle included — so a
 * broken connection would have looked like a healthy open transaction.
 */
function inTransaction(client: Database): boolean {
	return client.inTransaction;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The hazard, at the driver level
// ─────────────────────────────────────────────────────────────────────────────

describe("bun:sqlite transaction semantics (the reason for the contract)", () => {
	it("commits an async callback at its first await, not at its end", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nf-tx-contract-"));
		tempDirs.push(dir);
		const path = join(dir, "commit-boundary.db");

		const writer = new Database(path, { create: true });
		writer.exec("PRAGMA journal_mode = WAL");
		writer.exec(CREATE_TABLE);
		// A SEPARATE connection is the only honest observer: it can see only committed data,
		// so what it sees mid-callback is proof of a real COMMIT rather than of visibility
		// inside our own transaction.
		const observer = new Database(path, { readonly: true });
		const committed = () =>
			(observer.prepare("SELECT v FROM contract_rows ORDER BY id").all() as { v: string }[]).map(
				(r) => r.v,
			);

		const seenBeforeAwait: string[][] = [];
		const tx = writer.transaction(async () => {
			writer.prepare("INSERT INTO contract_rows (v) VALUES ('pre-await')").run();
			seenBeforeAwait.push(committed());
			await Promise.resolve();
			writer.prepare("INSERT INTO contract_rows (v) VALUES ('post-await')").run();
			throw new Error("if the transaction were still open, nothing would survive this");
		});

		const returned = tx();
		// The native call handed back a Promise, which is the whole problem: the transaction
		// bookkeeping already finished while the callback's body has not.
		expect(returned).toBeInstanceOf(Promise);
		// Committed the instant tx() returned — before the callback resumed.
		expect(committed()).toEqual(["pre-await"]);

		await expect(returned).rejects.toThrow("nothing would survive this");

		// Uncommitted while the callback was still in its synchronous prefix.
		expect(seenBeforeAwait).toEqual([[]]);
		// The throw rolled back NOTHING: the pre-await row was already committed, and the
		// post-await row was written in autocommit, outside any transaction.
		expect(committed()).toEqual(["pre-await", "post-await"]);

		observer.close();
		writer.close();
	});

	it("keeps a synchronous callback atomic, and rolls it back on throw", () => {
		const { client, values } = freshDb();
		client.prepare("INSERT INTO contract_rows (v) VALUES ('committed-earlier')").run();

		const tx = client.transaction(() => {
			client.prepare("INSERT INTO contract_rows (v) VALUES ('doomed-1')").run();
			expect(inTransaction(client)).toBe(true);
			client.prepare("INSERT INTO contract_rows (v) VALUES ('doomed-2')").run();
			throw new Error("business rule violated");
		});

		expect(() => tx()).toThrow("business rule violated");
		// All-or-nothing, which is the property the async form silently loses.
		expect(values()).toEqual(["committed-earlier"]);
		client.close();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The hazard, through Drizzle (what production actually calls)
// ─────────────────────────────────────────────────────────────────────────────

describe("Drizzle bun-sqlite inherits the hazard", () => {
	it("runs an awaited builder OUTSIDE the transaction, committing it empty", async () => {
		const { client, db, values } = freshDb();
		const where: Record<string, boolean> = {};

		const promise = db.transaction(async (tx) => {
			where.onEntry = inTransaction(client);
			// `await` on a Drizzle builder yields BEFORE the statement executes. The native
			// transaction therefore commits with zero statements in it, and this insert runs
			// afterwards in autocommit.
			await tx.insert(rows).values({ v: "awaited-insert" });
			where.afterAwaitedInsert = inTransaction(client);
			throw new Error("nothing to roll back — the transaction already closed");
		});

		await expect(promise).rejects.toThrow("already closed");

		expect(where.onEntry).toBe(true);
		expect(where.afterAwaitedInsert).toBe(false);
		// The row survives a thrown transaction. This is the failure mode that produced the
		// "message without ref" orphans in narrator-persistence.ts.
		expect(values()).toEqual(["awaited-insert"]);
		client.close();
	});

	it("leaves post-await writes unprotected even when the prefix is synchronous", async () => {
		const { client, db, values } = freshDb();

		const promise = db.transaction(async (tx) => {
			tx.insert(rows).values({ v: "sync-prefix" }).run(); // inside the transaction
			await Promise.resolve(); // COMMIT happens here
			tx.insert(rows).values({ v: "orphan" }).run(); // autocommit, unprotected
			throw new Error("boom");
		});

		await expect(promise).rejects.toThrow("boom");
		// Both rows persist: the first because it was committed, the second because it was
		// never in a transaction at all. A reviewer reading the callback would expect neither.
		expect(values()).toEqual(["sync-prefix", "orphan"]);
		client.close();
	});

	it("wrapping a sync transaction in Promise.resolve does not make it async-safe", async () => {
		// Guarding against the tempting shortcut of "satisfying" an async signature by
		// wrapping the sync call. It type-checks and the atomicity is real — but only because
		// the atomic section stayed synchronous. The wrapper adds nothing, so it must not be
		// mistaken for, or presented as, an async transaction.
		const { client, db, values } = freshDb();

		const result = await Promise.resolve(
			db.transaction((tx) => {
				tx.insert(rows).values({ v: "a" }).run();
				tx.insert(rows).values({ v: "b" }).run();
				return "done";
			}),
		);

		expect(result).toBe("done");
		expect(values()).toEqual(["a", "b"]);

		// The honest description of what happened: the transaction had already committed
		// before the Promise was created, because the callback was synchronous.
		expect(inTransaction(client)).toBe(false);
		client.close();
	});

	it("rolls back only the inner savepoint on nested transactions", () => {
		// Nesting is sound — but only for synchronous callbacks, and it is worth pinning
		// because the contract's "one synchronous atomic section" phrasing must not be read
		// as forbidding composition of synchronous units.
		const { client, db, values } = freshDb();

		db.transaction((tx) => {
			tx.insert(rows).values({ v: "outer-1" }).run();
			expect(() =>
				tx.transaction((inner) => {
					inner.insert(rows).values({ v: "inner-doomed" }).run();
					throw new Error("inner failed");
				}),
			).toThrow("inner failed");
			tx.insert(rows).values({ v: "outer-2" }).run();
		});

		expect(values()).toEqual(["outer-1", "outer-2"]);
		client.close();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Cross-request contamination
// ─────────────────────────────────────────────────────────────────────────────

describe("async transactions leak across concurrent requests", () => {
	it("strands one request's late write outside every transaction", async () => {
		// Two overlapping "requests" on the single shared connection, which is exactly how
		// the server runs: request A holds an async transaction across an await while
		// request B opens its own transaction and fails.
		const { client, db, values } = freshDb();

		let releaseA: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseA = resolve;
		});

		const requestA = db.transaction(async (tx) => {
			tx.insert(rows).values({ v: "A-early" }).run();
			await gate; // A's transaction commits here
			tx.insert(rows).values({ v: "A-late" }).run(); // no transaction protects this
		});

		await Promise.resolve(); // let A reach its await
		expect(values()).toEqual(["A-early"]);

		let requestBFailed = false;
		try {
			db.transaction((tx) => {
				tx.insert(rows).values({ v: "B-1" }).run();
				releaseA();
				tx.insert(rows).values({ v: "B-2" }).run();
				throw new Error("B failed");
			});
		} catch {
			requestBFailed = true;
		}

		await requestA;

		// B, being synchronous, was correctly atomic: neither of its rows survives.
		expect(requestBFailed).toBe(true);
		expect(values()).not.toContain("B-1");
		expect(values()).not.toContain("B-2");
		// A's late write persists with no atomicity guarantee whatsoever. Had A thrown after
		// it, or had it needed to roll back with A-early, nothing would have undone it.
		expect(values()).toEqual(["A-early", "A-late"]);
		client.close();
	});

	it("interleaves two async transactions' statements on the shared connection", async () => {
		const { client, db, values } = freshDb();

		// Explicit gates rather than `setTimeout(20)` vs `setTimeout(5)`: the interleaving under
		// test is a property of the commit boundary, not of the timer wheel, and a wall-clock
		// race would make this assertion flaky on a loaded machine for reasons unrelated to it.
		let releaseA: () => void = () => {};
		const aMayFinish = new Promise<void>((resolve) => {
			releaseA = resolve;
		});

		const a = db.transaction(async (tx) => {
			tx.insert(rows).values({ v: "A1" }).run();
			await aMayFinish;
			tx.insert(rows).values({ v: "A2" }).run();
		});
		const b = db.transaction(async (tx) => {
			tx.insert(rows).values({ v: "B1" }).run();
			await Promise.resolve();
			tx.insert(rows).values({ v: "B2" }).run();
			releaseA();
		});

		await Promise.all([a, b]);

		// Neither "transaction" isolated anything: B ran to completion in the middle of A, and
		// B's writes are visible between A's two statements.
		expect(values()).toEqual(["A1", "B1", "B2", "A2"]);
		// Both handles closed with nothing open — every statement above landed in autocommit.
		expect(inTransaction(client)).toBe(false);
		client.close();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The prescribed shape works
// ─────────────────────────────────────────────────────────────────────────────

describe("async business entry point over a synchronous atomic section", () => {
	/** The contract's shape: awaitable outside, strictly synchronous inside. */
	async function businessOperation(
		db: ReturnType<typeof freshDb>["db"],
		name: string,
	): Promise<string> {
		await new Promise((r) => setTimeout(r, 1)); // pre-work: I/O, git, other services
		const outcome = db.transaction((tx) => {
			tx.insert(rows)
				.values({ v: `${name}-1` })
				.run();
			tx.insert(rows)
				.values({ v: `${name}-2` })
				.run();
			if (name === "invalid") throw new Error("business rule violated");
			return `${name}-ok`;
		});
		await new Promise((r) => setTimeout(r, 1)); // post-work: broadcast, cache, cleanup
		return outcome;
	}

	it("is awaitable, returns the atomic section's value, and rolls back cleanly", async () => {
		const { client, db, values } = freshDb();

		const results = await Promise.allSettled([
			businessOperation(db, "x"),
			businessOperation(db, "invalid"),
			businessOperation(db, "y"),
		]);

		expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
		expect((results[0] as PromiseFulfilledResult<string>).value).toBe("x-ok");
		// The failed operation left no partial row — the property the async form loses.
		expect(values().filter((v) => v.startsWith("invalid"))).toEqual([]);
		expect(values().sort()).toEqual(["x-1", "x-2", "y-1", "y-2"]);
		client.close();
	});

	it("never splits an atomic section under concurrency", async () => {
		const { client, db, values } = freshDb();

		const operations = Array.from({ length: 25 }, (_, i) => businessOperation(db, `c${i}`));
		await Promise.all(operations);

		// Each operation writes exactly two adjacent rows. Any interleaving would separate a
		// pair, which is precisely what the synchronous atomic section makes impossible.
		const written = values();
		expect(written).toHaveLength(50);
		for (let i = 0; i < written.length; i += 2) {
			expect(written[i]?.replace(/-1$/, "")).toBe(written[i + 1]?.replace(/-2$/, ""));
		}
		client.close();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The gate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Source-level enforcement of rule 2.
 *
 * Nothing else in the pipeline can catch this. `db.transaction(async (tx) => …)` type-checks
 * (Drizzle's overloads accept it), Biome formats it, and tests pass — because the writes DO
 * land, just without atomicity. The damage only appears later, as orphaned rows after an
 * unrelated failure. So the shape has to be rejected at authoring time.
 */

const SCAN_ROOTS = ["server", "shared"] as const;
const SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
	"node_modules",
	"dist",
	"build",
	".git",
	"generated",
]);

function toPosixRelative(absolute: string): string {
	return relative(REPO_ROOT, absolute).split(sep).join("/");
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (SKIP_DIR_NAMES.has(entry)) continue;
			collectSourceFiles(full, out);
			continue;
		}
		if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
		// Tests construct hazardous shapes deliberately — this file most of all. Filtering by
		// FILENAME rather than by directory keeps non-test helpers inside `__tests__` in view;
		// skipping the whole directory (as an earlier version did) would exempt them, and a
		// shared test harness that opens a transaction is production-shaped code.
		if (entry.includes(".test.") || entry.includes(".spec.")) continue;
		// `.probe.` files exist to hold counterexamples that must compile but must never run —
		// `type-level-claims.probe.ts` deliberately passes an async callback to a transaction, and
		// the gate correctly flags it. The exemption is narrow (a naming convention, verified
		// below to cover exactly one file) rather than a path exception that could grow silently.
		if (entry.includes(".probe.")) continue;
		out.push(full);
	}
	return out;
}

/** Every .ts/.tsx file, exemptions included — used to prove the exemptions stay small. */
function allTypeScriptFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (SKIP_DIR_NAMES.has(entry)) continue;
			allTypeScriptFiles(full, out);
			continue;
		}
		if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
	}
	return out;
}

interface Violation {
	readonly file: string;
	readonly line: number;
	readonly reason: string;
}

type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
	return !!value && typeof value === "object" && typeof (value as Node).type === "string";
}

/** Child nodes, minus the metadata Babel hangs off every node. */
function childNodes(node: Node): Node[] {
	const out: Node[] = [];
	for (const [key, value] of Object.entries(node)) {
		if (key === "loc" || key.endsWith("Comments")) continue;
		if (Array.isArray(value)) {
			for (const item of value) if (isNode(item)) out.push(item);
		} else if (isNode(value)) out.push(value);
	}
	return out;
}

const FUNCTION_TYPES: ReadonlySet<string> = new Set([
	"ArrowFunctionExpression",
	"FunctionExpression",
	"FunctionDeclaration",
	"ClassMethod",
	"ClassPrivateMethod",
	"ObjectMethod",
]);

function lineOf(node: Node): number {
	const loc = node.loc as { start?: { line?: number } } | undefined;
	return loc?.start?.line ?? 0;
}

function parseSource(source: string, file: string): Node {
	return parse(source, {
		sourceType: "module",
		// `typescript` alone for .ts: enabling `jsx` there breaks generic arrow functions
		// (`<T>(x) => x` parses as a JSX element), which silently skipped three real files
		// when this gate was first prototyped with a single plugin set for everything.
		plugins: ["typescript", ...(file.endsWith(".tsx") ? (["jsx"] as const) : [])],
		// No error recovery: a file the gate cannot parse is reported as a violation rather
		// than silently contributing zero findings.
		errorRecovery: false,
	}) as unknown as Node;
}

/**
 * `await` reachable from `body` WITHOUT crossing into a nested function.
 *
 * Defense in depth, not the primary check. `await` is a syntax error outside an `async` body, so
 * a SYNCHRONOUS callback containing one does not compile — it never reaches this function,
 * because `parseSource` rejects the file first (and that rejection is itself reported). The
 * previous regex-based gate had a dedicated "await in a sync body" branch and self-tests for it;
 * those fixtures were not valid TypeScript, so the branch pinned a shape that cannot exist.
 *
 * It is kept because the nested-function boundary is the part worth being explicit about: an
 * `await` inside a closure defined in the body belongs to that closure, not to the atomic
 * section, and must not be reported.
 */
function findAwait(body: Node): Node | null {
	const pending: Node[] = [body];
	while (pending.length > 0) {
		const node = pending.pop() as Node;
		if (node.type === "AwaitExpression") return node;
		// `for await (…)` awaits without producing an AwaitExpression node.
		if (node.type === "ForOfStatement" && node.await === true) return node;
		if (node !== body && FUNCTION_TYPES.has(String(node.type))) continue;
		for (const child of childNodes(node)) pending.push(child);
	}
	return null;
}

/** Names bound to an `async` function in this module, for the by-reference callback case. */
function asyncFunctionNames(program: Node): ReadonlySet<string> {
	const names = new Set<string>();
	const pending: Node[] = [program];
	while (pending.length > 0) {
		const node = pending.pop() as Node;
		if (node.type === "FunctionDeclaration" && node.async === true && isNode(node.id)) {
			names.add(String((node.id as Node).name));
		}
		if (node.type === "VariableDeclarator" && isNode(node.id) && isNode(node.init)) {
			const id = node.id as Node;
			const init = node.init as Node;
			if (
				id.type === "Identifier" &&
				(init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression") &&
				init.async === true
			) {
				names.add(String(id.name));
			}
		}
		if (
			(node.type === "ClassMethod" || node.type === "ObjectMethod") &&
			node.async === true &&
			isNode(node.key)
		) {
			names.add(String((node.key as Node).name));
		}
		for (const child of childNodes(node)) pending.push(child);
	}
	return names;
}

/**
 * Local names bound to `BunSQLDatabase` by an import from the PostgreSQL driver module
 * (`drizzle-orm/bun-sql`), plus any namespace alias of that module. This is the ENTIRE
 * recognition surface for "the receiver is a PostgreSQL handle": no filename convention, no
 * per-file exemption, no whitelist. A name is evidence only where it annotates the specific
 * parameter or property used as the receiver of the specific `.transaction(` call.
 */
interface PgTypeScope {
	readonly typeNames: ReadonlySet<string>;
	readonly namespaces: ReadonlySet<string>;
}

function pgDatabaseTypes(program: Node): PgTypeScope {
	const typeNames = new Set<string>();
	const namespaces = new Set<string>();
	for (const stmt of ((program.body as unknown[]) ?? []) as unknown[]) {
		if (!isNode(stmt) || stmt.type !== "ImportDeclaration") continue;
		if ((stmt.source as Node | undefined)?.value !== "drizzle-orm/bun-sql") continue;
		for (const specifier of ((stmt.specifiers as unknown[]) ?? []) as unknown[]) {
			if (!isNode(specifier)) continue;
			if (specifier.type === "ImportNamespaceSpecifier" && isNode(specifier.local)) {
				namespaces.add(String((specifier.local as Node).name));
			}
			if (
				specifier.type === "ImportSpecifier" &&
				isNode(specifier.imported) &&
				String((specifier.imported as Node).name) === "BunSQLDatabase" &&
				isNode(specifier.local)
			) {
				typeNames.add(String((specifier.local as Node).name));
			}
		}
	}
	return { typeNames, namespaces };
}

/** Whether a type annotation mentions a recognized PG database type, anywhere in its shape. */
function typeReferencesPgDatabase(annotation: Node | undefined, scope: PgTypeScope): boolean {
	if (!annotation) return false;
	const pending: Node[] = [annotation];
	while (pending.length > 0) {
		const node = pending.pop() as Node;
		if (node.type === "TSTypeReference" && isNode(node.typeName)) {
			const name = node.typeName as Node;
			if (name.type === "Identifier" && scope.typeNames.has(String(name.name))) return true;
			if (
				name.type === "TSQualifiedName" &&
				isNode(name.left) &&
				(name.left as Node).type === "Identifier" &&
				scope.namespaces.has(String((name.left as Node).name)) &&
				isNode(name.right) &&
				String((name.right as Node).name) === "BunSQLDatabase"
			) {
				return true;
			}
		}
		for (const child of childNodes(node)) pending.push(child);
	}
	return false;
}

/** The annotation carried by an identifier-style node (`x: T`), unwrapped one level. */
function annotationOf(node: Node | undefined): Node | undefined {
	if (!node) return undefined;
	return (
		((node.typeAnnotation as Node | undefined)?.typeAnnotation as Node | undefined) ?? undefined
	);
}

/**
 * name → asyncness for every function bound by declaration in this module. Class/object
 * methods are deliberately EXCLUDED (they are resolved against the enclosing class instead,
 * where a same-named method on another class cannot collide). When two bindings share a name,
 * async wins: the cost of that collision is a false REPORT, never a false pass.
 */
function localFunctionSyncMap(program: Node): Map<string, boolean> {
	const map = new Map<string, boolean>();
	const record = (name: string, async: boolean): void => {
		map.set(name, (map.get(name) ?? false) || async);
	};
	const pending: Node[] = [program];
	while (pending.length > 0) {
		const node = pending.pop() as Node;
		if (node.type === "FunctionDeclaration" && isNode(node.id)) {
			record(String((node.id as Node).name), node.async === true);
		}
		if (
			node.type === "VariableDeclarator" &&
			isNode(node.id) &&
			(node.id as Node).type === "Identifier" &&
			isNode(node.init) &&
			((node.init as Node).type === "ArrowFunctionExpression" ||
				(node.init as Node).type === "FunctionExpression")
		) {
			record(String((node.id as Node).name), (node.init as Node).async === true);
		}
		for (const child of childNodes(node)) pending.push(child);
	}
	return map;
}

/**
 * Names bound by `const`/`let` to something OTHER than a function literal (`const w =
 * options.inTransaction`). The gate cannot see through the alias, but it must say THAT,
 * rather than claiming the name "is not declared in this module".
 */
function localAliasNames(program: Node): ReadonlySet<string> {
	const names = new Set<string>();
	const pending: Node[] = [program];
	while (pending.length > 0) {
		const node = pending.pop() as Node;
		if (
			node.type === "VariableDeclarator" &&
			isNode(node.id) &&
			(node.id as Node).type === "Identifier" &&
			isNode(node.init) &&
			(node.init as Node).type !== "ArrowFunctionExpression" &&
			(node.init as Node).type !== "FunctionExpression"
		) {
			names.add(String((node.id as Node).name));
		}
		for (const child of childNodes(node)) pending.push(child);
	}
	return names;
}

/** Facts about one class: method asyncness and which fields hold a recognized PG handle. */
interface ClassFacts {
	readonly methods: ReadonlyMap<string, boolean>;
	readonly asyncProperties: ReadonlySet<string>;
	readonly pgProperties: ReadonlySet<string>;
}

function classFacts(classNode: Node, pg: PgTypeScope): ClassFacts {
	const methods = new Map<string, boolean>();
	const asyncProperties = new Set<string>();
	const pgProperties = new Set<string>();
	const body = ((classNode.body as Node | undefined)?.body as unknown[]) ?? [];
	for (const member of body as unknown[]) {
		if (!isNode(member)) continue;
		if (member.type === "ClassMethod") {
			if (
				member.computed !== true &&
				isNode(member.key) &&
				(member.key as Node).type === "Identifier"
			) {
				const name = String((member.key as Node).name);
				if (member.kind === "constructor") {
					// `constructor(private readonly db: BunSQLDatabase)` — a parameter property.
					for (const param of ((member.params as unknown[]) ?? []) as unknown[]) {
						if (!isNode(param) || param.type !== "TSParameterProperty") continue;
						const inner = param.parameter as Node | undefined;
						if (inner?.type === "Identifier" && typeReferencesPgDatabase(annotationOf(inner), pg)) {
							pgProperties.add(String(inner.name));
						}
					}
				} else {
					methods.set(name, member.async === true);
				}
			}
			continue;
		}
		if (
			// Babel emits `ClassProperty`; `PropertyDeclaration` is the ESTree name for the same
			// node — accept both so a parser-configuration change cannot silently drop recognition.
			(member.type === "ClassProperty" || member.type === "PropertyDeclaration") &&
			member.computed !== true &&
			isNode(member.key) &&
			(member.key as Node).type === "Identifier"
		) {
			const name = String((member.key as Node).name);
			if (typeReferencesPgDatabase(annotationOf(member), pg)) pgProperties.add(name);
			const value = member.value as Node | undefined;
			if (
				value &&
				(value.type === "ArrowFunctionExpression" || value.type === "FunctionExpression") &&
				value.async === true
			) {
				asyncProperties.add(name);
			}
		}
	}
	return { methods, asyncProperties, pgProperties };
}

/**
 * Whether `receiver` (the object of a `.transaction(` call) is a recognized PostgreSQL handle
 * AT THIS CALL SITE. Two proofs, both per-call:
 *
 *   - `db.transaction(...)`: `db` is a parameter of an enclosing function, or a module-level
 *     `const`, carrying a `BunSQLDatabase` annotation imported from `drizzle-orm/bun-sql`.
 *   - `this.db.transaction(...)`: the innermost enclosing class declares the property (or a
 *     constructor parameter property) with a `BunSQLDatabase` annotation.
 *
 * Everything else — untyped parameters, `Pick<>`-narrowed handles that lost the annotation,
 * `getDb().transaction(...)`, receivers from another module — is NOT recognized. That is the
 * conservative direction: an unrecognized receiver with an async section is reported.
 */
function receiverIsRecognizedPg(
	receiver: Node,
	functions: readonly Node[],
	classes: readonly Node[],
	pg: PgTypeScope,
	pgModuleVariables: ReadonlySet<string>,
): boolean {
	if (receiver.type === "Identifier") {
		const name = String(receiver.name);
		for (const fn of [...functions].reverse()) {
			for (const param of ((fn.params as unknown[]) ?? []) as unknown[]) {
				if (!isNode(param)) continue;
				const id =
					param.type === "Identifier"
						? param
						: param.type === "AssignmentPattern" &&
								isNode(param.left) &&
								(param.left as Node).type === "Identifier"
							? (param.left as Node)
							: null;
				if (id && String(id.name) === name && typeReferencesPgDatabase(annotationOf(id), pg)) {
					return true;
				}
			}
		}
		return pgModuleVariables.has(name);
	}
	if (
		receiver.type === "MemberExpression" &&
		receiver.computed !== true &&
		(receiver.object as Node | undefined)?.type === "ThisExpression" &&
		isNode(receiver.property) &&
		(receiver.property as Node).type === "Identifier"
	) {
		const innermost = classes[classes.length - 1];
		if (!innermost) return false;
		return classFacts(innermost, pg).pgProperties.has(String((receiver.property as Node).name));
	}
	return false;
}

/**
 * The single call a synchronous callback delegates its whole body to, if it has that shape:
 * a concise-body call (`(tx) => section(tx)`), or a one-statement block that is exactly
 * `return section(tx)` / `section(tx);`. Anything larger is an ordinary inline body and is
 * already covered by the `await` scan.
 */
function deferredCallTarget(callback: Node): Node | null {
	const body = callback.body as Node | undefined;
	if (!body || !isNode(body)) return null;
	if (body.type === "BlockStatement") {
		const statements = ((body.body as unknown[]) ?? []) as unknown[];
		if (statements.length !== 1 || !isNode(statements[0])) return null;
		const statement = statements[0] as Node;
		const expression =
			statement.type === "ReturnStatement"
				? (statement.argument as Node | undefined)
				: statement.type === "ExpressionStatement"
					? (statement.expression as Node | undefined)
					: undefined;
		return expression && isCallNode(unwrapTypeSyntax(expression))
			? unwrapTypeSyntax(expression)
			: null;
	}
	return isCallNode(unwrapTypeSyntax(body)) ? unwrapTypeSyntax(body) : null;
}

function unwrapTypeSyntax(node: Node): Node {
	let current = node;
	while (
		current.type === "TSAsExpression" ||
		current.type === "TSSatisfiesExpression" ||
		current.type === "TSNonNullExpression"
	) {
		const inner = current.expression as Node | undefined;
		if (!inner || !isNode(inner)) return current;
		current = inner;
	}
	return current;
}

function isCallNode(node: Node): boolean {
	return node.type === "CallExpression" || node.type === "OptionalCallExpression";
}

function firstParamName(callback: Node): string | null {
	const first = (((callback.params as unknown[]) ?? []) as unknown[])[0];
	return isNode(first) && first.type === "Identifier" ? String(first.name) : null;
}

type DeferredTarget =
	| { readonly kind: "synchronous" }
	| { readonly kind: "async"; readonly name: string }
	| { readonly kind: "forwarded"; readonly name: string }
	| { readonly kind: "unknown"; readonly description: string };

/**
 * What a whole-body-delegating transaction callback actually calls:
 *
 *   - local function/arrow bound in this module → its declared asyncness decides;
 *   - `this.method(...)` → the innermost enclosing class decides;
 *   - a parameter of an enclosing function (the PG forwarder pattern, e.g.
 *     `runSection(label, section)` in postgres-runtime-queue) → `forwarded`: the declared type
 *     cannot prove sync-ness (see `forwardedCallbackProblem`), so it is held to the same
 *     standard as async — allowed only on a recognized PG receiver;
 *   - a builder chain rooted at the transaction parameter itself (`tx.insert(x).run()`) →
 *     synchronous; the `await` scan already covers suspension;
 *   - anything else (imported function, member of another object, call result) → `unknown`,
 *     reported rather than passed, matching the member-reference policy below.
 */
function classifyDeferredCall(
	call: Node,
	callback: Node,
	localFunctions: ReadonlyMap<string, boolean>,
	localAliases: ReadonlySet<string>,
	functions: readonly Node[],
	classes: readonly Node[],
	pg: PgTypeScope,
): DeferredTarget {
	const callee = call.callee as Node | undefined;
	if (!callee || !isNode(callee))
		return { kind: "unknown", description: "a non-resolvable callee" };
	const txParam = firstParamName(callback);

	if (callee.type === "Identifier") {
		const name = String(callee.name);
		const async = localFunctions.get(name);
		if (async === true) return { kind: "async", name };
		if (async === false) return { kind: "synchronous" };
		const owner = [...functions]
			.reverse()
			.find((fn) =>
				(((fn.params as unknown[]) ?? []) as unknown[]).some(
					(p) => isNode(p) && p.type === "Identifier" && String(p.name) === name,
				),
			);
		if (owner) return { kind: "forwarded", name };
		if (localAliases.has(name)) {
			return {
				kind: "unknown",
				description:
					`\`${name}\`, a local alias of an expression this gate does not resolve ` +
					"(the aliased value may be caller-supplied)",
			};
		}
		return { kind: "unknown", description: `\`${name}\`, which is not declared in this module` };
	}

	if (
		callee.type === "MemberExpression" &&
		callee.computed !== true &&
		isNode(callee.property) &&
		(callee.property as Node).type === "Identifier"
	) {
		const property = String((callee.property as Node).name);
		const object = callee.object as Node | undefined;
		if (object?.type === "ThisExpression") {
			const innermost = classes[classes.length - 1];
			if (!innermost) {
				return { kind: "unknown", description: `\`this.${property}\` outside any class` };
			}
			const facts = classFacts(innermost, pg);
			if (facts.methods.has(property)) {
				return facts.methods.get(property) === true
					? { kind: "async", name: `this.${property}` }
					: { kind: "synchronous" };
			}
			if (facts.asyncProperties.has(property)) return { kind: "async", name: `this.${property}` };
			return {
				kind: "unknown",
				description: `\`this.${property}\`, which the enclosing class does not declare`,
			};
		}
		// Builder chain rooted at the transaction parameter: `tx.insert(x).run()` and friends.
		let root: Node | undefined = callee;
		while (
			root &&
			(root.type === "MemberExpression" ||
				root.type === "CallExpression" ||
				root.type === "OptionalCallExpression" ||
				root.type === "OptionalMemberExpression" ||
				root.type === "TSAsExpression" ||
				root.type === "TSSatisfiesExpression" ||
				root.type === "TSNonNullExpression")
		) {
			root = (
				root.type === "MemberExpression" || root.type === "OptionalMemberExpression"
					? root.object
					: root.type === "CallExpression" || root.type === "OptionalCallExpression"
						? root.callee
						: root.expression
			) as Node | undefined;
		}
		if (root?.type === "Identifier" && txParam !== null && String(root.name) === txParam) {
			return { kind: "synchronous" };
		}
		return {
			kind: "unknown",
			description: `a member call not rooted at the transaction parameter`,
		};
	}

	return { kind: "unknown", description: "a callee shape this gate has not analysed" };
}

/**
 * A callback forwarded by reference: what the gate can and cannot conclude.
 *
 * Five production wrappers forward a caller-supplied callback straight into
 * `db.transaction(work)` (`workspace-write-coordinator`, `revert-plan-service`,
 * `revert-mutation-journal`, `file-change-evidence`, `file-change-blob-catalog`). The gate cannot
 * see the callback's body, so it cannot decide atomicity there.
 *
 * ⚠️ AN EARLIER VERSION OF THIS FILE CLAIMED THE TYPE SYSTEM CLOSED THAT HOLE — that
 * `(tx: Q) => T` "cannot accept an async function because tsgo rejects it". THAT CLAIM IS FALSE,
 * and `type-level-claims.probe.ts` next to this file compiles the counterexamples under `strict`
 * with both `tsc` and `tsgo`, both exiting 0:
 *
 *   - `(tx: Q) => T` is GENERIC. Passing an async callback simply infers `T = Promise<…>`. There
 *     is nothing to reject; the annotation constrains the parameter's shape, not its asyncness.
 *   - `(tx: Q) => void` accepts ANY return type. That is a deliberate TypeScript rule for
 *     callbacks (return-value-ignoring positions), so an async function is assignable to it too.
 *
 * So a declared return type is NOT evidence of a synchronous atomic section, and this function no
 * longer pretends otherwise. What it reports is narrower and true: a return type that is
 * EXPLICITLY Promise-shaped, or `any`/`unknown`, is a documented invitation to pass an async
 * callback and is flagged. Everything else is UNPROVEN, not proven safe — see `Forwarding` below.
 *
 * WHY THE FIVE WRAPPERS ARE ACTUALLY SAFE TODAY (verified, not inferred from types):
 * every one of them declares `transaction` as a `private` member, so no external caller can
 * reach it, and all 42 in-module `this.transaction(...)` call sites pass a synchronous inline
 * callback — zero async, zero by-reference. That is an enforced-by-encapsulation argument with a
 * bounded surface, which is why it holds; it is not a type-system guarantee, and it stops holding
 * the moment one of them becomes non-private. The gate therefore reports a non-private forwarder
 * as unproven while accepting a private one, and the test below pins that distinction.
 */
function forwardedCallbackProblem(annotation: Node | undefined): string | null {
	if (!annotation) return "forwarded callback parameter has no type annotation";
	if (annotation.type !== "TSFunctionType") {
		return `forwarded callback parameter is typed as ${String(annotation.type)}, not a function type`;
	}
	const ret = (annotation.typeAnnotation as Node | undefined)?.typeAnnotation as Node | undefined;
	if (!ret) return "forwarded callback parameter's function type declares no return type";
	if (ret.type === "TSAnyKeyword" || ret.type === "TSUnknownKeyword") {
		return "forwarded callback returns `any`/`unknown` — an async callback is assignable";
	}
	if (ret.type === "TSTypeReference") {
		const name = (ret.typeName as Node | undefined)?.name;
		if (name === "Promise" || name === "PromiseLike" || name === "Awaitable") {
			return `forwarded callback explicitly returns ${String(name)} — the atomic section can be async`;
		}
	}
	// Not flagged, but NOT proven synchronous either. Only encapsulation makes this acceptable,
	// which the caller checks.
	return null;
}

/** `private transaction(...)` / `#transaction(...)`: unreachable from outside the module. */
function isEncapsulatedForwarder(enclosing: Node | undefined): boolean {
	if (!enclosing) return false;
	if (enclosing.type === "ClassPrivateMethod") return true;
	return enclosing.type === "ClassMethod" && enclosing.accessibility === "private";
}

/**
 * Find `.transaction(…)` calls whose atomic section is not strictly synchronous.
 *
 * This parses the file rather than pattern-matching text. The previous implementation used a
 * regex plus brace counting and MISSED every one of these real shapes, each of which is exactly
 * the bug the gate exists to stop:
 *
 *   db.transaction(async (tx) => doWork(tx))          // concise body, no braces
 *   db.transaction(async function (tx) { … })          // function expression
 *   db.transaction(async (tx: Tx) => { … })            // annotated parameter
 *   db.transaction(async (tx, opts) => { … })          // more than one parameter
 *   db.transaction(work)                               // `work` is an async function
 *
 * All five are verified in the self-check test below, against the old detector's actual output.
 *
 * KNOWN LIMITS, stated because a gate whose accuracy is overstated gets trusted precisely where
 * it is wrong:
 *
 *   - Resolution is per-module and syntactic. An async callback imported from another module and
 *     passed by reference is not followed; the parameter-type rule above covers the wrapper
 *     pattern that exists today, but a direct `db.transaction(importedAsyncFn)` would pass.
 *   - A synchronous callback whose WHOLE BODY is one call to another function is the async
 *     hazard with one indirection when that target is async: `db.transaction((tx) =>
 *     section(tx))` returns `section`'s Promise to the native driver, which does not await it.
 *     The gate resolves the target (local function, `this` method, forwarded parameter) and
 *     rejects the shape UNLESS the receiver is a recognized PostgreSQL handle — see
 *     `pgDatabaseTypes`. Recognition is deliberately per-call and narrow: a `drizzle-orm/bun-sql`
 *     import elsewhere in the file does NOT whitewash an unrecognized receiver in the same
 *     file, and a receiver or target the gate cannot resolve is reported, not passed.
 *   - A synchronous callback that *calls* an async function from a LARGER body and discards
 *     the returned Promise stays synchronous for atomicity purposes and is correctly not
 *     reported: its own statements all execute inside the transaction. Whether the
 *     fire-and-forget is otherwise wise is out of scope here. (The regex gate reported this as
 *     a false positive and documented it as a deliberate trade; parsing removes the need.)
 *   - `.transaction` on something that is not a database handle (a mock, an unrelated API) is
 *     still checked. There are no such call sites; a false positive costs one review comment,
 *     while the opposite direction costs silent data loss.
 */
function findViolations(source: string, file: string): Violation[] {
	let program: Node;
	try {
		program = parseSource(source, file);
	} catch (error) {
		// An unparseable file must not be scored as clean: that is how a scan quietly stops
		// covering part of the tree.
		return [{ file, line: 0, reason: `could not be parsed for review: ${String(error)}` }];
	}
	const asyncNames = asyncFunctionNames(program);
	// `parse` returns a File node whose `program` child holds the module body; import and
	// module-level-const recognition need that body, not the wrapper.
	const moduleNode: Node =
		program.type === "File" && isNode(program.program) ? (program.program as Node) : program;
	const pgTypes = pgDatabaseTypes(moduleNode);
	const localFunctions = localFunctionSyncMap(program);
	const localAliases = localAliasNames(program);
	// Module-level `const db: BunSQLDatabase = …` — the only non-parameter identifier proof.
	const pgModuleVariables = new Set<string>();
	for (const stmt of ((moduleNode.body as unknown[]) ?? []) as unknown[]) {
		if (!isNode(stmt) || stmt.type !== "VariableDeclaration") continue;
		for (const declarator of ((stmt.declarations as unknown[]) ?? []) as unknown[]) {
			if (
				isNode(declarator) &&
				declarator.type === "VariableDeclarator" &&
				isNode(declarator.id) &&
				(declarator.id as Node).type === "Identifier" &&
				typeReferencesPgDatabase(annotationOf(declarator.id as Node), pgTypes)
			) {
				pgModuleVariables.add(String((declarator.id as Node).name));
			}
		}
	}
	const found: Violation[] = [];

	interface Frame {
		readonly node: Node;
		readonly functions: readonly Node[];
		readonly classes: readonly Node[];
	}
	const pending: Frame[] = [{ node: program, functions: [], classes: [] }];
	while (pending.length > 0) {
		const { node, functions, classes } = pending.pop() as Frame;

		if (node.type === "CallExpression" && isNode(node.callee)) {
			const callee = node.callee as Node;
			const property = callee.property as Node | undefined;
			const isTransactionCall =
				callee.type === "MemberExpression" &&
				callee.computed !== true &&
				isNode(property) &&
				property.type === "Identifier" &&
				property.name === "transaction";

			if (isTransactionCall) {
				const callback = ((node.arguments as unknown[]) ?? [])[0];

				if (
					isNode(callback) &&
					(callback.type === "ArrowFunctionExpression" || callback.type === "FunctionExpression")
				) {
					if (callback.async === true) {
						found.push({
							file,
							line: lineOf(callback),
							reason: "`async` transaction callback — commits at the first `await`",
						});
					} else {
						const awaited = findAwait(callback.body as Node);
						if (awaited) {
							found.push({
								file,
								line: lineOf(awaited),
								reason:
									"`await` inside a transaction body — the statements after it run uncommitted",
							});
						} else {
							// A synchronous callback whose whole body is one call delegates its atomicity
							// to that call's target. On `bun:sqlite` the native driver does not await a
							// returned Promise, so a delegation to an async target is the early-commit
							// hazard with one indirection — indistinguishable from the legitimate
							// PostgreSQL named-section convention except by the RECEIVER. The check is
							// therefore per call site: the target must be resolvable, and an async (or
							// unprovable) target requires a recognized `BunSQLDatabase` receiver.
							const deferred = deferredCallTarget(callback);
							if (deferred) {
								const target = classifyDeferredCall(
									deferred,
									callback,
									localFunctions,
									localAliases,
									functions,
									classes,
									pgTypes,
								);
								const receiver = callee.object as Node;
								if (target.kind === "async" || target.kind === "forwarded") {
									if (
										!receiverIsRecognizedPg(
											receiver,
											functions,
											classes,
											pgTypes,
											pgModuleVariables,
										)
									) {
										found.push({
											file,
											line: lineOf(callback),
											reason:
												target.kind === "async"
													? `transaction body delegates to async \`${target.name}\`, but the receiver ` +
														"is not a recognized PostgreSQL handle — on `bun:sqlite` the returned " +
														"Promise is not awaited and the section runs outside the transaction. " +
														"Make the section synchronous, or (PostgreSQL only) take the handle as a " +
														"parameter/property annotated `BunSQLDatabase` from `drizzle-orm/bun-sql`"
													: `transaction body delegates to the parameter \`${target.name}\`, whose ` +
														"sync-ness a declared type cannot prove, and the receiver is not a " +
														"recognized PostgreSQL handle — on `bun:sqlite` an async argument would " +
														"commit at its first `await`. Take a synchronous inline callback, or " +
														"(PostgreSQL only) a recognized `BunSQLDatabase` receiver",
										});
									}
								} else if (target.kind === "unknown") {
									found.push({
										file,
										line: lineOf(callback),
										reason:
											`transaction body is a single call to ${target.description}, so this gate ` +
											"cannot tell whether it is async. Inline a synchronous body, or delegate to a " +
											"function declared in this module",
									});
								}
							}
						}
					}
				} else if (isNode(callback) && callback.type === "Identifier") {
					const name = String(callback.name);
					if (asyncNames.has(name)) {
						found.push({
							file,
							line: lineOf(node),
							reason: `transaction callback \`${name}\` is an \`async\` function`,
						});
					} else {
						// A forwarded parameter. The declared type cannot prove synchronousness (see
						// `forwardedCallbackProblem`); only `private`/`#` encapsulation bounds the
						// callers to this module, where every call site is checkable.
						const owner = [...functions]
							.reverse()
							.find((fn) =>
								(((fn.params as unknown[]) ?? []) as unknown[]).some(
									(p) => isNode(p) && p.type === "Identifier" && String(p.name) === name,
								),
							);
						if (owner) {
							const parameter = (((owner.params as unknown[]) ?? []) as unknown[]).find(
								(p) => isNode(p) && p.type === "Identifier" && String(p.name) === name,
							) as Node;
							const annotation = (parameter.typeAnnotation as Node | undefined)?.typeAnnotation as
								| Node
								| undefined;
							const problem = forwardedCallbackProblem(annotation);
							if (problem) {
								found.push({ file, line: lineOf(node), reason: problem });
							} else if (!isEncapsulatedForwarder(owner)) {
								found.push({
									file,
									line: lineOf(node),
									reason:
										`forwards callback \`${name}\` into a transaction from a non-private ` +
										"member, so external callers can supply an async callback — the parameter " +
										"type does NOT prevent it (a generic `=> T` infers `Promise`, and `=> void` " +
										"accepts any return). Make the forwarder private, or take a synchronous " +
										"inline callback",
								});
							}
						}
					}
				} else if (isNode(callback) && callback.type === "MemberExpression") {
					// `db.transaction(this.method)` / `db.transaction(obj.fn)`. Resolving the target
					// would require following properties across classes and modules, which this gate
					// deliberately does not do. Refusing the shape outright is the honest option: a
					// silent skip would let an async method through while the gate reported clean.
					found.push({
						file,
						line: lineOf(node),
						reason:
							"transaction callback is a member reference, a shape this gate has not analysed — " +
							"it cannot tell whether the target is async. Pass a synchronous inline callback, " +
							"or route it through a private forwarder whose call sites are in this module",
					});
				}
			}
		}

		const nextFunctions = FUNCTION_TYPES.has(String(node.type)) ? [...functions, node] : functions;
		const nextClasses =
			node.type === "ClassDeclaration" || node.type === "ClassExpression"
				? [...classes, node]
				: classes;
		for (const child of childNodes(node)) {
			pending.push({ node: child, functions: nextFunctions, classes: nextClasses });
		}
	}
	return found;
}

/** Whether the file contains a real `.transaction(` CALL, as opposed to the text in a comment. */
function hasTransactionCall(source: string, file: string): boolean {
	let program: Node;
	try {
		program = parseSource(source, file);
	} catch {
		return false;
	}
	const pending: Node[] = [program];
	while (pending.length > 0) {
		const node = pending.pop() as Node;
		if (node.type === "CallExpression" && isNode(node.callee)) {
			const callee = node.callee as Node;
			const property = callee.property as Node | undefined;
			if (
				callee.type === "MemberExpression" &&
				callee.computed !== true &&
				isNode(property) &&
				property.type === "Identifier" &&
				property.name === "transaction"
			) {
				return true;
			}
		}
		for (const child of childNodes(node)) pending.push(child);
	}
	return false;
}

describe("gate: no async SQLite atomic sections in production code", () => {
	it("scans a meaningful surface", () => {
		// Without this, an over-broad skip rule or a failed walk would make the gate below
		// pass on an empty file list while looking healthy.
		const files = SCAN_ROOTS.flatMap((root) => collectSourceFiles(join(REPO_ROOT, root)));
		expect(files.length).toBeGreaterThan(400);
		const posix = files.map(toPosixRelative);
		expect(posix).toContain("server/services/narrator-persistence.ts");
		expect(posix.filter((p) => p.startsWith("shared/")).length).toBeGreaterThan(0);
		// The wrappers that forward a callback by reference are the hardest case for the gate
		// and must be in view, not skipped by a directory rule.
		expect(posix).toContain("server/services/file-change-evidence.ts");
		expect(posix).toContain("server/services/revert-mutation-journal.ts");
		// The PostgreSQL stores exercising the named-async-section convention must likewise be
		// in view: they are the positive side of the receiver-recognition rule, and a skip rule
		// that silently exempted them would make that rule look healthier than it is.
		expect(posix).toContain("server/services/knowledge/postgres-write-store.ts");
		expect(posix).toContain("server/services/postgres-workspace-lease-store.ts");
		expect(posix).toContain("server/services/agent-runtime/postgres-runtime-queue.ts");
		// The `.probe.` exemption must stay a one-file convention, not a growing loophole.
		expect(posix.filter((p) => p.includes(".probe."))).toEqual([]);
		const probes = SCAN_ROOTS.flatMap((root) => allTypeScriptFiles(join(REPO_ROOT, root))).filter(
			(p) => toPosixRelative(p).includes(".probe."),
		);
		expect(probes.map(toPosixRelative)).toEqual(["server/db/type-level-claims.probe.ts"]);
		// Counted through the parser, so this also proves the whole surface parses: the count
		// collapses if files start failing to parse rather than merely lacking transactions.
		const withTransactions = files.filter((absolute) => {
			const source = readFileSync(absolute, "utf8");
			if (!source.includes(".transaction(")) return false;
			return hasTransactionCall(source, toPosixRelative(absolute));
		});
		expect(withTransactions.length).toBeGreaterThan(20);
	});

	it("finds no async transaction callback anywhere in production code", () => {
		const violations = SCAN_ROOTS.flatMap((root) =>
			collectSourceFiles(join(REPO_ROOT, root))
				// Only files whose text mentions `.transaction(` can hold a violation, so the parse
				// is scoped to them. Parsing all ~1000 files would also mean an unrelated file
				// using syntax this parser configuration does not accept fails the atomicity gate,
				// which is a confusing signal on a change that has nothing to do with it.
				.filter((absolute) => readFileSync(absolute, "utf8").includes(".transaction("))
				.flatMap((absolute) =>
					findViolations(readFileSync(absolute, "utf8"), toPosixRelative(absolute)),
				),
		);

		if (violations.length > 0) {
			throw new Error(
				"Async SQLite atomic section(s) found.\n\n" +
					"`bun:sqlite` commits when the transaction callback RETURNS. An async callback " +
					"returns at its first `await`, so everything after that point runs in autocommit: " +
					"it is not rolled back on failure, and it can execute while another request's " +
					"transaction is open on the shared connection. The tests above demonstrate both.\n\n" +
					"Keep the atomic section synchronous and move awaitable work outside it. The " +
					"business entry point may still be `async` and return a Promise — see the " +
					"'async business entry point over a synchronous atomic section' tests.\n\n" +
					"PostgreSQL support does NOT change this: it gets its own async adapter, because " +
					"an `await` on a networked driver is safe and an `await` here is not. A non-async " +
					"arrow delegating to a named async section is accepted ONLY when the receiver of " +
					"the call is recognizably a `BunSQLDatabase` (a parameter, module-level const, or " +
					"class property annotated with the type imported from `drizzle-orm/bun-sql`).\n\n" +
					`${violations.map((v) => `  ${v.file}:${v.line}\n    ${v.reason}`).join("\n")}\n`,
			);
		}
		expect(violations).toHaveLength(0);
	});

	it("self-check: detects every async callback shape, including the ones text matching misses", () => {
		const detect = (source: string) => findViolations(source, "fixture.ts").map((v) => v.reason);

		// The obvious shape.
		expect(detect("db.transaction(async (tx) => { tx.insert(x).run(); });")[0]).toContain("async");
		expect(detect("sqlite.transaction(async () => { run(); });")[0]).toContain("async");
		expect(detect("db.transaction(async tx => { await x(); });")[0]).toContain("async");

		// Shapes an earlier regex-based version of this gate silently PASSED. Each is a real,
		// writable way to lose atomicity, so each is pinned individually.
		expect(detect("db.transaction(async (tx) => doWork(tx));")[0]).toContain("async");
		expect(detect("db.transaction(async (tx) => await doWork(tx));")[0]).toContain("async");
		expect(detect("db.transaction(async function (tx) { await x(); });")[0]).toContain("async");
		expect(detect("db.transaction(async (tx: Tx) => { await x(); });")[0]).toContain("async");
		expect(detect("db.transaction(async (tx, opts) => { await x(); });")[0]).toContain("async");
		expect(
			detect("const work = async (tx) => { await x(); };\ndb.transaction(work);")[0],
		).toContain("`work` is an `async` function");
		expect(detect("async function work(tx) { await x(); }\ndb.transaction(work);")[0]).toContain(
			"`work` is an `async` function",
		);

		// Safe shapes.
		expect(detect("db.transaction((tx) => { tx.insert(x).run(); });")).toEqual([]);
		expect(detect("db.transaction((tx) => tx.insert(x).run());")).toEqual([]);
		expect(detect("db.transaction((tx) => { tx.run(); }, { behavior: 'immediate' });")).toEqual([]);
		expect(
			detect("db.transaction((tx) => { tx.run(); tx.transaction((i) => i.run()); });"),
		).toEqual([]);
		expect(detect("await Promise.resolve(db.transaction((tx) => { tx.run(); }));")).toEqual([]);
		// An awaited call whose ARGUMENT contains a sync transaction is fine: the `await`
		// is outside the atomic section.
		expect(detect("await withDbRetry(() => db.transaction((tx) => { tx.run(); }));")).toEqual([]);
		// A closure created inside a synchronous body has its own execution; the atomic section
		// stays synchronous. The regex gate reported this and called it an accepted false positive.
		expect(
			detect("db.transaction((tx) => { tx.run(); queueMicrotask(async () => { await x(); }); });"),
		).toEqual([]);
		// String and template content cannot defeat a parser. The regex gate's brace counting
		// treated the `}` here as the end of the body.
		expect(detect('db.transaction((tx) => { tx.run("}"); tx.run(`}`); });')).toEqual([]);
		// Prose and comments are not code.
		expect(detect("// db.transaction(async (tx) => …) commits early — never do this")).toEqual([]);
		expect(detect("/*\n * db.transaction(async (tx) => { await x; })\n */")).toEqual([]);
	});

	it("self-check: a sync arrow delegating to an async section needs a proven PostgreSQL receiver", () => {
		// The hole this closes: `db.transaction((tx) => section(tx))` has no `async` keyword and
		// no `await` in the arrow, yet on `bun:sqlite` it returns `section`'s Promise to a driver
		// that does not await it — the early-commit hazard with one indirection. The same shape
		// is the documented PostgreSQL convention, so the gate distinguishes by the RECEIVER,
		// per call site, never by file.
		const detect = (source: string) => findViolations(source, "fixture.ts").map((v) => v.reason);
		const PG_IMPORT = 'import type { BunSQLDatabase } from "drizzle-orm/bun-sql";\n';
		const SECTION = "async function section(tx) { await tx.execute(x); }\n";

		// ── Negative: SQLite-shaped receivers keep being rejected, PG import or not ──

		// Untyped receiver, no PG import at all.
		expect(
			detect(`${SECTION}function make(db) { return db.transaction((tx) => section(tx)); }`)[0],
		).toContain("delegates to async `section`");
		// Block-body variant: `(tx) => { return section(tx); }` is the same shape.
		expect(
			detect(
				`${SECTION}function make(db) { return db.transaction((tx) => { return section(tx); }); }`,
			)[0],
		).toContain("delegates to async `section`");
		// Section bound as an async arrow const rather than a function declaration.
		expect(
			detect(
				"const section = async (tx) => { await tx.execute(x); };\n" +
					"function make(db) { return db.transaction((tx) => section(tx)); }",
			)[0],
		).toContain("delegates to async `section`");
		// The PG import exists in the file but does NOT whitewash an untyped receiver: the
		// recognition is per call site, not per file.
		expect(
			detect(
				`${PG_IMPORT}${SECTION}function make(db) { return db.transaction((tx) => section(tx)); }`,
			)[0],
		).toContain("not a recognized PostgreSQL handle");
		// A receiver annotated with the SQLITE driver's type stays rejected even in a file that
		// also imports the PG type.
		expect(
			detect(
				`${PG_IMPORT}import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";\n` +
					`${SECTION}function make(db: BunSQLiteDatabase) { return db.transaction((tx) => section(tx)); }`,
			)[0],
		).toContain("not a recognized PostgreSQL handle");
		// Same file, two receivers: the proven-PG one passes, the unproven one is flagged —
		// the exact anti-laundering property.
		{
			const violations = findViolations(
				`${PG_IMPORT}${SECTION}` +
					"function make(pg: BunSQLDatabase, other: unknown) {\n" +
					"\tpg.transaction((tx) => section(tx));\n" +
					"\tother.transaction((tx) => section(tx));\n" +
					"}",
				"fixture.ts",
			);
			expect(violations).toHaveLength(1);
			expect(violations[0]?.reason).toContain("not a recognized PostgreSQL handle");
			expect(violations[0]?.line).toBe(5);
		}

		// ── Positive: the recognized PG convention passes ──

		// Parameter-annotated receiver + local async section (the factory-store shape).
		expect(
			detect(
				`${PG_IMPORT}${SECTION}` +
					"function make(db: BunSQLDatabase) { return db.transaction((tx) => section(tx)); }",
			),
		).toEqual([]);
		// Aliased import of the PG type.
		expect(
			detect(
				'import type { BunSQLDatabase as PgDb } from "drizzle-orm/bun-sql";\n' +
					`${SECTION}` +
					"function make(db: PgDb) { return db.transaction((tx) => section(tx)); }",
			),
		).toEqual([]);
		// Constructor parameter property receiver + async class method section (the class-store
		// shape used by the lease/journal/plan stores).
		expect(
			detect(
				`${PG_IMPORT}class C {\n` +
					"\tconstructor(private readonly database: BunSQLDatabase) {}\n" +
					"\trun() { return this.database.transaction((tx) => this.section(tx)); }\n" +
					"\tprivate async section(tx) { await tx.execute(x); }\n" +
					"}",
			),
		).toEqual([]);
		// Property-declaration receiver + local async section (the blob-catalog shape).
		expect(
			detect(
				`${PG_IMPORT}${SECTION}class C {\n` +
					"\tprivate readonly db: BunSQLDatabase;\n" +
					"\trun() { return this.db.transaction((tx) => section(tx)); }\n" +
					"}",
			),
		).toEqual([]);
		// Forwarded section parameter on a recognized PG receiver (postgres-runtime-queue's
		// `runSection(label, section)` pattern): the type cannot prove sync-ness, the receiver can.
		expect(
			detect(
				`${PG_IMPORT}` +
					"function run(db: BunSQLDatabase, section: (tx) => Promise<void>) {\n" +
					"\treturn db.transaction((tx) => section(tx));\n" +
					"}",
			),
		).toEqual([]);

		// ── Conservative: what cannot be resolved is reported, never silently passed ──

		// Unresolvable receiver expression.
		expect(
			detect(
				`${PG_IMPORT}${SECTION}function make() { return getDb().transaction((tx) => section(tx)); }`,
			)[0],
		).toContain("not a recognized PostgreSQL handle");
		// `this.db` where the class property is untyped.
		expect(
			detect(
				`${PG_IMPORT}class C {\n` +
					"\tprivate db;\n" +
					"\trun() { return this.db.transaction((tx) => this.section(tx)); }\n" +
					"\tasync section(tx) { await tx.execute(x); }\n" +
					"}",
			)[0],
		).toContain("not a recognized PostgreSQL handle");
		// Forwarded parameter on an UNRECOGNIZED receiver.
		expect(
			detect("function run(db, section) { return db.transaction((tx) => section(tx)); }")[0],
		).toContain("delegates to the parameter `section`");
		// Callee not declared in this module (e.g. imported) — even on a recognized PG receiver.
		expect(
			detect(
				`${PG_IMPORT}` +
					"function make(db: BunSQLDatabase) { return db.transaction((tx) => importedSection(tx)); }",
			)[0],
		).toContain("not declared in this module");
		// A local alias of an expression (the recent-tabs-service `options.inTransaction` shape):
		// reported as an unresolvable alias, not as "not declared", and never passed.
		expect(
			detect(
				"function make(db, options) {\n" +
					"\tconst runInTransaction = options.inTransaction;\n" +
					"\tdb.transaction((tx) => { runInTransaction(tx); });\n" +
					"}",
			)[0],
		).toContain("local alias");
		// `this.missing(tx)` — no such method on the enclosing class.
		expect(
			detect(
				`${PG_IMPORT}class C {\n` +
					"\tconstructor(private readonly database: BunSQLDatabase) {}\n" +
					"\trun() { return this.database.transaction((tx) => this.missing(tx)); }\n" +
					"}",
			)[0],
		).toContain("does not declare");

		// ── Regression: existing legitimate SQLite shapes stay accepted ──

		// Delegation to a local SYNCHRONOUS function needs no receiver proof (the shape used by
		// narrator-persistence, device-service, sqlite-*-store).
		expect(
			detect(
				"function section(tx) { tx.run(); }\n" +
					"function make(db) { return db.transaction((tx) => section(tx)); }",
			),
		).toEqual([]);
		// A sync method reached through `this` on an unannotated class (integration-binding shape).
		expect(
			detect(
				"class C {\n" +
					"\tcreateInTransaction(tx) { tx.run(); }\n" +
					"\trun(db) { return db.transaction((tx) => this.createInTransaction(tx)); }\n" +
					"}",
			),
		).toEqual([]);
	});

	it("self-check: a forwarded callback is judged by encapsulation, not by its declared type", () => {
		// The five production wrappers pass a caller-supplied callback straight through, so the
		// body is invisible. An earlier version of this gate claimed the declared type closed the
		// hole; `type-level-claims.probe.ts` disproves that, so the criterion is `private`.
		const detect = (source: string) => findViolations(source, "fixture.ts").map((v) => v.reason);

		// Accepted: private/# forwarders. Callers are confined to the module, where every call
		// site is itself scanned by this gate.
		expect(
			detect(
				"class C { private transaction<T>(work: (tx: Q) => T): T { return d.transaction(work); } }",
			),
		).toEqual([]);
		expect(
			detect("class C { #transaction<T>(work: (tx: Q) => T): T { return d.transaction(work); } }"),
		).toEqual([]);

		// Flagged: the SAME signature reachable from outside the module. `=> T` and `=> void`
		// look synchronous but constrain nothing — this is the correction to the earlier claim.
		expect(
			detect(
				"class C { transaction<T>(work: (tx: Q) => T): T { return d.transaction(work); } }",
			)[0],
		).toContain("non-private");
		expect(
			detect("class C { public run(work: (tx: Q) => void) { d.transaction(work); } }")[0],
		).toContain("non-private");
		expect(
			detect("export function w<T>(work: (tx: Q) => T): T { return db.transaction(work); }")[0],
		).toContain("non-private");

		// Flagged regardless of encapsulation: a type that openly invites an async callback.
		// `private` bounds WHO can call, but a Promise-returning parameter documents intent to
		// hand the transaction an async body, which no access modifier makes sound.
		expect(
			detect(
				"class C { private t<T>(work: (tx: Q) => Promise<T>) { return d.transaction(work); } }",
			)[0],
		).toContain("explicitly returns Promise");
		expect(
			detect("class C { private t(work: (tx: Q) => any) { d.transaction(work); } }")[0],
		).toContain("`any`/`unknown`");
		expect(detect("function w(work) { db.transaction(work); }")[0]).toContain("no type annotation");
	});

	it("the false type-level claim stays disproven by a compiled counterexample", () => {
		// The correction this test guards is a claim ABOUT THE COMPILER, so prose is not enough:
		// `type-level-claims.probe.ts` is compiled by `tsgo --noEmit` with the rest of the repo and
		// passes, which is what proves an async callback reaches a `=> T` / `=> void` transaction
		// parameter without complaint. If that file were deleted or emptied, the gate's reasoning
		// would revert to an unverified assertion, so its presence and content are pinned here.
		const probe = readFileSync(join(REPO_ROOT, "server/db/type-level-claims.probe.ts"), "utf8");

		// Claim 1: a generic `=> T` parameter infers Promise rather than rejecting.
		expect(probe).toContain("probeDb.transaction(probeAsyncCallback)");
		expect(probe).toContain("const inferredAsPromise: Promise<string>");
		// Claim 2: `=> void` accepts any return type, async included.
		expect(probe).toContain("work: (tx: ProbeTx) => void");
		expect(probe).toContain("probeVoidParameter(probeAsyncCallback)");
		// The forwarder shape the five production wrappers use.
		expect(probe).toContain("function probeGenericForwarder<T>(work: (tx: ProbeTx) => T): T");

		// The counterexamples must be genuinely async, or they prove nothing.
		expect(probe).toContain("async function probeAsyncCallback");
		expect(probe).toContain("await Promise.resolve()");

		// The probe must stay inert: no import from real modules, no runtime entry point.
		expect(probe).not.toMatch(/^import\s/m);
		expect(probe).not.toContain("@server/");
		expect(probe).not.toContain("bun:sqlite");
	});

	it("the five forwarding wrappers are still private, which is what actually protects them", () => {
		// The safety argument for the by-reference case is encapsulation, so it has to be checked
		// rather than assumed. If one of these becomes non-private, the repo-wide gate above starts
		// reporting it — this test names them so the failure is self-explanatory instead of
		// arriving as an unattributed violation.
		const forwarders = [
			"server/services/workspace-write-coordinator.ts",
			"server/services/revert-plan-service.ts",
			"server/services/revert-mutation-journal.ts",
			"server/services/file-change-evidence.ts",
			"server/services/file-change-blob-catalog.ts",
		];

		for (const file of forwarders) {
			const violations = findViolations(readFileSync(join(REPO_ROOT, file), "utf8"), file);
			expect(violations, `${file} forwards a transaction callback unsafely`).toEqual([]);
			// The private declaration itself, so this does not pass merely because the wrapper was
			// renamed or removed and the file no longer forwards anything.
			expect(
				readFileSync(join(REPO_ROOT, file), "utf8"),
				`${file} no longer declares a private transaction forwarder`,
			).toMatch(/\bprivate\s+transaction\s*</);
		}
	});

	it("declares the callback shapes it does not analyse instead of implying coverage", () => {
		// A gate that silently ignores a shape is worse than one that says so: reviewers trust it
		// in exactly the case where it is blind. `db.transaction(this.method)` and
		// `db.transaction(obj.fn)` are MemberExpression arguments — the gate does not resolve
		// them, so it must not look like it did.
		const detect = (source: string) => findViolations(source, "fixture.ts").map((v) => v.reason);

		expect(detect("db.transaction(this.applyWrite);")[0]).toContain("not analysed");
		expect(detect("db.transaction(helpers.applyWrite);")[0]).toContain("not analysed");

		// There are no such call sites in production today; verified by the repo-wide scan above
		// (it would report them). This assertion exists so that adding one is a deliberate act.
		const memberExpressionSites = SCAN_ROOTS.flatMap((root) =>
			collectSourceFiles(join(REPO_ROOT, root))
				.filter((absolute) => readFileSync(absolute, "utf8").includes(".transaction("))
				.flatMap((absolute) =>
					findViolations(readFileSync(absolute, "utf8"), toPosixRelative(absolute)),
				),
		).filter((violation) => violation.reason.includes("not analysed"));
		expect(memberExpressionSites).toEqual([]);
	});

	it("self-check: an unparseable file is a violation, not a silent pass", () => {
		// A scan that treats parse failure as "nothing found" stops covering part of the tree
		// without anyone noticing. This is how the .tsx/generic-arrow plugin conflict was caught.
		const broken = findViolations("function ( { unbalanced", "fixture.ts");
		expect(broken).toHaveLength(1);
		expect(broken[0]?.reason).toContain("could not be parsed");

		// Generic arrow functions in .ts must NOT be treated as JSX.
		expect(findViolations("const id = <T,>(x: T): T => x;", "fixture.ts")).toEqual([]);
		// JSX in .tsx must parse.
		expect(findViolations("const el = <div>hi</div>;", "fixture.tsx")).toEqual([]);
	});
});
