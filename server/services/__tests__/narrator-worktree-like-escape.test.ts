import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { escapeLikePrefix } from "../narrator-worktree-retirement";

/**
 * The dependent scan finds sessions whose cwd is *inside* a worktree with a `LIKE`
 * prefix. SQLite only treats a backslash as an escape character when the statement says
 * so, and drizzle's `like()` helper never emits `ESCAPE` — which is why the query builds
 * the condition by hand.
 *
 * A worktree named `feat_x` is ordinary (branch names with underscores are common), so
 * these cases are the difference between "no dependents" and "the session that was
 * living in the directory".
 */
function seeded(): Database {
	const db = new Database(":memory:");
	db.run("create table t(path text)");
	for (const path of [
		"/repo/.worktrees/feat_x",
		"/repo/.worktrees/feat_x/sub",
		"/repo/.worktrees/featX/sub",
		"/repo/.worktrees/feat_x2/sub",
		"/repo/.worktrees/100%/sub",
	])
		db.run("insert into t values (?)", [path]);
	return db;
}

const matching = (db: Database, pattern: string) =>
	db.query("select path from t where path like ? escape '\\' order by path").all(pattern) as {
		path: string;
	}[];

describe("worktree dependent prefix matching", () => {
	test("escapes LIKE metacharacters", () => {
		expect(escapeLikePrefix("/repo/.worktrees/feat_x/")).toBe("/repo/.worktrees/feat\\_x/");
		expect(escapeLikePrefix("/repo/100%")).toBe("/repo/100\\%");
		expect(escapeLikePrefix("C:\\repo\\a")).toBe("C:\\\\repo\\\\a");
	});

	test("an underscore in the path still matches its own subtree only", () => {
		const db = seeded();
		const paths = matching(db, `${escapeLikePrefix("/repo/.worktrees/feat_x/")}%`).map(
			(row) => row.path,
		);
		expect(paths).toEqual(["/repo/.worktrees/feat_x/sub"]);
		db.close();
	});

	test("without the escape clause the same pattern matches nothing", () => {
		// Guards the reason `escapeLikePrefix` exists at all: this is what the query
		// silently did before, and it reports "no dependents" instead of failing.
		const db = seeded();
		const naive = "/repo/.worktrees/feat\\_x/%";
		expect(db.query("select path from t where path like ?").all(naive)).toEqual([]);
		db.close();
	});
});
