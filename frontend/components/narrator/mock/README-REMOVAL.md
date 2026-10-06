# Mock stream harness — removal guide

This directory is a **temporary** debug surface for tuning the virtual list's
measurement / animation / scroll behaviour. It replays scripted streaming output
(reasoning, assistant text, tool-call lifecycles) into a narrator's live view
without asking a real model for a turn, and without writing anything to the
database.

Reachability: it is gated behind the `narrafork_mock_stream` local preference
(off by default, toggled in Settings → Appearance). With the pref off, the
toolbar entry is hidden and the store's active flag is constant `false`.

## What it replays

A fixed 4-round turn (`mock-stream-corpus.ts`), each round being
reasoning → markdown text → tool calls, so new reasoning arrives *after* a tool
call has already settled — the case that matters most for animation tuning.

The markdown covers every block kind the layout pipeline has a distinct path for:
headings h1–h4, inline code / bold / italic / links, inline `$…$` math, display
`$$…$$` math (including a multi-line `aligned` block), fenced code with a
language, a **mermaid** fence (the one unknown-height block, corrected after
paint), tables with alignment rows and math in cells, unordered / ordered /
nested lists, blockquote, thematic break, and CJK-latin mixing.

The tool calls cover the distinct card bodies: Glob/Read/Grep (code box + match
list), Agent (delegation), Edit (diff, with `old_string` streamed before
`new_string` so the matching→replacing transition is exercised), Write (content
box), Bash (streaming terminal transcript, plus one **failing** call), WebSearch,
a `spec://tasks.json` write (task board) and ExitPlanMode (markdown plan card).

With **Permission gate** on, Bash / Write / Edit stop between `tool_started` and
`tool_executing` for a `permission_request` → hold → `permission_resolved`
(allow) cycle, so the low-LOD in-place drill (row opens into card + form, then
closes on the decision) can be watched. The form is display-only. Its buttons do
reach the server, which does not know the synthetic request id. Over WS the server
logs a warning and replies with an `error` frame; over the HTTP fallback it returns
404, which shows a "decision failed" toast. Nothing is written in either case.
Request ids are unique per pass because the panel never re-shows an id it has seen
resolved. A request still open when the run stops gets a decision-less
`permission_resolved`: `streaming_reset` does not clear pending permissions.

## Delete it in six steps

1. `rm -rf frontend/components/narrator/mock/`
2. `frontend/components/narrator/panels/panel-kind.ts` — remove `"mock"` from
   `PanelKind`, `PANEL_COMPONENT` and `PANEL_DEFAULT_TITLE`.
3. `frontend/components/narrator/dock/dock-panel-types.ts` — remove `mock` from
   `NARRATOR_DOCK_COMPONENT`, `NARRATOR_DOCK_DEFAULT_TITLE` and
   `NARRATOR_TOOL_PANEL_TYPES`.
4. `frontend/components/narrator/dock/panels.tsx` — remove `MockDockPanel`, its
   lazy import and its `narratorDockComponents` entry.
5. `frontend/components/narrator/NarratorPanel.tsx` — remove the
   `narrafork_mock_stream` pref read, the `useMockStreamActive` term from
   `isActive`, and the flask toolbar button.
6. `frontend/hooks/useLocalPref.ts` — remove the `"narrafork_mock_stream"` key;
   `frontend/routes/settings/appearance.tsx` — remove its switch;
   `frontend/locales/{en,zh-CN}/settings.json` — remove `mockStreamPanel*` keys;
   `frontend/lib/narrator-ws-manager.ts` — remove `dispatchLocalFrame` (and its
   test in `narrator-ws-manager.test.ts`).

After removal, a saved dock layout that still contains a `mock` panel no longer
resolves to a component. `narrator-dock-layout.ts` catches the `fromJSON` failure
and falls back to the default chat layout, so nothing breaks — but anyone who had
the panel open loses that narrator's custom layout once. Only operators who
enabled the debug pref are affected.

## Why it is built this way

- **`dispatchLocalFrame` skips sync bookkeeping.** Mock content is never
  persisted, so counting it into `messageVersion` would leave the client ahead of
  the server and make the next `sync_check` answer with a `catch_up` /
  `full_reload`, disturbing the real document.
- **The store exists because of `isActive`.** `useVListStreamingMessage` only
  subscribes while the narrator is `working`/`waiting`. A mock run leaves the
  narrator `idle`, so `NarratorPanel` ORs the store's flag into `isActive`.
  Injecting a fake `status_change` does not work: `useNarratorPanelWS`
  invalidates the narrator query and the refetch restores `idle`.
- **Stopping emits `streaming_reset`.** The live row is retired by the structural
  hand-off (a persisted message with the same content). Mock content never
  persists, so without the reset the row would linger forever with a running
  elapsed timer.
- **`tool_completed.output` is a plain string.** That is what the real wire format
  carries (`narrator-session.ts` sends `result.output`). A content-block array
  gets JSON-dumped by `resolveDisplayText`, so the card would render structure
  instead of the body.

## Corpus traps worth knowing

`mock-stream-corpus.test.ts` runs the REAL parser and asserts on block *kinds*,
because a source-level "the text contains ```` ```mermaid ````" check proves
nothing about what the parser produced. Two display formulas silently degraded to
plain paragraphs while this was written:

- A continuation line starting with `+ ` is lexed by marked as a **list**, which
  splits the `$$…$$` region in half.
- A continuation line indented by **4 spaces** matches `CODE_SEGMENT_PATTERN` (an
  indented code block), and math is never detected inside a code region.

Also: `\underbrace{…}_{\text{two words}}` makes KaTeX emit the inter-word space as
U+00A0, which the geometry prober re-measures and warns about (one glyph advance
guessed instead of measured). Such labels are kept single-word, and the test fails
on any KaTeX warning so this cannot creep back.
