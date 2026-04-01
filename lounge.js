const loungeLaunchers = Array.from(document.querySelectorAll(".lounge-launcher"));
const loungeWindowOverlay = document.getElementById("loungeWindowOverlay");
const loungeWindowTitle = document.getElementById("loungeWindowTitle");
const loungeWindowBody = document.getElementById("loungeWindowBody");
const loungeWindowClose = document.getElementById("loungeWindowClose");

let lastLauncher = null;

function buildPlaceholderCopy(title) {
  return `
    <p><strong>${title}</strong></p>
    <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>
    <p>Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>
  `;
}

function openLoungeWindow(title, launcher) {
  if (!loungeWindowOverlay || !loungeWindowTitle || !loungeWindowBody) return;

  lastLauncher = launcher ?? null;
  loungeWindowTitle.textContent = title;
  loungeWindowBody.innerHTML = buildPlaceholderCopy(title);
  loungeWindowOverlay.hidden = false;
  document.body.classList.add("lounge-window-open");
  loungeWindowClose?.focus();
}

function closeLoungeWindow() {
  if (!loungeWindowOverlay) return;

  loungeWindowOverlay.hidden = true;
  document.body.classList.remove("lounge-window-open");
  lastLauncher?.focus();
}

for (const launcher of loungeLaunchers) {
  launcher.addEventListener("click", () => {
    const title = launcher.dataset.windowTitle || launcher.textContent?.trim() || "Desktop Window";
    openLoungeWindow(title, launcher);
  });
}

loungeWindowClose?.addEventListener("click", closeLoungeWindow);

loungeWindowOverlay?.addEventListener("click", (event) => {
  if (event.target === loungeWindowOverlay) {
    closeLoungeWindow();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && loungeWindowOverlay && !loungeWindowOverlay.hidden) {
    closeLoungeWindow();
  }
});
