const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const announcer = document.querySelector<HTMLElement>("[data-announce]");

function announce(message: string) {
  if (announcer) announcer.textContent = message;
}

/* ---------- Copy buttons ---------- */

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

/** Flashes a "Copied" label on `target` after copying `text`, then restores it. */
function onCopy(button: HTMLButtonElement, text: string, target: HTMLElement, copied: string) {
  const idle = target.textContent ?? "";
  let timer = 0;
  button.addEventListener("click", async () => {
    const ok = await copyText(text);
    target.textContent = ok ? copied : "Copy failed";
    button.classList.toggle("copied", ok);
    announce(ok ? "Copied to clipboard" : "Copy failed. Select the text instead.");
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      target.textContent = idle;
      button.classList.remove("copied");
    }, 2400);
  });
}

function setupCopy() {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
    const label = button.querySelector<HTMLElement>("[data-copy-label]");
    if (label) onCopy(button, button.dataset.copy ?? "", label, "Copied");
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy-inline]")) {
    const code = button.querySelector("code");
    if (code) {
      onCopy(button, button.dataset.copyInline ?? "", code, button.dataset.copiedLabel ?? "Copied");
    }
  }
}

/* ---------- Header ---------- */

function setupHeader() {
  const header = document.querySelector<HTMLElement>("[data-header]");
  if (!header) return;
  const update = () => header.classList.toggle("scrolled", window.scrollY > 8);
  update();
  window.addEventListener("scroll", update, { passive: true });

  // The mobile menu's links mostly scroll within the page, which leaves a popover open.
  const menu = header.querySelector<HTMLElement>("[data-site-menu]");
  menu?.addEventListener("click", (event) => {
    if ((event.target as Element).closest("a")) menu.hidePopover();
  });
}

/* ---------- Runner order demo ---------- */

const JOB_EVERY_MS = 4200;

function setupOrder() {
  const list = document.querySelector<HTMLOListElement>("[data-lanes]");
  const nextName = document.querySelector<HTMLElement>("[data-next-name]");
  const nextWhy = document.querySelector<HTMLElement>("[data-next-why]");
  const nextLogo = document.querySelector<HTMLImageElement>("[data-next-logo]");
  const pr = document.querySelector<HTMLElement>("[data-pr]");
  if (!list || !nextName || !nextWhy || !nextLogo) return;

  const lanes = () => [...list.querySelectorAll<HTMLLIElement>("[data-lane]")];

  // The first lane takes the next job; the rest show where it falls through to.
  const render = () => {
    lanes().forEach((lane, i) => {
      lane.classList.toggle("on", i === 0);
      const state = lane.querySelector(".lane-state");
      if (state) state.textContent = i === 0 ? "Takes the next job" : i === 1 ? "Next" : "Fallback";
      const up = lane.querySelector<HTMLButtonElement>(".lane-up");
      if (up) up.disabled = i === 0;
    });
    const first = lanes()[0];
    nextName.textContent = first.dataset.next ?? "";
    nextWhy.textContent = first.dataset.why ?? "";
    nextLogo.src = first.querySelector("img")?.src ?? nextLogo.src;
  };

  list.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>(".lane-up");
    const lane = button?.closest<HTMLLIElement>("[data-lane]");
    const above = lane?.previousElementSibling;
    if (!button || !lane || !above) return;
    above.before(lane);
    render();
    announce(`Next job goes to ${lanes()[0].dataset.next}`);
    // Keep focus on the moved lane's button, or the next one up once it reaches the top.
    (button.disabled ? lanes()[1]?.querySelector<HTMLButtonElement>(".lane-up") : button)?.focus();
  });

  render();

  // A new job arrives every few seconds and lands on the first lane.
  if (reducedMotion.matches || !pr) return;
  let n = Number(pr.textContent) || 482;
  window.setInterval(() => {
    if (document.hidden) return;
    pr.textContent = String(++n);
    const first = lanes()[0];
    first.classList.remove("took");
    void first.offsetWidth;
    first.classList.add("took");
  }, JOB_EVERY_MS);
}

/* ---------- Minutes meter ---------- */

function setupMeter() {
  const fill = document.querySelector<HTMLElement>("[data-meter]");
  if (!fill || reducedMotion.matches || !("IntersectionObserver" in window)) return;
  fill.classList.add("armed");
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      fill.classList.add("filled");
    },
    { threshold: 0.6 },
  );
  observer.observe(fill);
}

setupCopy();
setupHeader();
setupOrder();
setupMeter();
