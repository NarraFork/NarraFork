import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import type { ScheduledTask } from "../../lib/api/scheduled-tasks";
import en from "../../locales/en/scheduledTasks.json";
import { runFixture, taskFixture } from "./scheduled-task.fixtures";

const calls: Array<{ action: string; value: unknown }> = [];
let detail: { data?: ScheduledTask; isSuccess: boolean } = { isSuccess: false };
let pages = [{ runs: [runFixture()], nextCursor: "opaque_cursor" }];
let runError: Error | null = null;
let loadCalls = 0;
let guarded = false;
let saveFailure: Error | null = null;
let previewFailure: Error | null = null;
const saveMutation = (action: string) => ({
	isPending: false,
	mutateAsync: async (value: unknown) => {
		calls.push({ action, value });
		if (saveFailure) throw saveFailure;
		return taskFixture();
	},
});
const mutation = (action: string) => ({
	isPending: false,
	error: null,
	mutate: (value: unknown) => calls.push({ action, value }),
});
mock.module("../../hooks/useScheduledTasks", () => ({
	useScheduledTask: () => detail,
	useScheduledTaskRuns: () => ({
		data: { pages },
		isPending: false,
		error: runError,
		hasNextPage: pages.at(-1)?.nextCursor != null,
		isFetchingNextPage: false,
		fetchNextPage: () => {
			loadCalls++;
		},
		refetch: () => {},
	}),
	useToggleScheduledTask: () => mutation("toggle"),
	useRunScheduledTask: () => mutation("run"),
	useCleanupScheduledTask: () => mutation("cleanup"),
	useDeleteScheduledTask: () => mutation("delete"),
	useCreateScheduledTask: () => saveMutation("create"),
	useUpdateScheduledTask: () => saveMutation("update"),
	useSchedulePreview: () => ({ error: previewFailure, isFetching: false, debouncing: false }),
}));
mock.module("../../hooks/useModels", () => ({ useAllModels: () => ({ groupedModels: [] }) }));
mock.module("../common/DirectoryPicker", () => ({ DirectoryPicker: () => null }));
mock.module("../knowledge/editor/useUnsavedChangesGuard", () => ({
	useUnsavedChangesGuard: (active: boolean) => {
		guarded = active;
		return { status: "idle" };
	},
}));
mock.module("../../hooks/useProjects", () => ({
	useProjects: () => ({ data: [], isError: false }),
}));
const { TaskActions } = await import("./TaskActions");
const { TaskConfigSummary } = await import("./TaskConfigSummary");
const { TaskRunHistory } = await import("./TaskRunHistory");
const { ManagedTaskBanner } = await import("./ManagedTaskBanner");
const { RunVerdictBadge, RunAxes, TaskLifecycleBadge } = await import("./TaskStatus");
const { ScheduleTimeInputs } = await import("./ScheduleTimeInputs");
const { TaskFilters } = await import("./TaskFilters");
const { TaskForm } = await import("./TaskForm");
const i18n = createInstance();
await i18n.init({
	lng: "en",
	resources: { en: { scheduledTasks: en } },
	defaultNS: "scheduledTasks",
});

let root: Root | null = null;
let container: HTMLElement;
let client: QueryClient;
const globals = new Map<string, PropertyDescriptor | undefined>();
const inputDescriptors = new Map<string, PropertyDescriptor | undefined>();
let inputPrototype: object;
function install(key: string, value: unknown) {
	globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}
beforeEach(() => {
	calls.length = 0;
	detail = { isSuccess: false };
	pages = [{ runs: [runFixture()], nextCursor: "opaque_cursor" }];
	runError = null;
	loadCalls = 0;
	guarded = false;
	saveFailure = null;
	previewFailure = null;
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	Object.defineProperty(window, "getComputedStyle", {
		value: () => ({ getPropertyValue: () => "", overflow: "visible" }),
		configurable: true,
	});
	install("window", window);
	install("document", window.document);
	install("navigator", window.navigator);
	install("HTMLElement", window.HTMLElement);
	install("HTMLInputElement", window.HTMLInputElement);
	inputPrototype = window.HTMLInputElement.prototype;
	for (const name of ["attachEvent", "detachEvent"]) {
		inputDescriptors.set(name, Object.getOwnPropertyDescriptor(inputPrototype, name));
		Object.defineProperty(inputPrototype, name, { configurable: true, value: () => {} });
	}
	install("Element", window.Element);
	install("Node", window.Node);
	install("ShadowRoot", window.ShadowRoot);
	install("Document", window.Document);
	install("getComputedStyle", window.getComputedStyle);
	install("IS_REACT_ACT_ENVIRONMENT", true);
	install(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	install(
		"MutationObserver",
		class {
			observe() {}
			disconnect() {}
			takeRecords() {
				return [];
			}
		},
	);
	install("requestAnimationFrame", (callback: (time: number) => void) =>
		setTimeout(() => callback(Date.now()), 0),
	);
	install("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
	install("matchMedia", () => ({
		matches: false,
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
	}));
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	container = window.document.createElement("div") as unknown as HTMLElement;
	window.document.body.appendChild(container);
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	container.remove();
	client.clear();
	for (const [key, descriptor] of inputDescriptors) {
		if (descriptor) Object.defineProperty(inputPrototype, key, descriptor);
		else Reflect.deleteProperty(inputPrototype, key);
	}
	inputDescriptors.clear();
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});
afterAll(() => mock.restore());
async function render(node: ReactNode) {
	root ??= createRoot(container);
	await act(async () =>
		root?.render(
			<MantineProvider>
				<QueryClientProvider client={client}>
					<I18nextProvider i18n={i18n}>{node}</I18nextProvider>
				</QueryClientProvider>
			</MantineProvider>,
		),
	);
}
async function clickText(text: string) {
	const button = [...container.querySelectorAll("button")].find(
		(element) => element.textContent === text,
	);
	expect(button).toBeDefined();
	await act(async () => button?.click());
}
async function fillName(value: string) {
	const field = container.querySelector<HTMLInputElement>('input[maxlength="200"]');
	if (!field) throw new Error("Name input not rendered");
	field.type = "text";
	await act(async () => field.dispatchEvent(new window.Event("focusin", { bubbles: true })));
	await act(async () => {
		Object.getOwnPropertyDescriptor(inputPrototype, "value")?.set?.call(field, value);
		field.dispatchEvent(new window.Event("input", { bubbles: true }));
		field.dispatchEvent(new window.Event("keyup", { bubbles: true }));
	});
}
async function submitForm() {
	await act(async () =>
		container
			.querySelector("form")
			?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
	);
}
const readOnly = {
	canEdit: false,
	canPause: false,
	canRun: false,
	canDelete: false,
	canSeePrompt: false,
};

describe("capability-gated task UI", () => {
	test("read-only observer has no mutations and no private instructions even if stale data includes them", async () => {
		const task = taskFixture({ capabilities: readOnly });
		await render(
			<>
				<TaskActions task={task} onEdit={() => {}} onCopy={() => {}} />
				<TaskConfigSummary task={task} />
			</>,
		);
		expect(container.textContent).not.toContain("Private instructions");
		expect(container.textContent).not.toContain("Private system prompt");
		expect(container.textContent).toContain(en.promptRestricted);
		expect(container.querySelectorAll("button")).toHaveLength(0);
		expect(calls).toEqual([]);
	});
	test("a pause-only capability does not grant editing or running", async () => {
		await render(
			<TaskActions
				task={taskFixture({ capabilities: { ...readOnly, canPause: true } })}
				onEdit={() => {}}
				onCopy={() => {}}
			/>,
		);
		expect(container.textContent).toContain("Pause");
		expect(container.textContent).not.toContain("Run now");
		expect(container.textContent).not.toContain("Edit");
		await clickText("Pause");
		expect(calls).toEqual([{ action: "toggle", value: { id: "task_1", enabled: false } }]);
	});
	test("ended schedules cannot resume but authorized manual runs remain available", async () => {
		await render(
			<TaskActions
				task={taskFixture({ lifecycle: "ended", enabled: false })}
				onEdit={() => {}}
				onCopy={() => {}}
			/>,
		);
		expect(container.textContent).not.toContain("Resume");
		await clickText("Run now");
		expect(calls).toEqual([{ action: "run", value: "task_1" }]);
	});
	test("ended and completed without a report are not shown as success", async () => {
		await render(
			<>
				<TaskLifecycleBadge lifecycle="ended" />
				<RunVerdictBadge status="completed" outcome={null} />
				<RunAxes status="completed" outcome={null} />
			</>,
		);
		expect(container.textContent).toContain(en.verdict.unconfirmed);
		expect(container.textContent).toContain(en.outcome.none);
		expect(container.textContent).not.toContain(en.verdict.succeeded);
		await render(<RunVerdictBadge status="success" outcome="done" />);
		expect(container.textContent).toContain(en.verdict.dispatched);
	});
	test("a task that is unavailable never discloses a cached name or link in the banner", async () => {
		detail = { isSuccess: false, data: taskFixture({ name: "Invisible private task" }) };
		await render(<ManagedTaskBanner taskId="task_1" model="changed:model" />);
		expect(container.textContent).toContain(en.managedGeneric);
		expect(container.textContent).not.toContain("Invisible private task");
		expect(container.querySelector("a")).toBeNull();
	});
});

describe("create and edit forms", () => {
	test("name-only save submits no cadence and clears dirty guard before navigation", async () => {
		await render(
			<TaskForm
				task={taskFixture()}
				onCancel={() => {}}
				onSaved={() => calls.push({ action: "navigate", value: guarded })}
			/>,
		);
		expect(guarded).toBe(false);
		await fillName("Renamed");
		expect(guarded).toBe(true);
		await submitForm();
		expect(calls).toEqual([
			{ action: "update", value: { id: "task_1", data: { name: "Renamed" } } },
			{ action: "navigate", value: false },
		]);
	});
	test("failed saves keep the draft and unsaved navigation protection", async () => {
		saveFailure = new Error("Save unavailable");
		await render(
			<TaskForm
				task={taskFixture()}
				onCancel={() => {}}
				onSaved={() => calls.push({ action: "navigate", value: null })}
			/>,
		);
		await fillName("Keep this name");
		await submitForm();
		expect(container.textContent).toContain("Save unavailable");
		expect(guarded).toBe(true);
		expect(calls).toHaveLength(1);
		expect(container.querySelector<HTMLInputElement>('input[maxlength="200"]')?.value).toBe(
			"Keep this name",
		);
	});
	test("invalid new forms cannot dispatch, and unavailable preview blocks a copy", async () => {
		await render(<TaskForm onCancel={() => {}} onSaved={() => {}} />);
		await submitForm();
		expect(calls).toEqual([]);
		expect(container.textContent).toContain(en.required);
		previewFailure = new Error("Preview unavailable");
		await render(
			<TaskForm key="copy" task={taskFixture()} copy onCancel={() => {}} onSaved={() => {}} />,
		);
		await submitForm();
		expect(calls).toEqual([]);
		expect(container.textContent).toContain("Preview unavailable");
	});
});

describe("history and schedule inputs", () => {
	test("paged run history is deduplicated, exposes load more and does not call completed success", async () => {
		pages.push({
			runs: [
				runFixture({ verdict: "succeeded", outcome: "done" }),
				runFixture({ id: "run_2", manual: true, trigger: "manual" }),
			],
			nextCursor: "next",
		});
		await render(<TaskRunHistory task={taskFixture()} />);
		expect(container.querySelectorAll('[id="run-run_1"]')).toHaveLength(1);
		expect(container.querySelector('[id="run-run_1"]')?.textContent).toContain(
			en.verdict.unconfirmed,
		);
		expect(container.querySelectorAll('[id="run-run_2"]')).toHaveLength(1);
		expect(container.textContent).toContain(en.triggerManual);
		expect(container.textContent).toContain(en.verdict.unconfirmed);
		await clickText(en.loadMore);
		expect(loadCalls).toBe(1);
	});
	test("history request failure displays an explicit retry instead of an empty success", async () => {
		runError = new Error("History unavailable");
		await render(<TaskRunHistory task={taskFixture()} />);
		expect(container.textContent).toContain("History unavailable");
		expect(container.textContent).toContain(en.retry);
		expect(container.textContent).not.toContain(en.noRuns);
	});
	test("deleting the first time keeps the second input node stable and duplicate times have distinct rows", async () => {
		function Times() {
			const [times, setTimes] = useState(["09:00", "12:00"]);
			return (
				<ScheduleTimeInputs
					times={times}
					limit={3}
					onChange={setTimes}
					fieldError={() => undefined}
				/>
			);
		}
		await render(<Times />);
		const retained = container.querySelectorAll('input[type="time"]')[1];
		await act(async () =>
			(container.querySelector('[aria-label="Remove time"]') as HTMLButtonElement).click(),
		);
		expect(container.querySelector('input[type="time"]')).toBe(retained);
		await clickText(en.addTime);
		expect(
			[...container.querySelectorAll('input[type="time"]')].map(
				(input) => (input as HTMLInputElement).value,
			),
		).toEqual(["12:00", "12:00"]);
		expect(container.querySelector('input[type="time"]')).toBe(retained);
	});
	test("quick filters toggle independently and do not manufacture roles", async () => {
		await render(
			<TaskFilters
				search={{ creator: "mine", attention: true }}
				onChange={(value) => calls.push({ action: "filter", value })}
			/>,
		);
		await clickText(en.filter.attention);
		await clickText(en.filter.narrator);
		expect(calls).toEqual([
			{ action: "filter", value: { attention: undefined } },
			{ action: "filter", value: { creator: "narrator" } },
		]);
	});
});
