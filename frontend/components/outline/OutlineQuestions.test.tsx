/** Shared question form: explicit answers, no adoption shortcut, and concise read-only results. */
import { describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type {
	OutlineBlockViewResponse,
	OutlineQuestionGroupResponse,
	OutlineQuestionView,
} from "@shared/outline-api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { outlineKeys } from "../../hooks/useOutline";
import outlineEn from "../../locales/en/outline.json";
import { OutlineQuestionsForm, OutlineQuestionsSection } from "./OutlineQuestions";
import { outlineAnswerInput } from "./outline-answer-draft";

const i18n = createInstance();
await i18n.init({
	lng: "en",
	resources: { en: { outline: outlineEn } },
	interpolation: { escapeValue: false },
});

function question(id: string, extra: Partial<OutlineQuestionView> = {}): OutlineQuestionView {
	return {
		blockId: id,
		spaceId: "space",
		sid: `s${id}`,
		address: `key/s${id}`,
		parentId: "task",
		alias: `Q${id}`,
		text: `Question ${id}?`,
		options: ["v1", "v2"],
		recommend: { option: 2, text: null, reason: "most exports are v2" },
		proceed: false,
		state: "open",
		to: { userId: "alice", name: "alice" },
		answer: null,
		askedBy: { narratorId: "n1", title: "Worker", hidden: false },
		createdAt: "2026-11-03T00:00:00.000Z",
		canAnswer: true,
		versionSeq: 3,
		...extra,
	};
}

const group: OutlineQuestionGroupResponse = {
	group: {
		blockId: "task",
		spaceId: "space",
		spaceKey: "key",
		pageId: "page",
		title: "Ship the importer",
		isQuestion: false,
	},
	questions: [
		question("1"),
		question("2", {
			parentId: "1",
			options: [],
			recommend: { option: null, text: "skip", reason: null },
		}),
		question("3", { to: { userId: "bob", name: "bob" }, canAnswer: false }),
		question("4", {
			state: "answered",
			canAnswer: false,
			answer: {
				option: 1,
				text: null,
				adopted: false,
				by: { userId: "alice", name: "alice" },
				at: "2026-11-03T01:00:00.000Z",
				relayed: true,
				relayedVia: null,
			},
		}),
	],
	truncated: false,
};

function render(node: ReactNode, data: OutlineQuestionGroupResponse | null): Document {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	if (data) client.setQueryData(outlineKeys.questions("task"), data);
	const html = renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<I18nextProvider i18n={i18n}>
				<MantineProvider>{node}</MantineProvider>
			</I18nextProvider>
		</QueryClientProvider>,
	);
	return parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;
}

describe("the questions form", () => {
	test("starts empty, keeps one submit action, and shows read-only answers", () => {
		const doc = render(<OutlineQuestionsForm blockId="task" showOpenLink={false} />, group);
		const card = (id: string) => doc.querySelector(`[data-testid=outline-question-${id}]`);
		expect(card("1")?.querySelector("input[type=radio][checked]")).toBeNull();
		expect(card("1")?.textContent).toContain("v2 (recommended)");
		expect(card("1")?.textContent).toContain("most exports are v2");
		expect(card("1")?.textContent).not.toContain("Recommended: v2");
		expect(card("2")?.querySelector("textarea")?.getAttribute("placeholder")).toBe("Your answer");
		expect(card("3")?.querySelector("input, textarea")).toBeNull();
		expect(card("3")?.textContent).toContain("Waiting for bob to answer");
		expect(card("4")?.textContent).toContain("alice answered in the conversation: v1");
		expect(doc.querySelector("[data-testid=outline-questions-adopt-all]")).toBeNull();
		expect(doc.querySelectorAll("button")).toHaveLength(1);
		expect(
			doc.querySelector("[data-testid=outline-questions-submit]")?.hasAttribute("disabled"),
		).toBe(true);
	});

	test("an answer relayed from a gateway says through which door it came (review N-1)", () => {
		const answered = group.questions[3] as OutlineQuestionView;
		const doc = render(<OutlineQuestionsForm blockId="task" showOpenLink={false} />, {
			...group,
			questions: [
				{
					...answered,
					answer: {
						...(answered.answer as NonNullable<OutlineQuestionView["answer"]>),
						relayedVia: "gateway:Telegram @im_stranger",
					},
				},
			],
		});
		expect(doc.querySelector("[data-testid=outline-question-4]")?.textContent).toContain(
			"alice answered in the conversation (via Telegram @im_stranger): v1",
		);
	});

	test("does not repeat source metadata or expose a hidden session", () => {
		const shown = render(<OutlineQuestionsForm blockId="task" showOpenLink={false} />, group);
		expect(shown.body.textContent).not.toContain("asked by Worker");
		const hidden = render(<OutlineQuestionsForm blockId="task" showOpenLink={false} />, {
			...group,
			questions: [question("1", { askedBy: { narratorId: null, title: null, hidden: true } })],
		});
		expect(hidden.body.textContent).not.toContain("Worker");
		expect(hidden.body.textContent).not.toContain("asked by a session you cannot open");
	});

	test("the body section shows questions under the focused block, and nothing without any", () => {
		const view = {
			rootId: "task",
			current: true,
			blocks: [{ id: "task", childIds: ["1"], openTasks: 1, question: null }],
		} as unknown as OutlineBlockViewResponse;
		const shown = render(<OutlineQuestionsSection view={view} />, group);
		expect(shown.querySelector("[data-testid=outline-questions-section]")).not.toBeNull();
		const empty = render(<OutlineQuestionsSection view={view} />, { ...group, questions: [] });
		expect(empty.querySelector("[data-testid=outline-questions-section]")).toBeNull();
	});
});

describe("explicit answer semantics", () => {
	test("an empty draft never adopts the recommendation", () => {
		expect(outlineAnswerInput(question("1"), { option: null, text: "  " })).toBeNull();
	});
	test("submits an explicitly selected option", () => {
		expect(outlineAnswerInput(question("1"), { option: 2, text: "" })).toEqual({
			blockId: "1",
			versionSeq: 3,
			option: 2,
		});
	});
	test("authored text replaces a previously selected recommendation", () => {
		const text = "不要按建议执行。\n".repeat(300);
		expect(outlineAnswerInput(question("1"), { option: 2, text })).toEqual({
			blockId: "1",
			versionSeq: 3,
			text: text.trim(),
		});
	});
	test("background refresh never upgrades the version of an existing draft", () => {
		expect(
			outlineAnswerInput(question("1", { versionSeq: 9 }), { option: 2, text: "", versionSeq: 3 }),
		).toEqual({ blockId: "1", versionSeq: 3, option: 2 });
		expect(
			outlineAnswerInput(question("1", { versionSeq: 9 }), {
				option: null,
				text: "old question's answer",
				versionSeq: 3,
			}),
		).toEqual({ blockId: "1", versionSeq: 3, text: "old question's answer" });
	});
	test("invalid choices are not silently submitted", () => {
		expect(outlineAnswerInput(question("1"), { option: 3, text: "" })).toBeNull();
	});
	test("read-only forms never expose answer controls", () => {
		const doc = render(
			<OutlineQuestionsForm blockId="task" showOpenLink={false} readOnly />,
			group,
		);
		expect(doc.querySelector("input, textarea, button")).toBeNull();
	});
	test("a card's whitelist excludes other questions under the same task", () => {
		const doc = render(
			<OutlineQuestionsForm blockId="task" showOpenLink={false} questionIds={["1", "2"]} />,
			group,
		);
		expect(doc.querySelectorAll("[data-state]")).toHaveLength(2);
		expect(doc.body.textContent).not.toContain("Question 3");
	});
	test("historical outline views never show a live form", () => {
		const view = {
			rootId: "task",
			current: false,
			blocks: [{ id: "task", childIds: ["1"], openTasks: 1, question: null }],
		} as unknown as OutlineBlockViewResponse;
		const doc = render(<OutlineQuestionsSection view={view} />, group);
		expect(doc.querySelector("[data-testid=outline-questions-section]")).toBeNull();
	});
});
