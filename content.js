(() => {
    if (globalThis.universalPiPLoaded) return;
    globalThis.universalPiPLoaded = true;

    const LOG_PREFIX = "Universal Auto PiP:";
    const WATCHDOG_INTERVAL_MS = 500;
    const FROZEN_THRESHOLD_MS = 2500;
    const DEEP_FROZEN_THRESHOLD_MS = 4000;
    const FAILED_CANDIDATE_COOLDOWN_MS = 1000;
    const CROSS_FRAME_COOLDOWN_MS = 2000;
    const MIN_AUDIBLE_WIDTH = 120;
    const MIN_AUDIBLE_HEIGHT = 68;
    const MIN_SUBSTANTIAL_WIDTH = 200;
    const MIN_SUBSTANTIAL_HEIGHT = 110;
    const MIN_DEAD_FALLBACK_WIDTH = 160;
    const MIN_DEAD_FALLBACK_HEIGHT = 90;

    const trackedVideos = new WeakSet();
    const observedShadowRoots = new WeakSet();
    const failedAttempts = new WeakMap();

    let watchdogTimer = null;
    let activePiPVideo = null;
    let lastObservedTime = null;
    let lastObservedFrames = null;
    let lastProgressAt = 0;
    let switching = false;
    let lastCrossFrameAttemptAt = 0;
    let loggedUnhealthyState = null;

    // Remove site-level restrictions so Chrome's native PiP control can be requested.
    function unblockVideo(video) {
        if (!(video instanceof HTMLVideoElement)) return;
        if (video.hasAttribute("disablePictureInPicture")) {
            video.removeAttribute("disablePictureInPicture");
        }
        try {
            video.disablePictureInPicture = false;
        } catch {}
        trackVideo(video);
    }

    function trackVideo(video) {
        if (trackedVideos.has(video)) return;
        trackedVideos.add(video);

        // Attach directly so Shadow DOM videos (whose events aren't composed) are also caught.
        video.addEventListener("enterpictureinpicture", () => onEnterPiP(video));
        video.addEventListener("leavepictureinpicture", () => onLeavePiP(video));
        for (const evt of ["playing", "canplay", "loadeddata"]) {
            video.addEventListener(evt, () => {
                if (document.pictureInPictureElement && video !== document.pictureInPictureElement) {
                    scheduleCheck();
                }
            });
        }
    }

    function observeShadowRoot(shadowRoot) {
        if (!shadowRoot || observedShadowRoots.has(shadowRoot)) return;
        observedShadowRoots.add(shadowRoot);
        shadowObserver.observe(shadowRoot, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["disablepictureinpicture"]
        });
    }

    function scanSubtree(root) {
        if (!root) return;
        if (root instanceof HTMLVideoElement) {
            unblockVideo(root);
            return;
        }
        if (root.shadowRoot) {
            observeShadowRoot(root.shadowRoot);
            scanSubtree(root.shadowRoot);
        }
        if (!root.querySelectorAll) return;

        try {
            const videos = root.querySelectorAll("video");
            for (const video of videos) {
                unblockVideo(video);
            }
            const elements = root.querySelectorAll("*");
            for (const element of elements) {
                if (element.shadowRoot) {
                    observeShadowRoot(element.shadowRoot);
                    scanSubtree(element.shadowRoot);
                }
            }
        } catch {}
    }

    function handleMutations(mutations) {
        let videoAdded = false;
        for (const mutation of mutations) {
            if (mutation.type === "attributes") {
                if (mutation.target instanceof HTMLVideoElement) {
                    unblockVideo(mutation.target);
                }
            } else if (mutation.type === "childList") {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
                        continue;
                    }
                    if (node instanceof HTMLVideoElement) {
                        unblockVideo(node);
                        videoAdded = true;
                    } else {
                        scanSubtree(node);
                        if (node.querySelector?.("video")) {
                            videoAdded = true;
                        }
                    }
                }
            }
        }
        if (videoAdded && document.pictureInPictureElement) {
            scheduleCheck();
        }
    }

    const domObserver = new MutationObserver(handleMutations);
    const shadowObserver = new MutationObserver(handleMutations);

    scanSubtree(document);
    if (document.documentElement) {
        domObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["disablepictureinpicture"]
        });
    }

    function collectVideos() {
        const list = [];
        const visited = new Set();
        const walk = (root) => {
            if (!root || visited.has(root)) return;
            visited.add(root);
            let videos = [];
            try {
                videos = root.querySelectorAll ? root.querySelectorAll("video") : [];
            } catch {
                return;
            }
            for (const video of videos) {
                if (video instanceof HTMLVideoElement) {
                    unblockVideo(video);
                    list.push(video);
                }
            }
            let elements = [];
            try {
                elements = root.querySelectorAll ? root.querySelectorAll("*") : [];
            } catch {
                return;
            }
            for (const element of elements) {
                if (element.shadowRoot) {
                    observeShadowRoot(element.shadowRoot);
                    walk(element.shadowRoot);
                }
            }
        };
        walk(document);
        return list;
    }

    function getVideoMetrics(video) {
        if (!(video instanceof HTMLVideoElement) || !video.isConnected) {
            return { visible: false, width: 0, height: 0, area: 0, audible: false, ready: false, playing: false };
        }
        let rect = { width: 0, height: 0 };
        let style = null;
        try {
            rect = video.getBoundingClientRect();
            style = getComputedStyle(video);
        } catch {}

        const width = Math.max(rect.width || 0, video.clientWidth || 0);
        const height = Math.max(rect.height || 0, video.clientHeight || 0);
        const visible = width > 0 && height > 0 &&
            (!style || (style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0));
        const ready = !video.error &&
            video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
            video.videoWidth > 0 && video.videoHeight > 0;
        const playing = !video.paused && !video.ended;
        const audible = !video.muted && video.volume > 0;

        return { visible, width, height, area: width * height, audible, ready, playing };
    }

    function getDecodedFrameCount(video) {
        try {
            const quality = video.getVideoPlaybackQuality?.();
            if (quality && typeof quality.totalVideoFrames === "number") {
                return quality.totalVideoFrames;
            }
        } catch {}
        return null;
    }

    function resetProgressTracking(video) {
        activePiPVideo = video;
        lastObservedTime = typeof video?.currentTime === "number" ? video.currentTime : null;
        lastObservedFrames = video ? getDecodedFrameCount(video) : null;
        lastProgressAt = Date.now();
        loggedUnhealthyState = null;
    }

    function updateProgressTracking(video) {
        const now = Date.now();
        const time = typeof video.currentTime === "number" ? video.currentTime : null;
        const frames = getDecodedFrameCount(video);

        const timeAdvanced = time !== null && lastObservedTime !== null && Math.abs(time - lastObservedTime) > 0.01;
        const framesAdvanced = frames !== null && lastObservedFrames !== null && frames > lastObservedFrames;

        if (timeAdvanced || framesAdvanced || lastObservedTime === null) {
            lastObservedTime = time;
            lastObservedFrames = frames;
            lastProgressAt = now;
        }
        return now - lastProgressAt;
    }

    function classifyPiPHealth(video) {
        if (!video) return { state: "none", stalledMs: 0 };

        if (!video.isConnected ||
            video.error ||
            video.ended ||
            video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
            video.videoWidth === 0 ||
            video.videoHeight === 0) {
            const reason = !video.isConnected ? "detached"
                : video.error ? `error(${video.error.code})`
                : video.ended ? "ended"
                : video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ? `readyState(${video.readyState})`
                : "no-dimensions";
            return { state: "dead", reason, stalledMs: 0 };
        }

        if (video.paused) {
            // Reset progress timer while paused so resuming doesn't look stalled.
            lastProgressAt = Date.now();
            lastObservedTime = video.currentTime;
            lastObservedFrames = getDecodedFrameCount(video);
            return { state: "paused", reason: "paused", stalledMs: 0 };
        }

        const stalledMs = updateProgressTracking(video);
        if (stalledMs >= FROZEN_THRESHOLD_MS) {
            return { state: "frozen", reason: `stalled(${stalledMs}ms)`, stalledMs };
        }

        return { state: "healthy", reason: "playing", stalledMs };
    }

    function isEligibleReplacement(metrics, health, currentMetrics) {
        if (!metrics.visible || !metrics.ready || !metrics.playing) return false;

        if (health.state === "dead") {
            // Prefer any audible video of reasonable size, or a substantial muted player
            // (skipping tiny muted hover thumbnails).
            if (metrics.audible) {
                return metrics.width >= MIN_AUDIBLE_WIDTH && metrics.height >= MIN_AUDIBLE_HEIGHT;
            }
            return metrics.width >= MIN_DEAD_FALLBACK_WIDTH && metrics.height >= MIN_DEAD_FALLBACK_HEIGHT;
        }

        if (health.state === "frozen") {
            if (metrics.audible) {
                return metrics.width >= MIN_AUDIBLE_WIDTH && metrics.height >= MIN_AUDIBLE_HEIGHT;
            }
            const currentHidden = !currentMetrics.visible;
            if (currentHidden || health.stalledMs >= DEEP_FROZEN_THRESHOLD_MS) {
                return metrics.width >= MIN_SUBSTANTIAL_WIDTH && metrics.height >= MIN_SUBSTANTIAL_HEIGHT;
            }
            return false;
        }

        if (health.state === "paused") {
            // Never hijack a healthy user-paused video for a muted hover preview.
            // Only hand off if a real, audible, substantial video starts playing.
            return metrics.audible &&
                metrics.width >= MIN_SUBSTANTIAL_WIDTH &&
                metrics.height >= MIN_SUBSTANTIAL_HEIGHT;
        }

        return false;
    }

    function findBestCandidate(excludeVideo, health, currentMetrics) {
        const now = Date.now();
        const candidates = [];

        for (const video of collectVideos()) {
            if (video === excludeVideo) continue;
            const lastFailed = failedAttempts.get(video) || 0;
            if (now - lastFailed < FAILED_CANDIDATE_COOLDOWN_MS) continue;

            const metrics = getVideoMetrics(video);
            if (!isEligibleReplacement(metrics, health, currentMetrics)) continue;

            candidates.push({ video, metrics });
        }

        candidates.sort((a, b) =>
            Number(b.metrics.audible) - Number(a.metrics.audible) ||
            b.metrics.area - a.metrics.area
        );

        return candidates[0] || null;
    }

    function requestCrossFrameHandoff() {
        const now = Date.now();
        if (now - lastCrossFrameAttemptAt < CROSS_FRAME_COOLDOWN_MS) return;
        lastCrossFrameAttemptAt = now;
        try {
            chrome.runtime.sendMessage({ type: "PIP_REQUEST_HANDOFF" }, () => {
                void chrome.runtime.lastError;
            });
        } catch {}
    }

    let checkQueued = false;
    function scheduleCheck() {
        if (checkQueued) return;
        checkQueued = true;
        queueMicrotask(() => {
            checkQueued = false;
            void evaluatePiPHealth();
        });
    }

    async function evaluatePiPHealth() {
        const current = document.pictureInPictureElement;
        if (!current) {
            stopWatchdog();
            return;
        }
        if (switching) return;

        if (current !== activePiPVideo) {
            attachActiveVideoListeners(current);
            resetProgressTracking(current);
        }

        const health = classifyPiPHealth(current);
        if (health.state === "healthy") {
            loggedUnhealthyState = null;
            return;
        }

        if (health.state !== "paused" && loggedUnhealthyState !== health.state) {
            loggedUnhealthyState = health.state;
            console.info(LOG_PREFIX, `PiP video unhealthy (${health.reason}); watching for replacement video.`);
        }

        const currentMetrics = getVideoMetrics(current);
        const best = findBestCandidate(current, health, currentMetrics);

        if (!best) {
            // If current is dead or frozen and no replacement exists in this frame,
            // ask background to check other frames in this tab.
            if (health.state === "dead" || health.state === "frozen") {
                requestCrossFrameHandoff();
            }
            return;
        }

        // Never call exitPictureInPicture() before requesting PiP on the replacement:
        // keeping document.pictureInPictureElement populated allows gesture-free handoff.
        switching = true;
        try {
            unblockVideo(best.video);
            await best.video.requestPictureInPicture();
            console.info(LOG_PREFIX, `Handed off PiP from ${health.reason} video to active video.`);
            attachActiveVideoListeners(best.video);
            resetProgressTracking(best.video);
        } catch (error) {
            failedAttempts.set(best.video, Date.now());
            console.debug(LOG_PREFIX, "PiP handoff attempt failed, will retry:", error?.name || error);
        } finally {
            switching = false;
        }
    }

    let activeVideoAbort = null;
    function attachActiveVideoListeners(video) {
        if (activeVideoAbort) {
            activeVideoAbort.abort();
            activeVideoAbort = null;
        }
        if (!(video instanceof HTMLVideoElement)) return;

        const controller = new AbortController();
        activeVideoAbort = controller;
        const { signal } = controller;

        for (const evt of ["error", "emptied", "abort", "ended", "stalled", "waiting"]) {
            video.addEventListener(evt, () => scheduleCheck(), { signal });
        }
        for (const evt of ["playing", "timeupdate"]) {
            video.addEventListener(evt, () => {
                if (video === activePiPVideo && !video.paused) {
                    updateProgressTracking(video);
                }
            }, { signal });
        }
    }

    function startWatchdog(video) {
        if (video && video !== activePiPVideo) {
            attachActiveVideoListeners(video);
            resetProgressTracking(video);
        }
        if (watchdogTimer !== null) return;
        watchdogTimer = setInterval(() => {
            void evaluatePiPHealth();
        }, WATCHDOG_INTERVAL_MS);
    }

    function stopWatchdog() {
        if (watchdogTimer !== null) {
            clearInterval(watchdogTimer);
            watchdogTimer = null;
        }
        if (activeVideoAbort) {
            activeVideoAbort.abort();
            activeVideoAbort = null;
        }
        activePiPVideo = null;
        lastObservedTime = null;
        lastObservedFrames = null;
        loggedUnhealthyState = null;
    }

    function onEnterPiP(video) {
        console.info(LOG_PREFIX, "PiP entered; health monitor active.");
        startWatchdog(video || document.pictureInPictureElement);
    }

    function onLeavePiP() {
        // When handing off from video A to video B, leavepictureinpicture fires on A
        // while document.pictureInPictureElement may already be B (or briefly null).
        // Defer stop check by one microtask so handoffs don't tear down the watchdog.
        queueMicrotask(() => {
            if (switching) return;
            const current = document.pictureInPictureElement;
            if (!current) {
                console.info(LOG_PREFIX, "PiP closed; health monitor stopped.");
                stopWatchdog();
            } else if (current !== activePiPVideo) {
                startWatchdog(current);
            }
        });
    }

    // Capture-phase listeners catch events from any light-DOM video in this document.
    document.addEventListener("enterpictureinpicture", (event) => {
        onEnterPiP(event.target instanceof HTMLVideoElement ? event.target : document.pictureInPictureElement);
    }, true);

    document.addEventListener("leavepictureinpicture", (event) => {
        onLeavePiP(event.target instanceof HTMLVideoElement ? event.target : null);
    }, true);

    for (const evt of ["playing", "canplay", "loadeddata"]) {
        document.addEventListener(evt, (event) => {
            const current = document.pictureInPictureElement;
            if (current && event.target instanceof HTMLVideoElement && event.target !== current) {
                scheduleCheck();
            }
        }, true);
    }

    // If PiP was already open before content.js initialized, start monitoring immediately.
    if (document.pictureInPictureElement) {
        startWatchdog(document.pictureInPictureElement);
    }

    // Cross-frame takeover hook invoked by background.js when another frame's PiP died.
    globalThis.__universalPiPTryTakeover = async () => {
        if (document.pictureInPictureElement) return { success: false, reason: "already-pip" };

        const candidates = [];
        for (const video of collectVideos()) {
            const metrics = getVideoMetrics(video);
            if (!metrics.visible || !metrics.ready || !metrics.playing) continue;
            if (metrics.audible) {
                if (metrics.width < MIN_AUDIBLE_WIDTH || metrics.height < MIN_AUDIBLE_HEIGHT) continue;
            } else if (metrics.width < MIN_SUBSTANTIAL_WIDTH || metrics.height < MIN_SUBSTANTIAL_HEIGHT) {
                continue;
            }
            candidates.push({ video, metrics });
        }

        if (!candidates.length) return { success: false, reason: "no-candidate" };
        candidates.sort((a, b) =>
            Number(b.metrics.audible) - Number(a.metrics.audible) ||
            b.metrics.area - a.metrics.area
        );

        try {
            unblockVideo(candidates[0].video);
            await candidates[0].video.requestPictureInPicture();
            console.info(LOG_PREFIX, "Cross-frame PiP takeover succeeded.");
            return { success: true };
        } catch (error) {
            return { success: false, reason: error?.name || "takeover-failed" };
        }
    };

    // Compatibility hook for existing integrations that message the active tab.
    globalThis.toggleUniversalPiP = async () => {
        const current = document.pictureInPictureElement;
        if (current) {
            await document.exitPictureInPicture();
            return { success: true, action: "closed" };
        }

        const candidates = [];
        for (const video of collectVideos()) {
            const metrics = getVideoMetrics(video);
            if (metrics.visible && metrics.ready && metrics.playing) {
                candidates.push({ video, metrics });
            }
        }
        if (!candidates.length) return { success: false, reason: "no-playing-video" };

        candidates.sort((a, b) =>
            Number(b.metrics.audible) - Number(a.metrics.audible) ||
            b.metrics.area - a.metrics.area
        );
        await candidates[0].video.requestPictureInPicture();
        return { success: true, action: "opened" };
    };

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.action === "togglePiP") {
            (async () => {
                try {
                    const result = await globalThis.toggleUniversalPiP();
                    sendResponse(result);
                } catch (error) {
                    sendResponse({ success: false, reason: error?.name || "error", message: error?.message || String(error) });
                }
            })();
            return true;
        }
    });
})();
