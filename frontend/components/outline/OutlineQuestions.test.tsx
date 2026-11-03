/**
 * The questions form (P2 PR 7), rendered from a group as the API returns it: each open question
 * put to the viewer starts on the asker's recommendation, sub-questions sit under their question,
 * a question put to someone else is read-only, an answered one shows its answer, and the side
 * panel shows nothing for a block without questions.
 */
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
	test("starts on the recommendations, nests sub-questions, and shows what others decide", () => {
		const doc = render(<OutlineQuestionsForm blockId="task" showOpenLink={false} />, group);
		const card = (id: string) => doc.querySelector(`[data-testid=outline-question-${id}]`);
		// The recommended option is chosen.
		const checked = card("1")?.querySelector("input[type=radio][checked]");
		expect(checked?.getAttribute("value")).toBe("2");
		expect(card("1")?.textContent).toContain("Recommended: v2 (most exports are v2)");
		// A sub-question without options: words, the recommendation as the placeholder.
		expect(card("2")?.querySelector("textarea")?.getAttribute("placeholder")).toBe("skip");
		// Someone else's question is read-only; an answered one shows the answer.
		expect(card("3")?.querySelector("input, textarea")).toBeNull();
		expect(card("3")?.textContent).toContain("Waiting for bob to answer");
		expect(card("4")?.getAttribute("data-state")).toBe("answered");
		expect(card("4")?.textContent).toContain("alice answered in the conversation: v1");
		// Adopting takes every answerable question with a recommendation.
		expect(doc.querySelector("[data-testid=outline-questions-adopt-all]")?.textContent).toContain(
			"(2)",
		);
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

	test("the asking session is named only to a viewer who may read it (review B2)", () => {
		const shown = render(<OutlineQuestionsForm blockId="task" showOpenLink={false} />, group);
		expect(shown.querySelector("[data-testid=outline-question-1]")?.textContent).toContain(
			"asked by Worker",
		);
		const hidden = render(<OutlineQuestionsForm blockId="task" showOpenLink={false} />, {
			...group,
			questions: [question("1", { askedBy: { narratorId: null, title: null, hidden: true } })],
		});
		const text = hidden.querySelector("[data-testid=outline-question-1]")?.textContent ?? "";
		expect(text).toContain("asked by a session you cannot open");
		expect(text).not.toContain("Worker");
	});

	test("the side panel shows questions under the focused block, and nothing without any", () => {
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
