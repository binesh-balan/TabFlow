# TabFlow

TabFlow is a Chrome and Edge extension (Manifest V3) that rotates through your tabs on a timer. It can run full screen, follow the tab bar order, reverse or shuffle it, or follow a playlist you sort yourself with its own time per tab.

It installs with **no permission warning**.

## Features

- Start, stop and skip to the next tab from the toolbar popup. A green **ON** badge shows while it runs.
- Interval from 1 second up to 24 hours, with presets (5s, 15s, 30s, 1m, 5m). Changing it while running takes effect right away.
- Order: tab bar order, tab bar order reversed, shuffle (every tab once per round), or **My playlist**.
- Playlist: add the tabs you want, drag or use the arrows to sort them, and give any tab its own time (empty means the default interval). Closed tabs drop off the list automatically.
- **Full screen while rotating**: puts the window into full screen when you start and restores it when you stop.
- Keyboard shortcut **Alt+Shift+R** starts or stops rotation with your last settings. In full screen the toolbar is hidden, so this is the way to stop. You can change it at `chrome://extensions/shortcuts` (Chrome) or `edge://extensions/shortcuts` (Edge).
- Rotation only touches the window it was started in, and stops if that window closes.

## Permissions

| Permission | Install warning | Why |
| --- | --- | --- |
| `activeTab` | None | Lets the popup read the title of the tab you are on when you press **Add this tab**, so the playlist shows names instead of "Tab 3". Access is temporary and only for the tab you opened the popup on. |

That is the whole list. No host permissions, no `tabs`, no `storage`, no `alarms`.

What it does without asking for anything:

- **Switching tabs.** `chrome.tabs.query` and `chrome.tabs.update(id, { active: true })` work without the `tabs` permission. That permission only unlocks tab URLs, titles and icons, which rotation never needs.
- **Full screen.** `chrome.windows.update(id, { state: "fullscreen" })` needs no permission.
- **Settings and playlist.** Saved in the popup's own `localStorage`, which every extension page has without the `storage` permission. They are sent to the background worker when you press Start.
- **Badge and shortcut.** `chrome.action` badge calls and the `commands` manifest key need no permission.

If you never use the playlist you can delete `"activeTab"` from `manifest.json` and run with an empty permission list. Added tabs then show as "Tab N" instead of their titles.

### Why not `chrome.alarms`?

MV3 background service workers go to sleep after about 30 seconds of inactivity, which would kill a normal `setTimeout`. There are two ways around that:

- **`chrome.alarms`** survives the worker sleeping, and its permission has no install warning, but the shortest period is 30 seconds (one minute before Chrome 120). Fast rotation, such as every 5 or 10 seconds, is impossible with alarms alone.
- **Timer plus heartbeat (what TabFlow uses).** Since Chrome 110, and the Edge versions built on the same engine, every extension API call resets the worker's idle timer. While rotating, TabFlow makes a cheap `chrome.runtime.getPlatformInfo()` call every 20 seconds, so the worker stays awake and a plain `setTimeout` can fire at any interval. The cost is that the worker uses a few MB of memory while rotation is on. When you stop, the heartbeat stops and the worker can sleep again.

The trade-off: state lives only in memory, so a browser restart or extension update turns rotation off. You start it again from the popup or with the shortcut. Your settings and playlist are kept.

## Install (unpacked)

1. Download or clone this repository.

### Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `extension` folder.
4. Pin TabFlow from the puzzle-piece menu so the button stays on the toolbar.

### Edge

1. Open `edge://extensions`.
2. Turn on **Developer mode** (left sidebar).
3. Click **Load unpacked** and pick the `extension` folder.
4. Click the puzzle-piece icon and choose the eye icon next to TabFlow to show it in the toolbar.

Chrome 116 or newer, or a current Edge, is required.

## Using a playlist

1. Go to a tab you want in the rotation, open the TabFlow popup and press **+ Add this tab**. Repeat for each tab.
2. Sort the list by dragging rows or with the arrows. Type a number of seconds next to a tab to keep it on screen longer or shorter than the default.
3. Set **Order** to **My playlist** and press **Start**.

Playlist tabs must be in the window you start from. Tab ids only last for the browser session, so after a restart you add the tabs again.

## Files

```
extension/
  manifest.json   permissions, popup, shortcut
  background.js   rotation timer, order modes, full screen, heartbeat
  popup.html/css/js  settings, playlist editor, start/stop
  icons/
```
