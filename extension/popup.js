// TabFlow popup.
// Settings and the playlist live in this page's localStorage, which extension
// pages get without the "storage" permission. Tab titles come from the
// "activeTab" permission: opening the popup grants temporary access to the
// tab you are on, which is enough to read its title when you add it.

const $ = (id) => document.getElementById(id);
const els = {
  interval: $("interval"), order: $("order"), fullscreen: $("fullscreen"),
  toggle: $("toggle"), next: $("next"), status: $("status"),
  add: $("add"), clear: $("clear"), list: $("list"), empty: $("empty")
};

let windowId = null;
let status = { running: false };
let playlist = load("playlist", []); // [{ tabId, title, seconds|null }]

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
  catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
const send = (msg) => chrome.runtime.sendMessage(msg);
const clampSec = (v) => Math.min(86400, Math.max(1, Math.round(Number(v)) || 10));

// ---- settings ----
els.interval.value = load("intervalSec", 10);
els.order.value = load("order", "strip");
els.fullscreen.checked = load("fullscreen", false);

function saveSettings() {
  els.interval.value = clampSec(els.interval.value);
  save("intervalSec", Number(els.interval.value));
  save("order", els.order.value);
  save("fullscreen", els.fullscreen.checked);
}

function pushLiveUpdate() {
  if (status.running) {
    send({ type: "update", intervalSec: Number(els.interval.value), playlist }).then((s) => { status = s; render(); });
  }
}

els.interval.addEventListener("change", () => { saveSettings(); pushLiveUpdate(); });
els.order.addEventListener("change", saveSettings);
els.fullscreen.addEventListener("change", saveSettings);
document.querySelectorAll(".presets button").forEach((b) =>
  b.addEventListener("click", () => { els.interval.value = b.dataset.sec; saveSettings(); pushLiveUpdate(); })
);

// ---- start / stop ----
els.toggle.addEventListener("click", async () => {
  if (status.running) {
    status = await send({ type: "stop" });
  } else {
    saveSettings();
    if (els.order.value === "playlist" && playlist.length === 0) {
      els.status.textContent = "Add tabs to the playlist first";
      return;
    }
    status = await send({
      type: "start",
      windowId,
      intervalSec: Number(els.interval.value),
      order: els.order.value,
      fullscreen: els.fullscreen.checked,
      playlist
    });
  }
  render();
});

els.next.addEventListener("click", async () => {
  status = await send({ type: "next" });
  render();
});

// ---- playlist ----
function savePlaylist() {
  save("playlist", playlist);
  renderList();
  pushLiveUpdate();
}

els.add.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (playlist.some((p) => p.tabId === tab.id)) {
    els.status.textContent = "Tab already in playlist";
    return;
  }
  // tab.title is present thanks to activeTab; fall back to its position otherwise.
  playlist.push({ tabId: tab.id, title: tab.title || `Tab ${tab.index + 1}`, seconds: null });
  savePlaylist();
});

els.clear.addEventListener("click", () => { playlist = []; savePlaylist(); });

function move(from, to) {
  if (to < 0 || to >= playlist.length || from === to) return;
  const [item] = playlist.splice(from, 1);
  playlist.splice(to, 0, item);
  savePlaylist();
}

let dragFrom = null;
function renderList() {
  els.list.textContent = "";
  els.empty.hidden = playlist.length > 0;
  playlist.forEach((item, i) => {
    const li = document.createElement("li");
    li.draggable = true;
    li.dataset.index = i;
    if (status.running && status.currentTabId === item.tabId) li.classList.add("current");

    const handle = Object.assign(document.createElement("span"), { className: "handle", textContent: "⋮⋮", title: "Drag to reorder" });
    const num = Object.assign(document.createElement("span"), { className: "num", textContent: i + 1 });
    const title = Object.assign(document.createElement("span"), { className: "title", textContent: item.title, title: item.title });
    const secs = Object.assign(document.createElement("input"), {
      type: "number", min: 1, max: 86400, placeholder: "auto", value: item.seconds ?? "", title: "Seconds on this tab (empty = default)"
    });
    secs.addEventListener("change", () => {
      item.seconds = secs.value === "" ? null : clampSec(secs.value);
      secs.value = item.seconds ?? "";
      savePlaylist();
    });
    const up = Object.assign(document.createElement("button"), { textContent: "↑", title: "Move up", disabled: i === 0 });
    up.addEventListener("click", () => move(i, i - 1));
    const down = Object.assign(document.createElement("button"), { textContent: "↓", title: "Move down", disabled: i === playlist.length - 1 });
    down.addEventListener("click", () => move(i, i + 1));
    const del = Object.assign(document.createElement("button"), { textContent: "×", title: "Remove" });
    del.addEventListener("click", () => { playlist.splice(i, 1); savePlaylist(); });

    li.addEventListener("dragstart", () => { dragFrom = i; li.classList.add("dragging"); });
    li.addEventListener("dragend", () => { dragFrom = null; li.classList.remove("dragging"); });
    li.addEventListener("dragover", (e) => { e.preventDefault(); li.classList.add("over"); });
    li.addEventListener("dragleave", () => li.classList.remove("over"));
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      li.classList.remove("over");
      if (dragFrom != null) move(dragFrom, i);
    });

    li.append(handle, num, title, secs, up, down, del);
    els.list.append(li);
  });
}

// Drop entries for tabs that have been closed since they were added.
async function pruneClosedTabs() {
  const alive = new Set((await chrome.tabs.query({})).map((t) => t.id));
  const before = playlist.length;
  playlist = playlist.filter((p) => alive.has(p.tabId));
  if (playlist.length !== before) save("playlist", playlist);
}

// ---- status ----
function render() {
  const running = status.running;
  els.toggle.textContent = running ? "Stop" : "Start";
  els.toggle.classList.toggle("running", running);
  els.next.disabled = !running;
  els.status.classList.toggle("on", running);
  if (!running) {
    els.status.textContent = "Stopped";
  } else {
    const left = Math.max(0, Math.ceil((status.nextAt - Date.now()) / 1000));
    const where = status.windowId === windowId ? "" : " (other window)";
    els.status.textContent = `Running${where} · next in ${left}s`;
  }
  els.list.querySelectorAll("li").forEach((li) => {
    const item = playlist[li.dataset.index];
    li.classList.toggle("current", running && item && status.currentTabId === item.tabId);
  });
}

async function refresh() {
  status = await send({ type: "status" });
  render();
}

(async () => {
  windowId = (await chrome.windows.getCurrent()).id;
  await pruneClosedTabs();
  renderList();
  await refresh();
  setInterval(refresh, 1000);
})();
