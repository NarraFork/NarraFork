/**
 * Inputs of the brief renderers' tests (`task-brief.test.ts`): delegation briefs whose bytes are
 * pinned (they must not change when the opening brief's sections are added to the renderer).
 */
import type { DelegationBriefInput, DelegationBriefNode } from "../delegation";

const note = (text: string, children: DelegationBriefNode[] = []): DelegationBriefNode => ({
	text,
	box: null,
	children,
});

/** `[name, input, budget]`: small, nested, over the budget, and with every optional part. */
export function delegationFixtures(): Array<[string, DelegationBriefInput, number | undefined]> {
	const wide = Array.from({ length: 400 }, (_, i) =>
		note(`Note ${i} ${"x".repeat(60)}`, [note(`Deep ${i} ${"y".repeat(40)}`)]),
	);
	return [
		["bare", { title: "T", body: null, goals: [], children: [], prerequisites: [] }, undefined],
		[
			"nested",
			{
				title: "Fix the refresh logic",
				body: "Two tabs refresh at once.\nSee the design.",
				goals: ["Tasks", "Make sign-in reliable"],
				children: [
					{ text: "Write the test", box: "done", children: [note("it fails\nas expected")] },
					{ text: "Change the code", box: "todo", children: [] },
					{
						text: "An earlier report (an earlier report; not repeated here)",
						box: null,
						collapsed: true,
						children: [],
					},
				],
				prerequisites: [{ title: "Agree on the lock", status: "done" }],
				prompt: "Keep the public API.",
			},
			undefined,
		],
		[
			"over the budget",
			{
				title: "Big 任务",
				body: "正文".repeat(9000),
				goals: ["G"],
				children: wide,
				prerequisites: [{ title: "P", status: "doing" }],
				prompt: null,
			},
			undefined,
		],
		[
			"a small budget",
			{
				title: "Small",
				body: "b".repeat(3000),
				goals: [],
				children: wide.slice(0, 30),
				prerequisites: [],
			},
			2048,
		],
	];
}
