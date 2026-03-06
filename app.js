/**
 * Fly By Night - 5 thread-spots w/ preview + expanded thread view (in-memory only)
 */

const REFRESH_SECONDS = 10;
const SPOT_COUNT = 5;
const STORAGE_KEY = "flybynight.thread_state.v1";
const STORAGE_DAY_KEY = "flybynight.thread_state.day";
const DAY_ROLLOVER_CHECK_MS = 60 * 1000;

// --- API wiring (server-backed threads) ---
const API_BASE = "/api"; // nginx should route this to your control service

function fmtIsoLikeUi(msOrIso) {
  // UI expects "YYYY-MM-DD HH:MM:SSZ"
  if (typeof msOrIso === "number") {
    const d = new Date(msOrIso);
    return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
  }
  // If server already returns a string, keep it
  return String(msOrIso ?? "");
}

function normalizeThreadFromApi(thread) {
  if (!thread) return null;
  return {
    threadId: Number(thread.threadId),
    createdAt: fmtIsoLikeUi(thread.createdAt),
    title: String(thread.title ?? ""),
    posts: Array.isArray(thread.posts)
      ? thread.posts.map((p) => ({
          id: Number(p.id),
          name: String(p.name ?? "Anonymous"),
          comment: String(p.comment ?? ""),
          createdAt: fmtIsoLikeUi(p.createdAt),
          imageDataUrl: p.imageDataUrl ? String(p.imageDataUrl) : null,
        }))
      : [],
  };
}

async function apiFetch(path, { method = "GET", body = null } = {}) {
  const url = `${API_BASE}${path}${path.includes("?") ? "&" : "?"}_=${Date.now()}`;

  const init = { method, cache: "no-store", headers: {} };
  if (body != null) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const r = await fetch(url, init);
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!r.ok) {
    const msg = (data && (data.detail || data.msg)) || `HTTP ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    err.data = data;
    throw err;
  }

  return data;
}

async function refreshFromServer() {
  // Expecting: [{ spotId, thread: { threadId, createdAt(ms), title, posts:[...] } }, ...]
  const serverSpots = await apiFetch(`/spots`, { method: "GET" });

  const normalized = Array.from({ length: SPOT_COUNT }, (_, i) => {
    const spotId = i + 1;
    const incoming = Array.isArray(serverSpots) ? serverSpots.find((s) => Number(s?.spotId) === spotId) : null;
    return {
      spotId,
      thread: normalizeThreadFromApi(incoming?.thread ?? null),
    };
  });

  spots = normalized;

  // Keep these sane in case any UI code still relies on them (quoting uses post ids).
  const allThreadIds = spots.map((s) => s.thread?.threadId).filter(Number.isFinite);
  const allPostIds = spots
    .flatMap((s) => (s.thread?.posts ?? []).map((p) => p.id))
    .filter(Number.isFinite);

  nextThreadId = (allThreadIds.length ? Math.max(...allThreadIds) : 0) + 1;
  nextPostId = (allPostIds.length ? Math.max(...allPostIds) : 99) + 1;
}

let spots = Array.from({ length: SPOT_COUNT }, (_, i) => ({
  spotId: i + 1,
  thread: null, // { threadId, createdAt, title, posts: Post[] }
}));

let nextThreadId = 1;
let nextPostId = 100;

let expandedSpotId = null; // when set, show only that spot expanded

const el = {
  spotsGrid: document.getElementById("spotsGrid"),
  tablesStage: document.getElementById("tablesStage"),
  spotsStatus: document.getElementById("spotsStatus"),
  refreshStatus: document.getElementById("refreshStatus"),
  clock: document.getElementById("clock"),
  header: document.getElementById("header"),
  backToTablesTop: document.getElementById("backToTablesTop"),
};

function localDayStamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function clearStoredThreadState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.setItem(STORAGE_DAY_KEY, localDayStamp());
  } catch (err) {
    console.warn("Failed clearing stored thread state:", err);
  }
}

function ensureCurrentDayStorage() {
  try {
    const savedDay = localStorage.getItem(STORAGE_DAY_KEY);
    const today = localDayStamp();
    if (savedDay !== today) {
      clearStoredThreadState();
      return true;
    }
  } catch (err) {
    console.warn("Failed checking storage day key:", err);
  }
  return false;
}

function saveThreadState() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        spots,
        nextThreadId,
        nextPostId,
      })
    );
    localStorage.setItem(STORAGE_DAY_KEY, localDayStamp());
  } catch (err) {
    console.warn("Failed saving thread state (possibly storage quota):", err);
  }
}

function loadThreadState() {
  ensureCurrentDayStorage();

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.spots)) return;

    const normalized = Array.from({ length: SPOT_COUNT }, (_, i) => {
      const spotId = i + 1;
      const incoming = parsed.spots.find((s) => Number(s?.spotId) === spotId);
      return {
        spotId,
        thread: incoming?.thread ?? null,
      };
    });

    spots = normalized;
    nextThreadId = Number.isFinite(parsed.nextThreadId) ? parsed.nextThreadId : nextThreadId;
    nextPostId = Number.isFinite(parsed.nextPostId) ? parsed.nextPostId : nextPostId;
  } catch (err) {
    console.warn("Failed loading thread state:", err);
  }
}

function nowIso() {
  const d = new Date();
  return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderCommentWithQuotes(comment) {
  const safe = escapeHtml(comment);
  return safe.replace(/&gt;&gt;(\d+)/g, (_, id) => {
    return `<a class="quote" href="#p${id}" data-quote="${id}">&gt;&gt;${id}</a>`;
  });
}

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);

  const needsSpaceBefore = before.length > 0 && !before.endsWith("\n") && !before.endsWith(" ");
  const needsSpaceAfter = after.length > 0 && !after.startsWith("\n") && !after.startsWith(" ");
  const insert = (needsSpaceBefore ? " " : "") + text + (needsSpaceAfter ? " " : "");

  textarea.value = before + insert + after;
  const pos = (before + insert).length;
  textarea.setSelectionRange(pos, pos);
  textarea.focus();
}

async function fileToDataUrl(file) {
  if (!file) return null;
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function snippet(text, max = 140) {
  const s = String(text ?? "").trim().replace(/\s+/g, " ");
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "...";
}

function defaultTitleForThread(spotId) {
  return `Thread Spot ${spotId}`;
}

/* ---------------------------
   Preserve form state across rerenders
   --------------------------- */

function stableFieldKey(node) {
  // Prefer explicit id if present
  if (node.id) return `id:${node.id}`;

  // Otherwise derive a stable key from spot + form + name
  const form = node.closest("form");
  const spot = node.closest(".spot")?.getAttribute("data-spot-id");
  const formType = form?.getAttribute("data-form");
  const name = node.getAttribute("name");
  if (spot && formType && name) return `spot:${spot}|form:${formType}|name:${name}`;

  return null;
}

function snapshotFormState(container) {
  const state = {
    activeKey: null,
    selStart: null,
    selEnd: null,
    values: new Map(),
  };

  const active = document.activeElement;
  if (active && container.contains(active) && (active.tagName === "TEXTAREA" || active.tagName === "INPUT")) {
    // track focus by our stable key (not DOM node)
    const k = stableFieldKey(active);
    if (k) state.activeKey = k;

    if (active.selectionStart != null) {
      state.selStart = active.selectionStart;
      state.selEnd = active.selectionEnd;
    }
  }

  container.querySelectorAll("input, textarea").forEach((node) => {
    if (node.tagName === "INPUT" && node.type === "file") return; // cannot restore
    const k = stableFieldKey(node);
    if (!k) return;
    state.values.set(k, node.value);
  });

  return state;
}

function restoreFormState(container, state) {
  if (!state) return;

  container.querySelectorAll("input, textarea").forEach((node) => {
    if (node.tagName === "INPUT" && node.type === "file") return;
    const k = stableFieldKey(node);
    if (!k) return;
    if (state.values.has(k)) node.value = state.values.get(k);
  });

  if (state.activeKey) {
    const target = Array.from(container.querySelectorAll("input, textarea")).find((n) => stableFieldKey(n) === state.activeKey);
    if (target) {
      target.focus();
      if (state.selStart != null && target.selectionStart != null) {
        target.setSelectionRange(state.selStart, state.selEnd ?? state.selStart);
      }
    }
  }
}

function hasSelectedFile(container) {
  return Array.from(container.querySelectorAll('input[type="file"]')).some(
    (inp) => inp.files && inp.files.length > 0
  );
}

function isUserTypingIn(container) {
  const a = document.activeElement;
  if (!a || !container.contains(a)) return false;
  if (a.tagName === "TEXTAREA") return true;
  if (a.tagName === "INPUT" && a.type !== "file") return true;
  return false;
}

/* ---- Mutations (server-backed) ---- */

async function createThreadInSpot(spotId, { title, name, comment, imageFile }) {
  // If there's already a thread locally, don't try.
  const spot = spots.find((s) => s.spotId === spotId);
  if (!spot || spot.thread) return;

  const imageDataUrl = await fileToDataUrl(imageFile);

  try {
    await apiFetch(`/spots/${spotId}/thread`, {
      method: "POST",
      body: {
        title: title?.trim() || defaultTitleForThread(spotId),
        name: name?.trim() || "Anonymous",
        comment: comment.trim(),
        imageDataUrl,
      },
    });
  } catch (e) {
    // Typical: 409 Conflict if already occupied by someone else
    alert(e?.message || "Failed to create thread.");
  }

  await refreshFromServer();
}

async function addReplyToSpotThread(spotId, { name, comment, imageFile }) {
  const spot = spots.find((s) => s.spotId === spotId);
  if (!spot?.thread) return;

  const imageDataUrl = await fileToDataUrl(imageFile);

  try {
    await apiFetch(`/spots/${spotId}/messages`, {
      method: "POST",
      body: {
        name: name?.trim() || "Anonymous",
        comment: comment.trim(),
        imageDataUrl,
      },
    });
  } catch (e) {
    alert(e?.message || "Failed to post reply.");
  }

  await refreshFromServer();
}

async function deleteThreadInSpot(spotId) {
  try {
    await apiFetch(`/spots/${spotId}/thread`, { method: "DELETE" });
  } catch (e) {
    alert(e?.message || "Failed to delete thread.");
  }

  if (expandedSpotId === spotId) expandedSpotId = null;
  await refreshFromServer();
}

/* ---- Rendering ---- */

function render() {
  // Snapshot BEFORE any DOM rewrite
  const snap = snapshotFormState(el.spotsGrid);

  if (el.refreshStatus) {
    el.refreshStatus.textContent = `every ${REFRESH_SECONDS}s`;
  }

  const activeCount = spots.filter((s) => !!s.thread).length;
  if (el.spotsStatus) {
    el.spotsStatus.textContent = `${activeCount}/${SPOT_COUNT} active`;
  }

  el.tablesStage.classList.toggle("expanded", expandedSpotId !== null);
  if (el.backToTablesTop) el.backToTablesTop.classList.toggle("hidden", expandedSpotId === null);

  // When expanded: show only the expanded spot (others hidden)
  el.spotsGrid.innerHTML = spots
    .map((spot) => {
      const hidden = expandedSpotId !== null && expandedSpotId !== spot.spotId;
      const expanded = expandedSpotId === spot.spotId;
      return renderSpot(spot, { hidden, expanded });
    })
    .join("");

  spots.forEach((s) => wireSpotHandlers(s.spotId));

  // Restore AFTER render + handlers
  restoreFormState(el.spotsGrid, snap);
}

function renderSpot(spot, { hidden, expanded }) {
  const cls = ["spot"];
  if (hidden) cls.push("hidden");

  if (!expanded) {
    // PREVIEW MODE (fits inside table)
    return `
      <section class="${cls.join(" ")}" data-spot-id="${spot.spotId}">
        ${renderPreview(spot)}
      </section>
    `;
  }

  // EXPANDED MODE (full thread module)
  return `
    <section class="${cls.join(" ")}" data-spot-id="${spot.spotId}">
      <div class="thread-full">
        <div class="thread-full-bar">
          <div>
            <div class="thread-full-title">${escapeHtml(spot.thread?.title ?? defaultTitleForThread(spot.spotId))}</div>
            <div class="thread-full-meta">${
              spot.thread
                ? `#${spot.thread.threadId} - ${escapeHtml(spot.thread.createdAt)} - posts ${spot.thread.posts.length}`
                : `EMPTY`
            }</div>
          </div>
          <div class="thread-back" data-action="back-to-tables"><- back to tables</div>
        </div>

        <div class="divider"></div>

        ${spot.thread ? renderThreadPosts(spot) : renderCreateThreadForm(spot.spotId)}

        ${spot.thread ? `<div class="divider"></div>${renderReplyForm(spot.spotId)}` : ""}
        ${
          spot.thread
            ? `<div class="actions"><button type="button" class="btn btn-danger" data-action="delete-thread" data-spot-id="${spot.spotId}">Delete Thread</button></div>`
            : ""
        }
      </div>
    </section>
  `;
}

function renderPreview(spot) {
  const isEmpty = !spot.thread;

  const title = isEmpty ? `EMPTY` : spot.thread.title;
  const latest = isEmpty
    ? `Click to start a thread in this spot.`
    : snippet(spot.thread.posts[spot.thread.posts.length - 1]?.comment ?? "");

  return `
    <div class="thread-preview" data-action="expand-spot" data-spot-id="${spot.spotId}">
      <div class="preview-title">${escapeHtml(title)}</div>
      <div class="preview-snippet ${isEmpty ? "preview-empty" : ""}">${escapeHtml(latest)}</div>
      <div class="preview-hint">Click to view thread and reply</div>
    </div>
  `;
}

function renderThreadPosts(spot) {
  const posts = spot.thread.posts;
  const postsHtml = posts
    .map((p, idx) => {
      const isOp = idx === 0;
      const title = isOp ? "OP" : "REPLY";
      const imgHtml = p.imageDataUrl ? `<img class="post-image" src="${p.imageDataUrl}" alt="upload" />` : "";

      return `
      <article class="post" id="p${p.id}" data-post-id="${p.id}" data-spot-id="${spot.spotId}">
        <div class="post-header">
          <div class="post-left">
            <span class="post-name">${escapeHtml(p.name)}</span>
            <span class="post-time">${escapeHtml(p.createdAt)}</span>
            <span class="post-time">${title}</span>
          </div>
          <div class="post-no" role="button" tabindex="0" title="Click to quote" data-postno="${p.id}">
            No.${p.id}
          </div>
        </div>
        <div class="post-body">
          <div class="post-comment">${renderCommentWithQuotes(p.comment)}</div>
          ${imgHtml}
        </div>
      </article>
    `;
    })
    .join("");

  return `<div class="posts" data-posts-for="${spot.spotId}">${postsHtml}</div>`;
}

function renderCreateThreadForm(spotId) {
  return `
    <form class="form" data-form="create-thread" data-spot-id="${spotId}">
      <label class="field">
        <span class="field-label">Thread title</span>
        <input type="text" maxlength="60" name="title" placeholder="Untitled thread" />
      </label>

      <label class="field">
        <span class="field-label">Name (optional)</span>
        <input type="text" maxlength="32" name="name" placeholder="Anonymous" />
      </label>

      <label class="field">
        <span class="field-label">Comment</span>
        <textarea rows="6" maxlength="2000" name="comment" placeholder="Start the OP..."></textarea>
      </label>

      <label class="field">
        <span class="field-label">Image (optional)</span>
        <input type="file" accept="image/*" name="image" />
      </label>

      <div class="actions">
        <button type="submit" class="btn">Create Thread</button>
      </div>
    </form>
  `;
}

function renderReplyForm(spotId) {
  return `
    <form class="form" data-form="reply" data-spot-id="${spotId}">
      <div class="form-row">
        <label class="field">
          <span class="field-label">Name (optional)</span>
          <input type="text" maxlength="32" name="name" placeholder="Anonymous" />
        </label>

        <label class="field">
          <span class="field-label">Image (optional)</span>
          <input type="file" accept="image/*" name="image" />
        </label>
      </div>

      <label class="field">
        <span class="field-label">Reply</span>
        <textarea rows="5" maxlength="2000" name="comment" placeholder="Use >>123 to quote. Click No.### to insert."></textarea>
      </label>

      <div class="actions">
        <button type="submit" class="btn">Post Reply</button>
      </div>
    </form>
  `;
}

/* ---- Wiring ---- */

function wireSpotHandlers(spotId) {
  const spotEl = el.spotsGrid.querySelector(`.spot[data-spot-id="${spotId}"]`);
  if (!spotEl) return;

  // Expand on preview click
  const preview = spotEl.querySelector(`[data-action="expand-spot"][data-spot-id="${spotId}"]`);
  if (preview) {
    preview.addEventListener("click", () => {
      expandedSpotId = spotId;
      render();
      spotEl.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }

  // Back to tables
  const back = spotEl.querySelector(`[data-action="back-to-tables"]`);
  if (back) {
    back.addEventListener("click", () => {
      expandedSpotId = null;
      render();
    });
  }

  // Create thread form
  const createForm = spotEl.querySelector(`form[data-form="create-thread"]`);
  if (createForm) {
    createForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(createForm);
      const comment = String(fd.get("comment") ?? "");
      if (!comment.trim()) return;

      await createThreadInSpot(spotId, {
        title: String(fd.get("title") ?? ""),
        name: String(fd.get("name") ?? ""),
        comment,
        imageFile: createForm.querySelector('input[type="file"][name="image"]')?.files?.[0] ?? null,
      });

      render();
    });
  }

  // Reply form
  const replyForm = spotEl.querySelector(`form[data-form="reply"]`);
  if (replyForm) {
    replyForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(replyForm);
      const comment = String(fd.get("comment") ?? "");
      if (!comment.trim()) return;

      await addReplyToSpotThread(spotId, {
        name: String(fd.get("name") ?? ""),
        comment,
        imageFile: replyForm.querySelector('input[type="file"][name="image"]')?.files?.[0] ?? null,
      });

      render();
    });
  }

  // Delete thread
  const delBtn = spotEl.querySelector(`[data-action="delete-thread"][data-spot-id="${spotId}"]`);
  if (delBtn) {
    delBtn.addEventListener("click", () => {
      deleteThreadInSpot(spotId);
      render();
    });
  }

  // Click No.### to insert quote
  spotEl.querySelectorAll(".post-no").forEach((node) => {
    node.addEventListener("click", () => {
      const postId = node.getAttribute("data-postno");
      const replyTextarea = spotEl.querySelector(`form[data-form="reply"] textarea[name="comment"]`);
      if (!postId || !replyTextarea) return;
      insertAtCursor(replyTextarea, `>>${postId}`);
    });
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") node.click();
    });
  });

  // Clicking a quote link inserts it into reply
  spotEl.querySelectorAll("a.quote").forEach((a) => {
    a.addEventListener("click", () => {
      const q = a.getAttribute("data-quote");
      const replyTextarea = spotEl.querySelector(`form[data-form="reply"] textarea[name="comment"]`);
      if (!q || !replyTextarea) return;
      insertAtCursor(replyTextarea, `>>${q}`);
    });
  });
}

/* ---- Sticky header height ---- */
function syncHeaderHeightVar() {
  const h = el.header?.getBoundingClientRect?.().height ?? 110;
  document.documentElement.style.setProperty("--header-height", `${Math.ceil(h)}px`);
}

/* ---- Clock + refresh loop ---- */
function tickClock() {
  el.clock.textContent = `LOCAL TIME: ${new Date().toLocaleString()}`;
}

window.addEventListener("resize", syncHeaderHeightVar);
syncHeaderHeightVar();

if (el.backToTablesTop) {
  el.backToTablesTop.addEventListener("click", () => {
    expandedSpotId = null;
    render();
  });
}

tickClock();
setInterval(tickClock, 1000);

refreshFromServer()
  .catch((e) => console.warn("Failed initial refresh:", e))
  .finally(() => render());

// IMPORTANT: don't erase in-progress typing or selected files on refresh tick
setInterval(async () => {
  if (hasSelectedFile(el.spotsGrid)) return;
  if (isUserTypingIn(el.spotsGrid)) return;

  try {
    await refreshFromServer();
  } catch (e) {
    console.warn("Refresh failed:", e);
    // Keep current UI state if refresh fails.
  }

  render();
}, REFRESH_SECONDS * 1000);

(() => {
  const HLS_CANDIDATES = Array.from(new Set([
    `${location.protocol}//${location.host}/live/live.m3u8`,
    `${location.protocol}//${location.hostname}:8088/live/live.m3u8`,
    "https://flybynight.channel/live/live.m3u8",
  ]));

  const PUBLISH_URL = `webrtc://${location.host}/live/live`;
  const LOCK_STATUS_URL = `${location.protocol}//${location.host}/control/status`;
  const STOP_STREAM_URL = `${location.protocol}//${location.host}/control/stop`;
  const LOCK_POLL_MS = 1500;
  const PLAYBACK_RETRY_MS = 1800;
  const STALE_PROGRESS_TIMEOUT_MS = 12000;
  const STALE_CHECK_INTERVAL_MS = 2000;

  const video = document.getElementById("live-video");
  const statusEl = document.getElementById("live-status");
  const overlay = document.getElementById("live-overlay");
  const startBtn = document.getElementById("btnStartStream");
  const stopBtn = document.getElementById("btnStopStream");
  const pubStatus = document.getElementById("pubStatus");
  const localPreview = document.getElementById("local-preview");

  if (!video || !statusEl || !overlay || !startBtn || !stopBtn || !pubStatus || !localPreview) return;

  let hls = null;
  let publisher = null;
  let liveKnown = false;
  let uiState = "offline"; // offline | starting | live | stopping | error
  let activeHlsUrl = HLS_CANDIDATES[0];
  let pollInFlight = false;
  let retryTimer = null;
  let staleTimer = null;
  let playbackMode = "none"; // none | native | hls
  let lastProgressAt = 0;
  let lastCurrentTime = 0;

  function setState(nextState, detail = "") {
    uiState = nextState;
    statusEl.textContent = detail ? `${nextState}: ${detail}` : nextState;
    refreshControls();
  }

  function setPublisherStatus(text) {
    pubStatus.textContent = text || "";
  }

  function stopTracks(stream) {
    if (!stream) return;
    for (const track of stream.getTracks?.() ?? []) {
      try { track.stop(); } catch {}
    }
  }

  // Streamer self-preview is always local getUserMedia/publisher media, never HLS playback.
  function setLocalPreviewStream(stream) {
    const prev = localPreview.srcObject;
    if (prev && prev !== stream) stopTracks(prev);

    localPreview.srcObject = stream || null;
    localPreview.classList.toggle("hidden", !stream);
    if (stream) localPreview.play().catch(() => {});
    refreshControls();
  }

  function clearLocalPreview() {
    try { localPreview.pause(); } catch {}
    stopTracks(localPreview.srcObject);
    localPreview.srcObject = null;
    localPreview.classList.add("hidden");
    refreshControls();
  }

  function stopStaleWatch() {
    if (!staleTimer) return;
    clearInterval(staleTimer);
    staleTimer = null;
  }

  function markPlaybackProgress() {
    lastProgressAt = Date.now();
    lastCurrentTime = video.currentTime || 0;
  }

  function resetPlaybackElement() {
    video.onerror = null;
    try { video.pause(); } catch {}
    video.srcObject = null;
    video.removeAttribute("src");
    video.load();
  }

  // Aggressive teardown to prevent stale replay when stream is dead/stopped.
  function teardownPlayback() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    stopStaleWatch();
    if (hls) {
      try { hls.stopLoad(); } catch {}
      try { hls.detachMedia(); } catch {}
      try { hls.destroy(); } catch {}
      hls = null;
    }
    playbackMode = "none";
    resetPlaybackElement();
  }

  function refreshControls() {
    const hasLocalPreview = !!localPreview.srcObject;
    const canStart = !liveKnown && !publisher && uiState !== "starting" && uiState !== "stopping";
    const canStop = !!publisher || uiState === "starting" || uiState === "stopping";
    const showPlayback = liveKnown && !hasLocalPreview;
    const showOverlay = hasLocalPreview || !showPlayback || uiState !== "live";

    startBtn.classList.toggle("hidden", !canStart);
    startBtn.disabled = !canStart;

    stopBtn.classList.toggle("hidden", !canStop);
    stopBtn.disabled = uiState === "stopping" || (!publisher && uiState !== "starting");

    overlay.classList.toggle("hidden", !showOverlay);
    video.classList.toggle("stream-hidden", !showPlayback);
  }

  async function fetchLiveLock() {
    const r = await fetch(`${LOCK_STATUS_URL}?_=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`lock status ${r.status}`);
    const data = await r.json();
    return !!data?.live;
  }

  async function sendStopSignal() {
    try {
      await fetch(`${STOP_STREAM_URL}?_=${Date.now()}`, {
        method: "POST",
        cache: "no-store",
        keepalive: true,
      });
    } catch {}
  }

  function schedulePlaybackRetry(ms = PLAYBACK_RETRY_MS) {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      ensureViewerPlayback();
    }, ms);
  }

  const bust = (url = activeHlsUrl) => `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`;

  async function selectPlayableHlsUrl() {
    for (const candidate of HLS_CANDIDATES) {
      try {
        const r = await fetch(bust(candidate), { method: "GET", cache: "no-store" });
        if (!r.ok) continue;
        activeHlsUrl = candidate;
        return true;
      } catch {}
    }
    return false;
  }

  function handleStalePlayback() {
    if (!liveKnown || publisher) return;
    teardownPlayback();
    setState("starting", "waiting for HLS");
    schedulePlaybackRetry();
  }

  function startStaleWatch() {
    stopStaleWatch();
    markPlaybackProgress();

    staleTimer = setInterval(() => {
      const now = Date.now();
      const current = video.currentTime || 0;
      const hasFutureData = video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
      const likelyUserPaused = video.paused && hasFutureData && !video.ended;

      if (likelyUserPaused) {
        markPlaybackProgress();
        return;
      }

      if (current > lastCurrentTime + 0.05) {
        markPlaybackProgress();
        return;
      }

      if (now - lastProgressAt >= STALE_PROGRESS_TIMEOUT_MS) {
        handleStalePlayback();
      }
    }, STALE_CHECK_INTERVAL_MS);
  }

  async function startNativePlayback() {
    teardownPlayback();
    playbackMode = "native";
    video.src = bust(activeHlsUrl);

    video.onerror = () => {
      if (!liveKnown || publisher) return;
      teardownPlayback();
      setState("starting", "waiting for HLS");
      schedulePlaybackRetry();
    };

    try {
      await video.play();
      setState("live");
      startStaleWatch();
    } catch {
      setState("live", "click to play");
    }
  }

  function startHlsPlayback() {
    teardownPlayback();
    playbackMode = "hls";

    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      manifestLoadingMaxRetry: 2,
      levelLoadingMaxRetry: 2,
      fragLoadingMaxRetry: 2,
      manifestLoadingRetryDelay: 500,
      levelLoadingRetryDelay: 500,
      fragLoadingRetryDelay: 500,
      backBufferLength: 0,
      maxBufferLength: 8,
    });

    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data?.fatal || !liveKnown || publisher) return;
      teardownPlayback();
      setState("starting", "waiting for HLS");
      schedulePlaybackRetry();
    });

    hls.on(Hls.Events.MANIFEST_PARSED, async () => {
      try {
        await video.play();
        setState("live");
        startStaleWatch();
      } catch {
        setState("live", "click to play");
      }
    });

    hls.loadSource(bust(activeHlsUrl));
    hls.attachMedia(video);
  }

  async function ensureViewerPlayback() {
    // HLS playback is viewer/live playback only. Streamers use local preview.
    if (!liveKnown || publisher || localPreview.srcObject) {
      teardownPlayback();
      if (!publisher && !liveKnown && uiState !== "stopping") {
        setState("offline");
      }
      return;
    }

    // Avoid resetting a currently active/connecting playback session on every status poll.
    if (playbackMode !== "none" || retryTimer) return;

    setState("starting");
    const found = await selectPlayableHlsUrl();
    if (!found) {
      setState("starting", "waiting for HLS");
      schedulePlaybackRetry();
      return;
    }

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      await startNativePlayback();
      return;
    }

    if (window.Hls && window.Hls.isSupported()) {
      startHlsPlayback();
      return;
    }

    setState("error", "HLS unsupported");
  }

  async function syncLiveStatus(force = false) {
    if (pollInFlight && !force) return;
    pollInFlight = true;
    try {
      const serverLive = await fetchLiveLock();
      liveKnown = serverLive || !!publisher;

      if (!liveKnown) {
        teardownPlayback();
        if (!publisher && uiState !== "stopping") {
          setState("offline");
          setPublisherStatus("Offline.");
        }
      } else if (!publisher) {
        await ensureViewerPlayback();
        setPublisherStatus("Live now. Viewing only.");
      } else {
        setState("live");
        setPublisherStatus("Live. Local preview is direct camera/mic.");
      }
    } catch {
      if (!publisher) {
        setState("error", "status check failed");
        setPublisherStatus("Cannot verify live status.");
      }
    } finally {
      pollInFlight = false;
      refreshControls();
    }
  }

  async function startPublishing() {
    if (publisher || uiState === "starting" || uiState === "stopping") return;

    setState("starting");
    setPublisherStatus("Requesting camera/mic...");

    try {
      const serverLive = await fetchLiveLock();
      if (serverLive) {
        liveKnown = true;
        setState("offline");
        setPublisherStatus("Another client is live.");
        await ensureViewerPlayback();
        return;
      }
    } catch {
      setState("error", "status check failed");
      setPublisherStatus("Cannot verify live status.");
      return;
    }

    let previewStream = null;
    try {
      // Immediate local preview for the streamer, independent from HLS.
      previewStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalPreviewStream(previewStream);

      setPublisherStatus("Starting publish transport...");
      publisher = new SrsRtcPublisherAsync();
      await publisher.publish(PUBLISH_URL);

      const publishStream = publisher.stream || previewStream;
      if (publishStream !== previewStream) stopTracks(previewStream);
      setLocalPreviewStream(publishStream);

      liveKnown = true;
      teardownPlayback();
      setState("live");
      setPublisherStatus("Live. Local preview is direct camera/mic.");
    } catch (e) {
      console.error(e);
      try { await publisher?.close(); } catch {}
      publisher = null;
      clearLocalPreview();
      liveKnown = false;
      setState("error", "start failed");
      setPublisherStatus(`Failed to start: ${e?.message || e}`);
      await syncLiveStatus(true);
    }
  }

  async function stopPublishing({ silent = false, fromUnload = false } = {}) {
    if (uiState === "stopping") return;

    setState("stopping");
    if (!silent) setPublisherStatus("Stopping stream...");

    const closing = publisher;
    publisher = null;

    try {
      await closing?.close();
    } catch (e) {
      if (!silent) console.warn("stop error", e);
    }

    clearLocalPreview();
    teardownPlayback();
    liveKnown = false;

    if (!fromUnload) await sendStopSignal();
    await syncLiveStatus(true);

    if (!silent) setPublisherStatus("Stopped.");
    setState("offline");
  }

  startBtn.addEventListener("click", () => startPublishing());
  stopBtn.addEventListener("click", () => stopPublishing());

  video.addEventListener("timeupdate", markPlaybackProgress);
  video.addEventListener("playing", () => {
    markPlaybackProgress();
    if (!staleTimer) startStaleWatch();
  });
  video.addEventListener("ended", handleStalePlayback);

  // Best-effort immediate unlock for abrupt tab close, plus local teardown.
  const unloadHandler = () => {
    try {
      navigator.sendBeacon(STOP_STREAM_URL, "{}");
    } catch {}
    try { publisher?.close?.(); } catch {}
    clearLocalPreview();
    teardownPlayback();
  };
  window.addEventListener("pagehide", unloadHandler);
  window.addEventListener("beforeunload", unloadHandler);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) syncLiveStatus(true);
  });

  setState("offline");
  setPublisherStatus("Checking stream status...");
  syncLiveStatus(true);
  setInterval(() => {
    syncLiveStatus();
  }, LOCK_POLL_MS);
})();
