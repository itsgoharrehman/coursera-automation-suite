// ==UserScript==
// @name         Coursera Autopilot
// @namespace    http://tampermonkey.net/
// @version      6.0
// @description  Complete Coursera autopilot. Handles ALL activity types: videos, readings, labs, discussions, quizzes, peer reviews, and more.
// @author       Antigravity
// @match        *://*.coursera.org/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // --- Configuration ---
    const SECONDS_FROM_END = 3;
    const CLICK_DELAY = 400;
    const AFTER_NAV_WAIT = 1800;
    const VIDEO_LOAD_TIMEOUT = 6000;
    const SCAN_INTERVAL = 1200;

    // --- State ---
    let autoEnabled = localStorage.getItem('tm_auto') === 'true';
    let isRunning = false;
    let scanTimer = null;
    let lastUrl = location.href;
    let doneUrls = new Set();
    let uiReady = false;
    let navTimestamp = 0;
    let waitingForAssignment = false;
    let primarySubmitClicked = false;
    let finalSubmitConfirmed = false;

    // Track user clicking Submit on assignment/quiz (distinguish 1st submit vs 2nd modal submit)
    document.addEventListener('click', (e) => {
        const target = e.target;
        if (!target) return;
        const btn = target.closest('button, [role="button"], input[type="submit"]');
        if (!btn) return;

        const insideModal = btn.closest('[role="dialog"], .rc-Modal, .cds-Modal-container, [data-test="modal"]') !== null;
        const text = (btn.textContent || btn.value || '').toLowerCase();

        if (insideModal) {
            if (text.includes('submit') || text.includes('confirm') || text.includes('yes')) {
                finalSubmitConfirmed = true;
                toast('Final submit confirmed! Waiting for next item...');
            }
        } else {
            if (text.includes('submit')) {
                primarySubmitClicked = true;
                toast('Submit clicked. Please confirm in popup modal...');
            }
        }
    }, true);

    // =============================================
    // URL TYPE DETECTION
    // Coursera URLs: /learn/[course]/[type]/[id]
    // =============================================

    function getPageType() {
        const path = location.pathname.toLowerCase();
        if (path.includes('/lecture'))           return 'video';
        if (path.includes('/supplement'))        return 'reading';
        if (path.includes('/quiz'))              return 'quiz';
        if (path.includes('/exam'))              return 'quiz';
        if (path.includes('/assignment'))        return 'assignment';
        if (path.includes('/ungradedlab'))       return 'lab';
        if (path.includes('/ungradedwidget'))    return 'lab';
        if (path.includes('/gradedlti'))         return 'lab';
        if (path.includes('/ungradedlti'))       return 'lab';
        if (path.includes('/discussionprompt'))  return 'discussion';
        if (path.includes('/dialogue'))          return 'dialogue';
        if (path.includes('/peer'))              return 'peer';
        if (path.includes('/programming'))       return 'programming';
        if (path.includes('/item'))              return 'generic';
        return 'unknown';
    }

    function isAssignmentPage() {
        const type = getPageType();
        if (['quiz', 'assignment', 'peer', 'programming'].includes(type)) return true;
        const path = location.pathname.toLowerCase();
        if (path.includes('/graded')) return true;
        const h1 = document.querySelector('h1, h2');
        const headerText = h1 ? h1.textContent.toLowerCase() : '';
        if (headerText.includes('assignment') || headerText.includes('graded quiz')) return true;
        return false;
    }

    function isSubmissionModalOpen() {
        const modal = document.querySelector('[role="dialog"], .rc-Modal, .cds-Modal-container, [data-test="modal"]');
        if (!modal) return false;
        const text = (modal.textContent || '').toLowerCase();
        return text.includes('submit') || text.includes('confirm') || text.includes('are you sure');
    }

    function isAlreadyCompletedAssignment() {
        const hasQuizInputs = document.querySelectorAll('input[type="radio"]:not([disabled]), input[type="checkbox"]:not([disabled]), textarea:not([disabled])').length > 0;
        const hasSubmitBtn = findBtnPartial(['submit assignment', 'submit quiz', 'submit']) !== null;
        const hasStartBtn = findBtnPartial(['start assignment', 'resume assignment', 'start quiz', 'attempt assignment']) !== null;

        if (hasQuizInputs || hasSubmitBtn || hasStartBtn) return false;

        const hasGradeBadge = document.querySelector('[data-test="grade-badge"], [data-testid="grade-badge"], [data-test="pass-badge"], .rc-QuizResults, .rc-AssignmentFeedback') !== null;
        return hasGradeBadge;
    }

    function isUnsubmittedAssignment() {
        if (!isAssignmentPage()) return false;
        if (isSubmissionModalOpen()) return true;

        const hasQuizInputs = document.querySelectorAll('input[type="radio"]:not([disabled]), input[type="checkbox"]:not([disabled]), textarea:not([disabled])').length > 0;
        const hasSubmitBtn = findBtnPartial(['submit assignment', 'submit quiz', 'submit']) !== null;
        const hasStartBtn = findBtnPartial(['start assignment', 'resume assignment', 'start quiz', 'attempt assignment', 'start']) !== null;

        if (hasQuizInputs || hasSubmitBtn || hasStartBtn || primarySubmitClicked) {
            return !finalSubmitConfirmed;
        }

        return !finalSubmitConfirmed && !isAlreadyCompletedAssignment();
    }

    // =============================================
    // VIDEO
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

    function waitVideoLoad() {
        return new Promise(resolve => {
            const t0 = Date.now();
            const poll = () => {
                const v = getLoadedVideo();
                if (v) return resolve(v);
                if (Date.now() - t0 > VIDEO_LOAD_TIMEOUT) return resolve(null);
                setTimeout(poll, 500);
            };
            poll();
        });
    }

    // =============================================
    // UNIVERSAL BUTTON FINDER
    // =============================================

    function findBtn(texts, arias, selectors) {
        for (const a of arias) {
            const b = document.querySelector(`button[aria-label="${a}"], [role="button"][aria-label="${a}"]`);
            if (b && !b.disabled && b.offsetParent !== null) return b;
        }
        for (const el of document.querySelectorAll('button, [role="button"]')) {
            const t = (el.textContent || '').trim().toLowerCase();
            for (const s of texts) {
                if (t === s && !el.disabled && el.offsetParent !== null) return el;
            }
        }
        for (const s of selectors) {
            const b = document.querySelector(s);
            if (b && !b.disabled && b.offsetParent !== null) return b;
        }
        return null;
    }

    // Helper: find button by partial text match (for modals/dynamic text)
    function findBtnPartial(partials) {
        for (const el of document.querySelectorAll('button, [role="button"]')) {
            if (el.disabled || el.offsetParent === null) continue;
            const t = (el.textContent || '').trim().toLowerCase();
            for (const p of partials) {
                if (t.includes(p.toLowerCase())) return el;
            }
        }
        return null;
    }

    // Poll for a button to appear (up to maxMs)
    function waitForBtn(finderFn, maxMs = 3000) {
        return new Promise(resolve => {
            const t0 = Date.now();
            const poll = () => {
                const b = finderFn();
                if (b) return resolve(b);
                if (Date.now() - t0 > maxMs) return resolve(null);
                setTimeout(poll, 300);
            };
            poll();
        });
    }

    function openInNewTab(el) {
        if (!el) return;
        const href = el.href || el.getAttribute('href');
        if (href && href !== '#' && !href.startsWith('javascript:')) {
            window.open(href, '_blank');
        } else {
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true, metaKey: true }));
        }
    }

    // =============================================
    // BUTTON FINDERS FOR EACH ACTIVITY TYPE
    // =============================================

    // --- Navigation ---
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

    // --- Assignment ---
    function findAssignmentStart() {
        return findBtn(
            ['start assignment', 'resume assignment', 'start quiz', 'attempt assignment', 'start', 'resume', 'begin assignment', 'open assignment'],
            ['Start assignment', 'Resume assignment', 'Start quiz', 'Attempt assignment', 'Start Assignment', 'Resume Assignment', 'Start', 'Resume'],
            ['[data-test="start-assignment-button"]', '[data-testid="start-assignment"]', 'button[aria-label*="assignment"]', 'button[aria-label*="Assignment"]']
        );
    }

    // --- Lab ---
    function findLabLaunch() {
        const btnPartial = findBtnPartial([
            'launch app', 'launch lab', 'open lab', 'start lab', 'open workspace', 'launch workspace', 'open tool', 'launch'
        ]);
        if (btnPartial) return btnPartial;

        return findBtn(
            ['launch app', 'launch lab', 'open lab', 'start lab', 'open workspace', 'launch workspace', 'open tool'],
            ['Launch App', 'Launch Lab', 'Open Lab', 'Start Lab', 'Open Workspace', 'Launch Workspace', 'Open Tool'],
            ['[data-test="launch-app-button"]', '[data-testid="launch-lab"]', 'button[aria-label*="Launch"]']
        );
    }

    function findSideBySide() {
        return findBtn(
            ['learn side-by-side', 'learn side by side', 'launch side by side', 'open side by side', 'side by side',
             'side-by-side learning', 'launch in split view', 'open in split view'],
            ['Learn side-by-side', 'Learn side by side', 'Launch side by side', 'Open side by side',
             'Side by side', 'Launch in split view', 'Open in split view'],
            ['[data-test="launch-side-by-side-button"]', '[data-testid="side-by-side"]']
        );
    }

    function findOpenBtn() {
        // The "Open" button on the lab choice page (alternative to side-by-side)
        return findBtn(
            ['open'],
            ['Open'],
            []
        );
    }

    // --- Discussion / Dialogue ---
    function findDiscussionStart() {
        return findBtn(
            ['start discussion', 'reply', 'respond', 'start dialogue', 'join discussion',
             'add response', 'create response', 'write a response'],
            ['Start Discussion', 'Reply', 'Respond', 'Start Dialogue', 'Join Discussion',
             'Add Response', 'Create Response', 'Write a Response'],
            ['[data-test="start-discussion-button"]', '[data-testid="start-discussion"]',
             'button[aria-label*="discussion"]', 'button[aria-label*="Discussion"]']
        );
    }

    function findDialogueStart() {
        return findBtn(
            ['start dialogue', 'start conversation', 'begin dialogue', 'start discussion', 'reply', 'respond', 'join discussion', 'add response', 'create response', 'write a response'],
            ['Start Dialogue', 'Start dialogue', 'Start Conversation', 'Start Discussion', 'Reply', 'Respond', 'Join Discussion'],
            ['[data-test="start-dialogue-button"]', '[data-testid="start-dialogue"]', 'button[aria-label*="dialogue"]', 'button[aria-label*="Dialogue"]', '[data-test="start-discussion-button"]', '[data-testid="start-discussion"]']
        );
    }

    function findDiscussionEnd() {
        return findBtn(
            ['end discussion', 'end dialogue', 'close discussion', 'close dialogue',
             'finish discussion', 'finish dialogue', 'done'],
            ['End Discussion', 'End Dialogue', 'Close Discussion', 'Close Dialogue',
             'Finish Discussion', 'Finish Dialogue', 'Done'],
            ['[data-test="end-discussion-button"]', '[data-testid="end-discussion"]',
             'button[aria-label*="End"]']
        );
    }

    function findDialogueEnd() {
        return findBtn(
            ['end dialogue', 'end conversation', 'finish dialogue', 'end discussion', 'close dialogue', 'close discussion', 'finish discussion', 'done'],
            ['End Dialogue', 'End dialogue', 'End Conversation', 'Finish Dialogue', 'End Discussion', 'Close Dialogue'],
            ['[data-test="end-dialogue-button"]', '[data-testid="end-dialogue"]', 'button[aria-label*="End dialogue"]', 'button[aria-label*="End Dialogue"]', '[data-test="end-discussion-button"]']
        );
    }

    // --- Checkbox (Honor Code / Agreement) ---
    function checkAgreementCheckbox() {
        const checkboxes = document.querySelectorAll('input[type="checkbox"]:not(:checked)');
        for (const cb of checkboxes) {
            const parent = cb.closest('label') || cb.parentElement;
            const text = (parent ? parent.textContent : '').toLowerCase();
            const bodyText = (cb.form ? cb.form.textContent : (parent ? parent.textContent : '')).toLowerCase();
            if (text.includes('agree') || text.includes('honor') || text.includes('responsib') || text.includes('i accept') || bodyText.includes('honor code') || bodyText.includes('responsibly')) {
                cb.click();
                if (parent && !cb.checked) parent.click();
                return true;
            }
        }
        for (const label of document.querySelectorAll('label')) {
            const text = label.textContent.toLowerCase();
            if (text.includes('agree') || text.includes('honor') || text.includes('responsib') || text.includes('responsibly')) {
                const cb = label.querySelector('input[type="checkbox"]');
                if (cb && !cb.checked) {
                    cb.click();
                    label.click();
                    return true;
                } else if (!cb) {
                    label.click();
                    return true;
                }
            }
        }
        return false;
    }

    // --- Confirmation Modal (Yes / Confirm / OK) ---
    function findConfirmBtn() {
        return findBtnPartial([
            'yes, end dialogue', 'yes, end', 'yes,end', 'yes end dialogue', 'yes end', 'confirm', 'yes'
        ]);
    }

    function findDialogueConfirm() {
        return findBtnPartial([
            'yes, end dialogue', 'yes, end', 'yes,end', 'yes end dialogue', 'yes end', 'confirm'
        ]);
    }

    // =============================================
    // PAGE-SPECIFIC HANDLERS
    // =============================================

    async function handleVideo() {
        if (!hasVideoElement()) return;
        toast('Loading video...');
        const video = await waitVideoLoad();
        if (!video) return;
        if (skipVideo(video)) toast('Skipped to last ' + SECONDS_FROM_END + 's');
        toast('Playing last seconds...');
        await videoEnded(video);
        toast('Video done');
        await sleep(800);
    }

    async function handleLab() {
        // 1. Check agreement checkbox
        if (checkAgreementCheckbox()) {
            toast('Agreement checked');
            await sleep(800);
        }

        // 2. Find and click Launch button (wait for it to enable)
        let lab = await waitForBtn(findLabLaunch, 3000);
        if (lab) {
            lab.click();
            toast('Lab launched');
            await sleep(1500);
        }

        // 3. Side-by-side or Open button
        let sbs = findSideBySide();
        if (sbs) {
            openInNewTab(sbs);
            toast('Side-by-side (new tab)');
            await sleep(800);
        } else {
            const openBtn = findOpenBtn();
            if (openBtn) {
                openInNewTab(openBtn);
                toast('Opened (new tab)');
                await sleep(800);
            }
        }
    }

    async function handleDiscussion() {
        await handleDialogue();
    }

    async function handleDialogue() {
        // 1. Click start dialogue / conversation / discussion
        const start = findDialogueStart() || findDiscussionStart();
        if (start) {
            start.click();
            toast('Dialogue started');
            await sleep(1500);
        }

        // 2. Click end dialogue / discussion
        let end = await waitForBtn(() => findDialogueEnd() || findDiscussionEnd(), 5000);
        if (end) {
            end.click();
            toast('Ending dialogue...');
            await sleep(1000);

            // 3. Click "Yes, end dialogue" / confirmation modal
            const confirm = await waitForBtn(() => findDialogueConfirm() || findConfirmBtn(), 3000);
            if (confirm) {
                confirm.click();
                toast('Confirmed end dialogue');
                await sleep(800);
            }
        }
    }

    // =============================================
    // THE ONE FLOW — handles ALL activity types
    // =============================================

    async function doIt(isAuto) {
        if (isRunning) return;
        if (isAuto && doneUrls.has(location.href)) return;

        if (isAuto) {
            const elapsed = Date.now() - navTimestamp;
            if (elapsed < AFTER_NAV_WAIT) return;
        }

        // Uncompleted assignment check
        if (isAuto && isUnsubmittedAssignment()) {
            if (!waitingForAssignment) {
                waitingForAssignment = true;
                autoEnabled = false;
                updateUi();
                toast('Assignment page — Auto paused.');
            }
            return;
        }

        isRunning = true;
        const url = location.href;
        const pageType = getPageType();

        try {
            // --- Handle by page type ---

            // VIDEO: /lecture pages or any page with a <video> element
            if (pageType === 'video' || hasVideoElement()) {
                await handleVideo();
            }

            // LAB: /ungradedLab, /ungradedWidget, /gradedLti, /ungradedLti
            if (pageType === 'lab' || findLabLaunch()) {
                await handleLab();
            }

            // DISCUSSION / DIALOGUE: /discussionPrompt, /dialogue, or dialogue/discussion buttons
            if (pageType === 'discussion' || pageType === 'dialogue' || findDiscussionStart() || findDialogueStart()) {
                await handleDialogue();
            }

            // QUIZ / EXAM / ASSIGNMENT / PEER / PROGRAMMING: Skip auto-submit (handled via assignment wait logic)

            // --- Universal: Mark Complete ---
            let mark = await waitForBtn(findMarkComplete, 2000);
            if (mark) {
                mark.click();
                toast('Marked complete');
                await sleep(CLICK_DELAY);
            }

            // --- Universal: Go to Next Item ---
            const next = findNextItem();
            if (next) {
                next.click();
                toast('Next item');
                doneUrls.add(url);
                navTimestamp = Date.now();
            } else if (!mark && pageType === 'unknown' && !hasVideoElement() && !findLabLaunch() && !findDiscussionStart() && !findDialogueStart()) {
                toast('Nothing to do');
            }

        } finally {
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
            if (isRunning) return;

            // Check assignment page state
            if (isAssignmentPage()) {
                // 1. If modal is currently open, stay paused and wait for user to click Submit in modal
                if (isSubmissionModalOpen()) {
                    return;
                }

                // 2. If user confirmed final submit in modal and modal closed
                if (waitingForAssignment && finalSubmitConfirmed) {
                    const nextBtn = findNextItem();
                    if (nextBtn) {
                        toast('Assignment submitted! Moving to next item...');
                        waitingForAssignment = false;
                        primarySubmitClicked = false;
                        finalSubmitConfirmed = false;
                        autoEnabled = true;
                        updateUi();
                        nextBtn.click();
                        doneUrls.add(location.href);
                        navTimestamp = Date.now();
                        return;
                    }
                    // Next button is loading after submit, keep waiting
                    return;
                }

                // 3. Unsubmitted assignment (user is working or 1st submit clicked)
                if (isUnsubmittedAssignment()) {
                    if (autoEnabled && !waitingForAssignment) {
                        waitingForAssignment = true;
                        autoEnabled = false;
                        updateUi();
                        toast('Assignment page — Auto paused.');
                    }
                    return;
                }

                // 4. Completed assignment from previous session
                if (waitingForAssignment && isAlreadyCompletedAssignment()) {
                    const nextBtn = findNextItem();
                    if (nextBtn) {
                        toast('Moving to next item...');
                        waitingForAssignment = false;
                        primarySubmitClicked = false;
                        finalSubmitConfirmed = false;
                        autoEnabled = true;
                        updateUi();
                        nextBtn.click();
                        doneUrls.add(location.href);
                        navTimestamp = Date.now();
                        return;
                    }
                }
            } else {
                if (waitingForAssignment) {
                    waitingForAssignment = false;
                    primarySubmitClicked = false;
                    finalSubmitConfirmed = false;
                    updateUi();
                }
            }

            if (!autoEnabled) return;
            if (doneUrls.has(location.href)) return;
            if (Date.now() - navTimestamp < AFTER_NAV_WAIT) return;

            // Trigger if anything actionable exists
            if (hasVideoElement() || findLabLaunch() || findSideBySide() || findDiscussionStart() || findDialogueStart()
                || findMarkComplete() || findNextItem()) {
                doIt(true);
            }
        }, SCAN_INTERVAL);
    }

    function stopScan() {
        if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    }

    // =============================================
    // URL WATCHER (SPA navigation)
    // =============================================

    setInterval(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            navTimestamp = Date.now();
            isRunning = false;
            if (waitingForAssignment && !isAssignmentPage()) {
                waitingForAssignment = false;
                primarySubmitClicked = false;
                finalSubmitConfirmed = false;
                updateUi();
            }
        }
    }, 800);

    // =============================================
    // TOGGLE
    // =============================================

    function toggleAuto() {
        waitingForAssignment = false;
        primarySubmitClicked = false;
        finalSubmitConfirmed = false;
        autoEnabled = !autoEnabled;
        localStorage.setItem('tm_auto', autoEnabled ? 'true' : 'false');
        updateUi();
        toast(autoEnabled ? 'Auto: ON' : 'Auto: OFF');
        if (autoEnabled) {
            navTimestamp = Date.now();
            isRunning = false;
            doneUrls.delete(location.href);
            startScan();
        } else {
            stopScan();
        }
    }

    // =============================================
    // UI — Two buttons, draggable, green toast
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

        // Drag logic
        let isDragging = false;
        let dragStartX, dragStartY, barStartX, barStartY;

        bar.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            isDragging = true;
            bar.style.cursor = 'grabbing';
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            const rect = bar.getBoundingClientRect();
            barStartX = rect.left;
            barStartY = rect.top;
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
        if (waitingForAssignment) {
            b.textContent = 'Auto: Paused (Assignment)';
            Object.assign(b.style, { background: '#2e1005', color: '#fb923c', borderColor: '#c2410c', border: '1px solid #c2410c' });
            b.onmouseenter = () => b.style.background = '#431407';
            b.onmouseleave = () => Object.assign(b.style, { background: '#2e1005' });
        } else if (autoEnabled) {
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
        navTimestamp = Date.now();
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
