/**
 * Files seeded into the tutorial sandbox repository.
 *
 * The tutorial executes its tool calls for real, so a lesson that scripts
 * `Read src/greeting.ts` needs that file to actually exist — otherwise the card
 * shows a genuine "file not found" error and the lesson teaches what a failure
 * looks like. These are the files every script may assume are present.
 *
 * Deliberately small and boring. This is not a demo of good code; it is a stable
 * substrate for demonstrating *tools*. Keeping it tiny also keeps `git init` plus
 * one commit fast enough for the provisioning request to stay synchronous.
 *
 * Content lives in `shared/` next to the scripts so the guard test can assert the
 * two agree: every path a script touches must be seeded here, which is the check
 * that catches a script referencing a file nobody created.
 */

export interface TutorialSandboxFile {
	/** Repo-relative path, POSIX separators. Never absolute (see script-safety). */
	path: string;
	content: string;
}

/**
 * A `${...}` sequence destined for the SEEDED file, not for this module.
 *
 * Written as a concatenation because a literal `"${name}"` in source makes Biome
 * suggest converting the surrounding quotes to a template string — which would
 * interpolate at build time and emit `Hello, undefined!` into the sandbox.
 */
function interp(expression: string): string {
	return `\${${expression}}`;
}

/**
 * The seeded tree.
 *
 * `src/greeting.ts` has a deliberate, obvious duplication so an `Edit` lesson has
 * something worth changing, and `notes.md` exists so `Glob`/`Grep` return more
 * than one match (a single-hit search does not show what the match list is for).
 */
export const TUTORIAL_SANDBOX_FILES: readonly TutorialSandboxFile[] = [
	{
		path: "README.md",
		content: [
			"# Tutorial sandbox",
			"",
			"This repository was created by the NarraFork interactive tutorial.",
			"",
			"It is a real git repository in your NarraFork data directory, and the",
			"tutorial's narrators really do read, edit and run commands in it. Nothing",
			"here is connected to your own projects.",
			"",
			"You can delete it at any time from the tutorial page. It will be recreated",
			"the next time you start a lesson.",
			"",
		].join("\n"),
	},
	{
		path: "src/greeting.ts",
		content: [
			"/** Greeting helpers used by the tutorial's tool lessons. */",
			"",
			"export function greet(name: string): string {",
			`\treturn \`Hello, ${interp("name")}!\`;`,
			"}",
			"",
			"export function greetLoudly(name: string): string {",
			"\t// Duplicated on purpose: the Edit lesson replaces this with a call to greet().",
			`\treturn \`Hello, ${interp("name")}!\`.toUpperCase();`,
			"}",
			"",
		].join("\n"),
	},
	{
		path: "src/tasks.ts",
		content: [
			"/** A tiny in-memory task list, used by the Grep and Bash lessons. */",
			"",
			"export interface Task {",
			"\tid: string;",
			"\ttitle: string;",
			'\tstatus: "todo" | "done";',
			"}",
			"",
			"export function countOpen(tasks: Task[]): number {",
			'\treturn tasks.filter((task) => task.status === "todo").length;',
			"}",
			"",
		].join("\n"),
	},
	{
		path: "notes.md",
		content: [
			"# Notes",
			"",
			"- `greet` and `greetLoudly` in `src/greeting.ts` repeat the same template.",
			"- `countOpen` in `src/tasks.ts` has no tests yet.",
			"",
		].join("\n"),
	},
];

/** Every seeded path, for guard tests and provisioning. */
export function tutorialSandboxPaths(): string[] {
	return TUTORIAL_SANDBOX_FILES.map((file) => file.path);
}

// ---------------------------------------------------------------------------
// Commit history
// ---------------------------------------------------------------------------

/**
 * One commit in the seeded history.
 *
 * The NarraFlow lessons need history to be *about* something: a graph with one
 * node, or a fork whose only ancestor is "Initial commit", shows the mechanism
 * without showing why anyone would use it. Several commits with recognisable
 * messages give the graph, the commit list and the fork picker real content.
 *
 * Kept to four small commits — enough to be legible, cheap enough that
 * provisioning stays a synchronous request (see `routes/tutorial.ts`).
 */
export interface TutorialSandboxCommit {
	/** Commit message. Shown verbatim in the graph and commit list. */
	message: string;
	/**
	 * Files written before this commit is made. Paths are repo-relative and must
	 * appear in `TUTORIAL_SANDBOX_FILES` — the guard test enforces that, so a
	 * commit cannot introduce a file the scripts believe does not exist.
	 */
	paths: string[];
}

/**
 * The seeded history, oldest first.
 *
 * Ordered so the final state equals `TUTORIAL_SANDBOX_FILES` exactly: the last
 * commit leaves every seeded file present and committed. A dirty tree after
 * provisioning would make the very first chapter lesson open on uncommitted
 * changes the user did not make, which reads as a bug in the product.
 */
export const TUTORIAL_SANDBOX_COMMITS: readonly TutorialSandboxCommit[] = [
	{ message: "Add README", paths: ["README.md"] },
	{ message: "Add greeting helpers", paths: ["src/greeting.ts"] },
	{ message: "Add task helpers", paths: ["src/tasks.ts"] },
	{ message: "Note the duplicated greeting template", paths: ["notes.md"] },
];
