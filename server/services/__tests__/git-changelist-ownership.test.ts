import { describe, expect, spyOn, test } from "bun:test";
import {
	createTextOwnership,
	materializeTextOwnership,
	moveTextUnits,
	normalizeTextOwnership,
	prepareTextCommit,
	rebaseTextOwnership,
	splitOwnershipLines,
	TextOwnershipError,
	type TextOwnershipMode,
	type TextOwnershipSnapshot,
	updateTextOwnership,
} from "../git-changelist-ownership";

function create(baseText: string, workText = baseText, group = "A") {
	return createTextOwnership({ fileId: "file", baseText, workText, activeGroupId: group });
}

function expectCurrent(snapshot: TextOwnershipSnapshot, allowLegacyBaseAliases = false) {
	expect(materializeTextOwnership(snapshot)).toBe(snapshot.workText);
	expect(snapshot.workLines.map((line) => line.text).join("")).toBe(snapshot.workText);
	expect(new Set(snapshot.units.map((unit) => unit.id)).size).toBe(snapshot.units.length);
	expect(new Set(snapshot.workLines.map((line) => line.id)).size).toBe(snapshot.workLines.length);
	if (!allowLegacyBaseAliases)
		expect(new Set(snapshot.baseLineIds).size).toBe(snapshot.baseLineIds.length);
	expect(snapshot.structuralSourceGroupIds).toBeUndefined();
	for (const unit of snapshot.units) {
		expect(unit.needsReview).toBe(false);
		expect(unit.reviewReason).toBeUndefined();
		expect(unit.sourceGroupIds).toEqual([unit.groupId]);
	}
}

function edit(
	snapshot: TextOwnershipSnapshot,
	workText: string,
	group = "B",
	mode: TextOwnershipMode = "observe",
) {
	const encoded = JSON.stringify(snapshot);
	const result = updateTextOwnership(snapshot, { workText, activeGroupId: group, mode });
	expect(result.workText).toBe(workText);
	expectCurrent(result);
	expect(JSON.stringify(snapshot)).toBe(encoded);
	return result;
}

function expectProjections(snapshot: TextOwnershipSnapshot, projections: Record<string, string>) {
	for (const [groupId, text] of Object.entries(projections)) {
		expect(materializeTextOwnership(snapshot, { groupIds: [groupId] })).toBe(text);
	}
	expectCurrent(snapshot);
	expect(
		updateTextOwnership(snapshot, { workText: snapshot.workText, activeGroupId: "another-group" }),
	).toBe(snapshot);
}

function twoGroups() {
	return edit(create("a\nb\nc\nd\ne\n", "a\nA\nc\nd\ne\n"), "a\nA\nc\nB\ne\n");
}

function expectCode(run: () => unknown, code: TextOwnershipError["code"]) {
	try {
		run();
		throw new Error("Expected an ownership error");
	} catch (error) {
		expect(error).toBeInstanceOf(TextOwnershipError);
		expect((error as TextOwnershipError).code).toBe(code);
	}
}

function legacy(snapshot = twoGroups()): TextOwnershipSnapshot {
	return {
		...snapshot,
		units: snapshot.units.map((unit) => ({
			...unit,
			needsReview: true,
			reviewReason: "headChanged",
			sourceGroupIds: ["former-owner", unit.groupId],
		})),
		structuralSourceGroupIds: { "file:mode": ["mode-owner"] },
	};
}

test("an external append after an unterminated local replacement uses the HEAD conflict policy", () => {
	for (const newline of ["\n", "\r\n"]) {
		const previous = create(`a${newline}b${newline}`, `a${newline}B`);
		const input = {
			baseText: `a${newline}b${newline}c${newline}`,
			workText: `a${newline}B${newline}c${newline}`,
			activeGroupId: "active",
		};
		expect(rebaseTextOwnership(previous, input).status).toBe("headConflict");
		const result = rebaseTextOwnership(previous, {
			...input,
			headConflictGroupId: "unassigned",
		});
		expect(result).toMatchObject({ status: "ok", headRebuilt: true });
		expect(result.snapshot.workText).toBe(input.workText);
		expect(result.snapshot.units.map((unit) => unit.groupId)).toEqual(["unassigned"]);
		expectCurrent(result.snapshot);
	}
});

describe("observed edit attribution", () => {
	test("line terminators, Unicode and missing EOF remain byte-exact", () => {
		for (const value of ["", "a", "a\n", "a\r\n", "a\r\nb\r", "\n\n", "中文\r\n尾行"]) {
			expect(splitOwnershipLines(value).join("")).toBe(value);
			expectCurrent(create(value));
		}
		let snapshot = create("a\r\nb\r\nc", "a\r\nA\r\nc");
		snapshot = edit(snapshot, "a\r\nA\r\nC", "B");
		expectProjections(snapshot, { A: "a\r\nA\r\nc", B: "a\r\nb\r\nC" });
		snapshot = edit(snapshot, "a\r\nA\r\nC\r\n", "C");
		expect(snapshot.units.map((unit) => unit.groupId)).toEqual(["A", "C"]);
	});

	test("new blocks enter the target and untouched blocks retain owners and identities", () => {
		const previous = twoGroups();
		const snapshot = edit(previous, "a\nA2\nc\nB\ne\n", "C");
		expect(snapshot.units.map((unit) => unit.groupId)).toEqual(["C", "B"]);
		expect(snapshot.units.map((unit) => unit.id)).toEqual(previous.units.map((unit) => unit.id));
		expect(snapshot.workLines[2].id).toBe(previous.workLines[2].id);
		expect(snapshot.baseLineIds).toEqual(previous.baseLineIds);
		expectProjections(snapshot, { C: "a\nA2\nc\nd\ne\n", B: "a\nb\nc\nB\ne\n" });
	});

	test("adjacent replacements remain independently owned", () => {
		const previous = edit(create("a\nb\nc\n", "A\nb\nc\n"), "A\nB\nc\n");
		const snapshot = edit(previous, "A2\nB\nc\n", "C");
		expect(snapshot.units.map((unit) => unit.groupId)).toEqual(["C", "B"]);
		expectProjections(snapshot, { C: "A2\nb\nc\n", B: "a\nB\nc\n" });
	});

	test("independent insertion at either edge leaves the old unit in its group", () => {
		for (const work of ["new\nA\nb\n", "A\nnew\nb\n"]) {
			const snapshot = edit(create("a\nb\n", "A\nb\n"), work);
			expect(snapshot.units.map((unit) => unit.groupId).sort()).toEqual(["A", "B"]);
			expectProjections(snapshot, { A: "A\nb\n" });
		}
	});

	test("internal insertion rebuilds the existing block into the current target", () => {
		const old = create("a\nz\n", "a\nx\ny\nz\n");
		const snapshot = edit(old, "a\nx\nadded\ny\nz\n");
		expect(snapshot.units).toHaveLength(1);
		expect(snapshot.units[0]).toMatchObject({ id: old.units[0].id, groupId: "B" });
	});

	test("front insertions and deletions move coordinates without moving untouched owners", () => {
		const old = twoGroups();
		const inserted = edit(old, "front\na\nA\nc\nB\ne\n", "C");
		expect(inserted.units.map((unit) => unit.groupId)).toEqual(["C", "A", "B"]);
		expect(inserted.units[2].workStart).toBe(old.units[1].workStart + 1);
		const removed = edit(inserted, "front\nA\nc\nB\ne\n", "D");
		expect(removed.units.find((unit) => unit.id === old.units[1].id)?.groupId).toBe("B");
	});

	test("zero-width deletions retain identity until affected or restored", () => {
		let snapshot = create("a\nb\nc\nd\n", "a\nd\n");
		const id = snapshot.units[0].id;
		expect(snapshot.units[0].workStart).toBe(snapshot.units[0].workEnd);
		snapshot = edit(snapshot, "front\na\nd\n");
		expect(snapshot.units.find((unit) => unit.id === id)).toMatchObject({
			groupId: "A",
			workStart: 2,
		});
		snapshot = edit(snapshot, "front\na\nb\nd\n", "C");
		expect(snapshot.units.find((unit) => unit.id === id)).toMatchObject({ groupId: "C" });
		expect(snapshot.units.find((unit) => unit.id === id)?.deletedLineIds).toHaveLength(1);
		snapshot = edit(snapshot, "front\na\nb\nc\nd\n", "D");
		expect(snapshot.units.map((unit) => unit.groupId)).toEqual(["B"]);
	});

	test("an adjacent replacement does not consume an untouched empty deletion range", () => {
		const snapshot = edit(create("a\nb\nc\nd\n", "b\nc\nd\n"), "B\nc\nd\n");
		expect(snapshot.units.map((unit) => unit.groupId)).toEqual(["A", "B"]);
		expectProjections(snapshot, { A: "b\nc\nd\n", B: "a\nB\nc\nd\n" });
	});

	test("cross-owner replacement adopts the target and is directly synthesizable", () => {
		const snapshot = edit(twoGroups(), "a\ncombined\ne\n", "C");
		expect(snapshot.units).toHaveLength(1);
		expect(snapshot.units[0].groupId).toBe("C");
		expect(prepareTextCommit(snapshot, { groupIds: ["C"] }).text).toBe(snapshot.workText);
		expect(edit(snapshot, "a\ncombined again\ne\n", "D").units[0].groupId).toBe("D");
	});

	test("unique moved text retains line identity but adopts the current target", () => {
		const old = create("a\nb\nc\nd\n", "a\nunique inserted\nb\nc\nd\n");
		const snapshot = edit(old, "a\nb\nc\nunique inserted\nd\n");
		expect(snapshot.units).toHaveLength(1);
		expect(snapshot.units[0].groupId).toBe("B");
		expect(snapshot.workLines[3].id).toBe(old.workLines[1].id);
	});

	test("partial restores and a moved replacement rebuild every affected part", () => {
		for (const work of ["b\nc\n", "a\nb\n"]) {
			const snapshot = edit(create("a\nb\nc\n", "a\nc\n"), work);
			expect(snapshot.units).toHaveLength(1);
			expect(snapshot.units[0].groupId).toBe("B");
			expect(prepareTextCommit(snapshot, { groupIds: ["B"] }).text).toBe(work);
		}
		const moved = edit(create("a\nb\nc\nd\n", "a\nunique\nc\nd\n"), "a\nc\nunique\nd\n");
		expect(moved.units.every((unit) => unit.groupId === "B")).toBe(true);
	});

	test("manual moves survive no-op refreshes and only subsequent touched edits change their owner", () => {
		const old = twoGroups();
		const encoded = JSON.stringify(old);
		const moved = moveTextUnits(old, { unitIds: [old.units[0].id], targetGroupId: "manual" });
		expect(moved.units.map((unit) => unit.groupId)).toEqual(["manual", "B"]);
		expectProjections(moved, { manual: "a\nA\nc\nd\ne\n" });
		expect(moveTextUnits(moved, { unitIds: [moved.units[0].id], targetGroupId: "manual" })).toBe(
			moved,
		);
		expect(edit(moved, "a\nnew A\nc\nB\ne\n", "C").units.map((unit) => unit.groupId)).toEqual([
			"C",
			"B",
		]);
		expect(JSON.stringify(old)).toBe(encoded);
		expectCode(
			() => moveTextUnits(old, { unitIds: ["missing"], targetGroupId: "C" }),
			"unknownUnit",
		);
	});

	test("a merge observation can explicitly target unassigned while untouched units remain", () => {
		const old = twoGroups();
		const snapshot = edit(old, "a\nnew A\nc\nB\ne\n", "unassigned");
		expect(snapshot.units.map((unit) => unit.groupId)).toEqual(["unassigned", "B"]);
		expect(snapshot.units[1].id).toBe(old.units[1].id);
	});

	test("restoring current text to the baseline removes only restored units", () => {
		const snapshot = edit(twoGroups(), "a\nb\nc\nB\ne\n", "C");
		expect(snapshot.units.map((unit) => unit.groupId)).toEqual(["B"]);
		const restored = edit(snapshot, snapshot.baseText, "C");
		expect(restored.units).toEqual([]);
		expect(restored.workLines.map((line) => line.id)).toEqual(restored.baseLineIds);
	});
});

describe("repeated contexts and reconstructed regions", () => {
	for (const [base, before, after] of [
		["", "start\nx\nx\nend\n", "start\nx\nend\n"],
		["", "start\n\n\nend\n", "start\n\nend\n"],
		["", "start\n}\n}\nend\n", "start\n}\nend\n"],
		["", "x\n", "x\nx\n"],
		["a\n", "a\na\na\n", "a\nb\na\nb\n"],
		["head\nx\nfoot\n", "head\nx\nx\nend\nfoot\n", "head\nx\nend\nfoot\n"],
		["a\nx\nq\nx\nz\n", "a\nx\nx\nz\n", "a\nx\nx\nx\nz\n"],
		["a\nsame\nb\nc\nd\n", "a\nsame\nsame\nb\nc\nd\n", "a\nb\nsame\nc\nd\n"],
	]) {
		test(`rebuilds the affected duplicate region into its target: ${JSON.stringify(after)}`, () => {
			const old = create(base, before);
			const snapshot = edit(old, after, "B");
			expect(snapshot.units.every((unit) => unit.groupId === "B")).toBe(true);
			expectProjections(snapshot, { A: base, B: after });
			expect(prepareTextCommit(snapshot, { groupIds: ["B"] }).text).toBe(after);
		});
	}

	test("unrelated repeated fragments outside the affected region retain their manual group", () => {
		let old = create("a\nsame\nb\nc\nd\ne\n", "a\nsame\nb\nsame\nc\nd\ne\n");
		old = edit(old, "a\nsame\nb\nsame\nc\nd\nsame\ne\n", "D");
		const id = old.units.find((unit) => unit.groupId === "D")?.id;
		const snapshot = edit(old, "a\nb\nc\nsame\nd\nsame\ne\n", "B");
		expect(snapshot.units.find((unit) => unit.id === id)?.groupId).toBe("D");
		expect(snapshot.workLines[5].id).toBe(old.workLines[6].id);
		expectProjections(snapshot, { B: "a\nb\nc\nsame\nd\ne\n", D: "a\nsame\nb\nc\nd\nsame\ne\n" });
	});

	test("co-located deletions reconstruct together under the current target", () => {
		let snapshot = create("a\na\nb\n", "a\na\n");
		snapshot = edit(snapshot, "a\n", "C");
		expect(snapshot.units).toHaveLength(2);
		expect(snapshot.units.every((unit) => unit.workStart === 1 && unit.workEnd === 1)).toBe(true);
		snapshot = edit(snapshot, "b\n", "B");
		expect(snapshot.units).toHaveLength(1);
		expect(snapshot.units[0]).toMatchObject({ groupId: "B", baseStart: 0, baseEnd: 2 });
		expect(snapshot.workLines[0].id).toBe(snapshot.baseLineIds[2]);
	});

	test("joint duplicate insertions and deletions retain exact unique identities", () => {
		let snapshot = create("a\nb\n", "b\nb\na\n");
		snapshot = edit(snapshot, "b\na\na\nb\n", "B");
		snapshot = edit(snapshot, "a\nb\nb\nb\n", "C");
		expect(snapshot.units).toHaveLength(1);
		expect(snapshot.units[0].groupId).toBe("C");
		expect(snapshot.workLines.slice(0, 2).map((line) => line.id)).toEqual(snapshot.baseLineIds);
	});

	test("496 short duplicate-context edits synthesize exact text and preserve prior observations", () => {
		const texts = [""];
		for (let size = 1; size <= 4; size++) {
			for (let bits = 0; bits < 2 ** size; bits++) {
				texts.push(
					Array.from({ length: size }, (_, i) => (bits & (1 << i) ? "b\n" : "a\n")).join(""),
				);
			}
		}
		for (const base of ["", "a\n"]) {
			for (const before of ["a\n", "a\na\n", "a\na\na\n", "a\nb\na\n"]) {
				for (const work of texts) {
					for (const group of ["A", "B"]) {
						const old = create(base, before);
						const snapshot = edit(old, work, group);
						expect(snapshot.baseLineIds).toEqual(old.baseLineIds);
					}
				}
			}
		}
	});
});

describe("legacy snapshot normalization", () => {
	test("normalizes metadata immutably while preserving every owner, coordinate and identity", () => {
		const old = legacy();
		const encoded = JSON.stringify(old);
		const normalized = normalizeTextOwnership(old);
		expectCurrent(normalized);
		expect(normalized.fileId).toBe(old.fileId);
		expect(normalized.baseText).toBe(old.baseText);
		expect(normalized.workText).toBe(old.workText);
		expect(normalized.baseLineIds).toBe(old.baseLineIds);
		expect(normalized.workLines).toBe(old.workLines);
		expect(
			normalized.units.map((unit) => [unit.id, unit.groupId, unit.baseStart, unit.workStart]),
		).toEqual(old.units.map((unit) => [unit.id, unit.groupId, unit.baseStart, unit.workStart]));
		expect(JSON.stringify(old)).toBe(encoded);
		expect(normalizeTextOwnership(normalized)).toBe(normalized);
	});

	test("no-op updates upgrade metadata without reassigning existing units", () => {
		const old = legacy();
		const upgraded = edit(old, old.workText, "new-active");
		expect(upgraded.units.map((unit) => unit.groupId)).toEqual(["A", "B"]);
		const changed = edit(old, "a\nA edited\nc\nB\ne\n", "C");
		expect(changed.units.map((unit) => unit.groupId)).toEqual(["C", "B"]);
	});

	test("structure-only legacy metadata is removed even with no remaining text units", () => {
		const old = legacy(create("a\n"));
		const encoded = JSON.stringify(old);
		const normalized = normalizeTextOwnership(old);
		expectCurrent(normalized);
		expect(normalized.units).toEqual([]);
		expect(JSON.stringify(old)).toBe(encoded);
	});

	test("legacy flags do not block pure candidate synthesis and do not hide invalid content", () => {
		const old = legacy();
		const encoded = JSON.stringify(old);
		expect(prepareTextCommit(old, { groupIds: ["A"] }).text).toBe("a\nA\nc\nd\ne\n");
		expect(JSON.stringify(old)).toBe(encoded);
		for (const corrupt of [
			{ ...old, workText: "wrong" },
			{ ...old, baseLineIds: [] },
			{ ...old, workLines: old.workLines.map((line) => ({ ...line, text: "wrong" })) },
		]) {
			expectCode(() => normalizeTextOwnership(corrupt), "invalidSnapshot");
			expectCode(() => prepareTextCommit(corrupt, { groupIds: ["A"] }), "invalidSnapshot");
		}
	});

	test("malformed legacy structural metadata remains an explicit invalid snapshot", () => {
		for (const value of [null, [], "wrong", { mode: [] }, { mode: [3] }]) {
			const snapshot = {
				...create("a\n"),
				structuralSourceGroupIds:
					value as unknown as TextOwnershipSnapshot["structuralSourceGroupIds"],
			};
			expectCode(() => normalizeTextOwnership(snapshot), "invalidSnapshot");
		}
	});
});

describe("external HEAD attribution", () => {
	const unassigned = "unassigned";

	test("disjoint HEAD changes preserve reliable owner and source line identities", () => {
		const old = create("a\nb\nc\nd\n", "a\nb\nC\nd\n");
		const result = rebaseTextOwnership(old, {
			baseText: "front\na\nb\nc\nd\n",
			workText: "front\na\nb\nC\nd\n",
			activeGroupId: "active",
			headConflictGroupId: unassigned,
		});
		expect(result.status).toBe("ok");
		expect("headRebuilt" in result).toBe(false);
		expect(result.snapshot.units[0]).toMatchObject({
			id: old.units[0].id,
			groupId: "A",
			baseStart: 3,
		});
		expect(result.snapshot.baseLineIds[1]).toBe(old.baseLineIds[0]);
		expectCurrent(result.snapshot);
	});

	test("new differences and rewritten old regions during external HEAD projection enter unassigned", () => {
		const old = twoGroups();
		const result = rebaseTextOwnership(old, {
			baseText: "front\na\nb\nc\nd\ne\n",
			workText: "a\nA\nc\nB edited\ne\nnew\n",
			activeGroupId: "active",
			headConflictGroupId: unassigned,
		});
		expect(result.status).toBe("ok");
		expect(result.snapshot.units.map((unit) => unit.groupId)).toEqual([
			unassigned,
			"A",
			unassigned,
			unassigned,
		]);
		expectCurrent(result.snapshot);
	});

	test("independent HEAD changes at unit boundaries do not consume old ownership", () => {
		for (const { snapshot, head, work } of [
			{
				snapshot: create("a\nb\nc\n", "a\nB\nc\n"),
				head: "a\nexternal\nb\nc\n",
				work: "a\nexternal\nB\nc\n",
			},
			{
				snapshot: create("a\nb\nc\n", "a\ninserted\nb\nc\n"),
				head: "a\nexternal\nc\n",
				work: "a\ninserted\nexternal\nc\n",
			},
		]) {
			const result = rebaseTextOwnership(snapshot, {
				baseText: head,
				workText: work,
				activeGroupId: "active",
				headConflictGroupId: unassigned,
			});
			expect(result.status).toBe("ok");
			expect(result.snapshot.units.map((unit) => unit.groupId)).toEqual(["A"]);
			expectCurrent(result.snapshot);
		}
	});

	test("exact absorption removes committed content while retaining untouched local groups", () => {
		const old = twoGroups();
		const partial = rebaseTextOwnership(old, {
			baseText: "a\nA\nc\nd\ne\n",
			workText: old.workText,
			activeGroupId: "active",
			headConflictGroupId: unassigned,
		});
		expect(partial.status).toBe("ok");
		expect(partial.snapshot.units.map((unit) => unit.groupId)).toEqual(["B"]);
		expect(partial.snapshot.baseLineIds[1]).toBe(old.workLines[1].id);
		const full = rebaseTextOwnership(old, {
			baseText: old.workText,
			workText: old.workText,
			activeGroupId: "active",
			headConflictGroupId: unassigned,
		});
		expect(full.status).toBe("ok");
		expect("headRebuilt" in full).toBe(false);
		expect(full.snapshot.units).toEqual([]);
		expectCurrent(full.snapshot);
	});

	for (const { base, before, head, work } of [
		{ base: "a\nz\n", before: "a\nlocal\nz\n", head: "a\nexternal\nz\n", work: "a\nlocal\nz\n" },
		{ base: "a\nb\nc\n", before: "a\nA\nc\n", head: "a\nH\nc\n", work: "a\nA\nc\n" },
		{ base: "a\nb\nc\n", before: "a\nc\n", head: "a\nH\nc\n", work: "a\nc\n" },
		{ base: "a\nb\nc\n", before: "a\nA\nc\n", head: "a\nc\n", work: "a\nnew A\nc\n" },
		{ base: "a\nx\nx\nz\n", before: "a\nA\nx\nz\n", head: "a\nx\nz\n", work: "a\nA\nz\n" },
		{
			base: "a\r\nb\r\n尾",
			before: "a\r\nA\r\n尾",
			head: "a\r\nH\r\n尾",
			work: "a\r\nnew A\r\n尾",
		},
	]) {
		test(`file fallback handles an unprovable HEAD overlap: ${JSON.stringify(head)}`, () => {
			const old = create(base, before);
			const encoded = JSON.stringify(old);
			const input = { baseText: head, workText: work, activeGroupId: "active" };
			const strict = rebaseTextOwnership(old, input);
			expect(strict.status).toBe("headConflict");
			expect(strict.snapshot).toBe(old);
			const result = rebaseTextOwnership(old, { ...input, headConflictGroupId: unassigned });
			expect(result).toMatchObject({ status: "ok", headRebuilt: true, conflicts: [] });
			expect(result.snapshot.fileId).toBe(old.fileId);
			expect(result.snapshot.units.every((unit) => unit.groupId === unassigned)).toBe(true);
			expectProjections(result.snapshot, { [unassigned]: work, A: head });
			expect(JSON.stringify(old)).toBe(encoded);
		});
	}

	test("file fallback includes untouched file regions but does not duplicate earlier absorbed text", () => {
		const old = twoGroups();
		const all = rebaseTextOwnership(old, {
			baseText: "a\nexternal\nc\nd\ne\n",
			workText: old.workText,
			activeGroupId: "active",
			headConflictGroupId: unassigned,
		});
		expect(all.snapshot.units.map((unit) => unit.groupId)).toEqual([unassigned, unassigned]);
		const partial = rebaseTextOwnership(old, {
			baseText: "a\nA\nc\nexternal\ne\n",
			workText: old.workText,
			activeGroupId: "active",
			headConflictGroupId: unassigned,
		});
		expect(partial.snapshot.units).toHaveLength(1);
		expect(partial.snapshot.units[0]).toMatchObject({
			groupId: unassigned,
			baseStart: 3,
			baseEnd: 4,
		});
		expectCurrent(partial.snapshot);
	});

	test("fallback can leave no text units and later ordinary edits adopt the active group", () => {
		const old = legacy();
		const head = "a\nexternal\nc\nd\ne\n";
		const result = rebaseTextOwnership(old, {
			baseText: head,
			workText: head,
			activeGroupId: "active",
			headConflictGroupId: unassigned,
		});
		expect(result).toMatchObject({ status: "ok", headRebuilt: true });
		expect(result.snapshot.units).toEqual([]);
		expectCurrent(result.snapshot);
		const changed = edit(result.snapshot, "a\nnew local\nc\nd\ne\n", "new-active");
		expect(changed.units[0].groupId).toBe("new-active");
	});
});

describe("strict commit and recovery projection", () => {
	test("committing one group preserves the other group's unit and line identities", () => {
		const old = twoGroups();
		const candidate = prepareTextCommit(old, { groupIds: ["A"] });
		const result = rebaseTextOwnership(old, {
			baseText: candidate.text,
			workText: old.workText,
			activeGroupId: "active",
			commitMapping: JSON.parse(JSON.stringify(candidate.mapping)),
		});
		expect(result.status).toBe("ok");
		expect(result.snapshot.units.map((unit) => unit.groupId)).toEqual(["B"]);
		expect(result.snapshot.units[0].id).toBe(old.units[1].id);
		expect(result.snapshot.baseLineIds[1]).toBe(old.workLines[1].id);
		expect(prepareTextCommit(result.snapshot, { groupIds: ["B"] }).text).toBe(old.workText);
		expectCurrent(result.snapshot);
	});

	test("commit-time edits to remaining owners use provenance, unlike ordinary observation", () => {
		const old = twoGroups();
		const ordinary = edit(old, "a\nA\nc\nB edited\ne\n", "active");
		const strict = edit(old, "a\nA\nc\nB edited\ne\n", "active", "commit");
		expect(ordinary.units.map((unit) => unit.groupId)).toEqual(["A", "active"]);
		expect(strict.units.map((unit) => unit.groupId)).toEqual(["A", "B"]);
		const candidate = prepareTextCommit(old, { groupIds: ["A"] });
		const result = rebaseTextOwnership(old, {
			baseText: candidate.text,
			workText: "a\nA newer\nc\nB newer\ne\nnew\n",
			activeGroupId: "active",
			headConflictGroupId: "unassigned",
			mode: "observe",
			commitMapping: candidate.mapping,
		});
		expect(result.status).toBe("ok");
		expect(result.snapshot.units.map((unit) => unit.groupId)).toEqual(["active", "B", "active"]);
		expectCurrent(result.snapshot);
	});

	test("explicit commit mode without mapping never enables the external fallback", () => {
		const old = twoGroups();
		const result = rebaseTextOwnership(old, {
			baseText: "a\nexternal\nc\nd\ne\n",
			workText: old.workText,
			activeGroupId: "active",
			headConflictGroupId: "unassigned",
			mode: "commit",
		});
		expect(result.status).toBe("headConflict");
		expect(result.snapshot).toBe(old);
		const projected = rebaseTextOwnership(old, {
			baseText: `front\n${old.baseText}`,
			workText: `front\na\nA\nc\nB edited\ne\n`,
			activeGroupId: "active",
			headConflictGroupId: "unassigned",
			mode: "commit",
		});
		expect(projected.snapshot.units.map((unit) => unit.groupId)).toEqual(["A", "B"]);
		expectCurrent(projected.snapshot);
	});

	test("mapping preserves independently owned insertions at replacement boundaries", () => {
		for (const work of ["new\nA\nb\n", "A\nnew\nb\n"]) {
			const old = edit(create("a\nb\n", "A\nb\n"), work);
			for (const group of ["A", "B"]) {
				const candidate = prepareTextCommit(old, { groupIds: [group] });
				const result = rebaseTextOwnership(old, {
					baseText: candidate.text,
					workText: work,
					activeGroupId: "active",
					commitMapping: candidate.mapping,
				});
				expect(result.status).toBe("ok");
				expect(result.snapshot.units.map((unit) => unit.groupId)).toEqual([
					group === "A" ? "B" : "A",
				]);
				expectCurrent(result.snapshot);
			}
		}
	});

	test("mapping handles line count changes and a remaining zero-width deletion", () => {
		const old = edit(create("a\nb\nc\nd\n", "a\nx\ny\nb\nc\nd\n"), "a\nx\ny\nb\nd\n");
		const candidate = prepareTextCommit(old, { groupIds: ["A"] });
		const result = rebaseTextOwnership(old, {
			baseText: candidate.text,
			workText: old.workText,
			activeGroupId: "active",
			commitMapping: candidate.mapping,
		});
		expect(result.snapshot.units[0]).toMatchObject({
			groupId: "B",
			baseStart: 4,
			baseEnd: 5,
			workStart: 4,
			workEnd: 4,
		});
		expectCurrent(result.snapshot);
	});

	test("historical source flags remain unchanged while a validated projection becomes normalized", () => {
		const old = legacy();
		const encoded = JSON.stringify(old);
		const candidate = prepareTextCommit(old, { groupIds: ["A"] });
		const result = rebaseTextOwnership(old, {
			baseText: candidate.text,
			workText: old.workText,
			activeGroupId: "active",
			mode: "commit",
			commitMapping: candidate.mapping,
		});
		expect(result.status).toBe("ok");
		expect(result.snapshot.units[0]).toMatchObject({ id: old.units[1].id, groupId: "B" });
		expectCurrent(result.snapshot);
		expect(JSON.stringify(old)).toBe(encoded);
	});

	test("explicit provenance rejects illegal mappings even when an external target is supplied", () => {
		const old = twoGroups();
		const candidate = prepareTextCommit(old, { groupIds: ["A"] });
		for (const mapping of [
			{ ...candidate.mapping, fileId: "another" },
			{ ...candidate.mapping, baseText: "wrong" },
			{ ...candidate.mapping, workText: "wrong" },
			{ ...candidate.mapping, text: "wrong" },
			{ ...candidate.mapping, lineIds: [] },
			{ ...candidate.mapping, selectedUnitIds: [old.units[1].id] },
		]) {
			expectCode(
				() =>
					rebaseTextOwnership(old, {
						baseText: candidate.text,
						workText: old.workText,
						activeGroupId: "active",
						headConflictGroupId: "unassigned",
						commitMapping: mapping,
					}),
				"invalidCommitMapping",
			);
		}
		expectCode(
			() =>
				rebaseTextOwnership(old, {
					baseText: candidate.text,
					workText: old.workText,
					activeGroupId: "active",
					commitMapping: { ...candidate.mapping, selectedUnitIds: ["unknown"] },
				}),
			"unknownUnit",
		);
	});
});

describe("strict historical source validation", () => {
	const corruptions: [string, (snapshot: TextOwnershipSnapshot) => TextOwnershipSnapshot][] = [
		[
			"work line text",
			(snapshot) => ({
				...snapshot,
				workLines: snapshot.workLines.map((line, index) =>
					index === 1 ? { ...line, text: "WRONG\n" } : line,
				),
			}),
		],
		[
			"unit work range",
			(snapshot) => ({
				...snapshot,
				units: snapshot.units.map((unit, index) =>
					index === 0 ? { ...unit, workStart: 0, workEnd: 1 } : unit,
				),
			}),
		],
		[
			"inserted line unit identity",
			(snapshot) => ({
				...snapshot,
				workLines: snapshot.workLines.map((line, index) =>
					index === 1 ? { ...line, unitId: "wrong" } : line,
				),
			}),
		],
		[
			"retained line unit identity",
			(snapshot) => ({
				...snapshot,
				workLines: snapshot.workLines.map((line, index) =>
					index === 0 ? { ...line, unitId: snapshot.units[0].id } : line,
				),
			}),
		],
		[
			"inserted line baseline lineage",
			(snapshot) => ({
				...snapshot,
				workLines: snapshot.workLines.map((line, index) =>
					index === 1 ? { ...line, baseLineId: snapshot.baseLineIds[1] } : line,
				),
			}),
		],
		[
			"retained line baseline lineage",
			(snapshot) => ({
				...snapshot,
				workLines: snapshot.workLines.map((line, index) =>
					index === 0 ? { ...line, baseLineId: "wrong" } : line,
				),
			}),
		],
		[
			"retained line source identity",
			(snapshot) => ({
				...snapshot,
				workLines: snapshot.workLines.map((line, index) =>
					index === 0 ? { ...line, id: "wrong" } : line,
				),
			}),
		],
		[
			"duplicate baseline identities",
			(snapshot) => ({ ...snapshot, baseLineIds: snapshot.baseLineIds.map(() => "dup") }),
		],
		[
			"duplicate work identities",
			(snapshot) => ({
				...snapshot,
				workLines: snapshot.workLines.map((line, index) =>
					index === 1 ? { ...line, id: snapshot.workLines[0].id } : line,
				),
			}),
		],
		[
			"duplicate unit identities",
			(snapshot) => ({
				...snapshot,
				units: snapshot.units.map((unit) => ({ ...unit, id: snapshot.units[0].id })),
			}),
		],
		[
			"deleted line identities",
			(snapshot) => ({
				...snapshot,
				units: snapshot.units.map((unit, index) =>
					index === 0 ? { ...unit, deletedLineIds: [snapshot.baseLineIds[0]] } : unit,
				),
			}),
		],
		[
			"left anchor",
			(snapshot) => ({
				...snapshot,
				units: snapshot.units.map((unit, index) =>
					index === 0 ? { ...unit, leftAnchor: "wrong" } : unit,
				),
			}),
		],
		[
			"right anchor",
			(snapshot) => ({
				...snapshot,
				units: snapshot.units.map((unit, index) =>
					index === 0 ? { ...unit, rightAnchor: "wrong" } : unit,
				),
			}),
		],
	];
	for (const [name, corrupt] of corruptions) {
		test(`rejects corrupted ${name} before normalization, candidate synthesis or HEAD projection`, () => {
			const source = legacy();
			const mapping = prepareTextCommit(source, { groupIds: ["A"] }).mapping;
			const bad = corrupt(source);
			const encoded = JSON.stringify(bad);
			expectCode(() => normalizeTextOwnership(bad), "invalidSnapshot");
			expectCode(() => prepareTextCommit(bad, { groupIds: ["A"] }), "invalidSnapshot");
			expectCode(
				() => updateTextOwnership(bad, { workText: source.workText, activeGroupId: "active" }),
				"invalidSnapshot",
			);
			expectCode(
				() =>
					rebaseTextOwnership(bad, {
						baseText: mapping.text,
						workText: source.workText,
						activeGroupId: "active",
						mode: "commit",
						commitMapping: mapping,
					}),
				"invalidSnapshot",
			);
			expectCode(
				() =>
					rebaseTextOwnership(bad, {
						baseText: "a\nexternal\nc\nd\ne\n",
						workText: source.workText,
						activeGroupId: "active",
						headConflictGroupId: "unassigned",
					}),
				"invalidSnapshot",
			);
			expect(JSON.stringify(bad)).toBe(encoded);
		});
	}

	test("requires exact historical candidate line identities, not only their count or uniqueness", () => {
		const source = legacy();
		const encoded = JSON.stringify(source);
		const candidate = prepareTextCommit(source, { groupIds: ["A"] });
		for (const lineIds of [
			candidate.mapping.lineIds.map(() => "fake"),
			candidate.mapping.lineIds.map((_, index) => `unique-fake-${index}`),
			[...candidate.mapping.lineIds].reverse(),
			[
				...candidate.mapping.lineIds.slice(0, 1),
				source.baseLineIds[1],
				...candidate.mapping.lineIds.slice(2),
			],
		]) {
			expectCode(
				() =>
					rebaseTextOwnership(source, {
						baseText: candidate.text,
						workText: source.workText,
						activeGroupId: "active",
						headConflictGroupId: "unassigned",
						commitMapping: { ...candidate.mapping, lineIds },
					}),
				"invalidCommitMapping",
			);
		}
		expect(JSON.stringify(source)).toBe(encoded);
	});

	test("valid historical moved baseline identities and unselected owners remain projectable", () => {
		let snapshot = edit(create("a\nb\nc\nd\ne\n"), "a\nc\nb\nd\ne\n", "moved");
		snapshot = edit(snapshot, "a\nc\nb\nd\nE\n", "unselected");
		expect(snapshot.workLines[2].id).toBe(snapshot.baseLineIds[1]);
		expect(snapshot.workLines[2].baseLineId).toBeNull();
		const source = legacy(snapshot);
		const encoded = JSON.stringify(source);
		const normalized = normalizeTextOwnership(source);
		expect(normalized.baseLineIds).toBe(source.baseLineIds);
		expect(normalized.workLines).toBe(source.workLines);
		const candidate = prepareTextCommit(source, { groupIds: ["moved"] });
		const result = rebaseTextOwnership(source, {
			baseText: candidate.text,
			workText: source.workText,
			activeGroupId: "active",
			mode: "commit",
			commitMapping: JSON.parse(JSON.stringify(candidate.mapping)),
		});
		expect(result.status).toBe("ok");
		expect(result.snapshot.units.map((unit) => [unit.id, unit.groupId])).toEqual(
			source.units
				.filter((unit) => unit.groupId === "unselected")
				.map((unit) => [unit.id, unit.groupId]),
		);
		expectCurrent(result.snapshot);
		expect(JSON.stringify(source)).toBe(encoded);
	});
});

describe("historical moved-line candidate identity projection", () => {
	const base = "a\nb\nc\nd\ne\n";
	const works = ["a\nc\nd\nb\ne\n", "a\nd\nb\nc\ne\n"];

	function splitMove(workText: string) {
		const moved = edit(create(base), workText, "insert");
		const deletions = moved.units.filter((unit) => unit.insertedLines.length === 0);
		expect(deletions).toHaveLength(1);
		return legacy(
			moveTextUnits(moved, {
				unitIds: deletions.map((unit) => unit.id),
				targetGroupId: "delete",
			}),
		);
	}

	function publishedLegacyMove(workText: string, withOtherGroup = false): TextOwnershipSnapshot {
		const source = splitMove(workText);
		const candidate = prepareTextCommit(source, { groupIds: ["insert"] });
		let projected = rebaseTextOwnership(source, {
			baseText: candidate.text,
			workText,
			activeGroupId: "active",
			mode: "commit",
			commitMapping: candidate.mapping,
		}).snapshot;
		if (withOtherGroup) projected = edit(projected, workText.replace("e\n", "E\n"), "other");
		const ids = candidate.mapping.lineIds;
		const legacyIds = new Map(projected.baseLineIds.map((id, index) => [id, ids[index]]));
		// Reproduce the already-published v1 projection, before duplicate candidate IDs
		// were disambiguated for a new baseline. Remaining changes keep their old IDs.
		return legacy({
			...projected,
			baseLineIds: ids,
			units: projected.units.map((unit) => ({
				...unit,
				deletedLineIds: ids.slice(unit.baseStart, unit.baseEnd),
				leftAnchor: ids[unit.baseStart - 1] ?? null,
				rightAnchor: ids[unit.baseEnd] ?? null,
			})),
			workLines: projected.workLines.map((line) =>
				line.baseLineId === null
					? line
					: {
							...line,
							id: legacyIds.get(line.baseLineId) as string,
							baseLineId: legacyIds.get(line.baseLineId) as string,
						},
			),
		});
	}

	for (const workText of works) {
		for (const first of ["insert", "delete"]) {
			test(`projects the moved-line historical candidate and then its remaining group: ${first}, ${JSON.stringify(workText)}`, () => {
				const source = splitMove(workText);
				const encoded = JSON.stringify(source);
				const candidate = prepareTextCommit(source, { groupIds: [first] });
				const evidence = JSON.stringify(candidate.mapping);
				if (first === "insert")
					expect(new Set(candidate.mapping.lineIds).size).toBeLessThan(
						candidate.mapping.lineIds.length,
					);
				const result = rebaseTextOwnership(source, {
					baseText: candidate.text,
					workText,
					activeGroupId: "active",
					mode: "commit",
					commitMapping: JSON.parse(evidence),
				});
				expect(result.status).toBe("ok");
				const remaining = first === "insert" ? "delete" : "insert";
				expect(result.snapshot.units.map((unit) => [unit.id, unit.groupId])).toEqual(
					source.units
						.filter((unit) => unit.groupId === remaining)
						.map((unit) => [unit.id, unit.groupId]),
				);
				expect(normalizeTextOwnership(result.snapshot)).toBe(result.snapshot);
				expectCurrent(result.snapshot);
				const second = prepareTextCommit(result.snapshot, { groupIds: [remaining] });
				const finished = rebaseTextOwnership(result.snapshot, {
					baseText: second.text,
					workText,
					activeGroupId: "active",
					mode: "commit",
					commitMapping: second.mapping,
				});
				expect(finished.status).toBe("ok");
				expect(finished.snapshot.units).toEqual([]);
				expect(finished.snapshot.baseText).toBe(workText);
				expect(normalizeTextOwnership(finished.snapshot)).toBe(finished.snapshot);
				expectCurrent(finished.snapshot);
				expect(JSON.stringify(source)).toBe(encoded);
				expect(JSON.stringify(candidate.mapping)).toBe(evidence);
			});
		}
	}

	for (const workText of works) {
		test(`normalizes an already-published v1 alias snapshot without replacing historical identities: ${JSON.stringify(workText)}`, () => {
			const source = publishedLegacyMove(workText);
			const encoded = JSON.stringify(source);
			expect(new Set(source.baseLineIds).size).toBeLessThan(source.baseLineIds.length);
			const normalized = normalizeTextOwnership(source);
			expect(normalized.baseLineIds).toBe(source.baseLineIds);
			expect(normalized.workLines).toBe(source.workLines);
			expect(normalized.units.map((unit) => [unit.id, unit.groupId])).toEqual(
				source.units.map((unit) => [unit.id, unit.groupId]),
			);
			expectCurrent(normalized, true);
			expect(normalizeTextOwnership(normalized)).toBe(normalized);
			const refreshed = updateTextOwnership(source, {
				workText: source.workText,
				activeGroupId: "another",
			});
			expect(refreshed.baseLineIds).toBe(source.baseLineIds);
			expect(refreshed.workLines).toBe(source.workLines);
			expectCurrent(refreshed, true);
			expect(JSON.stringify(source)).toBe(encoded);
		});

		test(`projects edits and the remaining commit from an already-published v1 alias snapshot: ${JSON.stringify(workText)}`, () => {
			const source = publishedLegacyMove(workText);
			const encoded = JSON.stringify(source);
			const work = workText.replace("e\n", "E\n");
			const edited = updateTextOwnership(source, { workText: work, activeGroupId: "new-edit" });
			expect(normalizeTextOwnership(edited)).toBe(edited);
			expectCurrent(edited);
			expect(edited.units.find((unit) => unit.id === source.units[0].id)?.groupId).toBe("delete");
			for (const line of source.workLines.slice(0, -1))
				expect(edited.workLines.find((current) => current.text === line.text)?.id).toBe(line.id);
			const candidate = prepareTextCommit(source, { groupIds: ["delete"] });
			const evidence = JSON.stringify(candidate.mapping);
			const result = rebaseTextOwnership(source, {
				baseText: candidate.text,
				workText: work,
				activeGroupId: "new-edit",
				mode: "commit",
				commitMapping: JSON.parse(evidence),
			});
			expect(result.status).toBe("ok");
			expect(result.snapshot.units.map((unit) => unit.groupId)).toEqual(["new-edit"]);
			expect(normalizeTextOwnership(result.snapshot)).toBe(result.snapshot);
			expectCurrent(result.snapshot);
			expect(JSON.stringify(source)).toBe(encoded);
			expect(JSON.stringify(candidate.mapping)).toBe(evidence);
		});

		for (const withOtherGroup of [false, true]) {
			test(`restores a published v1 alias deletion with distinct work identities and remaining owners: ${withOtherGroup}, ${JSON.stringify(workText)}`, () => {
				const source = publishedLegacyMove(workText, withOtherGroup);
				const encoded = JSON.stringify(source);
				const alias = source.baseLineIds.find(
					(id, index) => source.baseLineIds.indexOf(id) !== index,
				) as string;
				const visibleIndex = source.baseLineIds.findIndex(
					(id, index) =>
						id === alias &&
						!source.units.some((unit) => unit.baseStart <= index && index < unit.baseEnd),
				);
				const hiddenIndex = source.units.find((unit) => unit.groupId === "delete")
					?.baseStart as number;
				const restoredWork = withOtherGroup
					? source.baseText.replace("e\n", "E\n")
					: source.baseText;
				const restored = updateTextOwnership(source, {
					workText: restoredWork,
					activeGroupId: "restore",
				});
				expectCurrent(restored);
				expect(normalizeTextOwnership(restored)).toBe(restored);
				expect(restored.workText).toBe(restoredWork);
				expect(restored.workLines[visibleIndex].id).toBe(alias);
				expect(restored.workLines[hiddenIndex].id).not.toBe(alias);
				expect(restored.workLines[hiddenIndex].baseLineId).toBe(restored.baseLineIds[hiddenIndex]);
				expect(restored.units.map((unit) => [unit.id, unit.groupId])).toEqual(
					source.units
						.filter((unit) => unit.groupId === "other")
						.map((unit) => [unit.id, unit.groupId]),
				);
				if (withOtherGroup) expect(restored.workLines.at(-1)?.id).toBe(source.workLines.at(-1)?.id);
				const candidate = prepareTextCommit(restored, {
					groupIds: withOtherGroup ? ["other"] : [],
				});
				const projected = rebaseTextOwnership(restored, {
					baseText: candidate.text,
					workText: restoredWork,
					activeGroupId: "active",
					mode: "commit",
					commitMapping: candidate.mapping,
				});
				expect(projected.status).toBe("ok");
				expect(projected.snapshot.units).toEqual([]);
				expectCurrent(projected.snapshot);
				expect(JSON.stringify(source)).toBe(encoded);
			});
		}

		test(`rejects corrupted text, coverage and work identity in a published v1 alias snapshot: ${JSON.stringify(workText)}`, () => {
			const source = publishedLegacyMove(workText);
			const candidate = prepareTextCommit(source, { groupIds: ["delete"] });
			const alias = source.baseLineIds.find(
				(id, index) => source.baseLineIds.indexOf(id) !== index,
			);
			const aliasWorkIndex = source.workLines.findIndex((line) => line.id === alias);
			const hiddenIndex = source.units[0].baseStart;
			for (const bad of [
				{
					...source,
					baseText: splitOwnershipLines(source.baseText)
						.map((line, index) => (index === hiddenIndex ? "different alias text\n" : line))
						.join(""),
				},
				{ ...source, baseText: source.baseText.replace("b\n", "wrong\n") },
				{
					...source,
					units: source.units.map((unit) => ({ ...unit, baseStart: unit.baseStart + 1 })),
				},
				{ ...source, units: source.units.map((unit) => ({ ...unit, deletedLineIds: ["wrong"] })) },
				{ ...source, units: source.units.map((unit) => ({ ...unit, leftAnchor: "wrong" })) },
				{
					...source,
					workLines: source.workLines.map((line, index) =>
						index === aliasWorkIndex ? { ...line, unitId: source.units[0].id } : line,
					),
				},
				{
					...source,
					workLines: source.workLines.map((line, index) =>
						index === aliasWorkIndex ? { ...line, id: source.workLines[0].id } : line,
					),
				},
			]) {
				expectCode(() => normalizeTextOwnership(bad), "invalidSnapshot");
				expectCode(
					() =>
						rebaseTextOwnership(bad, {
							baseText: candidate.text,
							workText,
							activeGroupId: "active",
							mode: "commit",
							commitMapping: candidate.mapping,
						}),
					"invalidSnapshot",
				);
			}
			expectCode(
				() =>
					rebaseTextOwnership(source, {
						baseText: candidate.text,
						workText,
						activeGroupId: "active",
						mode: "commit",
						commitMapping: {
							...candidate.mapping,
							lineIds: candidate.mapping.lineIds.map(() => "fake"),
						},
					}),
				"invalidCommitMapping",
			);
		});
	}

	test("repairing an edited legacy alias shares its original normalization deadline", () => {
		const source = publishedLegacyMove(works[0]);
		const encoded = JSON.stringify(source);
		const input = { workText: source.workText, activeGroupId: "active", limits: { timeoutMs: 50 } };
		const clock = spyOn(performance, "now").mockReturnValue(0);
		try {
			expect(updateTextOwnership(source, input).baseLineIds).toBe(source.baseLineIds);
			const originalReads = clock.mock.calls.length;
			let reads = 0;
			clock.mockImplementation(() => {
				reads++;
				return reads <= originalReads ? 0 : reads === originalReads + 1 ? 49 : 51;
			});
			expectCode(
				() => updateTextOwnership(source, { ...input, workText: source.baseText }),
				"diffBudgetExceeded",
			);
			expect(reads).toBeGreaterThan(originalReads);
		} finally {
			clock.mockRestore();
		}
		expect(JSON.stringify(source)).toBe(encoded);
	});

	test("external exact absorption also projects distinct baseline identities for moved copies", () => {
		for (const workText of works) {
			const source = splitMove(workText);
			const encoded = JSON.stringify(source);
			const head = materializeTextOwnership(source, { groupIds: ["insert"] });
			const result = rebaseTextOwnership(source, {
				baseText: head,
				workText,
				activeGroupId: "active",
				headConflictGroupId: "unassigned",
			});
			expect(result.status).toBe("ok");
			expect("headRebuilt" in result).toBe(false);
			expect(result.snapshot.units.map((unit) => [unit.id, unit.groupId])).toEqual(
				source.units
					.filter((unit) => unit.groupId === "delete")
					.map((unit) => [unit.id, unit.groupId]),
			);
			expect(normalizeTextOwnership(result.snapshot)).toBe(result.snapshot);
			expectCurrent(result.snapshot);
			expect(JSON.stringify(source)).toBe(encoded);
		}
	});
});

describe("bounded synthesis properties", () => {
	test("byte and line limits reject observations without modifying old evidence", () => {
		const old = twoGroups();
		const encoded = JSON.stringify(old);
		for (const maxBytes of [Number.NaN, Number.POSITIVE_INFINITY, 10 * 1024 * 1024]) {
			expectCode(
				() =>
					createTextOwnership({
						fileId: "f",
						baseText: "",
						workText: "x".repeat(2 * 1024 * 1024 + 1),
						activeGroupId: "A",
						limits: { maxBytes },
					}),
				"textTooLarge",
			);
		}
		expectCode(
			() =>
				updateTextOwnership(old, { workText: "x".repeat(2 * 1024 * 1024 + 1), activeGroupId: "C" }),
			"textTooLarge",
		);
		expectCode(
			() => updateTextOwnership(old, { workText: "x\n".repeat(100_001), activeGroupId: "C" }),
			"tooManyLines",
		);
		expectCode(
			() =>
				createTextOwnership({
					fileId: "f",
					baseText: "",
					workText: "中中",
					activeGroupId: "A",
					limits: { maxBytes: 5 },
				}),
			"textTooLarge",
		);
		expect(JSON.stringify(old)).toBe(encoded);
	});

	test("timeout and exact edit-length limits never yield partial fallback snapshots", () => {
		const old = twoGroups();
		expectCode(
			() =>
				updateTextOwnership(old, {
					workText: "changed",
					activeGroupId: "C",
					limits: { timeoutMs: 0 },
				}),
			"diffBudgetExceeded",
		);
		expectCode(() => normalizeTextOwnership(legacy(old), { timeoutMs: 0 }), "diffBudgetExceeded");
		expectCode(
			() =>
				createTextOwnership({
					fileId: "f",
					baseText: "a\nb\nc\n",
					workText: "x\ny\nz\n",
					activeGroupId: "A",
					limits: { maxEditLength: 1 },
				}),
			"diffBudgetExceeded",
		);
		const input = {
			baseText: "a\nexternal\nc\nd\ne\n",
			workText: old.workText,
			activeGroupId: "active",
			headConflictGroupId: "unassigned",
		};
		for (const { limits, code } of [
			{ limits: { maxBytes: 2 }, code: "textTooLarge" as const },
			{ limits: { maxLines: 2 }, code: "tooManyLines" as const },
			{ limits: { maxEditLength: 2 }, code: "diffBudgetExceeded" as const },
		]) {
			expectCode(() => rebaseTextOwnership(old, { ...input, limits }), code);
		}
	});

	test("file fallback shares the original deadline rather than starting a fresh budget", () => {
		const old = twoGroups();
		const encoded = JSON.stringify(old);
		const input = {
			baseText: "a\nexternal\nc\nd\ne\n",
			workText: old.workText,
			activeGroupId: "active",
			limits: { timeoutMs: 50 },
		};
		const clock = spyOn(performance, "now").mockReturnValue(0);
		try {
			expect(rebaseTextOwnership(old, input).status).toBe("headConflict");
			const strictReads = clock.mock.calls.length;
			let reads = 0;
			clock.mockImplementation(() => {
				reads++;
				return reads <= strictReads ? 0 : reads === strictReads + 1 ? 49 : 51;
			});
			expectCode(
				() => rebaseTextOwnership(old, { ...input, headConflictGroupId: "unassigned" }),
				"diffBudgetExceeded",
			);
			expect(reads).toBeGreaterThan(strictReads);
		} finally {
			clock.mockRestore();
		}
		expect(JSON.stringify(old)).toBe(encoded);
	});

	test("a sparse edit in a 100,000-line file stays exact and bounded", () => {
		const lines = Array.from({ length: 100_000 }, (_, i) => `${i}\n`);
		const base = lines.join("");
		lines[50_000] = "changed\n";
		const started = performance.now();
		const snapshot = create(base, lines.join(""));
		expect(snapshot.units).toHaveLength(1);
		expect(materializeTextOwnership(snapshot)).toBe(lines.join(""));
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	test("committing arbitrary groups preserves every unselected unit across repeated projection", () => {
		let random = 78;
		const next = (max: number) => {
			random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
			return random % max;
		};
		for (let round = 0; round < 20; round++) {
			const lines = Array.from({ length: 10 }, (_, i) => `base-${i}\n`);
			let snapshot = create(lines.join(""));
			for (let step = 0; step < 12; step++) {
				const at = next(lines.length + 1);
				lines.splice(
					at,
					Math.min(next(3), lines.length - at),
					...Array.from({ length: next(3) }, (_, i) => `${round}-${step}-${i}\n`),
				);
				snapshot = edit(snapshot, lines.join(""), `group-${step % 3}`);
			}
			for (const group of [...new Set(snapshot.units.map((unit) => unit.groupId))]) {
				const candidate = prepareTextCommit(snapshot, { groupIds: [group] });
				const remaining = snapshot.units
					.filter((unit) => unit.groupId !== group)
					.map((unit) => unit.id);
				const result = rebaseTextOwnership(snapshot, {
					baseText: candidate.text,
					workText: lines.join(""),
					activeGroupId: "active",
					commitMapping: candidate.mapping,
				});
				expect(result.status).toBe("ok");
				expect(result.snapshot.units.map((unit) => unit.id)).toEqual(remaining);
				expectCurrent(result.snapshot);
				snapshot = result.snapshot;
			}
			expect(snapshot.units).toHaveLength(0);
			expect(snapshot.baseText).toBe(lines.join(""));
		}
	});

	test("deterministic edit sequences always synthesize current bytes and move independently", () => {
		let random = 123456789;
		const next = (max: number) => {
			random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
			return random % max;
		};
		for (let round = 0; round < 30; round++) {
			const base = Array.from({ length: 15 }, (_, i) => `base-${i}\n`);
			const current = [...base];
			let snapshot = create(base.join(""));
			for (let step = 0; step < 20; step++) {
				const at = next(current.length + 1);
				current.splice(
					at,
					Math.min(next(4), current.length - at),
					...Array.from({ length: next(4) }, (_, i) => `new-${round}-${step}-${i}\n`),
				);
				snapshot = edit(snapshot, current.join(""), ["A", "B", "C"][step % 3]);
				if (snapshot.units.length) {
					snapshot = moveTextUnits(snapshot, {
						unitIds: [snapshot.units[next(snapshot.units.length)].id],
						targetGroupId: "D",
					});
					expectCurrent(snapshot);
				}
			}
			snapshot = edit(snapshot, base.join(""));
			expect(snapshot.units).toHaveLength(0);
		}
	});
});
