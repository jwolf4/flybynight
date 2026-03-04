/**
 * Fly By Night â€” 5 thread-spots w/ preview + expanded thread view (in-memory only)
 */

const REFRESH_SECONDS = 10;
const SPOT_COUNT = 5;
const STORAGE_KEY = "flybynight.thread_state.v1";
const STORAGE_DAY_KEY = "flybynight.thread_state.day";
const DAY_ROLLOVER_CHECK_MS = 60 * 1000;

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
  return s.slice(0, max - 1) + "â€¦";
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

/* ---- Mutations ---- */

async function createThreadInSpot(spotId, { title, name, comment, imageFile }) {
  const spot = spots.find((s) => s.spotId === spotId);
  if (!spot || spot.thread) return;

  const imageDataUrl = await fileToDataUrl(imageFile);

  const threadId = nextThreadId++;
  const createdAt = nowIso();

  const opPost = {
    id: nextPostId++,
    name: name?.trim() || "Anonymous",
    comment: comment.trim(),
    createdAt,
    imageDataUrl,
  };

  spot.thread = {
    threadId,
    createdAt,
    title: title?.trim() || defaultTitleForThread(spotId),
    posts: [opPost],
  };

  saveThreadState();
}

async function addReplyToSpotThread(spotId, { name, comment, imageFile }) {
  const spot = spots.find((s) => s.spotId === spotId);
  if (!spot?.thread) return;

  const imageDataUrl = await fileToDataUrl(imageFile);

  const post = {
    id: nextPostId++,
    name: name?.trim() || "Anonymous",
    comment: comment.trim(),
    createdAt: nowIso(),
    imageDataUrl,
  };

  spot.thread.posts.push(post);
  saveThreadState();
}

function deleteThreadInSpot(spotId) {
  const spot = spots.find((s) => s.spotId === spotId);
  if (!spot) return;
  spot.thread = null;
  if (expandedSpotId === spotId) expandedSpotId = null;
  saveThreadState();
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
                ? `#${spot.thread.threadId} â€” ${escapeHtml(spot.thread.createdAt)} â€” posts ${spot.thread.posts.length}`
                : `EMPTY`
            }</div>
          </div>
          <div class="thread-back" data-action="back-to-tables">â† back to tables</div>
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

loadThreadState();
render();

// IMPORTANT: don't erase in-progress typing or selected files on refresh tick
setInterval(() => {
  if (hasSelectedFile(el.spotsGrid)) return;
  if (isUserTypingIn(el.spotsGrid)) return;
  if (ensureCurrentDayStorage()) {
    spots = Array.from({ length: SPOT_COUNT }, (_, i) => ({ spotId: i + 1, thread: null }));
    nextThreadId = 1;
    nextPostId = 100;
    expandedSpotId = null;
  }
  render();
}, REFRESH_SECONDS * 1000);

setInterval(() => {
  if (!ensureCurrentDayStorage()) return;
  spots = Array.from({ length: SPOT_COUNT }, (_, i) => ({ spotId: i + 1, thread: null }));
  nextThreadId = 1;
  nextPostId = 100;
  expandedSpotId = null;
  render();
}, DAY_ROLLOVER_CHECK_MS);

(() => {
  const HLS_CANDIDATES = Array.from(new Set([
    `${location.protocol}//${location.host}/live/live.m3u8`,
    `${location.protocol}//${location.hostname}:8088/live/live.m3u8`,
    "https://flybynight.channel/live/live.m3u8",
  ]));
  const STALE_PROGRESS_TIMEOUT_MS = 15000;
  const STALE_CHECK_INTERVAL_MS = 3000;

  const video = document.getElementById("live-video");
  const statusEl = document.getElementById("live-status");
  const overlay = document.getElementById("live-overlay");

  if (!video || !statusEl || !overlay) return;

  let hls = null;
  let retryTimer = null;
  let staleTimer = null;
  let lastProgressAt = 0;
  let lastCurrentTime = 0;
  let activeHlsUrl = HLS_CANDIDATES[0];

  const setStatus = (text, showOverlay) => {
    statusEl.textContent = text;
    overlay.classList.toggle("hidden", !showOverlay);
    video.classList.toggle("stream-hidden", showOverlay);
  };

  const bust = (url = activeHlsUrl) => `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`;

  const selectPlayableHlsUrl = async () => {
    for (const candidate of HLS_CANDIDATES) {
      try {
        const r = await fetch(bust(candidate), { method: "GET", cache: "no-store" });
        if (!r.ok) continue;
        activeHlsUrl = candidate;
        return true;
      } catch {
        // Try next candidate URL.
      }
    }
    return false;
  };

  const stopStaleWatch = () => {
    if (staleTimer) {
      clearInterval(staleTimer);
      staleTimer = null;
    }
  };

  const markPlaybackProgress = () => {
    lastProgressAt = Date.now();
    lastCurrentTime = video.currentTime || 0;
  };

  const handleStaleStream = () => {
    setStatus("offline (stale stream, retrying...)", true);
    cleanup();
    scheduleRetry(2000);
  };

  const startStaleWatch = () => {
    stopStaleWatch();
    markPlaybackProgress();
    staleTimer = setInterval(() => {
      const now = Date.now();
      const current = video.currentTime || 0;

      const hasFutureData = video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
      const likelyUserPaused = video.paused && hasFutureData && !video.ended;
      if (likelyUserPaused) {
        // User likely paused with buffered media available; don't force retries.
        markPlaybackProgress();
        return;
      }

      if (current > lastCurrentTime + 0.05) {
        markPlaybackProgress();
        return;
      }

      if (now - lastProgressAt >= STALE_PROGRESS_TIMEOUT_MS) {
        handleStaleStream();
      }
    }, STALE_CHECK_INTERVAL_MS);
  };

  const cleanup = () => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    stopStaleWatch();
    if (hls) {
      try { hls.destroy(); } catch {}
      hls = null;
    }
    // Donâ€™t keep old sources around
    video.removeAttribute("src");
    video.load();
  };

  const scheduleRetry = (ms = 4000) => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => start(), ms);
  };

  const startNative = async () => {
    cleanup();
    setStatus("live: connectingâ€¦", true);

    video.src = bust();
    try {
      await video.play();
      setStatus("live", false);
      startStaleWatch();
    } catch {
      // Autoplay might be blocked; keep overlay off once data flows
      setStatus("live (click to play)", true);
    }

    // If it errors (stream offline), retry
    video.onerror = () => {
      setStatus("offline (retryingâ€¦)", true);
      scheduleRetry(4000);
    };
  };

  const startHlsJs = () => {
    cleanup();
    setStatus("live: connectingâ€¦", true);

    hls = new Hls({
      // Low-latency not required for you; keep it stable
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 30,
    });

    hls.on(Hls.Events.ERROR, (_evt, data) => {
      // Network/media errors: treat as offline and retry
      if (data && data.fatal) {
        setStatus("offline (retryingâ€¦)", true);
        cleanup();
        scheduleRetry(4000);
      }
    });

    hls.on(Hls.Events.MANIFEST_PARSED, async () => {
      try {
        await video.play();
        setStatus("live", false);
        startStaleWatch();
      } catch {
        setStatus("live (click to play)", true);
      }
    });

    hls.loadSource(bust());
    hls.attachMedia(video);
  };

  const start = async () => {
    // Quick â€œis there a stream?â€ probe:
    // If 404, donâ€™t spin up hls.js, just show offline and retry.
    setStatus("checking...", true);
    if (!(await selectPlayableHlsUrl())) {
      setStatus("offline", true);
      scheduleRetry(4000);
      return;
    }

    // Choose native HLS where available (Safari), otherwise hls.js
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      startNative();
    } else if (window.Hls && window.Hls.isSupported()) {
      startHlsJs();
    } else {
      setStatus("HLS not supported in this browser", true);
    }
  };

  // Start now
  start();

  video.addEventListener("timeupdate", markPlaybackProgress);
  video.addEventListener("playing", () => {
    markPlaybackProgress();
    if (!staleTimer) startStaleWatch();
  });
  video.addEventListener("ended", handleStaleStream);

  // If tab returns to foreground, refresh (helps with your sliding window)
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) start();
  });
})();

(() => {
  const btn = document.getElementById("btnToggleStream");
  const status = document.getElementById("pubStatus");
  const preview = document.getElementById("pub-preview");
  if (!btn || !status) return;

  // SRS publish URL. Note: webrtc:// (SRS uses HTTPS signaling under the hood)
  const PUBLISH_URL = `webrtc://${location.host}/live/live`;
  const LOCK_STATUS_URL = `${location.protocol}//${location.host}/control/status`;
  const LOCK_POLL_MS = 2000;

  let publisher = null; // SRSPublisher from srs.sdk.js

  function setState(on, msg) {
    btn.textContent = on ? "Stop Streaming" : "Start Streaming";
    status.textContent = msg || "";
  }

  function setPreview(stream) {
    if (!preview) return;
    preview.srcObject = stream || null;
    preview.classList.toggle("hidden", !stream);
    if (stream) preview.play().catch(() => {});
  }

  async function fetchLiveLock() {
    const r = await fetch(`${LOCK_STATUS_URL}?_=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`lock status ${r.status}`);
    const data = await r.json();
    return !!data?.live;
  }

  async function syncStartAvailability() {
    if (publisher) {
      btn.classList.remove("hidden");
      btn.disabled = false;
      return;
    }

    try {
      const live = await fetchLiveLock();
      if (live) {
        btn.classList.add("hidden");
        btn.disabled = true;
        setState(false, "Live now. Viewing only.");
      } else {
        btn.classList.remove("hidden");
        btn.disabled = false;
        if (!status.textContent || status.textContent === "Live now. Viewing only.") {
          setState(false, "Offline.");
        }
      }
    } catch {
      // Fail closed in UI, while hooks still enforce lock server-side.
      btn.classList.add("hidden");
      btn.disabled = true;
      setState(false, "Checking stream status...");
    }
  }

  async function start() {
    try {
      const live = await fetchLiveLock();
      if (live) {
        btn.classList.add("hidden");
        btn.disabled = true;
        setState(false, "Another client is live.");
        return;
      }
    } catch {
      setState(false, "Cannot verify live status.");
      return;
    }

    btn.classList.remove("hidden");
    btn.disabled = false;
    setState(true, "Requesting camera/mic...");

    try {
      // Create publisher
      publisher = new SrsRtcPublisherAsync();

      // Ask for cam/mic and publish
      await publisher.publish(PUBLISH_URL);

      setPreview(publisher.stream || null);
      setState(true, "Publishing. Stage playback may take a few seconds.");
    } catch (e) {
      console.error(e);
      await stop(true);
      setState(false, `Failed to start: ${e?.message || e}`);
      await syncStartAvailability();
    }
  }

  async function stop(silent) {
    try {
      if (publisher) {
        // Close peer connection + stop tracks
        await publisher.close();
      }
    } catch (e) {
      if (!silent) console.warn("stop error", e);
    } finally {
      publisher = null;
      setPreview(null);
      if (!silent) setState(false, "Stopped.");
      else setState(false, "");
      await syncStartAvailability();
    }
  }

  btn.addEventListener("click", async () => {
    if (!publisher) await start();
    else await stop(false);
  });

  setState(false, "Checking stream status...");
  syncStartAvailability();
  setInterval(syncStartAvailability, LOCK_POLL_MS);
})();
