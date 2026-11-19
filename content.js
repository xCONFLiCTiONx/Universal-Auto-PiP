(() => {
    if (globalThis.universalPiPLoaded) return;
    globalThis.universalPiPLoaded = true;

    // Remove site-level restrictions so Chrome's native PiP control can be requested.
    function unblockVideo(video) {
        if (!(video instanceof HTMLVideoElement)) return;
        if (video.hasAttribute("disablePictureInPicture")) video.removeAttribute("disablePictureInPicture");
        try { video.disablePictureInPicture = false; } catch {}
    }

    function unblockVideos(root = document) {
        try {
            root.querySelectorAll?.("video").forEach(unblockVideo);
            root.querySelectorAll?.("*").forEach(element => {
                if (element.shadowRoot) unblockVideos(element.shadowRoot);
            });
        } catch {}
    }

    unblockVideos();
    const observer = new MutationObserver(() => unblockVideos());
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["disablepictureinpicture"]
    });

    // Compatibility hook for existing integrations that message the active tab.
    globalThis.toggleUniversalPiP = async () => {
        const current = document.pictureInPictureElement;
        if (current) {
            await document.exitPictureInPicture();
            return { success: true, action: "closed" };
        }

        const videos = [];
        const walk = root => {
            if (!root) return;
            root.querySelectorAll?.("*").forEach(element => {
                if (element instanceof HTMLVideoElement) {
                    unblockVideo(element);
                    if (!element.paused && !element.ended && element.readyState >= 2 &&
                        element.videoWidth > 0 && element.videoHeight > 0) videos.push(element);
                }
                if (element.shadowRoot) walk(element.shadowRoot);
            });
        };
        walk(document);
        if (!videos.length) return { success: false, reason: "no-playing-video" };
        videos.sort((a, b) =>
            Number(!b.muted && b.volume > 0) - Number(!a.muted && a.volume > 0) ||
            (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight)
        );
        await videos[0].requestPictureInPicture();
        return { success: true, action: "opened" };
    };

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.action === "togglePiP") {
            globalThis.toggleUniversalPiP()
                .then(sendResponse)
                .catch(error => sendResponse({ success: false, reason: error.name, message: error.message }));
            return true;
        }
    });
})();