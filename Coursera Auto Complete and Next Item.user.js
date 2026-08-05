// ==UserScript==
// @name         Coursera Autopilot
// @namespace    http://tampermonkey.net/
// @version      5.0
// @description  Two buttons: manual "Do It" and "Auto" toggle. Handles video and non-video pages.
// @author       Antigravity
// @match        *://*.coursera.org/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const SECONDS_FROM_END = 3;
    const CLICK_DELAY = 400;           // Wait 400ms after clicks
    const AFTER_NAV_WAIT = 1800;       // Wait 1.8s after page nav before acting
    const VIDEO_LOAD_TIMEOUT = 6000;   // Max 6s wait for video metadata
    const SCAN_INTERVAL = 1200;        // Check every 1.2s

    let autoEnabled = localStorage.getItem('tm_auto') === 'true';
    let isRunning = false;
    let scanTimer = null;
    let lastUrl = location.href;
    let doneUrls = new Set();
    let uiReady = false;
    let navTimestamp = 0;  // When the last navigation happened

    // =============================================
    // VIDEO HELPERS
    // =============================================

    function getLoadedVideo() {
        for (const v of document.querySelectorAll('video')) {
            if (v.readyState >= 1 && v.duration > 0 && !isNaN(v.duration)) return v;
        }
        return null;
    }

    function hasVideoElement() {
        return document.querySelectorAll('video').length > 0;
    }

    function skipVideo(video) {
        if (!video || !video.duration || isNaN(video.duration)) return false;
        const t = Math.max(0, video.duration - SECONDS_FROM_END);
        if (video.currentTime >= t - 0.5) return false;
        video.currentTime = t;
        if (video.paused) video.play().catch(() => {});
        return true;
    }

    function videoEnded(video) {
        return new Promise(resolve => {
            if (!video || video.ended) { resolve(); return; }
            if (video.currentTime >= video.duration - 0.5) { resolve(); return; }
            video.addEventListener('ended', resolve, { once: true });
            setTimeout(resolve, 30000);
        });
    }

    // Poll until video metadata loads or timeout
    function waitVideoLoad() {
        return new Promise(resolve => {
            const t0 = Date.now();
            const poll = () => {
                const v = getLoadedVideo();
                if (v) return resolve(v);
                if (Date.now() - t0 > VIDEO_LOAD_TIMEOUT) return resolve(null);
                setTimeout(poll, 600);
            };
            poll();
        });
    }

    // =============================================
    // BUTTON HELPERS
    // =============================================

    function findBtn(texts, arias, selectors) {
        // Try aria-label
        for (const a of arias) {
            const b = document.querySelector(`button[aria-label="${a}"], [role="button"][aria-label="${a}"]`);
            if (b && !b.disabled && b.offsetParent !== null) return b;
        }
        // Try text match
        for (const el of document.querySelectorAll('button, [role="button"]')) {
            const t = (el.textContent || '').trim().toLowerCase();
            for (const s of texts) {
                if (t === s && !el.disabled && el.offsetParent !== null) return el;
            }
        }
        // Try selectors
        for (const s of selectors) {
            const b = document.querySelector(s);
            if (b && !b.disabled && b.offsetParent !== null) return b;
        }
        return null;
    }

    function findLabLaunch() {
        return findBtn(
            ['launch app', 'launch lab', 'open lab', 'start lab', 'open workspace', 'launch workspace'],
            ['Launch App', 'Launch Lab', 'Open Lab', 'Start Lab', 'Open Workspace', 'Launch Workspace'],
            ['[data-test="launch-app-button"]', '[data-testid="launch-lab"]', 'button[aria-label*="Lab"]']
        );
    }

    function findSideBySide() {
        return findBtn(
            ['learn side-by-side', 'learn side by side', 'launch side by side', 'open side by side', 'side by side', 'launch in split view', 'open in split view'],
            ['Learn side-by-side', 'Learn side by side', 'Launch side by side', 'Open side by side', 'Side by side', 'Launch in split view', 'Open in split view'],
            ['[data-test="launch-side-by-side-button"]', '[data-testid="side-by-side"]']
        );
    }

    // Helper to open side-by-side in a new tab without interrupting autopilot on current tab
    function openInNewTab(element) {
        if (!element) return;
        const href = element.href || element.getAttribute('href');
        if (href && href !== '#' && !href.startsWith('javascript:')) {
            window.open(href, '_blank');
        } else {
            // Trigger Ctrl+Click / Cmd+Click to force opening in new tab
            const evt = new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                ctrlKey: true,
                metaKey: true
            });
            element.dispatchEvent(evt);
        }
    }

    function findMarkComplete() {
        return findBtn(
            ['mark as completed', 'mark as complete', 'mark completed', 'mark complete'],
            ['Mark as completed', 'Mark as Completed', 'Mark complete', 'Mark Complete'],
            ['[data-test="mark-as-completed-button"]', '[data-testid="mark-as-completed"]']
        );
    }

    function findNextItem() {
        return findBtn(
            ['go to next item', 'next item', 'go to next', 'continue', 'next'],
            ['Go to next item', 'Go To Next Item', 'Next Item', 'Next', 'Go to next'],
            ['[data-test="next-item-button"]', '[data-testid="next-button"]']
        );
    }

    function findDialogueStart() {
        return findBtn(
            ['start discussion', 'reply', 'respond', 'start dialogue', 'join discussion', 'add response', 'create response'],
            ['Start Discussion', 'Reply', 'Respond', 'Start Dialogue', 'Join Discussion', 'Add Response', 'Create Response'],
            ['[data-test="start-discussion-button"]', '[data-testid="start-discussion"]', 'button[aria-label*="discussion"]', 'button[aria-label*="Discussion"]']
        );
    }

    function findDialogueEnd() {
        return findBtn(
            ['submit', 'end discussion', 'post', 'save', 'done', 'close', 'post reply', 'submit reply'],
            ['Submit', 'End Discussion', 'Post', 'Save', 'Done', 'Close', 'Post Reply', 'Submit Reply'],
            ['[data-test="submit-discussion-button"]', '[data-testid="submit-discussion"]']
        );
    }

    // =============================================
    // THE ONE FLOW — handles video, lab, dialogue, and non-video
    // =============================================

    async function doIt(isAuto) {
        if (isRunning) return;
        if (isAuto && doneUrls.has(location.href)) return;

        // If auto, make sure enough time passed since last navigation
        if (isAuto) {
            const elapsed = Date.now() - navTimestamp;
            if (elapsed < AFTER_NAV_WAIT) {
                return; // Not enough time since page changed, wait more
            }
        }

        isRunning = true;
        const url = location.href;

        try {
            // STEP 1: Is there a video on this page?
            if (hasVideoElement()) {
                toast('Loading video...');

                // Wait for video to actually load its metadata
                const video = await waitVideoLoad();

                if (video) {
                    // Skip to last N seconds
                    if (skipVideo(video)) toast('Skipped to last ' + SECONDS_FROM_END + 's');

                    // Wait for video to actually finish playing
                    toast('Playing last seconds...');
                    await videoEnded(video);
                    toast('Video done');
                    await sleep(1000); // Let Coursera update its UI
                }
            }

            // STEP 2: Lab & Side-by-Side Handling
            // 1. First click "Launch Lab" / "Launch App" if present
            let lab = findLabLaunch();
            if (lab) {
                lab.click();
                toast('Lab Launched');
                await sleep(1500); // Wait for "Learn side-by-side" screen/button to render
            }

            // 2. Then click "Learn side-by-side" in a NEW TAB if present
            let sbs = findSideBySide();
            if (sbs) {
                openInNewTab(sbs);
                toast('Side-by-Side (New Tab)');
                await sleep(1000);
            }

            // Poll briefly for "Mark as Completed" to appear after launching lab
            let mark = findMarkComplete();
            if (!mark && (lab || sbs)) {
                for (let i = 0; i < 10; i++) { // wait up to 3s for Mark Complete button
                    await sleep(300);
                    mark = findMarkComplete();
                    if (mark) break;
                }
            }

            // STEP 3: Dialogue / Discussion Prompt Handling
            const dlgStart = findDialogueStart();
            if (dlgStart) {
                dlgStart.click();
                toast('Discussion started');
                await sleep(1500); // Wait for discussion UI to load

                // Poll for End/Submit button
                let dlgEnd = findDialogueEnd();
                if (!dlgEnd) {
                    for (let i = 0; i < 10; i++) {
                        await sleep(500);
                        dlgEnd = findDialogueEnd();
                        if (dlgEnd) break;
                    }
                }
                if (dlgEnd) {
                    dlgEnd.click();
                    toast('Discussion ended');
                    await sleep(1000);
                }

                // Re-check mark complete after dialogue
                if (!mark) {
                    for (let i = 0; i < 10; i++) {
                        await sleep(300);
                        mark = findMarkComplete();
                        if (mark) break;
                    }
                }
            }

            // STEP 4: Mark as complete (if button exists)
            if (mark) {
                mark.click();
                toast('Marked complete');
                await sleep(CLICK_DELAY);
            }

            // STEP 5: Go to next item
            const next = findNextItem();
            if (next) {
                next.click();
                toast('Next item');
                doneUrls.add(url);
                navTimestamp = Date.now();
            } else if (!mark && !lab && !sbs && !dlgStart && !hasVideoElement()) {
                toast('Nothing to do');
            }

        } finally {
            // Keep set small
            if (doneUrls.size > 200) doneUrls = new Set([...doneUrls].slice(-50));

            await sleep(AFTER_NAV_WAIT);
            isRunning = false;
        }
    }

    // =============================================
    // AUTO SCANNER
    // =============================================

    function startScan() {
        stopScan();
        scanTimer = setInterval(() => {
            if (!autoEnabled || isRunning) return;
            if (doneUrls.has(location.href)) return;

            // Don't act until AFTER_NAV_WAIT has passed since last navigation
            if (Date.now() - navTimestamp < AFTER_NAV_WAIT) return;

            // Only trigger if there's something to act on
            if (hasVideoElement() || findLabLaunch() || findSideBySide() || findDialogueStart() || findMarkComplete() || findNextItem()) {
                doIt(true);
            }
        }, SCAN_INTERVAL);
    }

    function stopScan() {
        if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    }

    // =============================================
    // URL WATCHER
    // =============================================

    setInterval(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            navTimestamp = Date.now(); // Reset — new page is loading
            isRunning = false;
        }
    }, 800);

    // =============================================
    // TOGGLE
    // =============================================

    function toggleAuto() {
        autoEnabled = !autoEnabled;
        localStorage.setItem('tm_auto', autoEnabled ? 'true' : 'false');
        updateUi();
        toast(autoEnabled ? 'Auto: ON' : 'Auto: OFF');
        if (autoEnabled) {
            navTimestamp = Date.now(); // Reset so it waits before first action
            isRunning = false;
            doneUrls.delete(location.href); // Allow re-processing current page
            startScan();
        } else {
            stopScan();
        }
    }

    // =============================================
    // UI — Two buttons only
    // =============================================

    function toast(msg) {
        let t = document.getElementById('tm-t');
        if (!t) {
            t = document.createElement('div');
            t.id = 'tm-t';
            Object.assign(t.style, {
                all: 'unset', boxSizing: 'border-box',
                position: 'fixed', bottom: '60px', right: '16px',
                background: '#052e16', color: '#4ade80',
                padding: '8px 16px', borderRadius: '6px',
                fontFamily: 'system-ui, sans-serif', fontSize: '13px', fontWeight: '600',
                zIndex: '9999999', pointerEvents: 'none',
                transition: 'opacity .15s', opacity: '0',
                border: '1px solid #16a34a', maxWidth: '320px', whiteSpace: 'nowrap'
            });
            document.body.appendChild(t);
        }
        t.textContent = msg;
        t.style.opacity = '1';
        clearTimeout(t._x);
        t._x = setTimeout(() => t.style.opacity = '0', 1400);
    }

    function createUi() {
        if (uiReady && document.getElementById('tm-bar')) return;
        const old = document.getElementById('tm-bar');
        if (old) old.remove();

        const bar = document.createElement('div');
        bar.id = 'tm-bar';
        Object.assign(bar.style, {
            all: 'unset', boxSizing: 'border-box',
            position: 'fixed', zIndex: '999998',
            display: 'flex', gap: '4px', alignItems: 'center',
            fontFamily: 'system-ui, sans-serif',
            background: '#111', padding: '4px 6px',
            borderRadius: '8px', border: '1px solid #2a2a2a',
            boxShadow: '0 2px 12px rgba(0,0,0,.4)',
            userSelect: 'none', cursor: 'grab'
        });

        // Restore saved position or default to bottom-center
        const saved = localStorage.getItem('tm_bar_pos');
        if (saved) {
            try {
                const pos = JSON.parse(saved);
                bar.style.left = pos.x + 'px';
                bar.style.top = pos.y + 'px';
            } catch (_) {
                bar.style.bottom = '16px';
                bar.style.left = '50%';
                bar.style.transform = 'translateX(-50%)';
            }
        } else {
            bar.style.bottom = '16px';
            bar.style.left = '50%';
            bar.style.transform = 'translateX(-50%)';
        }

        // --- Drag logic ---
        let isDragging = false;
        let dragStartX, dragStartY, barStartX, barStartY;

        bar.addEventListener('mousedown', (e) => {
            // Only drag from the bar itself, not from buttons
            if (e.target.tagName === 'BUTTON') return;
            isDragging = true;
            bar.style.cursor = 'grabbing';
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            const rect = bar.getBoundingClientRect();
            barStartX = rect.left;
            barStartY = rect.top;
            // Clear default positioning so left/top work
            bar.style.bottom = '';
            bar.style.right = '';
            bar.style.transform = '';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - dragStartX;
            const dy = e.clientY - dragStartY;
            let newX = barStartX + dx;
            let newY = barStartY + dy;
            // Clamp to viewport
            const rect = bar.getBoundingClientRect();
            newX = Math.max(0, Math.min(newX, window.innerWidth - rect.width));
            newY = Math.max(0, Math.min(newY, window.innerHeight - rect.height));
            bar.style.left = newX + 'px';
            bar.style.top = newY + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (!isDragging) return;
            isDragging = false;
            bar.style.cursor = 'grab';
            // Save position
            const rect = bar.getBoundingClientRect();
            localStorage.setItem('tm_bar_pos', JSON.stringify({ x: rect.left, y: rect.top }));
        });

        // Button 1: Skip & Next (manual)
        const doBtn = document.createElement('button');
        doBtn.id = 'tm-do';
        doBtn.textContent = 'Skip & Next';
        doBtn.title = 'Run the full process once [Alt+D]';
        Object.assign(doBtn.style, {
            all: 'unset', boxSizing: 'border-box',
            background: '#1a1a1a', color: '#ccc',
            border: '1px solid #2a2a2a', borderRadius: '5px',
            padding: '4px 10px', fontWeight: '600', fontSize: '10px',
            lineHeight: '1', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background .1s', whiteSpace: 'nowrap'
        });
        doBtn.onmouseenter = () => doBtn.style.background = '#2a2a2a';
        doBtn.onmouseleave = () => doBtn.style.background = '#1a1a1a';
        doBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); doIt(false); };

        // Button 2: Auto Skip (toggle)
        const autoBtn = document.createElement('button');
        autoBtn.id = 'tm-auto';
        autoBtn.title = 'Toggle autopilot [Alt+A]';
        Object.assign(autoBtn.style, {
            all: 'unset', boxSizing: 'border-box',
            borderRadius: '5px',
            padding: '4px 10px', fontWeight: '600', fontSize: '10px',
            lineHeight: '1', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background .1s, color .1s, border-color .1s',
            whiteSpace: 'nowrap'
        });
        autoBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); toggleAuto(); };

        bar.appendChild(doBtn);
        bar.appendChild(autoBtn);
        document.body.appendChild(bar);
        uiReady = true;
        updateUi();
    }

    function updateUi() {
        const b = document.getElementById('tm-auto');
        if (!b) return;
        if (autoEnabled) {
            b.textContent = 'Auto Skip: ON';
            Object.assign(b.style, { background: '#0a1a0a', color: '#4ade80', borderColor: '#16a34a', border: '1px solid #16a34a' });
            b.onmouseenter = () => b.style.background = '#0f2a0f';
            b.onmouseleave = () => Object.assign(b.style, { background: '#0a1a0a' });
        } else {
            b.textContent = 'Auto Skip: OFF';
            Object.assign(b.style, { background: '#1a1a1a', color: '#666', borderColor: '#2a2a2a', border: '1px solid #2a2a2a' });
            b.onmouseenter = () => b.style.background = '#2a2a2a';
            b.onmouseleave = () => Object.assign(b.style, { background: '#1a1a1a' });
        }
    }

    // Debounced UI check
    let uiTmr = null;
    function ensureUi() {
        if (uiTmr) return;
        uiTmr = setTimeout(() => { uiTmr = null; if (!document.getElementById('tm-bar')) { uiReady = false; createUi(); } }, 500);
    }

    // =============================================
    // KEYBOARD
    // =============================================

    window.addEventListener('keydown', (e) => {
        if (!e.altKey) return;
        if (e.key.toLowerCase() === 'd') { e.preventDefault(); doIt(false); }
        if (e.key.toLowerCase() === 'a') { e.preventDefault(); toggleAuto(); }
    });

    // =============================================
    // INIT
    // =============================================

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function init() {
        navTimestamp = Date.now(); // Page just loaded
        createUi();

        const obs = new MutationObserver(() => ensureUi());
        obs.observe(document.body || document.documentElement, { childList: true, subtree: true });

        if (autoEnabled) {
            setTimeout(() => startScan(), AFTER_NAV_WAIT);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
