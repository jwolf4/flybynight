/**
 * Fly By Night — 5 thread-spots "catalog" prototype (in-memory only)
 * - Fixed spots: 1..5
 * - Each spot can host 0 or 1 thread
 * - Thread = OP post + replies
 * - Post No.<id>, quoting with >>id
 * - Click No.<id> to insert >>id in that spot's reply box
 * - Render loop every N seconds (plus immediate render after posting)
 */

const REFRESH_SECONDS = 10;
const SPOT_COUNT = 5;

// ---- In-memory state ----
/**
 * spots = [
 *  { spotId: 1, thread: null | { threadId, createdAt, posts: Post[] } },
 *  ...
 * ]
 */
let spots = Array.from({ length: SPOT_COUNT }, (_, i) => ({
  spotId: i + 1,
  thread: null,
}));

let nextThreadId = 1;
let nextPostId = 100;

// ---- DOM ----
const el = {
  spotsGrid: document.getElementById("spotsGrid"),
  spotsStatus: document.getElementById("spotsStatus"),
  refreshStatus: document.getElementById("refreshStatus"),
  clock: document.getElementById("clock"),
};

// ---- Utilities ----
function nowIso() {
  const d = new Date();
  return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function escapeHtml(str) {
  return str
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

// ---- Mutations ----
async function createThreadInSpot(spotId, { name, comment, imageFile }) {
  const spot = spots.find(s => s.spotId === spotId);
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
    posts: [opPost],
  };
}

async function addReplyToSpotThread(spotId, { name, comment, imageFile }) {
  const spot = spots.find(s => s.spotId === spotId);
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
}

function deleteThreadInSpot(spotId) {
  const spot = spots.find(s => s.spotId === spotId);
  if (!spot) return;
  spot.thread = null;
}

async function seedDemo() {
  // Fill 2 spots with demo threads
  await createThreadInSpot(1, {
    name: "Anonymous",
    comment: "Spot 1 OP: catalog view prototype.\nClick No.### to quote.\nTry writing >>100 in a reply.",
    imageFile: null
  });
  await addReplyToSpotThread(1, { name: "Anonymous", comment: "replying to >>100", imageFile: null });
  await addReplyToSpotThread(1, { name: "Anonymous", comment: "chain: >>100 >>101", imageFile: null });

  await createThreadInSpot(3, {
    name: "Anonymous",
    comment: "Spot 3 OP: this thread stays here.\nNo bump logic.\nDeletion = explicit for now.",
    imageFile: null
  });
  await addReplyToSpotThread(3, { name: "Anonymous", comment: "ok", imageFile: null });
}

// ---- Rendering ----
function render() {
  el.refreshStatus.textContent = `every ${REFRESH_SECONDS}s`;

  const activeCount = spots.filter(s => !!s.thread).length;
  el.spotsStatus.textContent = `${activeCount}/${SPOT_COUNT} active`;

  el.spotsGrid.innerHTML = spots.map(spot => renderSpot(spot)).join("");

  // attach handlers for each spot
  spots.forEach((spot) => {
    wireSpotHandlers(spot.spotId);
  });
}

function renderSpot(spot) {
  const isEmpty = !spot.thread;

  const headerBadge = isEmpty
    ? `<span class="badge empty">EMPTY</span>`
    : `<span class="badge active">ACTIVE</span>`;

  const meta = isEmpty
    ? `—`
    : `#${spot.thread.threadId} — ${spot.thread.createdAt} — posts ${spot.thread.posts.length}`;

  const body = isEmpty
    ? renderSpotEmptyBody(spot.spotId)
    : renderSpotThreadBody(spot.spotId, spot.thread);

  return `
    <section class="spot" data-spot-id="${spot.spotId}">
      <div class="spot-header">
        <div class="spot-title">Thread Spot ${spot.spotId}</div>
        <div style="display:flex; gap:10px; align-items:baseline;">
          <div class="spot-meta">${escapeHtml(meta)}</div>
          ${headerBadge}
        </div>
      </div>

      <div class="spot-body">
        ${body}
      </div>

      <div class="spot-footer">
        <div class="spot-meta">—</div>
      </div>
    </section>
  `;
}

function renderSpotEmptyBody(spotId) {
  return `
    <form class="form" data-form="create-thread" data-spot-id="${spotId}">
      <label class="field">
        <span class="field-label">Name (optional)</span>
        <input type="text" maxlength="32" name="name" placeholder="Anonymous" />
      </label>

      <label class="field">
        <span class="field-label">Comment</span>
        <textarea rows="5" maxlength="2000" name="comment" placeholder="Start a thread in Spot ${spotId}..."></textarea>
      </label>

      <label class="field">
        <span class="field-label">Image (optional)</span>
        <input type="file" accept="image/*" name="image" />
      </label>

      <div class="actions">
        <button type="submit" class="btn">Create Thread</button>
        ${spotId === 1 ? `<button type="button" class="btn btn-ghost" data-action="seed-demo">Seed Demo</button>` : ""}
      </div>
    </form>
  `;
}

function renderSpotThreadBody(spotId, thread) {
  const postsHtml = thread.posts.map((p, idx) => {
    const isOp = idx === 0;
    const title = isOp ? "OP" : "REPLY";

    const imgHtml = p.imageDataUrl
      ? `<img class="post-image" src="${p.imageDataUrl}" alt="upload" />`
      : "";

    return `
      <article class="post" id="p${p.id}" data-post-id="${p.id}" data-spot-id="${spotId}">
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
  }).join("");

  return `
    <div class="posts" data-posts-for="${spotId}">
      ${postsHtml}
    </div>

    <div class="divider"></div>

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
        <textarea rows="4" maxlength="2000" name="comment" placeholder="Use >>123 to quote. Click No.### to insert."></textarea>
      </label>

      <div class="actions">
        <button type="submit" class="btn">Post Reply</button>
        <button type="button" class="btn btn-danger" data-action="delete-thread" data-spot-id="${spotId}">Delete Thread</button>
      </div>
    </form>
  `;
}

function wireSpotHandlers(spotId) {
  const spotEl = el.spotsGrid.querySelector(`.spot[data-spot-id="${spotId}"]`);
  if (!spotEl) return;

  // Seed demo button (only exists in spot 1 create form)
  const seedBtn = spotEl.querySelector(`[data-action="seed-demo"]`);
  if (seedBtn) {
    seedBtn.addEventListener("click", async () => {
      await seedDemo();
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
        name: String(fd.get("name") ?? ""),
        comment,
        imageFile: (createForm.querySelector('input[type="file"][name="image"]')?.files?.[0]) ?? null,
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
        imageFile: (replyForm.querySelector('input[type="file"][name="image"]')?.files?.[0]) ?? null,
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

  // Click No.### to insert quote into that spot's reply textarea
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

  // Clicking a quote link inserts it into that spot's reply box too
  spotEl.querySelectorAll("a.quote").forEach((a) => {
    a.addEventListener("click", () => {
      const q = a.getAttribute("data-quote");
      const replyTextarea = spotEl.querySelector(`form[data-form="reply"] textarea[name="comment"]`);
      if (!q || !replyTextarea) return;
      insertAtCursor(replyTextarea, `>>${q}`);
    });
  });
}

// ---- Clock + refresh loop ----
function tickClock() {
  el.clock.textContent = `LOCAL TIME: ${new Date().toLocaleString()}`;
}

tickClock();
setInterval(tickClock, 1000);

render();
setInterval(render, REFRESH_SECONDS * 1000);