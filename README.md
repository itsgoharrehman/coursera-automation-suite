# Coursera Video Auto-Skip & Fast-Seek Userscript

A lightweight Userscript designed for **Coursera** video lectures that automatically seeks videos to the final **5 seconds**. Features **Auto-Skip playlist support**, manual shortcut keys, customizable settings, and on-screen toast notifications.

---

## ✨ Features

- ⚡ **Auto-Skip Mode:** Automatically skips newly loaded videos to their final 5 seconds as you navigate through playlist/lecture modules.
- ⌨️ **Keyboard Shortcuts:**
  - `Alt` + `S`: Manually skip the current video to the last 5 seconds.
  - `Alt` + `A`: Toggle Auto-Skip mode ON or OFF.
- 🔔 **On-Screen Toast Notifications:** Visual feedback when skipping or toggling settings.
- 💾 **Persistent State:** Saves your Auto-Skip preference in `localStorage`.
- 🎨 **Modern UI Overlay:** Subtle HUD showing controls and current status without obstructing content.

---

## 🚀 Installation Guide

### Step 1: Install a Userscript Manager
Before installing the script, ensure you have a Userscript extension installed in your web browser:
- **Chrome / Edge / Brave / Opera:** [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/)
- **Firefox:** [Greasemonkey](https://addons.mozilla.org/en-US/firefox/addon/greasemonkey/) or [Tampermonkey](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/)

### Step 2: Install the Script
1. Open your Userscript manager extension dashboard.
2. Click **Create a new script** (or `+`).
3. Copy the contents of [`Video Player Seek to Last 5 Seconds (Auto Playlist Support).user.js`](./Video%20Player%20Seek%20to%20Last%205%20Seconds%20%28Auto%20Playlist%20Support%29.user.js).
4. Paste into the editor and press `Ctrl + S` (`Cmd + S` on Mac) to save.

---

## 🎮 How to Use

1. Navigate to any course video page on **[Coursera](https://www.coursera.org/)**.
2. The script will automatically activate when a video loads.
3. Use keyboard shortcuts for manual control:
   | Shortcut | Action |
   | :--- | :--- |
   | <kbd>Alt</kbd> + <kbd>S</kbd> | Jump active video to the last 5 seconds |
   | <kbd>Alt</kbd> + <kbd>A</kbd> | Toggle Auto-Skip mode On/Off |

---

## ⚙️ Configuration

You can customize the script by editing the configuration variables near the top of the `.user.js` file:

```javascript
// --- Configuration ---
const SECONDS_FROM_END = 5;      // Target seconds before video end (default: 5)
const MANUAL_HOTKEY = 's';       // Manual Skip: Alt + S
const AUTO_TOGGLE_HOTKEY = 'a';  // Toggle Auto-Skip: Alt + A
```

---

## 📝 License

Distributed under the MIT License. Feel free to modify and adapt for personal use.