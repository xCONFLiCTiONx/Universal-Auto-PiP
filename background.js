const MENU_TOGGLE_ACTIVE = "universal-pip-toggle-active";

function setupContextMenus() {
    chrome.contextMenus.removeAll(() => {
        if (chrome.runtime.lastError) {
            // Ignore error if contextMenus.removeAll fails
        }
        chrome.contextMenus.create({
            id: MENU_TOGGLE_ACTIVE,
            title: "Toggle Picture-in-Picture",
            contexts: ["all"]
        }, () => {
            void chrome.runtime.lastError;
        });
    });
}

async function toggleFramePiP() {
    if (document.pictureInPictureElement) {
        try {
            await document.exitPictureInPicture();
            return { success: true, action: "closed" };
        } catch (error) {
            return { success: false, reason: error?.name || "exit-failed", message: error?.message || String(error) };
        }
    }

    const videos = [];
    const visited = new Set();

    function walk(root) {
        if (!root || visited.has(root)) return;
        visited.add(root);

        let elements = [];
        try {
            elements = root.querySelectorAll ? root.querySelectorAll("*") : [];
        } catch {
            return;
        }

        for (const element of elements) {
            if (element instanceof HTMLVideoElement) {
                if (element.hasAttribute("disablePictureInPicture")) {
                    element.removeAttribute("disablePictureInPicture");
                }
                try {
                    element.disablePictureInPicture = false;
                } catch {}

                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                const visible = rect.width > 0 && rect.height > 0 &&
                    style.display !== "none" && style.visibility !== "hidden" &&
                    Number(style.opacity || 1) > 0;
                const ready = !element.error &&
                    element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
                    element.videoWidth > 0 && element.videoHeight > 0;

                if (visible && ready) {
                    videos.push({
                        element,
                        playing: !element.paused && !element.ended,
                        audible: !element.muted && element.volume > 0,
                        area: rect.width * rect.height
                    });
                }
            }
            if (element.shadowRoot) {
                walk(element.shadowRoot);
            }
        }
    }

    walk(document);
    if (videos.length === 0) {
        return { success: false, reason: "no-video" };
    }

    videos.sort((a, b) =>
        Number(b.playing) - Number(a.playing) ||
        Number(b.audible) - Number(a.audible) ||
        b.area - a.area
    );

    try {
        // Must be called before any await so Chrome keeps the user gesture from the extension click.
        await videos[0].element.requestPictureInPicture();
        return { success: true, action: "opened" };
    } catch (error) {
        return { success: false, reason: error?.name || "pip-failed", message: error?.message || String(error) };
    }
}

async function exitFramePiP() {
    if (!document.pictureInPictureElement) return { success: true, alreadyClosed: true };
    try {
        await document.exitPictureInPicture();
        return { success: true };
    } catch (error) {
        return { success: false, reason: error?.name || "exit-failed", message: error?.message || String(error) };
    }
}

function isRestrictedUrl(url = "") {
    return /^(chrome|chrome-extension|edge|about|devtools):/i.test(url);
}

async function toggleTabPiP(tab) {
    if (!tab?.id || isRestrictedUrl(tab.url)) {
        await chrome.action.setBadgeText({ text: "—" });
        await chrome.action.setBadgeBackgroundColor({ color: "#64748b" });
        return { success: false, code: "RESTRICTED_TAB", message: "Cannot access this tab." };
    }

    try {
        // Call executeScript before any await to preserve the transient user activation.
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            func: toggleFramePiP
        });

        const frameResults = (results || []).map(item => item.result).filter(Boolean);
        const succeeded = frameResults.find(result => result.success);
        if (succeeded) {
            await chrome.action.setBadgeText({ text: "" });
            return { success: true, code: succeeded.action === "closed" ? "PIP_CLOSED" : "PIP_OPENED" };
        }

        const failure = frameResults.find(result => result.reason && result.reason !== "no-video");
        if (failure) {
            await chrome.action.setBadgeText({ text: "!" });
            await chrome.action.setBadgeBackgroundColor({ color: "#b91c1c" });
            return { success: false, code: failure.reason, message: failure.message || "Picture-in-Picture failed." };
        }

        await chrome.action.setBadgeText({ text: "—" });
        await chrome.action.setBadgeBackgroundColor({ color: "#64748b" });
        return { success: false, code: "NO_VIDEO", message: "No ready video was found in the active tab." };
    } catch (error) {
        await chrome.action.setBadgeText({ text: "!" });
        await chrome.action.setBadgeBackgroundColor({ color: "#b91c1c" });
        return { success: false, code: "INJECTION_FAILED", message: error.message || String(error) };
    }
}

async function stopPiP() {
    const tabs = await chrome.tabs.query({});
    const results = await Promise.all(tabs.filter(tab => tab.id && !isRestrictedUrl(tab.url)).map(async tab => {
        try {
            const frames = await chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: true },
                func: exitFramePiP
            });
            return (frames || []).some(frame => frame.result?.success && !frame.result?.alreadyClosed);
        } catch {
            return false;
        }
    }));
    const closed = results.filter(Boolean).length;
    await chrome.action.setBadgeText({ text: "" });
    return { success: true, code: closed ? "PIP_CLOSED" : "NO_ACTIVE_PIP", closedFrames: closed };
}

function reportResult(result) {
    if (!result) return;
    if (!result.success) console.warn("Universal Auto PiP:", result.code, result.message);
    else console.info("Universal Auto PiP:", result.code);
}

chrome.action.onClicked.addListener(async (tab) => {
    const result = await toggleTabPiP(tab);
    reportResult(result);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
    if (command === "start-pip") {
        const result = await toggleTabPiP(tab);
        reportResult(result);
    }
    if (command === "stop-pip") {
        const result = await stopPiP();
        reportResult(result);
    }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === MENU_TOGGLE_ACTIVE) {
        const result = await toggleTabPiP(tab);
        reportResult(result);
    }
});

// Context menu items persist across service worker restarts and browser sessions in MV3.
// Creating them only on onInstalled prevents duplicate ID race conditions.
chrome.runtime.onInstalled.addListener(setupContextMenus);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "PIP_REQUEST_HANDOFF") return;
    const tabId = sender?.tab?.id;
    if (!tabId || isRestrictedUrl(sender?.tab?.url)) {
        sendResponse({ success: false, reason: "invalid-tab" });
        return;
    }

    (async () => {
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId, allFrames: true },
                func: async () => {
                    if (document.pictureInPictureElement) return { success: false, reason: "source-frame" };
                    if (typeof globalThis.__universalPiPTryTakeover === "function") {
                        return await globalThis.__universalPiPTryTakeover();
                    }
                    return { success: false, reason: "no-handler" };
                }
            });
            const handedOff = (results || []).some(item => item?.result?.success);
            sendResponse({ success: handedOff });
        } catch (error) {
            sendResponse({ success: false, reason: error?.name || "handoff-failed" });
        }
    })();
    return true;
});
