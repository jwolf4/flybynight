/**
 * Fly By Night — Thread UI Prototype (in-memory only)
 * - One thread at a time
 * - Posts with No.<id>, quoting via >>id
 * - Click post number to insert >>id into reply box
 * - Rerender "refresh" only every N seconds
 */

const REFRESH_SECONDS = 10;

// ---- In-memory state (lost on reload) ----
let thread = null; // { threadId, createdAt, posts: Post[] }
let nextThreadId = 1;
let nextPostId = 100; // chan-like feel: global-ish number

// Post: { id, name, comment, createdAt, imageDataUrl? }

// ---- DOM ----
const el = {
  threadStatus: document.getElementById("threadStatus"),
  refreshStatus: document.getElementById("refreshStatus"),
  clock: document.getElementById("clock"),

  createThreadBox: document.getElementById("createThreadBox"),
  createThreadForm: document.getElementById("createThreadForm"),
  opName: document.getElementById("opName"),
  opComment: document.getElementById("opComment"),
  opImage: document.getElementById("opImage"),
  seedDemo: document.getElementById("seedDemo"),

  threadBox: document.getElementById("threadBox"),
  threadMeta: document.getElementById("threadMeta"),
  threadPosts: document.getElementById("threadPosts"),

  replyForm: document.getElementById("replyForm"),
  replyName: document.getElementById("replyName"),
  replyComment: document.getElementById("replyComment"),
  replyImage: document.getElementById("replyImage"),
  deleteThread: document.getElementById("deleteThread"),
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

// Convert >>123 into anchor links to #p123
function renderCommentWithQuotes(comment) {
  const safe = escapeHtml(comment);

  // Replace >>123 with <a class="quote" href="#p123">>>123</a>
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

// ---- Thread operations ----
async function createThread({ name, comment, imageFile }) {
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

  thread = {
    threadId,
    createdAt,
    posts: [opPost],
  };
}

async function addReply({ name, comment, imageFile }) {
  if (!thread) return;

  const imageDataUrl = await fileToDataUrl(imageFile);

  const post = {
    id: nextPostId++,
    name: name?.trim() || "Anonymous",
    comment: comment.trim(),
    createdAt: nowIso(),
    imageDataUrl,
  };

  thread.posts.push(post);
}

function deleteCurrentThread() {
  thread = null;
}

// ---- Rendering (only called on refresh tick, not on every keystroke) ----
function render() {
  el.refreshStatus.textContent = `every ${REFRESH_SECONDS}s`;

  if (!thread) {
    el.threadStatus.textContent = "EMPTY";
    el.createThreadBox.classList.remove("hidden");
    el.threadBox.classList.add("hidden");
    el.threadPosts.innerHTML = "";
    el.threadMeta.textContent = "";
    return;
  }

  el.threadStatus.textContent = `ACTIVE (#${thread.threadId})`;
  el.createThreadBox.classList.add("hidden");
  el.threadBox.classList.remove("hidden");

  el.threadMeta.textContent = `— created ${thread.createdAt} — posts ${thread.posts.length}`;

  const postsHtml = thread.posts.map((p, idx) => {
    const isOp = idx === 0;
    const title = isOp ? "OP" : "REPLY";

    const imgHtml = p.imageDataUrl
      ? `<img class="post-image" src="${p.imageDataUrl}" alt="upload" />`
      : "";

    return `
      <article class="post" id="p${p.id}" data-post-id="${p.id}">
        <div class="post-header">
          <div class="post-left">
            <span class="post-name">${escapeHtml(p.name)}</span>
            <span class="post-time">${escapeHtml(p.createdAt)}</span>
            <span class="post-time">${title}</span>
          </div>
          <div class="post-no" role="button" tabindex="0" title="Click to quote">
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

  el.threadPosts.innerHTML = postsHtml;

  // Attach click handlers for "No.###" quoting
  el.threadPosts.querySelectorAll(".post-no").forEach((node) => {
    node.addEventListener("click", () => {
      const postEl = node.closest(".post");
      const postId = postEl?.dataset?.postId;
      if (!postId) return;
      insertAtCursor(el.replyComment, `>>${postId}`);
    });
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") node.click();
    });
  });

  // Optional: clicking a quote link also inserts it (nice UX)
  el.threadPosts.querySelectorAll("a.quote").forEach((a) => {
    a.addEventListener("click", (e) => {
      // Let anchor still jump; also prefill reply box.
      const q = a.getAttribute("data-quote");
      if (q) insertAtCursor(el.replyComment, `>>${q}`);
    });
  });
}

// ---- Events ----
el.createThreadForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const comment = el.opComment.value;
  if (!comment.trim()) return;

  await createThread({
    name: el.opName.value,
    comment,
    imageFile: el.opImage.files?.[0] ?? null,
  });

  // Clear form inputs
  el.opComment.value = "";
  el.opName.value = "";
  el.opImage.value = "";

  // immediate render so user sees it (still keep refresh loop for steady cadence)
  render();
});

el.replyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!thread) return;

  const comment = el.replyComment.value;
  if (!comment.trim()) return;

  await addReply({
    name: el.replyName.value,
    comment,
    imageFile: el.replyImage.files?.[0] ?? null,
  });

  el.replyComment.value = "";
  el.replyName.value = "";
  el.replyImage.value = "";

  render();
});

el.deleteThread.addEventListener("click", () => {
  deleteCurrentThread();
  render();
});

el.seedDemo.addEventListener("click", async () => {
  await createThread({
    name: "Anonymous",
    comment: "OP: this is a demo thread.\n\nTry replying with >>100 or click No.100.",
    imageFile: null
  });
  await addReply({
    name: "Anonymous",
    comment: "replying to >>100\n\nit works.",
    imageFile: null
  });
  await addReply({
    name: "Anonymous",
    comment: "another reply. quote chain: >>100 >>101",
    imageFile: null
  });

  render();
});

// ---- Refresh loop (only every N seconds) ----
function tickClock() {
  el.clock.textContent = `LOCAL TIME: ${new Date().toLocaleString()}`;
}
tickClock();
setInterval(tickClock, 1000);

// Render loop at N-second cadence (simulating “thread refresh” behavior)
render();
setInterval(render, REFRESH_SECONDS * 1000);