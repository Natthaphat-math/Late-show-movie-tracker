// Custom lists: the "shelf" of VHS tapes and a single list's poster grid.
// Pure rendering — every button carries a data-action that app.js handles.

import { posterUrl } from "./storage.js";
import { h, icon, posterSlot, libraryCard, emptyState } from "./ui.js";

/** The shelf: one tape per list, plus a "new list" tape. */
export function listShelf(lists, movies) {
  const tapes = lists.map((l) => tape(l, movies));
  tapes.push(h("button", { type: "button", class: "tape tape-new", dataset: { action: "list-new" } },
    h("span", { class: "tape-new-icon", "aria-hidden": "true" }, icon("plus")),
    h("span", { class: "tape-new-text", text: "New list" })));
  return h("div", {},
    lists.length ? null : h("p", { class: "muted shelf-intro", text: "Group titles your way — “Christmas movies”, “Watch with Mom”, “My top 10”. A title can be in as many lists as you like." }),
    h("div", { class: "shelf" }, tapes));
}

function tape(list, movies) {
  const items = list.items.map((id) => movies.get(id)).filter(Boolean);
  const peek = items.slice(0, 3);
  const reelWindow = h("span", { class: "tape-window", "aria-hidden": "true" },
    peek.length
      ? peek.map((m) => posterSlot(posterUrl(m, "w185"), { emoji: m.emoji }))
      : [h("span", { class: "tape-reel" }), h("span", { class: "tape-reel" })]);
  return h("button", { type: "button", class: "tape", dataset: { action: "list-open", id: list.id }, "aria-label": `${list.name}, ${items.length} titles` },
    h("span", { class: "tape-label" },
      list.emoji ? h("span", { class: "tape-emoji", text: list.emoji }) : null,
      h("span", { class: "tape-name", text: list.name })),
    reelWindow,
    h("span", { class: "tape-foot micro" },
      h("span", { text: `${items.length} title${items.length === 1 ? "" : "s"}` }),
      list.ranked ? h("span", { class: "tape-ranked", text: "Ranked" }) : null));
}

/** One list's grid. Ranked lists number their cards and show ▲▼ to reorder. */
export function listDetail(list, movies) {
  const items = list.items.map((id) => movies.get(id)).filter(Boolean);
  const toolbar = h("div", { class: "list-toolbar" },
    h("button", { type: "button", class: "btn btn-sm btn-ghost", dataset: { action: "list-back" } }, "← All lists"),
    h("span", { class: "spacer" }),
    h("button", { type: "button", class: "btn btn-sm", dataset: { action: "list-edit", id: list.id } }, icon("pencil"), "Edit"),
    h("button", { type: "button", class: "btn btn-sm btn-danger", dataset: { action: "list-delete", id: list.id } }, icon("trash"), "Delete"));

  const intro = list.description ? h("p", { class: "list-desc", text: list.description }) : null;

  if (!items.length) {
    return h("div", {}, toolbar, intro,
      emptyState("Empty tape", "Open any title and tap “Add to list”, or pick this list when batch adding.", null));
  }

  const cards = items.map((m, i) => {
    const card = libraryCard(m, { rank: list.ranked ? i + 1 : null });
    const tools = h("div", { class: "card-tools" },
      list.ranked
        ? [
            h("button", { type: "button", class: "icon-btn", dataset: { action: "list-up", id: m.id }, "aria-label": `Move ${m.title} up`, disabled: i === 0 }, icon("chev-up")),
            h("button", { type: "button", class: "icon-btn", dataset: { action: "list-down", id: m.id }, "aria-label": `Move ${m.title} down`, disabled: i === items.length - 1 }, icon("chev-down")),
          ]
        : null,
      h("button", { type: "button", class: "icon-btn", dataset: { action: "list-remove", id: m.id }, "aria-label": `Remove ${m.title} from this list`, title: "Remove from list" }, icon("x")));
    card.append(tools);
    return card;
  });
  return h("div", {}, toolbar, intro, h("div", { class: "grid" }, cards));
}
