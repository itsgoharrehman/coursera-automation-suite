// ==UserScript==
// @name         Video Player Seek to Last 5 Seconds (Auto Playlist Support)
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Scans web pages for HTML5 video players, provides manual jump and an Auto-Skip toggle for consecutive/playlist videos.
// @author       Antigravity
// @match        *://*.coursera.org/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // --- Configuration ---
    const SECONDS_FROM_END = 5;      // Target seconds before video end
    const MANUAL_HOTKEY = 's';       // Manual Skip: Alt + S
    const AUTO_TOGGLE_HOTKEY = 'a';  // Toggle Auto-Skip: Alt + A

    // Persistent Auto-Skip state (saved across pages in localStorage)
    let autoSkipEnabled = localStorage.getItem('tm_auto_skip_video') !== 'false'; // Default: ON

    /**
     * Seek a specific video element to (duration - 5s)
     */
    function seekToLastSeconds(video, isAuto = false) {
        if (!video) return;

        const executeSeek = () => {
            if (video.duration && !isNaN(video.duration) && video.duration > 0) {
                const targetTime = Math.max(0, video.duration - SECONDS_FROM_END);

                // Avoid re-seeking if already within the last 5 seconds
                if (Math.abs(video.currentTime - targetTime) > 1) {
                    video.currentTime = targetTime;
                    if (video.paused) {
                        video.play().catch(() => {});
                    }
                    if (!isAuto) {
                        showToast(`Skipped to last ${SECONDS_FROM_END}s (${formatTime(targetTime)} / ${formatTime(video.duration)})`);
                    }
                }
            } else if (!isAuto) {
                showToast("Video duration unavailable or not loaded yet.");
            }
        };

        if (video.readyState >= 1) {
            executeSeek();
        } else {
            video.addEventListener('loadedmetadata', executeSeek, { once: true });
        }
    }

    /**
     * Handle auto-skipping a video when it loads/starts playing
     */
    function handleAutoSkip(video) {
        if (!autoSkipEnabled || !video) return;

        const currentSrc = video.currentSrc || video.src || video.querySelector('source')?.src || 'video_stream';

        // Check if we already auto-skipped this specific video source
        if (video.dataset.lastAutoSkippedSrc === currentSrc) {
            return;
        }

        // Mark as auto-skipped for this source
        video.dataset.lastAutoSkippedSrc = currentSrc;

        // Perform auto-seek
        seekToLastSeconds(video, true);
    }

    /**
     * Find active video player
     */
    function findTargetVideo() {
        const videos = Array.from(document.querySelectorAll('video'));
        if (videos.length === 0) return null;

        const playingVideo = videos.find(v => !v.paused && v.readyState >= 1);
        if (playingVideo) return playingVideo;

        return videos.reduce((best, current) => {
            const rect = current.getBoundingClientRect();
            const area = rect.width * rect.height;
            const bestArea = best ? best.getBoundingClientRect().width * best.getBoundingClientRect().height : 0;
            return area > bestArea ? current : best;
        }, null);
    }

    /**
     * Manual Trigger
     */
    function triggerManualSeek() {
        const targetVideo = findTargetVideo();
        if (targetVideo) {
            seekToLastSeconds(targetVideo, false);
        } else {
            const allVideos = document.querySelectorAll('video');
            if (allVideos.length > 0) {
                allVideos.forEach(v => seekToLastSeconds(v, false));
            } else {
                showToast("No video player detected on this page.");
            }
        }
    }

    /**
     * Toggle Auto-Skip Mode
     */
    function toggleAutoSkip() {
        autoSkipEnabled = !autoSkipEnabled;
        localStorage.setItem('tm_auto_skip_video', autoSkipEnabled ? 'true' : 'false');
        updateUiState();
        showToast(autoSkipEnabled ? "Auto-Skip: ENABLED" : "Auto-Skip: DISABLED");

        if (autoSkipEnabled) {
            // Trigger auto-skip immediately on active video
            const activeVideo = findTargetVideo();
            if (activeVideo) handleAutoSkip(activeVideo);
        }
    }

    /**
     * Attach auto-skip listeners to video elements
     */
    function setupVideoListeners(video) {
        if (video.dataset.tmListenersAttached === 'true') return;
        video.dataset.tmListenersAttached = 'true';

        // Listen for video play or metadata load
        const onPlayOrLoad = () => handleAutoSkip(video);

        video.addEventListener('playing', onPlayOrLoad);
        video.addEventListener('loadedmetadata', onPlayOrLoad);

        // Reset auto-skip marker when src attribute changes (for playlist auto-advance)
        const observer = new MutationObserver((mutations) => {
            mutations.forEach(m => {
                if (m.attributeName === 'src') {
                    delete video.dataset.lastAutoSkippedSrc;
                    if (!video.paused) {
                        handleAutoSkip(video);
                    }
                }
            });
        });
        observer.observe(video, { attributes: true, attributeFilter: ['src'] });

        // If video is already playing right now upon setup
        if (!video.paused && video.readyState >= 1) {
            handleAutoSkip(video);
        }
    }

    /**
     * Time Formatter
     */
    function formatTime(seconds) {
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    }

    /**
     * Toast Component (Thin Top-Right Notification with Fast 700ms Flash)
     */
    function showToast(message) {
        let toast = document.getElementById('tm-video-seek-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'tm-video-seek-toast';
            toast.style.cssText = `
                all: unset;
                box-sizing: border-box;
                position: fixed;
                top: 16px;
                right: 16px;
                background: #18181b;
                color: #f4f4f5;
                padding: 6px 12px;
                border-radius: 6px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 12px;
                font-weight: 500;
                line-height: 1.3;
                z-index: 9999999;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                pointer-events: none;
                transition: opacity 0.15s ease, transform 0.15s ease;
                opacity: 0;
                transform: translateY(-6px) scale(0.98);
                border: 1px solid #3f3f46;
                max-width: 320px;
                white-space: nowrap;
            `;
            document.body.appendChild(toast);
        }
        toast.textContent = message;

        requestAnimationFrame(() => {
            toast.style.opacity = '1';
            toast.style.transform = 'translateY(0) scale(1)';
        });

        clearTimeout(toast._timeout);
        toast._timeout = setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(-6px) scale(0.98)';
        }, 700);
    }

    /**
     * Render UI Controls Container (Bottom Middle)
     */
    function createUiControls() {
        if (document.getElementById('tm-video-seek-container')) return;

        const container = document.createElement('div');
        container.id = 'tm-video-seek-container';
        container.style.cssText = `
            all: unset;
            box-sizing: border-box;
            position: fixed;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 999998;
            display: flex;
            gap: 6px;
            align-items: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: #18181b;
            padding: 4px 6px;
            border-radius: 8px;
            border: 1px solid #3f3f46;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
        `;

        // Button 1: Manual Seek
        const seekBtn = document.createElement('button');
        seekBtn.id = 'tm-video-seek-btn';
        seekBtn.textContent = 'Skip -5s';
        seekBtn.title = `Skip active video to last ${SECONDS_FROM_END}s (Alt + ${MANUAL_HOTKEY.toUpperCase()})`;
        seekBtn.style.cssText = `
            all: unset;
            box-sizing: border-box;
            background: #27272a;
            color: #f4f4f5;
            border: 1px solid #3f3f46;
            border-radius: 6px;
            padding: 5px 12px;
            font-weight: 600;
            font-size: 12px;
            line-height: 1;
            cursor: pointer;
            user-select: none;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            transition: background 0.12s ease, border-color 0.12s ease;
        `;
        seekBtn.onmouseover = () => {
            seekBtn.style.background = '#3f3f46';
            seekBtn.style.borderColor = '#52525b';
        };
        seekBtn.onmouseout = () => {
            seekBtn.style.background = '#27272a';
            seekBtn.style.borderColor = '#3f3f46';
        };
        seekBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            triggerManualSeek();
        };

        // Button 2: Auto-Skip Toggle
        const autoBtn = document.createElement('button');
        autoBtn.id = 'tm-video-auto-btn';
        autoBtn.title = `Toggle Auto-Skip for next videos in playlist (Alt + ${AUTO_TOGGLE_HOTKEY.toUpperCase()})`;
        autoBtn.style.cssText = `
            all: unset;
            box-sizing: border-box;
            border-radius: 6px;
            padding: 5px 12px;
            font-weight: 600;
            font-size: 12px;
            line-height: 1;
            cursor: pointer;
            user-select: none;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
        `;
        autoBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleAutoSkip();
        };

        container.appendChild(seekBtn);
        container.appendChild(autoBtn);
        document.body.appendChild(container);

        updateUiState();
    }

    /**
     * Update Auto-Skip Button UI
     */
    function updateUiState() {
        const autoBtn = document.getElementById('tm-video-auto-btn');
        if (!autoBtn) return;

        if (autoSkipEnabled) {
            autoBtn.textContent = 'Auto-Skip: ON';
            autoBtn.style.background = '#27272a';
            autoBtn.style.color = '#4ade80';
            autoBtn.style.border = '1px solid #22c55e';
            autoBtn.onmouseover = () => { autoBtn.style.background = '#3f3f46'; };
            autoBtn.onmouseout = () => { autoBtn.style.background = '#27272a'; };
        } else {
            autoBtn.textContent = 'Auto-Skip: OFF';
            autoBtn.style.background = '#27272a';
            autoBtn.style.color = '#a1a1aa';
            autoBtn.style.border = '1px solid #3f3f46';
            autoBtn.onmouseover = () => { autoBtn.style.background = '#3f3f46'; };
            autoBtn.onmouseout = () => { autoBtn.style.background = '#27272a'; };
        }
    }

    /**
     * Keyboard Shortcuts
     */
    window.addEventListener('keydown', (e) => {
        if (e.altKey && e.key.toLowerCase() === MANUAL_HOTKEY) {
            e.preventDefault();
            triggerManualSeek();
        } else if (e.altKey && e.key.toLowerCase() === AUTO_TOGGLE_HOTKEY) {
            e.preventDefault();
            toggleAutoSkip();
        }
    });

    /**
     * Scanner for Videos
     */
    function scanAndAttach() {
        const videos = document.querySelectorAll('video');
        if (videos.length > 0) {
            createUiControls();
            videos.forEach(v => setupVideoListeners(v));
        }
    }

    function initScanner() {
        const observer = new MutationObserver(() => {
            scanAndAttach();
        });

        observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true
        });

        scanAndAttach();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initScanner);
    } else {
        initScanner();
    }
})();
