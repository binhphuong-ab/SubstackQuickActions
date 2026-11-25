// Substack Quick Actions: Writer column
//
// Replaces Substack's left navigation with a column built to get you writing:
//   • one-click "New note" / "New article"
//   • nudges for the first post of the day and of the week, with a streak
//   • your recent notes and articles
// The original navigation is hidden behind a ☰ Menu button (shown as a popover).
//
// Posting history comes from Substack's API and is accumulated in
// chrome.storage.local, so the streak survives beyond the API's latest page.

(() => {
  "use strict";

  const STORE_KEY = "sqaWriter";
  // Below 1280px Substack collapses its nav to a narrow rail and the feed moves
  // left, so there's no room for the column; leave the page alone there.
  const MIN_WIDTH = 1280;
  const NAV_SEL = '[role="navigation"][aria-label="Main navigation"]';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();

  const h = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "html") e.innerHTML = v; // only ever used with our own static SVG
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) e.append(kid);
    return e;
  };

  const svg = (inner, size = 18) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const ICON = {
    menu: svg('<line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="18" y2="18"/>'),
    note: svg('<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>'),
    article: svg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>'),
    heart: svg('<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>', 12),
    comment: svg('<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>', 12),
  };

  // Profile photos are stored in a private S3 bucket (direct links → 403);
  // Substack serves them through its image proxy, so we do the same.
  const cdnImage = (url, size = 64) => {
    if (!url || url.includes("substackcdn.com")) return url;
    return `https://substackcdn.com/image/fetch/w_${size},h_${size},c_fill,f_auto,q_auto:good,fl_progressive:steep/${encodeURIComponent(url)}`;
  };

  function avatar(me) {
    const initial = h("span", { class: "sqa-w-avatar sqa-w-initial" }, (me && me.name ? me.name.trim()[0] : "S").toUpperCase());
    if (!me || !me.photo) return initial;
    const img = h("img", { class: "sqa-w-avatar", src: cdnImage(me.photo, 64), alt: "" });
    img.addEventListener("error", () => img.replaceWith(initial), { once: true });
    return img;
  }

  // ---------- dates (local calendar) ----------

  const dayKey = (d) => {
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const startOfWeek = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return addDays(x, -((x.getDay() + 6) % 7)); }; // Monday

  const ago = (iso) => {
    const s = (Date.now() - new Date(iso)) / 1000;
    if (s < 60) return "now";
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
    const d = new Date(iso);
    const o = { month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) o.year = "numeric";
    return d.toLocaleDateString("en-US", o);
  };

  // ---------- extension lifecycle ----------

  // When the extension is reloaded or updated, the copy of this script already
  // running in an open tab is orphaned: chrome.* calls then throw "Extension
  // context invalidated". Detect that and stop all timers/observers quietly.
  const cleanups = [];
  let dead = false;
  const alive = () => {
    if (dead) return false;
    try { if (chrome.runtime && chrome.runtime.id) return true; } catch (_) { /* invalidated */ }
    dead = true;
    for (const fn of cleanups.splice(0)) { try { fn(); } catch (_) { /* ignore */ } }
    return false;
  };
  const isContextError = (err) => /extension context invalidated/i.test(String(err && err.message || err));

  // ---------- storage ----------

  const EMPTY = () => ({ activity: {}, bestStreak: 0, me: null });
  const store = {
    async get() {
      if (!alive()) return EMPTY();
      try {
        const r = await chrome.storage.local.get(STORE_KEY);
        return Object.assign(EMPTY(), r[STORE_KEY]);
      } catch (err) {
        if (isContextError(err)) { alive(); return EMPTY(); }
        throw err;
      }
    },
    async set(v) {
      if (!alive()) return;
      try {
        await chrome.storage.local.set({ [STORE_KEY]: v });
      } catch (err) {
        if (isContextError(err)) { alive(); return; }
        throw err;
      }
    },
  };

  // ---------- API ----------

  async function api(path) {
    const res = await fetch(path, { credentials: "include" });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json();
  }

  async function fetchMe() {
    const p = await api("/api/v1/user/profile/self");
    const pub = p.primaryPublication || (p.publicationUsers || []).map((u) => u.publication).find(Boolean) || null;
    return {
      id: p.id, name: p.name, handle: p.handle, photo: p.photo_url,
      subdomain: pub && pub.subdomain, pubName: pub && pub.name,
    };
  }

  // Notes (and posts) from your profile feed. Only your own original notes
  // count; restacks and replies don't.
  async function fetchNotes(me, pages) {
    const notes = [];
    let cursor = null;
    for (let i = 0; i < pages; i++) {
      let data;
      try {
        data = await api(`/api/v1/reader/feed/profile/${me.id}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
      } catch (err) {
        if (i === 0) throw err; // older pages are a bonus; keep what we have
        break;
      }
      for (const it of data.items || []) {
        const c = it.comment;
        if (it.context && it.context.type === "note" && c && c.user_id === me.id) {
          notes.push({
            id: `c-${c.id}`, kind: "note", date: c.date,
            text: (c.body || "").trim(),
            likes: c.reaction_count || 0, replies: c.children_count || 0,
            url: `https://substack.com/@${me.handle}/note/c-${c.id}`,
          });
        }
      }
      cursor = data.nextCursor;
      if (!cursor) break;
    }
    return notes;
  }

  async function fetchArticles(me) {
    const data = await api(`/api/v1/profile/posts?profile_user_id=${me.id}&limit=10`);
    return (data.posts || []).map((p) => ({
      id: `p-${p.id}`, kind: "article", date: p.post_date,
      text: p.title || "(untitled)",
      likes: p.reaction_count || 0, replies: p.comment_count || 0,
      url: p.canonical_url,
    }));
  }

  // ---------- streak maths ----------

  function computeStats(activity) {
    const days = new Set(Object.values(activity).map((a) => a.day));
    const now = new Date();
    const today = dayKey(now);
    const postedToday = days.has(today);

    // A streak stays alive through today even before you've posted today.
    let streak = 0;
    for (let d = postedToday ? now : addDays(now, -1); days.has(dayKey(d)); d = addDays(d, -1)) streak++;

    const monday = startOfWeek(now);
    const week = [...Array(7)].map((_, i) => {
      const d = addDays(monday, i);
      const k = dayKey(d);
      return { key: k, label: "MTWTFSS"[i], posted: days.has(k), isToday: k === today, future: d > now && k !== today };
    });
    const weekCount = Object.values(activity).filter((a) => week.some((w) => w.key === a.day)).length;
    const postedThisWeek = week.some((w) => w.posted);

    return { postedToday, postedThisWeek, streak, week, weekCount };
  }

  // ---------- opening the composers ----------

  // "New note" drives the hidden nav's own Create ▸ Note, which opens
  // Substack's real note composer (same as clicking it yourself).
  async function openNoteComposer() {
    const nav = document.querySelector(NAV_SEL);
    const create = nav && [...nav.querySelectorAll("button")].find((b) => norm(b.innerText) === "create");
    if (!create) return false;
    document.documentElement.classList.add("sqa-busy"); // keeps the menu invisible
    try {
      create.click();
      for (let i = 0; i < 40; i++) {
        await sleep(30);
        const item = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((m) => norm(m.textContent) === "note");
        if (item) { item.click(); return true; }
      }
      return false;
    } finally {
      setTimeout(() => document.documentElement.classList.remove("sqa-busy"), 250);
    }
  }

  const articleUrl = (me) =>
    `https://${me.subdomain}.substack.com/publish/post?back=${encodeURIComponent(location.href)}`;

  // ---------- writing prompts ----------

  const PROMPTS = [
    "What did you learn today that surprised you?",
    "What's one idea you changed your mind about recently?",
    "Explain something you know well to a 12-year-old.",
    "What question have you been chewing on this week?",
    "Share a quote you read recently and why it stuck.",
    "What's a mistake you made and what it taught you?",
    "What would you tell yourself one year ago?",
    "Describe a small habit that made a big difference.",
    "What's a book, article or video worth someone's time?",
    "What's something most people get wrong about your field?",
    "Write down a half-formed idea. Notes are for drafts.",
    "What's one thing you're curious to learn next, and why?",
    "Summarise the best conversation you had this week.",
    "What did you notice today that others probably missed?",
  ];
  const promptOfTheDay = () => {
    const d = new Date();
    const doy = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
    return PROMPTS[doy % PROMPTS.length];
  };

  // ---------- rendering ----------

  const state = { me: null, notes: [], articles: [], stats: null, loading: true, error: null };
  let col = null;
  let navOpen = false;

  function nudge() {
    const s = state.stats;
    if (!s) return null;
    if (s.postedToday) {
      return {
        tone: "done",
        title: "Today's post is done ✓",
        text: s.streak > 1 ? `🔥 ${s.streak}-day streak. See you tomorrow.` : "Nice. Come back tomorrow to start a streak.",
      };
    }
    if (!s.postedThisWeek) {
      return { tone: "week", title: "First post of the week", text: "A new week is a clean page. One short note gets it started." };
    }
    return {
      tone: "day",
      title: "First post of the day",
      text: s.streak > 0
        ? `🔥 ${s.streak}-day streak. Post today to make it ${s.streak + 1}.`
        : "You've posted this week. Keep the rhythm with a quick note today.",
    };
  }

  function renderList(items, emptyText) {
    if (!items.length) return h("div", { class: "sqa-w-empty" }, emptyText);
    return h("div", { class: "sqa-w-list" }, items.map((it) =>
      h("a", { class: "sqa-w-item", href: it.url },
        h("div", { class: `sqa-w-itemtext ${it.kind === "article" ? "sqa-w-title" : ""}` }, it.text),
        h("div", { class: "sqa-w-itemmeta" },
          h("span", {}, ago(it.date)),
          h("span", { class: "sqa-w-stat", html: ICON.heart }), String(it.likes),
          h("span", { class: "sqa-w-stat", html: ICON.comment }), String(it.replies)
        )
      )
    ));
  }

  function render() {
    if (!col) return;
    const me = state.me;
    const n = nudge();
    const s = state.stats;

    const header = h("div", { class: "sqa-w-header" },
      h("a", { class: "sqa-w-me", href: me ? `https://substack.com/@${me.handle}` : "https://substack.com/" },
        avatar(me),
        h("span", { class: "sqa-w-name" }, me ? me.name : "Substack")
      ),
      h("button", { type: "button", class: "sqa-w-menu", title: "Menu", "aria-label": "Menu", html: ICON.menu, onclick: toggleNav })
    );

    // Articles are the main goal → primary button; notes are the quick warm-up.
    const write = h("div", { class: "sqa-w-write" },
      h("a", { class: "sqa-w-btn sqa-w-primary", href: me && me.subdomain ? articleUrl(me) : "#", onclick: (e) => { if (!me || !me.subdomain) e.preventDefault(); } },
        h("span", { html: ICON.article }), "New article"),
      h("button", { type: "button", class: "sqa-w-btn sqa-w-secondary", onclick: onNewNote },
        h("span", { html: ICON.note }), "New note")
    );

    const nudgeCard = n && h("div", { class: `sqa-w-nudge sqa-w-${n.tone}` },
      h("div", { class: "sqa-w-nudge-title" }, n.title),
      h("div", { class: "sqa-w-nudge-text" }, n.text),
      s && h("div", { class: "sqa-w-week", title: `${s.weekCount} post${s.weekCount === 1 ? "" : "s"} this week` },
        s.week.map((d) => h("div", { class: `sqa-w-day${d.posted ? " on" : ""}${d.isToday ? " today" : ""}${d.future ? " future" : ""}` },
          h("span", { class: "sqa-w-dot" }), h("span", { class: "sqa-w-dlabel" }, d.label)))
      ),
      !s.postedToday && h("button", { type: "button", class: "sqa-w-prompt", onclick: onNewNote, title: "Write a note about this" },
        h("span", { class: "sqa-w-prompt-label" }, "Today's prompt"),
        h("span", {}, promptOfTheDay()))
    );

    const body = state.loading && !me
      ? h("div", { class: "sqa-w-empty" }, "Loading…")
      : state.error && !me
        ? h("div", { class: "sqa-w-empty" }, "Couldn't load your profile. Are you signed in?")
        : [
          h("div", { class: "sqa-w-section" },
            h("div", { class: "sqa-w-sechead" }, h("span", {}, "Recent notes"),
              me && h("a", { href: `https://substack.com/@${me.handle}/notes` }, "All")),
            renderList(state.notes.slice(0, 3), "No notes yet. Your first one is a click away.")),
          h("div", { class: "sqa-w-section" },
            h("div", { class: "sqa-w-sechead" }, h("span", {}, "Recent articles"),
              me && me.subdomain && h("a", { href: `https://${me.subdomain}.substack.com/publish/posts` }, "All")),
            renderList(state.articles.slice(0, 3), "No articles yet.")),
        ];

    col.replaceChildren(header, write, nudgeCard || "", ...[body].flat());
  }

  async function onNewNote(e) {
    e && e.preventDefault();
    if (!(await openNoteComposer())) {
      // Fallback: the feed's own "What's on your mind?" box.
      const box = [...document.querySelectorAll("div,button")].find((x) => norm(x.textContent) === "what's on your mind?" && x.childElementCount <= 2);
      if (box) box.click();
    }
  }

  // ---------- data refresh ----------

  let refreshing = false;
  async function refresh() {
    if (refreshing || !alive()) return;
    refreshing = true;
    try {
      const saved = await store.get();
      state.me = state.me || saved.me;
      const me = await fetchMe();
      state.me = me;

      // First run: read further back so the streak/week start out accurate.
      const firstRun = !Object.keys(saved.activity).length;
      const [notes, articles] = await Promise.all([fetchNotes(me, firstRun ? 4 : 1), fetchArticles(me)]);
      state.notes = notes.sort((a, b) => b.date.localeCompare(a.date));
      state.articles = articles.sort((a, b) => b.date.localeCompare(a.date));

      // Merge into the stored history (keep the newest ~500 entries).
      const activity = { ...saved.activity };
      for (const it of [...notes, ...articles]) activity[it.id] = { day: dayKey(it.date), kind: it.kind };
      const trimmed = Object.fromEntries(Object.entries(activity).sort((a, b) => b[1].day.localeCompare(a[1].day)).slice(0, 500));

      state.stats = computeStats(trimmed);
      const bestStreak = Math.max(saved.bestStreak || 0, state.stats.streak);
      await store.set({ activity: trimmed, bestStreak, me });
      state.error = null;
    } catch (err) {
      state.error = String(err);
      if (!state.stats) state.stats = computeStats((await store.get()).activity);
    } finally {
      state.loading = false;
      refreshing = false;
      render();
    }
  }

  // ---------- nav popover ----------

  function setNavOpen(open) {
    navOpen = open;
    document.documentElement.classList.toggle("sqa-nav-open", open);
  }
  function toggleNav(e) { e && e.stopPropagation(); setNavOpen(!navOpen); }

  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && navOpen) setNavOpen(false); });
  document.addEventListener("click", (e) => {
    if (!navOpen) return;
    const nav = document.querySelector(NAV_SEL);
    if (nav && nav.contains(e.target)) {
      // Following a nav link closes the popover; opening a submenu doesn't.
      if (e.target.closest("a,[data-href]")) setTimeout(() => setNavOpen(false), 50);
      return;
    }
    if (e.target.closest('[role="menu"],[role="dialog"]')) return;
    setNavOpen(false);
  }, true);

  // ---------- mounting ----------

  function syncTheme() {
    if (!col) return;
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    const nav = document.querySelector(NAV_SEL);
    col.style.setProperty("--sqa-bg", bodyBg);
    document.documentElement.style.setProperty("--sqa-page-bg", bodyBg);
    if (nav) {
      const cs = getComputedStyle(nav);
      col.style.setProperty("--sqa-fg", cs.color);
      // Use the nav's UI font: some pages (profiles) set a serif body font.
      col.style.fontFamily = cs.fontFamily;
    }
  }

  function mount() {
    const nav = document.querySelector(NAV_SEL);
    const enabled = !!nav && innerWidth >= MIN_WIDTH;
    document.documentElement.classList.toggle("sqa-writer", enabled);
    if (!enabled) { if (navOpen) setNavOpen(false); return; }

    if (!col || !col.isConnected) {
      col = h("aside", { class: "sqa-w-col", "aria-label": "Writing" });
      document.body.appendChild(col);
      syncTheme();
      render();
      refresh();
    }
  }

  // Re-check after DOM changes (SPA navigation, the composer closing).
  let composerWasOpen = false;
  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (!alive()) return;
      mount();
      // When the note composer closes, you may have just posted: refresh.
      const open = !!document.querySelector('[data-testid="modal"][data-state="open"]');
      if (composerWasOpen && !open) setTimeout(refresh, 2500);
      composerWasOpen = open;
    });
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state"] });
  cleanups.push(() => observer.disconnect());

  const onVisible = () => { if (!document.hidden && col) { syncTheme(); refresh(); } };
  addEventListener("resize", mount);
  document.addEventListener("visibilitychange", onVisible);
  cleanups.push(() => {
    removeEventListener("resize", mount);
    document.removeEventListener("visibilitychange", onVisible);
  });

  const refreshTimer = setInterval(() => { if (!document.hidden && col) refresh(); }, 5 * 60 * 1000);
  // The day can roll over while the tab is open: re-render the nudge each minute.
  const dayTimer = setInterval(() => {
    if (!col || !state.stats || !alive()) return;
    store.get()
      .then((s) => { state.stats = computeStats(s.activity); render(); })
      .catch(() => { /* keep the current stats */ });
  }, 60 * 1000);
  cleanups.push(() => { clearInterval(refreshTimer); clearInterval(dayTimer); });

  mount();
})();
