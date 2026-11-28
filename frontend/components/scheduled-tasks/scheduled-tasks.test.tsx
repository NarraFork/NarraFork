import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import type { ScheduledTaskAssociation, ScheduledTaskTarget } from "../../lib/api/scheduled-tasks";
import en from "../../locales/en/scheduledTasks.json";
import { runFixture, taskFixture } from "./scheduled-task.fixtures";

function associationFixture(
	patch: Partial<ScheduledTaskAssociation> = {},
): ScheduledTaskAssociation {
	return {
		id: "task_1",
		name: "Daily task",
		lifecycle: "active",
		firedCount: 1,
		total: 3,
		lastStatus: "completed",
		hasUnfinishedRun: false,
		modelPolicy: "follow",
		requireReport: true,
		...patch,
	};
}
mock.module("@tanstack/react-router", () => ({
	Link: ({
		children,
		params,
	}: {
		children?: ReactNode;
		params: { taskId?: string; narratorId?: string };
	}) => (
		<a
			href={params.taskId ? `/scheduled-tasks/${params.taskId}` : `/narrators/${params.narratorId}`}
		>
			{children}
		</a>
	),
}));
const calls: Array<{ action: string; value: unknown }> = [];
let associations: ScheduledTaskAssociation[] = [];
let associationError = false;
let associationNextCursor: string | null = null;
let associationPending = false;
let targets: ScheduledTaskTarget[] = [];
let targetsError = false;
let targetsPending = false;
let targetNextCursor: string | null = null;
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
	useScheduledTaskAssociations: () => ({
		data: { pages: [{ tasks: associations, nextCursor: associationNextCursor }] },
		isSuccess: !associationError && !associationPending,
		isError: associationError,
		isPending: associationPending,
		hasNextPage: !!associationNextCursor,
		isFetchingNextPage: false,
		fetchNextPage: () => {
			loadCalls++;
		},
		refetch: () => {
			calls.push({ action: "retry-associations", value: null });
		},
	}),
	useScheduledTaskTargets: () => ({
		data: { pages: [{ items: targets, nextCursor: targetNextCursor }] },
		isSuccess: !targetsError && !targetsPending,
		isError: targetsError,
		isPending: targetsPending,
		isFetching: targetsPending,
		debouncing: false,
		hasNextPage: !!targetNextCursor,
		isFetchingNextPage: false,
		fetchNextPage: () => {
			loadCalls++;
		},
		refetch: () => {
			calls.push({ action: "retry-targets", value: null });
		},
	}),
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
const { TaskTargetPicker } = await import("./TaskTargetPicker");
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
	associations = [];
	associationError = false;
	associationPending = false;
	associationNextCursor = null;
	targets = [];
	targetsError = false;
	targetsPending = false;
	targetNextCursor = null;
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
	Object.defineProperty(window.document, "fonts", {
		configurable: true,
		value: { addEventListener() {}, removeEventListener() {} },
	});
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
	const field = [...container.querySelectorAll<HTMLInputElement>("input")].find(
		(input) => input.getAttribute("placeholder") === en.namePlaceholder,
	);
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
	test("an unavailable association never discloses a cached name, count or link", async () => {
		associations = [
			associationFixture({ name: "Invisible private task", firedCount: 12, total: 12 }),
		];
		associationError = true;
		await render(<ManagedTaskBanner narratorId="narrator_1" model="changed:model" />);
		expect(container.textContent).toContain(en.associationsLoadFailed);
		expect(container.textContent).not.toContain("Invisible private task");
		expect(container.textContent).not.toContain("12/12");
		expect(container.querySelector("a")).toBeNull();
		await clickText(en.retry);
		expect(calls).toEqual([{ action: "retry-associations", value: null }]);
	});
	test("multiple associations retain paused tasks and the last executing occurrence until terminal", async () => {
		associations = [
			associationFixture({
				id: "first",
				name: "Last occurrence",
				lifecycle: "ended",
				firedCount: 12,
				total: 12,
				lastStatus: "running",
				hasUnfinishedRun: true,
			}),
			associationFixture({
				id: "second",
				name: "Paused task",
				lifecycle: "paused",
				firedCount: 2,
				total: 5,
			}),
			associationFixture({ id: "third", name: "Finished task", lifecycle: "ended" }),
		];
		associationNextCursor = "next";
		await render(<ManagedTaskBanner narratorId="narrator_1" />);
		expect(container.textContent).toContain("12/12");
		expect(container.textContent).toContain(en.associationRunning);
		expect(container.textContent).toContain("Paused task");
		expect(container.textContent).toContain("2/5");
		expect(container.textContent).not.toContain("Finished task");
		await clickText(en.loadMore);
		expect(loadCalls).toBe(1);
		associations[0] = { ...associations[0], lastStatus: "completed", hasUnfinishedRun: false };
		await render(<ManagedTaskBanner narratorId="narrator_1" />);
		expect(container.textContent).not.toContain("Last occurrence");
		expect(container.textContent).toContain("Paused task");
		associations = [];
		await render(<ManagedTaskBanner narratorId="narrator_1" />);
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(container.querySelector("a")).toBeNull();
	});
	test("waiting is not dispatched and optional reports never manufacture success", async () => {
		associations = [associationFixture({ lastStatus: "waiting", hasUnfinishedRun: true })];
		await render(
			<>
				<ManagedTaskBanner narratorId="narrator_1" />
				<RunVerdictBadge status="completed" outcome={null} requireReport={false} />
			</>,
		);
		expect(container.textContent).toContain(en.verdict.waiting);
		expect(container.textContent).not.toContain(en.associationRunning);
		expect(container.textContent).toContain(en.verdict.completed);
		expect(container.textContent).not.toContain(en.verdict.succeeded);
		expect(container.textContent).not.toContain(en.verdict.unconfirmed);
	});
});

describe("create and edit forms", () => {
	test("existing targets inherit settings and save a report toggle without a cadence reset", async () => {
		targets = [
			{
				id: "target_1",
				title: "Chosen session",
				cwd: "/target",
				projectId: null,
				model: "target:model",
				status: "idle",
			},
		];
		await render(
			<TaskForm
				task={taskFixture({
					narratorMode: "existing",
					targetNarratorId: "target_1",
					modelPolicy: "follow",
				})}
				onCancel={() => {}}
				onSaved={() => {}}
			/>,
		);
		expect(container.textContent).toContain(en.existingInherited);
		expect(container.textContent).not.toContain(en.cleanupPolicy);
		expect(container.textContent).not.toContain(en.permissionModeDesc);
		expect(container.querySelector('textarea[maxlength="10000"]')).toBeNull();
		const control = [...container.querySelectorAll<HTMLInputElement>('input[role="switch"]')].find(
			(input) => input.closest(".mantine-Switch-root")?.textContent?.includes(en.requireReport),
		);
		expect(control?.checked).toBe(true);
		await act(async () => {
			if (!control) throw new Error("Report switch not rendered");
			// linkedom does not implement the checkbox default click action.
			Object.defineProperty(control, "checked", {
				configurable: true,
				writable: true,
				value: false,
			});
			control.dispatchEvent(new window.Event("click", { bubbles: true }));
		});
		await submitForm();
		expect(calls).toEqual([
			{ action: "update", value: { id: "task_1", data: { requireReport: false } } },
		]);
	});
	test("reuse forms expose their persisted clear-context choice", async () => {
		await render(
			<TaskForm
				task={taskFixture({ narratorMode: "reuse", contextPolicy: "clear" })}
				onCancel={() => {}}
				onSaved={() => {}}
			/>,
		);
		expect(container.textContent).toContain(en.contextPolicy);
		expect(container.innerHTML).toContain(en.context.clear);
		expect(container.textContent).toContain(en.contextClearWarning);
	});
	test("missing existing targets and out-of-range busy waits cannot dispatch", async () => {
		await render(
			<TaskForm
				task={taskFixture({ narratorMode: "existing", targetNarratorId: null })}
				onCancel={() => {}}
				onSaved={() => {}}
			/>,
		);
		await submitForm();
		expect(calls).toEqual([]);
		expect(container.textContent).toContain(en.required);
		await render(
			<TaskForm
				key="invalid-wait"
				task={taskFixture({ onBusy: "wait", busyWaitMinutes: 0 })}
				onCancel={() => {}}
				onSaved={() => {}}
			/>,
		);
		await submitForm();
		expect(calls).toEqual([]);
		expect(container.textContent).toContain(en.validation.invalid_interval);
	});
	test("target pagination and request failures stay explicit and hide stale labels", async () => {
		targets = [
			{
				id: "target_1",
				title: "Private target title",
				cwd: null,
				projectId: null,
				model: null,
				status: "idle",
			},
		];
		targetNextCursor = "next";
		await render(<TaskTargetPicker value="target_1" onChange={() => {}} />);
		expect(container.innerHTML).toContain("Private target title");
		await clickText(en.loadMore);
		expect(loadCalls).toBe(1);
		targetsError = true;
		await render(<TaskTargetPicker value="target_1" onChange={() => {}} />);
		expect(container.innerHTML).not.toContain("Private target title");
		expect(container.textContent).toContain(en.targetsLoadFailed);
		await clickText(en.retry);
		expect(calls).toHaveLength(2);
	});
	test("a selected target outside the first lookup page is not treated as inaccessible", async () => {
		targets = [];
		targetNextCursor = "more-matching-titles";
		await render(<TaskTargetPicker value="target_2" onChange={() => {}} />);
		expect(container.textContent).not.toContain(en.targetUnavailable);
		await clickText(en.targetFindMore);
		expect(loadCalls).toBe(1);
		targets = [
			{
				id: "target_2",
				title: "Found target",
				cwd: null,
				projectId: null,
				model: null,
				status: "idle",
			},
		];
		targetNextCursor = null;
		await render(<TaskTargetPicker value="target_2" onChange={() => {}} />);
		expect(container.innerHTML).toContain("Found target");
		expect(container.textContent).not.toContain(en.targetFindMore);
	});
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
		expect(
			[...container.querySelectorAll<HTMLInputElement>("input")].find(
				(input) => input.getAttribute("placeholder") === en.namePlaceholder,
			)?.value,
		).toBe("Keep this name");
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
