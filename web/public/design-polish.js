const focusable = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const restoreFocus = new WeakMap();
const managedSurfaces = new Set();

function visibleControls(surface) {
  return [...surface.querySelectorAll(focusable)].filter((control) => control.getClientRects().length > 0);
}

function enhanceModal(surface) {
  if (surface.dataset.focusManaged === "true") return;
  surface.dataset.focusManaged = "true";
  restoreFocus.set(surface, document.activeElement);
  managedSurfaces.add(surface);

  surface.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      const close = surface.querySelector("[aria-label^='Close']") ||
        [...surface.querySelectorAll("button")].find((button) => ["Cancel", "Close"].includes(button.textContent.trim()));
      close?.click();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = visibleControls(surface);
    if (!controls.length) return;
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  requestAnimationFrame(() => {
    const preferred = surface.querySelector("[autofocus], [aria-label^='Close'], input, textarea, select, button:not([disabled])");
    preferred?.focus({ preventScroll: true });
  });
}

function restoreClosedSurfaces() {
  managedSurfaces.forEach((surface) => {
    const overlayOpen = !surface.matches(".sidebar, .inspector") || surface.matches(".sidebar.open, .inspector.open");
    const stillOpen = surface.isConnected && overlayOpen && surface.getClientRects().length > 0;
    if (stillOpen) return;
    restoreFocus.get(surface)?.focus?.({ preventScroll: true });
    surface.dataset.focusManaged = "false";
    managedSurfaces.delete(surface);
  });
}

function enhanceOverlays() {
  document.querySelectorAll(".sidebar:not(.open), .inspector:not(.open)").forEach((surface) => {
    surface.removeAttribute("role");
    surface.removeAttribute("aria-modal");
  });
  document.querySelectorAll("[role='dialog'][aria-modal='true'], .sidebar.open, .inspector.open").forEach((surface) => {
    if (surface.matches(".sidebar.open, .inspector.open")) {
      surface.setAttribute("role", "dialog");
      surface.setAttribute("aria-modal", "true");
      surface.setAttribute("aria-label", surface.matches(".sidebar") ? "Task navigation" : "Artifact review");
    }
    enhanceModal(surface);
  });
  restoreClosedSurfaces();
}

function enhanceTabs() {
  document.querySelectorAll("[role='tablist']").forEach((tablist, listIndex) => {
    const tabs = [...tablist.querySelectorAll("[role='tab']")];
    const panel = tablist.closest(".inspector")?.querySelector(".panel-body");
    if (!panel || !tabs.length) return;
    panel.id ||= `review-panel-${listIndex}`;
    panel.setAttribute("role", "tabpanel");
    tabs.forEach((tab, tabIndex) => {
      tab.id ||= `review-tab-${listIndex}-${tabIndex}`;
      tab.setAttribute("aria-controls", panel.id);
      tab.tabIndex = tab.getAttribute("aria-selected") === "true" ? 0 : -1;
    });
    const selected = tabs.find((tab) => tab.getAttribute("aria-selected") === "true");
    if (selected) panel.setAttribute("aria-labelledby", selected.id);
    if (tablist.dataset.keyboardManaged === "true") return;
    tablist.dataset.keyboardManaged = "true";
    tablist.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const current = Math.max(0, tabs.indexOf(document.activeElement));
      const target = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
        (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[target].focus();
      tabs[target].click();
    });
  });
}

function reconcileReviewState() {
  document.querySelectorAll(".inspector").forEach((inspector) => {
    const hasDiff = Boolean(inspector.querySelector(".diff-view .code-block"));
    if (hasDiff) inspector.dataset.reviewState = "ready";
    const emptyDiff = [...inspector.querySelectorAll(".panel-empty")].find((node) =>
      node.textContent.trim() === "No committed or working-tree diff yet." ||
      node.textContent.startsWith("No reviewable diff is available."),
    );
    if (emptyDiff?.textContent.trim() === "No committed or working-tree diff yet.") {
      inspector.dataset.reviewState = "no-diff";
      emptyDiff.textContent = "No reviewable diff is available. The reported file list may be stale; refresh task state before publishing.";
    }
    const publish = [...inspector.querySelectorAll("button")].find((button) =>
      ["Publish changes", "No diff to publish"].includes(button.textContent.trim()),
    );
    if (publish && inspector.dataset.reviewState === "no-diff") {
      publish.disabled = true;
      if (publish.textContent.trim() !== "No diff to publish") publish.textContent = "No diff to publish";
      publish.title = "Refresh task state before publishing; no Git diff is currently available.";
    } else if (publish && inspector.dataset.reviewState === "ready" && publish.textContent.trim() === "No diff to publish") {
      publish.disabled = false;
      publish.textContent = "Publish changes";
      publish.removeAttribute("title");
    }
    const count = inspector.querySelector(".review-count");
    if (count && inspector.dataset.reviewState === "no-diff" && count.textContent.trim() !== "0 reviewable files" && /files$/.test(count.textContent.trim())) {
      count.textContent = "0 reviewable files";
    }
  });
}

function clarifyHistory() {
  document.querySelectorAll(".run-card").forEach((run) => {
    const live = run.querySelector(".runtime-dot.running, .runtime-dot.paused, .runtime-dot.queued");
    if (live) return;
    const log = run.querySelector(".live-activity");
    if (!log) return;
    log.setAttribute("aria-label", "Completed run history; event labels show their state when captured");
    log.setAttribute("aria-live", "off");
    run.querySelectorAll(".activity-event.pending strong, .activity-event.in_progress strong").forEach((label) => {
      if (!label.textContent.includes("at capture")) label.textContent += " at capture";
    });
  });
}

function closeCompactMenus(except) {
  document.querySelectorAll(".compact-select.is-open").forEach((control) => {
    if (control === except) return;
    control.classList.remove("is-open");
    control.querySelector(".compact-option")?.setAttribute("aria-expanded", "false");
    const menu = control.querySelector(".compact-menu");
    if (menu) menu.hidden = true;
  });
}

function compactControlName(label, select) {
  return select.getAttribute("aria-label") ||
    [...label.childNodes].find((node) => node.nodeType === Node.TEXT_NODE)?.textContent.trim() ||
    "Option";
}

function createCompactSelect(label) {
  const select = label.querySelector("select");
  if (!select) return null;
  const name = compactControlName(label, select);
  const control = document.createElement("div");
  control.className = "compact-select";
  control.dataset.control = name.toLowerCase();

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "compact-option";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");

  const value = document.createElement("span");
  value.className = "compact-option-value";
  trigger.append(value);

  const menu = document.createElement("div");
  menu.className = "compact-menu";
  menu.id = `new-agent-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-menu`;
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", name);
  menu.hidden = true;
  trigger.setAttribute("aria-controls", menu.id);

  const sync = () => {
    const selected = select.selectedOptions[0];
    const selectedText = selected?.textContent || "";
    if (value.textContent !== selectedText) value.textContent = selectedText;
    const accessibleName = `${name}: ${selectedText}`;
    if (trigger.getAttribute("aria-label") !== accessibleName) trigger.setAttribute("aria-label", accessibleName);
    if (trigger.title !== accessibleName) trigger.title = accessibleName;
    trigger.disabled = select.disabled;
    menu.querySelectorAll("[role='option']").forEach((option) => {
      option.setAttribute("aria-selected", option.dataset.value === select.value ? "true" : "false");
    });
  };

  [...select.options].forEach((option) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "compact-menu-option";
    item.setAttribute("role", "option");
    item.dataset.value = option.value;
    item.disabled = option.disabled;
    item.textContent = option.textContent;
    item.addEventListener("click", () => {
      select.value = option.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      sync();
      closeCompactMenus();
      trigger.focus();
    });
    menu.append(item);
  });

  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    const opening = !control.classList.contains("is-open");
    closeCompactMenus(control);
    control.classList.toggle("is-open", opening);
    trigger.setAttribute("aria-expanded", opening ? "true" : "false");
    menu.hidden = !opening;
  });

  trigger.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    closeCompactMenus(control);
    control.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");
    menu.hidden = false;
    const options = [...menu.querySelectorAll("button:not(:disabled)")];
    const selected = options.find((option) => option.getAttribute("aria-selected") === "true");
    (selected || options[event.key === "ArrowDown" ? 0 : options.length - 1])?.focus();
  });

  menu.addEventListener("keydown", (event) => {
    const options = [...menu.querySelectorAll("button:not(:disabled)")];
    if (event.key === "Escape") {
      event.preventDefault();
      closeCompactMenus();
      trigger.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !options.length) return;
    event.preventDefault();
    const current = Math.max(0, options.indexOf(document.activeElement));
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 :
      (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[next].focus();
  });

  select.addEventListener("change", sync);
  new MutationObserver(sync).observe(select, { attributes: true, attributeFilter: ["disabled"] });
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");
  label.classList.add("native-select-source");
  control.append(trigger, menu);
  sync();
  return control;
}

function enhanceNewAgent() {
  const surface = document.querySelector(".empty-workspace");
  const form = surface?.querySelector("form.composer.large");
  const textarea = form?.querySelector("textarea[aria-label='Agent instructions']");
  if (!surface || !form || !textarea) return;

  form.querySelectorAll(".composer-label, .configuration-label").forEach((label) => label.remove());
  const intro = surface.querySelector("h1 + p");
  if (intro) {
    intro.id ||= "new-agent-intro";
    textarea.setAttribute("aria-describedby", intro.id);
  }
  textarea.placeholder = "What should Grok build?";
  textarea.autocomplete = "off";
  const options = form.querySelector(".composer-options");
  const labels = [...options?.querySelectorAll("label") || []];
  const existingControls = surface.querySelectorAll(".compact-select");
  if (form.dataset.cursorControls !== "true" || existingControls.length !== labels.length) {
    surface.querySelector(".cursor-context-bar")?.remove();
    options?.querySelectorAll(".compact-select").forEach((control) => control.remove());
    labels.forEach((label) => label.classList.remove("native-select-source"));

    const context = document.createElement("div");
    context.className = "cursor-context-bar";
    context.setAttribute("aria-label", "Repository and execution context");
    const identifiers = document.createElement("div");
    identifiers.className = "cursor-context-identifiers";
    form.querySelectorAll(".composer-tools .tool-chip").forEach((chip) => identifiers.append(chip.cloneNode(true)));
    const runtime = document.createElement("div");
    runtime.className = "cursor-context-runtime";
    context.append(identifiers, runtime);
    form.before(context);

    labels.forEach((label) => {
      const select = label.querySelector("select");
      const name = select ? compactControlName(label, select) : "";
      const control = createCompactSelect(label);
      if (!control) return;
      if (["Access", "Compute"].includes(name)) runtime.append(control);
      else options.append(control);
    });
    form.querySelector(".composer-tools > div")?.classList.add("native-tool-context");
    form.dataset.cursorControls = "true";
  }

  if (document.documentElement.dataset.compactMenus !== "true") {
    document.documentElement.dataset.compactMenus = "true";
    document.addEventListener("click", () => closeCompactMenus());
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const open = document.querySelector(".compact-select.is-open");
      if (!open) return;
      const trigger = open.querySelector(".compact-option");
      closeCompactMenus();
      trigger?.focus();
    });
  }
  const submit = form.querySelector("button[aria-label='Start agent']");
  if (submit) {
    submit.title = "Start agent";
    submit.querySelector(".send-label")?.remove();
  }
}

function enhance() {
  enhanceOverlays();
  enhanceTabs();
  reconcileReviewState();
  clarifyHistory();
  enhanceNewAgent();
}

const observerOptions = { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "aria-selected"] };
const observer = new MutationObserver(() => {
  observer.disconnect();
  enhance();
  observer.observe(document.documentElement, observerOptions);
});

enhance();
observer.observe(document.documentElement, observerOptions);
