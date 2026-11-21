<img src="icons/icon128.png" width="64" align="left" style="margin-right: 20px; border-radius: 10px;">

# Universal Auto PiP

A lightweight Chrome extension that finds actively playing web video across tabs and requests native Picture-in-Picture. It also works with the native C# desktop overlay controls in xTaskForge.

## Features

- **Global video discovery:** scans accessible tabs and frames for visible, actively playing HTML video, including open Shadow DOM.
- **Unique-tab selection:** opens PiP only when exactly one tab contains actively playing video. If multiple tabs are playing, it reports ambiguity instead of guessing.
- **Best video in the selected tab:** prefers audible video, then the largest visible video.
- **PiP unblocking:** removes the page's `disablePictureInPicture` restriction where possible.
- **Native Chrome PiP:** uses the browser's native Picture-in-Picture window.
- **Command interface:** supports address-bar commands, keyboard shortcuts, context-menu actions, and extension-to-extension messages.
- **xTaskForge click-through integration:** retains the separate `native:pip_clickthrough` desktop overlay behavior.

## Use it

### Toolbar
Click the Universal Auto PiP toolbar icon. It scans all accessible tabs and, when exactly one tab has a playing video, displays an **Open Picture-in-Picture** button over that video page. Click that in-page button to open native PiP.

### Address bar commands
Type `pip` in Chrome's address bar, press Space or Tab, then enter a command. A start command finds the unique playing-video tab and displays an **Open Picture-in-Picture** button on that page; click the button to open PiP:

| Command | Action |
| --- | --- |
| `start` or `pip.start` | Find the unique playing-video tab and request PiP |
| `stop` or `pip.stop` | Close active PiP windows |
| `toggle` or `pip.toggle` | Close PiP if active; otherwise find and open it |
| `find` or `pip.find` | Return a report of playing videos found across tabs |
| `status` or `pip.status` | Same discovery report as find |

Aliases include `pip`, `start`, `start pip`, `enable-pip`, `enable pip`, `stop`, `disable-pip`, and `toggle`.

### Keyboard shortcuts
- `Alt+Shift+P`: find the unique playing video and display the in-page **Open Picture-in-Picture** button. Click it to open PiP.
- `Alt+Shift+O`: close PiP.

Change or assign these at `chrome://extensions/shortcuts` if Chrome reserves either shortcut.

### Context menu
Right-click a page and choose **Picture-in-Picture: find the playing tab** or **Close Picture-in-Picture**. **Toggle PiP in this tab** remains available for page-local use.

## Command message API

Another Chrome extension can send a command using this extension's ID:

```js
chrome.runtime.sendMessage("YOUR_UNIVERSAL_AUTO_PIP_EXTENSION_ID", {
  type: "UNIVERSAL_PIP_COMMAND",
  command: "pip.start"
}, response => {
  if (chrome.runtime.lastError) {
    console.error(chrome.runtime.lastError.message);
    return;
  }
  console.log(response);
});
```

The receiving extension can send any supported string alias in `command`. Scripts running inside Universal Auto PiP can use `chrome.runtime.sendMessage({ command: "pip.start" })`.

The response includes `success`, a machine-readable `code`, a message, and any matching tab details. For example, `AMBIGUOUS_TABS` means more than one tab is playing video and the extension deliberately did not choose one.

## Chrome limitations

Chrome requires `HTMLVideoElement.requestPictureInPicture()` to be called during a trusted user gesture in the page that owns the video. A toolbar click, omnibox submission, keyboard shortcut, context-menu callback, extension message, or service-worker task does not reliably transfer that activation into the target page—especially when the extension must scan tabs asynchronously first. Universal Auto PiP therefore separates discovery from activation: the command locates the unique playing-video tab and injects a small in-page **Open Picture-in-Picture** button. Clicking that button is the trusted page gesture, and its click handler calls `requestPictureInPicture()` synchronously. This preserves Chrome's security model instead of repeatedly issuing requests that Chrome will reject.

The scan is limited to pages and frames where Chrome permits extension script execution. Browser-internal pages, the Chrome Web Store, inaccessible frames, closed Shadow DOM, and media players that do not expose an HTML video element cannot be guaranteed.

## xTaskForge desktop click-through

The existing native `native:pip_clickthrough` integration remains separate from browser video discovery:

- **Dynamic cursor tracking:** hides the PiP window while the cursor hovers over it so underlying applications can be used.
- **Auto-reappear:** restores the video when the cursor leaves the PiP bounds.
- **Shift bypass:** hold Shift over the PiP window to keep it visible while moving or repositioning it.
- **Low-overhead updates:** uses cached state and non-activating window updates (`SWP_NOACTIVATE`) to avoid focus changes and flashing.

This desktop behavior is handled by xTaskForge; the extension only opens and controls native Chrome PiP.

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions/`.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose this repository directory.
5. Pin Universal Auto PiP if you want toolbar access.

## Privacy

Video discovery and selection run locally in Chrome. The extension does not transmit browsing history, visited URLs, playback metadata, or media content.

## License

Original project materials are proprietary and All Rights Reserved under [LICENSE](LICENSE). Third-party components remain subject to their respective licenses.
