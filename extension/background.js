// TabFlow background service worker.
//
// Permission notes (see README for the full list):
// - chrome.tabs.query / chrome.tabs.update({active}) work without the "tabs"
//   permission. Only tab URLs, titles and favicons are gated, and the
//   rotation itself never reads them.
// - chrome.windows.update({state: "fullscreen"}) needs no permission.
// - The timer is a plain setTimeout in this worker. Since Chrome 110 (and the
//   matching Edge), every extension API call resets the worker's 30-second
//   idle timer, so a 20-second heartbeat (chrome.runtime.getPlatformInfo)
//   keeps the worker awake while rotating. That avoids the "alarms"
//   permission and its 30-second minimum.
// - Nothing is stored here. The popup keeps settings and the playlist in its
//   own localStorage (free for extension pages, no "storage" permission) and
//   sends them along when rotation starts.

const HEARTBEAT_MS = 20_000;
const MIN_SEC = 1;
const MAX_SEC = 24 * 60 * 60;

const clampSec = (s, fallback = 10) =>
  Math.min(MAX_SEC, Math.max(MIN_SEC, Math.round(Number(s)) || fallback));

let state = idleState();
let rotateTimer = null;
let heartbeatTimer = null;
let lastOpts = { intervalSec: 10, order: "strip" }; // reused by the keyboard shortcut

function idleState() {
  return {
    running: false,
    windowId: null,
    intervalSec: 10,
    order: "strip", // strip | reverse | shuffle | playlist
    fullscreen: false,
    prevWindowState: null,
    playlist: [], // [{ tabId, seconds|null }]
    shuffleQueue: [],
    currentTabId: null,
    nextAt: 0
  };
}

function clearTimers() {
  clearTimeout(rotateTimer);
  clearInterval(heartbeatTimer);
  rotateTimer = heartbeatTimer = null;
}

function secondsFor(tabId) {
  if (state.order === "playlist") {
    const item = state.playlist.find((p) => p.tabId === tabId);
    if (item?.seconds) return clampSec(item.seconds, state.intervalSec);
  }
  return state.intervalSec;
}

function scheduleAfter(tabId) {
  clearTimeout(rotateTimer);
  const ms = secondsFor(tabId) * 1000;
  state.nextAt = Date.now() + ms;
  rotateTimer = setTimeout(rotateOnce, ms);
}

// Returns the ordered list of tab ids to cycle through.
async function rotationIds() {
  const tabs = await chrome.tabs.query({ windowId: state.windowId });
  tabs.sort((a, b) => a.index - b.index);
  const ids = tabs.map((t) => t.id);
  switch (state.order) {
    case "reverse":
      return ids.reverse();
    case "playlist": {
      const open = new Set(ids);
      return state.playlist.map((p) => p.tabId).filter((id) => open.has(id));
    }
    default:
      return ids; // strip and shuffle both start from strip order
  }
}

function pickNext(ids, activeId) {
  if (state.order === "shuffle") {
    state.shuffleQueue = state.shuffleQueue.filter((id) => ids.includes(id) && id !== activeId);
    if (state.shuffleQueue.length === 0) {
      state.shuffleQueue = ids.filter((id) => id !== activeId);
      for (let i = state.shuffleQueue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [state.shuffleQueue[i], state.shuffleQueue[j]] = [state.shuffleQueue[j], state.shuffleQueue[i]];
      }
    }
    return state.shuffleQueue.shift();
  }
  const pos = ids.indexOf(activeId);
  return ids[(pos + 1) % ids.length]; // pos -1 (not in list) gives ids[0]
}

async function rotateOnce() {
  if (!state.running) return;
  try {
    const ids = await rotationIds();
    const [active] = await chrome.tabs.query({ windowId: state.windowId, active: true });
    let target = active?.id;
    if (ids.length > 0 && !(ids.length === 1 && ids[0] === active?.id)) {
      target = pickNext(ids, active?.id);
      await chrome.tabs.update(target, { active: true });
    }
    state.currentTabId = target;
    scheduleAfter(target);
  } catch (err) {
    console.warn("TabFlow stopped:", err); // most likely the window closed
    await stop();
  }
}

async function start(opts) {
  clearTimers();
  if (state.running) await restoreWindow();
  lastOpts = { ...opts, windowId: undefined };
  const windowId = opts.windowId ?? (await currentWindowId());
  state = {
    ...idleState(),
    running: true,
    windowId,
    intervalSec: clampSec(opts.intervalSec),
    order: ["strip", "reverse", "shuffle", "playlist"].includes(opts.order) ? opts.order : "strip",
    fullscreen: !!opts.fullscreen,
    playlist: Array.isArray(opts.playlist)
      ? opts.playlist.map((p) => ({ tabId: p.tabId, seconds: p.seconds ? clampSec(p.seconds) : null }))
      : []
  };

  if (state.fullscreen) {
    const win = await chrome.windows.get(windowId);
    state.prevWindowState = win.state;
    if (win.state !== "fullscreen") {
      await chrome.windows.update(windowId, { state: "fullscreen" });
    }
  }

  // In playlist mode, jump straight to the first playlist tab.
  const [active] = await chrome.tabs.query({ windowId, active: true });
  let current = active?.id;
  if (state.order === "playlist") {
    const ids = await rotationIds();
    if (ids.length && !ids.includes(current)) {
      current = ids[0];
      await chrome.tabs.update(current, { active: true });
    }
  }
  state.currentTabId = current;
  scheduleAfter(current);
  heartbeatTimer = setInterval(() => chrome.runtime.getPlatformInfo(), HEARTBEAT_MS);
  await updateBadge();
  return getStatus();
}

async function restoreWindow() {
  if (!state.fullscreen || state.windowId == null) return;
  const prev = state.prevWindowState;
  if (prev && prev !== "fullscreen") {
    try {
      await chrome.windows.update(state.windowId, { state: prev === "minimized" ? "normal" : prev });
    } catch {
      /* window already closed */
    }
  }
}

async function stop() {
  clearTimers();
  await restoreWindow();
  state = { ...idleState(), intervalSec: state.intervalSec };
  await updateBadge();
  return getStatus();
}

function getStatus() {
  return {
    running: state.running,
    windowId: state.windowId,
    intervalSec: state.intervalSec,
    order: state.order,
    fullscreen: state.fullscreen,
    currentTabId: state.currentTabId,
    nextAt: state.nextAt
  };
}

async function updateBadge() {
  await chrome.action.setBadgeBackgroundColor({ color: "#1a7f37" });
  await chrome.action.setBadgeText({ text: state.running ? "ON" : "" });
}

async function currentWindowId() {
  const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
  return win.id;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "status":
        return getStatus();
      case "start":
        return start(msg);
      case "stop":
        return stop();
      case "next":
        if (state.running) {
          clearTimeout(rotateTimer);
          await rotateOnce();
        }
        return getStatus();
      case "update":
        // Live changes from the popup while running (interval, per-tab times, order of playlist).
        if (state.running) {
          if (msg.intervalSec) state.intervalSec = clampSec(msg.intervalSec);
          if (Array.isArray(msg.playlist)) {
            state.playlist = msg.playlist.map((p) => ({ tabId: p.tabId, seconds: p.seconds ? clampSec(p.seconds) : null }));
          }
          scheduleAfter(state.currentTabId);
        }
        return getStatus();
      default:
        return { error: "unknown message" };
    }
  })().then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});

// Keyboard shortcut. Also the way out of full screen, where the toolbar is hidden.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-rotation") return;
  if (state.running) await stop();
  else await start({ ...lastOpts, windowId: await currentWindowId() });
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (state.running && windowId === state.windowId) {
    state.fullscreen = false; // nothing to restore
    stop();
  }
});

updateBadge();
