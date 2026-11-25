// Substack Quick Actions
// Puts the most-used items of each note's "…" menu (Copy link, Save, Hide note,
// Mute, Block) directly into the note's action bar, next to Like/Comment/Restack/Share.
//
// Each quick button opens that note's real "…" menu with the menu hidden,
// clicks the matching menu item, and lets Substack do the rest, so behaviour
// (including Mute/Block confirmation dialogs) is identical to doing it by hand.

(() => {
  "use strict";

  const svg = (inner) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

  // Icons: Lucide (ISC), the same set Substack uses in its own menu.
  const ICONS = {
    link: svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
    bookmark: svg('<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>'),
    eyeOff: svg('<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>'),
    mute: svg('<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>'),
    ban: svg('<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>'),
    check: svg('<path d="M20 6 9 17l-5-5"/>'),
    x: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  };

  // `labels` are the menu-item texts to look for, in priority order. Toggled
  // states ("Unsave", "Unmute", "Unblock") are included so the button works both ways.
  const ACTIONS = [
    { key: "copy",  title: "Copy link", icon: ICONS.link,     labels: ["copy link"] },
    { key: "hide",  title: "Hide note", icon: ICONS.eyeOff,   labels: ["hide note", "hide", "unhide note", "unhide"] },
    { key: "mute",  title: "Mute",      icon: ICONS.mute,     labels: ["mute", "unmute"] },
    { key: "block", title: "Block",     icon: ICONS.ban,      labels: ["block", "unblock"] },
    { key: "save",  title: "Save",      icon: ICONS.bookmark, labels: ["save", "unsave", "saved", "remove from saved"] },
  ];

  const PROCESSED = "sqaDone";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();

  // ---------- locating a note's pieces ----------

  // The "…" button that belongs to the same note as this action bar: the
  // nearest ancestor holding a "More options" button, then the last such
  // button that comes *before* the bar (the note's header), so we never grab
  // a nested reply's menu that sits after it.
  function findMoreButton(bar) {
    let node = bar.parentElement;
    for (let depth = 0; node && depth < 12; depth++, node = node.parentElement) {
      const candidates = [...node.querySelectorAll('button[aria-label="More options"]')].filter(
        (b) => b.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING
      );
      if (candidates.length) return candidates[candidates.length - 1];
    }
    return null;
  }

  async function waitFor(fn, timeout = 1500, step = 30) {
    const end = performance.now() + timeout;
    while (performance.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  function menuFor(trigger) {
    const id = trigger.getAttribute("aria-controls");
    const byId = id && document.getElementById(id);
    if (byId && byId.getAttribute("role") === "menu") return byId;
    return null;
  }

  function closeMenu(menu) {
    const esc = { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true };
    menu.dispatchEvent(new KeyboardEvent("keydown", esc));
    document.dispatchEvent(new KeyboardEvent("keydown", esc));
  }

  // ---------- running an action ----------

  // A note that shares an article shows the article as a card with its own
  // bookmark button. The "…" menu's Save saves the *note*; what you usually
  // want is the article, so prefer the card's button when the note has one.
  const SAVE_LABELS = ["save", "unsave", "saved", "remove from saved"];

  function findEmbeddedSave(bar, more) {
    const scope = more ? noteScope(more, bar) : bar.parentElement;
    if (!scope) return null;
    const hits = [...scope.querySelectorAll("button[aria-label]")].filter((b) =>
      !b.classList.contains("sqa-btn") &&
      SAVE_LABELS.includes(norm(b.getAttribute("aria-label"))) &&
      (b.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING) && // above the bar
      (!more || (more.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)) // below the header
    );
    return hits[hits.length - 1] || null;
  }

  // What Save will save for this feed item:
  //   note only            → "note"    (via the … menu)
  //   note about an article → "article" (the article card's bookmark)
  //   article              → "article" (card bookmark, or the … menu, which on
  //                                      an article item saves the article)
  function saveKind(bar) {
    const more = findMoreButton(bar);
    if (findEmbeddedSave(bar, more)) return "article";
    const scope = more ? noteScope(more, bar) : bar.parentElement;
    return scope && scope.querySelector('a[href*="/note/c-"]') ? "note" : "article";
  }

  // Smallest ancestor holding both the note's header "…" button and its action bar.
  function noteScope(more, bar) {
    let node = more.parentElement;
    while (node && !node.contains(bar)) node = node.parentElement;
    return node;
  }

  let running = false;

  async function runAction(action, bar, btn) {
    if (running) return;
    const more = findMoreButton(bar);

    if (action.key === "save") {
      const cardSave = findEmbeddedSave(bar, more);
      if (cardSave) {
        const wasSaved = norm(cardSave.getAttribute("aria-label")) !== "save";
        cardSave.click();
        setTimeout(refreshSaved, 1000);
        return flash(btn, true, wasSaved ? "Article removed from Saved" : "Article saved ✓");
      }
    }

    if (!more) return flash(btn, false, "Couldn't find this note's … menu");

    running = true;
    document.documentElement.classList.add("sqa-busy");
    let ok = false;
    let reason = "";
    try {
      // If this note's menu is already open, close it first so the click opens it.
      const already = menuFor(more);
      if (already) { closeMenu(already); await sleep(150); }

      more.click();
      const menu = await waitFor(() => menuFor(more));
      if (!menu) { reason = "Menu didn't open"; return; }

      // Wait a moment for menu items to render, then match by exact text.
      const item = await waitFor(() => {
        const items = [...menu.querySelectorAll('[role="menuitem"]')];
        for (const label of action.labels) {
          const hit = items.find((i) => norm(i.textContent) === label);
          if (hit) return hit;
        }
        return null;
      }, 800);

      if (!item) {
        closeMenu(menu);
        reason = `"${action.title}" isn't available for this note`;
        return;
      }
      if (item.getAttribute("aria-disabled") === "true") {
        closeMenu(menu);
        reason = `"${action.title}" is disabled here`;
        return;
      }

      item.click();
      ok = true;
      if (action.key === "save") action.doneMsg = saveKind(bar) === "article" ? "Article saved ✓" : "Note saved ✓";
      // Show a newly saved/unsaved post in the sidebar's Saved panel.
      if (action.key === "save") setTimeout(refreshSaved, 1000);
    } finally {
      // Small delay so the menu's close animation also stays hidden.
      setTimeout(() => document.documentElement.classList.remove("sqa-busy"), 250);
      running = false;
      flash(btn, ok, ok ? (action.doneMsg || `${action.title} ✓`) : reason);
      delete action.doneMsg;
    }
  }

  function flash(btn, ok, msg) {
    const original = btn.dataset.sqaIcon;
    btn.innerHTML = ok ? ICONS.check : ICONS.x;
    btn.classList.add(ok ? "sqa-ok" : "sqa-fail");
    if (msg) btn.title = msg;
    setTimeout(() => {
      btn.innerHTML = original;
      btn.classList.remove("sqa-ok", "sqa-fail");
      btn.title = btn.dataset.sqaTitle;
    }, ok ? 1000 : 2200);
  }

  // ---------- injecting buttons ----------

  function buildGroup(bar) {
    const group = document.createElement("div");
    group.className = "sqa-group";

    for (const action of ACTIONS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sqa-btn";
      b.title = action.title;
      b.setAttribute("aria-label", action.title);
      b.dataset.sqaIcon = action.icon;
      b.dataset.sqaTitle = action.title;
      b.innerHTML = action.icon;
      group.appendChild(b);

      // Notes in the feed are clickable cards that open the note page;
      // keep our clicks from bubbling up and triggering that navigation.
      for (const ev of ["pointerdown", "mousedown", "mouseup"]) {
        b.addEventListener(ev, (e) => e.stopPropagation());
      }
      // Tell you up front what Save will save.
      if (action.key === "save") {
        b.addEventListener("mouseenter", () => {
          if (b.classList.contains("sqa-ok") || b.classList.contains("sqa-fail")) return;
          b.title = saveKind(bar) === "article" ? "Save article" : "Save note";
          b.dataset.sqaTitle = b.title;
        });
      }
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        runAction(action, bar, b);
      });
    }
    return group;
  }

  // ---------- hiding unwanted feed modules ----------

  // Feed items are [role="article"] elements; recommendation modules are the
  // ones whose section heading matches one of these titles.
  const HIDDEN_MODULES = ["people to follow"];

  function hideModules() {
    for (const h of document.querySelectorAll('[role="article"] h4')) {
      if (!HIDDEN_MODULES.includes(norm(h.textContent))) continue;
      const item = h.closest('[role="article"]');
      // Hide with a class instead of removing the node: the feed is rendered
      // by React, and deleting nodes React owns can break its re-renders.
      if (item) item.classList.add("sqa-hidden");
    }
  }

  // ---------- right sidebar: replace Subscriptions / Recommended with Saved ----------

  const SIDEBAR_HIDE = ["subscriptions", "recommended for you"];
  const SAVED_API = "/api/v1/reader/posts?inboxType=saved&limit=15";
  const isHome = () => location.pathname === "/" || location.pathname === "/home";

  // Finds a right-column card by its heading text. Returns the card's wrapper
  // (the direct child of the position:fixed sidebar column) so we never depend
  // on Substack's hashed class names or exact nesting depth.
  function findSidebarSection(title) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (norm(n.nodeValue) !== title) continue;
      let el = n.parentElement;
      if (el.getBoundingClientRect().left < innerWidth / 2) continue; // not right column
      for (let d = 0; el && el.parentElement && d < 10; d++, el = el.parentElement) {
        if (getComputedStyle(el.parentElement).position === "fixed") {
          return { wrapper: el, column: el.parentElement };
        }
      }
    }
    return null;
  }

  const fmtDate = (iso) => {
    const d = new Date(iso);
    const opts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString("en-US", opts).toUpperCase();
  };

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text; // textContent, never innerHTML: titles are user content
    return e;
  };

  function renderSavedItem(post, pub) {
    const a = el("a", "sqa-saved-item");
    a.href = `https://substack.com/home/post/p-${post.id}`;

    const body = el("div", "sqa-saved-body");
    const pubRow = el("div", "sqa-saved-pub");
    if (pub && pub.logo_url) {
      const logo = el("img", "sqa-saved-logo");
      logo.src = pub.logo_url;
      logo.alt = "";
      logo.loading = "lazy";
      pubRow.appendChild(logo);
    }
    pubRow.appendChild(el("span", "sqa-saved-pubname", pub ? pub.name : ""));
    body.appendChild(pubRow);
    body.appendChild(el("div", "sqa-saved-title", post.title || "(untitled)"));

    // Short description: the post's subtitle, falling back to its SEO description.
    const desc = (post.subtitle || post.description || "").trim();
    if (desc) body.appendChild(el("div", "sqa-saved-desc", desc));

    const author = (post.publishedBylines || []).map((b) => b.name).join(", ");
    // ~220 wpm reproduces the "N min read" Substack shows on its Saved page.
    const mins = Math.max(1, Math.round((post.wordcount || 0) / 220));
    const meta = [author, `${mins} min read`, fmtDate(post.post_date)].filter(Boolean).join(" · ");
    body.appendChild(el("div", "sqa-saved-meta", meta));
    a.appendChild(body);

    if (post.cover_image) {
      const img = el("img", "sqa-saved-cover");
      img.src = post.cover_image;
      img.alt = "";
      img.loading = "lazy";
      a.appendChild(img);
    }
    return a;
  }

  const saved = { panel: null, list: null, more: null, cursor: null, loading: false };

  async function loadSaved(reset) {
    if (saved.loading || !saved.panel) return;
    saved.loading = true;
    saved.more.textContent = "Loading…";
    saved.more.hidden = false;
    try {
      const url = SAVED_API + (!reset && saved.cursor ? `&cursor=${encodeURIComponent(saved.cursor)}` : "");
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      const pubs = new Map((data.publications || []).map((p) => [p.id, p]));
      // The API pages by save time but doesn't order within a page; newest first.
      const posts = (data.posts || []).sort((a, b) => (b.saved_at || "").localeCompare(a.saved_at || ""));

      if (reset) saved.list.textContent = "";
      for (const p of posts) saved.list.appendChild(renderSavedItem(p, pubs.get(p.publication_id)));
      if (reset && !posts.length) saved.list.appendChild(el("div", "sqa-saved-empty", "No saved posts yet."));

      saved.cursor = data.cursor;
      saved.more.textContent = "Load more";
      saved.more.hidden = !data.more;
    } catch (e) {
      saved.more.textContent = "Couldn't load saved posts — retry";
      saved.more.hidden = false;
    } finally {
      saved.loading = false;
    }
  }

  function buildSavedPanel(themeWrapperClass, cardClass) {
    // Borrow the hidden card's classes so the panel matches Substack's own
    // card styling (background, radius, theme colours) in light and dark mode.
    const wrapper = el("div", `sqa-saved ${themeWrapperClass || ""}`);
    const card = el("div", `sqa-saved-card ${cardClass || ""}`);

    const head = el("div", "sqa-saved-head");
    const title = el("a", "sqa-saved-heading", "Saved");
    title.href = "https://substack.com/inbox/saved";
    const all = el("a", "sqa-saved-seeall", "See all");
    all.href = "https://substack.com/inbox/saved";
    head.append(title, all);

    saved.list = el("div", "sqa-saved-list");
    saved.more = el("button", "sqa-saved-more", "Load more");
    saved.more.type = "button";
    // No cursor yet (first load failed) → start over; otherwise fetch the next page.
    saved.more.addEventListener("click", () => loadSaved(!saved.cursor));

    card.append(head, saved.list, saved.more);
    wrapper.appendChild(card);
    return wrapper;
  }

  function refreshSaved() {
    if (saved.panel && saved.panel.isConnected) { saved.cursor = null; loadSaved(true); }
  }

  function updateSidebar() {
    document.documentElement.classList.toggle("sqa-home", isHome());
    if (!isHome()) return;

    // Fast path once the panel is in place: only re-check the column's few
    // direct children (React may re-render a card as a fresh node).
    if (saved.panel && saved.panel.isConnected) {
      for (const child of saved.panel.parentElement.children) {
        if (child === saved.panel || child.classList.contains("sqa-side-hidden")) continue;
        const heading = norm((child.innerText || "").split("\n")[0]);
        if (SIDEBAR_HIDE.includes(heading)) child.classList.add("sqa-side-hidden");
      }
      return;
    }

    const sections = SIDEBAR_HIDE.map(findSidebarSection).filter(Boolean);
    if (!sections.length) return;
    for (const s of sections) s.wrapper.classList.add("sqa-side-hidden");

    const first = sections[0];
    const card = first.wrapper.firstElementChild;
    saved.panel = buildSavedPanel(first.wrapper.className.replace("sqa-side-hidden", ""), card && card.className);
    first.column.insertBefore(saved.panel, first.wrapper);
    loadSaved(true);
  }

  // Keep the list fresh when coming back to the tab.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshSaved(); });

  function scan() {
    hideModules();
    updateSidebar();
    for (const share of document.querySelectorAll('button[aria-label="Share"]')) {
      const bar = share.parentElement;
      if (!bar || bar.dataset[PROCESSED]) continue;
      // Only real note action bars (they also contain Like + Comment).
      if (!bar.querySelector('button[aria-label="Like"]')) continue;
      bar.dataset[PROCESSED] = "1";
      bar.appendChild(buildGroup(bar));
    }
  }

  // Substack is a single-page app with an infinite feed: rescan whenever the
  // DOM changes, batched to at most one scan per animation frame.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; scan(); });
  }).observe(document.body, { childList: true, subtree: true });

  scan();
})();
