const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
let motionEnabled = !motionPreference.matches;
document.documentElement.dataset.motion = motionEnabled ? "on" : "off";
document.documentElement.classList.add("js");

const demo = document.querySelector(".demo");
const playButton = document.querySelector("[data-demo-play]");
const stepButtons = [...document.querySelectorAll("[data-step-button]")];
const motionButton = document.querySelector("[data-motion-toggle]");
const steps = [
  {
    operation: "OBSERVE",
    target: "page → possibilities",
    description: "Observe the page. Find the available actions.",
    status: "Reading the page",
    count: "10 visible elements",
  },
  {
    operation: "TYPE_TEXT",
    target: '[04] → "Lisbon"',
    description: "Type Lisbon into the observed destination field.",
    status: "Destination entered",
    count: "Lisbon",
  },
  {
    operation: "SELECT",
    target: "[06] → Design",
    description: "Select the Design category from the observed options.",
    status: "Category selected",
    count: "Design",
  },
  {
    operation: "CLICK",
    target: "[07] → checked",
    description: "Check Free cancellation and observe the new state.",
    status: "Cancellation confirmed",
    count: "Checked",
  },
  {
    operation: "CLICK",
    target: "[08] → Casa Flora",
    description: "Choose Casa Flora and open its stay page.",
    status: "Opening Casa Flora",
    count: "Target matched",
  },
  {
    operation: "DONE",
    target: "all steps verified",
    description: "Review the final page and confirm the complete goal.",
    status: "Goal reviewed",
    count: "Complete",
  },
];
let step = 0;
let playing = false;
let timer;

function setText(selector, value) {
  document.querySelector(selector).textContent = value;
}

function renderStep() {
  const current = steps[step];
  demo.dataset.step = String(step);
  setText("[data-operation]", current.operation);
  setText("[data-target-label]", current.target);
  setText("[data-step-description]", current.description);
  setText("[data-browser-status]", current.status);
  setText("[data-browser-count]", current.count);
  setText("[data-step-count]", String(step + 1).padStart(2, "0") + " / 06");
  setText(
    "[data-destination]",
    step > 0 ? "Lisbon" : "Where would you like to go?",
  );
  setText("[data-category]", step > 1 ? "Design" : "All stays");
  setText(
    "[data-demo-url]",
    step === 5 ? "forma.example / stays / casa-flora" : "forma.example / stays",
  );
  for (const button of stepButtons)
    button.setAttribute(
      "aria-pressed",
      String(Number(button.dataset.stepButton) === step),
    );
  for (const selector of [
    ".stay-search > .mini-eyebrow",
    ".stay-search > h2",
    ".mini-search",
    ".mini-filters",
    ".mini-results",
  ]) {
    document.querySelector(selector).hidden = step === 5;
  }
  document.querySelector(".stay-detail").hidden = step !== 5;
  document.querySelector(".ticket-icon .icon").className =
    "icon " + (step === 5 ? "check" : "cursor");
  renderPlayback();
}

function renderPlayback() {
  const ended = step === steps.length - 1;
  playButton.setAttribute(
    "aria-label",
    playing
      ? "Pause walkthrough"
      : ended
        ? "Replay walkthrough"
        : "Play walkthrough",
  );
  playButton.querySelector(".icon").className =
    "icon " + (playing ? "pause" : ended ? "replay" : "play");
}

function pause() {
  clearTimeout(timer);
  playing = false;
  renderPlayback();
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (!playing || document.hidden) return pause();
    step += 1;
    if (step === steps.length - 1) playing = false;
    renderStep();
    if (playing) schedule();
  }, 2400);
}

function play() {
  if (step === steps.length - 1) step = 0;
  playing = true;
  renderStep();
  schedule();
}

playButton.disabled = false;
playButton.addEventListener("click", () => (playing ? pause() : play()));
for (const button of stepButtons) {
  button.disabled = false;
  button.addEventListener("click", () => {
    pause();
    step = Number(button.dataset.stepButton);
    renderStep();
  });
}
document.querySelector("[data-watch]").addEventListener("click", () => {
  step = 0;
  if (motionEnabled) play();
  else {
    pause();
    renderStep();
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) pause();
});

function setMotion(enabled) {
  motionEnabled = enabled;
  document.documentElement.dataset.motion = enabled ? "on" : "off";
  motionButton.setAttribute("aria-pressed", String(enabled));
  setText("[data-motion-label]", enabled ? "Motion on" : "Motion off");
  if (!enabled) pause();
}
motionButton.disabled = false;
motionButton.addEventListener("click", () => setMotion(!motionEnabled));
motionPreference.addEventListener("change", (event) =>
  setMotion(!event.matches),
);
setMotion(motionEnabled);

const reveals = document.querySelectorAll(".reveal");
if ("IntersectionObserver" in window) {
  const revealObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          revealObserver.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.12 },
  );
  for (const element of reveals) revealObserver.observe(element);
  const demoObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) if (!entry.isIntersecting) pause();
    },
    { threshold: 0.15 },
  );
  demoObserver.observe(demo);
} else {
  for (const element of reveals) element.classList.add("is-visible");
}

const tabs = [...document.querySelectorAll("[data-code-tab]")];
const copyButton = document.querySelector("[data-copy]");
let activeTab = "install";
let copyTimer;

function selectTab(button) {
  activeTab = button.dataset.codeTab;
  clearTimeout(copyTimer);
  setText("[data-copy-label]", "Copy");
  setText("[data-copy-status]", "");
  for (const tab of tabs) {
    const selected = tab === button;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    document.getElementById(tab.getAttribute("aria-controls")).hidden =
      !selected;
  }
  const labels = {
    install: "installation commands",
    connect: "model configuration",
    run: "agent example",
  };
  copyButton.setAttribute("aria-label", "Copy " + labels[activeTab]);
}
for (const button of tabs) {
  button.addEventListener("click", () => selectTab(button));
  button.addEventListener("keydown", (event) => {
    const index = tabs.indexOf(button);
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft")
      next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    selectTab(tabs[next]);
    tabs[next].focus();
  });
}
copyButton.disabled = false;
copyButton.addEventListener("click", async () => {
  const copiedTab = activeTab;
  const code = document.querySelector("#panel-" + copiedTab + " pre code");
  try {
    await navigator.clipboard.writeText(code.textContent);
    if (activeTab !== copiedTab) return;
    setText("[data-copy-label]", "Copied");
    setText("[data-copy-status]", "Copied to clipboard.");
  } catch {
    if (activeTab !== copiedTab) return;
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(code);
    selection.removeAllRanges();
    selection.addRange(range);
    setText("[data-copy-label]", "Selected");
    setText(
      "[data-copy-status]",
      "Clipboard unavailable. The code is selected; use your device's copy command.",
    );
  }
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => setText("[data-copy-label]", "Copy"), 2200);
});
renderStep();
if (motionEnabled) play();
