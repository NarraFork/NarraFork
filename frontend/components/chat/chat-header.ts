/**
 * chat-header.ts — Shared geometry for the chat surfaces' top bars.
 *
 * The room list and the room view are siblings in a two-column layout, so their
 * headers sit next to each other with a divider running between them. Their
 * contents differ (the list carries an ActionIcon, the view only a title), and
 * padding-derived heights therefore disagree by a few pixels — enough for the
 * bottom borders to visibly step across the divider. A fixed height is the only
 * way the two bars line up regardless of what either one holds.
 */

/** Height of the chat surfaces' top bars, in px. */
export const CHAT_HEADER_HEIGHT = 44;
