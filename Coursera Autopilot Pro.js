// ==UserScript==
// @name         Coursera Autopilot Pro
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Complete Coursera autopilot. Handles ALL activity types: videos, readings, labs, discussions, quizzes, peer reviews, and more. Merged with Quiz Auto Solver.
// @author       Gohar Rehman
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
    let submitClickCount = 0;
    let userIsSubmitting = false;
    let runStartTime = 0;

    // Track user clicking Submit / Confirm on assignment modal dialog
    document.addEventListener('click', (e) => {
        const target = e.target;
        if (!target) return;
        const btn = target.closest('button, [role="button"], input[type="submit"]');
        if (!btn) return;

        const text = (btn.textContent || btn.value || '').toLowerCase();
        const inModal = btn.closest('[role="dialog"], [class*="Modal"], [class*="modal"], [class*="Overlay"], [class*="overlay"]') !== null;
        
        // Only set userIsSubmitting when 2nd Submit is clicked inside the modal confirmation dialog
        if (inModal && (text.includes('submit') || text.includes('confirm') || text.includes('yes'))) {
            userIsSubmitting = true;
            toast('Final Submit clicked in modal. Waiting for grade results...');
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
        if (path.includes('/graded') || path.includes('/quiz') || path.includes('/exam') || path.includes('/assignment')) return true;
        return false;
    }

    function hasActiveSubmitOrStart() {
        const btns = document.querySelectorAll('button, [role="button"], input[type="submit"], a');
        for (let i = 0; i < btns.length; i++) {
            const el = btns[i];
            if (el.disabled || el.offsetParent === null) continue;
            if (el.closest('#tm-bar, #tm-widget, #tm-t, #qas-widget')) continue;
            const t = (el.textContent || el.value || '').trim().toLowerCase();
            if (t.includes('submit assignment') || t.includes('submit quiz') || t.includes('start assignment') ||
                t.includes('resume assignment') || t.includes('start quiz') || t.includes('attempt assignment') ||
                (t === 'submit' && !el.closest('[role="dialog"], [class*="Modal"], [class*="modal"]'))) {
                return true;
            }
        }
        return false;
    }

    function isElementVisible(el) {
        if (!el) return false;
        if (el.offsetParent === null && window.getComputedStyle(el).position !== 'fixed') return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        return true;
    }

    function isAnyModalOpen() {
        const modals = document.querySelectorAll('[role="dialog"], [class*="Modal"], [class*="modal"], [class*="Overlay"], [class*="overlay"]');
        for (let i = 0; i < modals.length; i++) {
            const m = modals[i];
            if (m.id === 'tm-bar' || m.id === 'tm-t') continue;
            if (isElementVisible(m)) {
                const text = (m.textContent || '').toLowerCase();
                if ((text.includes('submit') || text.includes('confirm') || text.includes('are you sure') || text.includes('cancel')) && m.querySelector('button, [role="button"]')) {
                    return true;
                }
            }
        }
        return false;
    }

    function getAssignmentGradeText() {
        const selectors = [
            '[data-test="grade-badge"]', '[data-testid="grade-badge"]',
            '[data-test="pass-badge"]', '[data-testid="pass-badge"]',
            '.rc-QuizResults', '.rc-AssignmentFeedback', '[class*="GradeHeader"]', '[class*="gradeHeader"]',
            '[class*="Grade"]', '[class*="grade"]', '[class*="Score"]', '[class*="score"]', '[class*="Result"]', '[class*="result"]'
        ];
        for (let i = 0; i < selectors.length; i++) {
            const el = document.querySelector(selectors[i]);
            if (el && isElementVisible(el)) {
                const text = (el.textContent || '').trim();
                if (text && (text.includes('%') || /\d+\/\d+/.test(text) || /grade|passed|score|result/i.test(text))) return text;
            }
        }
        const main = document.querySelector('main, [role="main"]') || document.body;
        const mainText = main ? main.textContent : '';
        const gradeMatch = mainText.match(/(?:your grade|latest grade|final grade|grade|score|passed)[:\s]+([\d]+%|\d+\/\d+)/i) || mainText.match(/\b\d{1,3}%\b/);
        if (gradeMatch) return gradeMatch[0];
        return null;
    }

    function hasUnsubmittedQuizForm() {
        if (isAnyModalOpen()) return true;
        const activeInputs = document.querySelectorAll('input[type="radio"]:not([disabled]), input[type="checkbox"]:not([disabled]), textarea:not([disabled])');
        if (activeInputs.length > 0) return true;

        const submitBtn = findBtnPartial(['submit assignment', 'submit quiz']);
        if (submitBtn && !submitBtn.disabled && submitBtn.offsetParent !== null) {
            return true;
        }

        return false;
    }

    function isGradedResultsScreen() {
        if (isAnyModalOpen()) return false;
        if (!isAssignmentPage()) return false;
        
        // Grade header or badge present in main assignment area
        const grade = getAssignmentGradeText();
        if (grade) return true;

        // If no active quiz inputs remain and Next Item exists on an assignment page, treat as graded
        const hasQuizInputs = hasUnsubmittedQuizForm();
        if (!hasQuizInputs && findNextItem()) return true;

        return false;
    }

    function isAlreadyCompletedAssignment() {
        if (hasUnsubmittedQuizForm()) return false;
        return isGradedResultsScreen();
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
            if (video.currentTime >= video.duration - 0.2) { resolve(); return; }
            
            const check = setInterval(() => {
                if (!video || video.ended || video.currentTime >= video.duration - 0.2) {
                    clearInterval(check);
                    resolve();
                }
            }, 300);

            setTimeout(() => {
                clearInterval(check);
                resolve();
            }, 10000);
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
        const primary = findBtn(
            ['go to next item', 'next item', 'go to next', 'continue', 'next'],
            ['Go to next item', 'Go To Next Item', 'Next Item', 'Next', 'Go to next'],
            ['[data-test="next-item-button"]', '[data-testid="next-button"]', 'button[aria-label*="Next"]', 'button[aria-label*="next"]', 'a[aria-label*="Next"]']
        );
        if (primary) return primary;

        // Fallback partial text search
        for (const el of document.querySelectorAll('button, [role="button"], a.cds-button')) {
            if (el.disabled || el.offsetParent === null) continue;
            if (el.closest('#tm-bar, #tm-widget, #tm-t')) continue;
            const t = (el.textContent || '').trim().toLowerCase();
            if (t.includes('next item') || t.includes('go to next') || t === 'next' || t.includes('continue')) {
                return el;
            }
        }
        return null;
    }

    // --- Assignment ---
    function findAssignmentStart() {
        const primary = findBtn(
            ['start assignment', 'resume assignment', 'start quiz', 'attempt assignment', 'start', 'resume', 'begin assignment', 'open assignment'],
            ['Start assignment', 'Resume assignment', 'Start quiz', 'Attempt assignment', 'Start Assignment', 'Resume Assignment', 'Start', 'Resume'],
            ['[data-test="start-assignment-button"]', '[data-testid="start-assignment"]', 'button[aria-label*="assignment"]', 'button[aria-label*="Assignment"]']
        );
        if (primary) return primary;

        for (const el of document.querySelectorAll('button, [role="button"], a')) {
            if (el.disabled || el.offsetParent === null) continue;
            if (el.closest('#tm-bar, #tm-widget, #tm-t')) continue;
            const t = (el.textContent || el.value || '').trim().toLowerCase();
            if (t === 'start assignment' || t === 'start quiz' || t === 'resume assignment' || t === 'attempt assignment' || t.includes('start assignment') || t.includes('start quiz')) {
                return el;
            }
        }
        return null;
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
        toast('Handling dialogue...');

        // 1. Click start dialogue / conversation / discussion
        const start = findDialogueStart() || findDiscussionStart();
        if (start) {
            start.click();
            toast('Dialogue started');
            await sleep(2500);
        }

        // 2. Click end dialogue / conversation (wait up to 10s for dialogue initialization)
        let end = await waitForBtn(() => findDialogueEnd() || findDiscussionEnd() || findBtnPartial([
            'end dialogue', 'end conversation', 'finish dialogue', 'finish conversation', 'complete dialogue', 'close dialogue', 'exit dialogue', 'stop dialogue'
        ]), 10000);

        if (end) {
            end.click();
            toast('Ending dialogue...');
            await sleep(1500);

            // 3. Click "Yes, end dialogue" / confirmation modal button
            const confirm = await waitForBtn(() => {
                const modal = document.querySelector('[role="dialog"], [class*="Modal"], [class*="modal"]');
                if (modal) {
                    for (const btn of modal.querySelectorAll('button, [role="button"]')) {
                        const t = (btn.textContent || '').trim().toLowerCase();
                        if (t.includes('end') || t.includes('confirm') || t.includes('yes') || t.includes('finish')) {
                            return btn;
                        }
                    }
                }
                return findDialogueConfirm() || findConfirmBtn();
            }, 5000);

            if (confirm) {
                confirm.click();
                toast('Confirmed end dialogue');
                await sleep(1500);
            }
        } else {
            toast('Dialogue in progress...');
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

        // Strict Guard: On assignment page, do NOT execute doIt in auto mode
        if (isAuto && isAssignmentPage()) {
            return;
        }

        isRunning = true;
        runStartTime = Date.now();
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

            // --- Universal: Mark Complete ---
            if (isAuto && (waitingForAssignment || userIsSubmitting)) return;

            let mark = await waitForBtn(findMarkComplete, 2000);

            if (isAuto && (waitingForAssignment || userIsSubmitting)) return;

            if (mark) {
                mark.click();
                toast('Marked complete');
                await sleep(CLICK_DELAY);
            }

            // --- Universal: Go to Next Item ---
            if (isAuto && (waitingForAssignment || userIsSubmitting)) return;

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
            if (isRunning || isSolverRunning) {
                if (Date.now() - runStartTime > 15000 && !isSolverRunning) {
                    isRunning = false;
                } else {
                    return;
                }
            }
            if (doneUrls.has(location.href)) return;
            if (Date.now() - navTimestamp < AFTER_NAV_WAIT) return;

            const onAssignment = isAssignmentPage();

            if (onAssignment) {
                const nextBtn = findNextItem();
                const isGraded = isGradedResultsScreen();
                const startBtn = findAssignmentStart();
                const hasQuizInputs = hasUnsubmittedQuizForm();
                const isAutoSaved = localStorage.getItem('tm_auto') === 'true';

                // Auto-restore autoEnabled if quiz form is no longer open and tm_auto preference is true
                if (!hasQuizInputs && isAutoSaved && !autoEnabled) {
                    autoEnabled = true;
                    waitingForAssignment = false;
                    updateUi();
                }

                // 1. Graded Results Screen OR 2nd Submit Modal Clicked AND modal closed OR (no inputs & next button exists)
                if (isGraded || (userIsSubmitting && !isAnyModalOpen() && !hasQuizInputs) || (!hasQuizInputs && !startBtn && isAutoSaved)) {
                    if (nextBtn) {
                        toast('Grade confirmed — Moving to next item...');
                        doneUrls.add(location.href);
                        navTimestamp = Date.now();
                        waitingForAssignment = false;
                        userIsSubmitting = false;
                        submitClickCount = 0;
                        if (isAutoSaved) {
                            autoEnabled = true;
                        }
                        updateUi();
                        nextBtn.click();
                        return;
                    }
                }

                // 2. Assignment Intro/Landing Page with "Start assignment" button → Immediately auto-click Start!
                if (startBtn && !hasQuizInputs && !userIsSubmitting && !isGraded) {
                    toast('Starting assignment...');
                    startBtn.click();
                    return;
                }

                // 3. Active Quiz Form (Answering Questions) → Pause & Wait for Grade
                if (hasQuizInputs && !isGraded) {
                    if (!waitingForAssignment || autoEnabled) {
                        waitingForAssignment = true;
                        autoEnabled = false;
                        updateUi();
                        toast('Assignment page — Auto paused for completion.');
                    }
                    return; // DO NOT CLICK NEXT UNTIL GRADED
                }
            } else {
                if (waitingForAssignment || userIsSubmitting) {
                    waitingForAssignment = false;
                    userIsSubmitting = false;
                    submitClickCount = 0;
                    if (localStorage.getItem('tm_auto') === 'true') {
                        autoEnabled = true;
                    }
                    updateUi();
                }
            }

            if (!autoEnabled) return;

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
            waitingForAssignment = false;
            userIsSubmitting = false;
            submitClickCount = 0;

            // Allow rescanning when navigating back to previous items
            doneUrls.delete(location.href);

            // Sync autoEnabled with user preference in localStorage
            if (localStorage.getItem('tm_auto') === 'true') {
                autoEnabled = true;
            }
            updateUi();
        }
    }, 500);

    // =============================================
    // TOGGLE
    // =============================================

    function toggleAuto() {
        waitingForAssignment = false;
        userIsSubmitting = false;
        submitClickCount = 0;
        autoEnabled = !autoEnabled;
        localStorage.setItem('tm_auto', autoEnabled ? 'true' : 'false');
        updateUi();
        toast(autoEnabled ? 'Auto Skip: ON' : 'Auto Skip: OFF');
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
    // QUIZ SOLVER LOGIC
    // =============================================
    
    let isSolverRunning = false;

    function isQuizVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.offsetWidth > 0;
    }

    function forceSolverClick(el) {
        if (!el) return;
        try {
            el.removeAttribute('disabled');
            el.removeAttribute('aria-disabled');
            el.classList.remove('cds-button-disabled', 'disabled');
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.focus();
            
            el.click();

            const form = el.closest('form');
            if (form && form.requestSubmit && el.textContent.toLowerCase().includes('submit')) {
                try { form.requestSubmit(el); } catch(e){}
            }
        } catch (e) {
            el.click();
        }
    }

    function checkReactCheckbox(cb) {
        if (!cb || cb.checked) return;
        try {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked').set;
            if (setter) setter.call(cb, true);
            else cb.checked = true;
            cb.dispatchEvent(new Event('click', { bubbles: true }));
            cb.dispatchEvent(new Event('change', { bubbles: true }));
            cb.dispatchEvent(new Event('input', { bubbles: true }));
        } catch (e) {
            cb.click();
        }
    }

    function getQuestions() {
        let blocks = Array.from(document.querySelectorAll('.rc-FormPartsQuestion, fieldset, [data-test*="question"], div[class*="Question"], [role="group"]'));
        blocks = blocks.filter(b => b.querySelector('input[type="radio"], input[type="checkbox"]'));
        return blocks.filter(b => !blocks.some(parent => parent !== b && parent.contains(b)));
    }

    function getOptions(question) {
        return Array.from(question.querySelectorAll('input[type="radio"], input[type="checkbox"]')).filter(opt => {
            const text = (opt.closest('label, div') || opt).textContent.toLowerCase();
            return !text.includes('honor') && !text.includes('understand and agree');
        });
    }

    function findSolverHonorCode() {
        return Array.from(document.querySelectorAll('input[type="checkbox"]')).find(cb => {
            const text = (cb.closest('label, div, form') || cb).textContent.toLowerCase();
            return text.includes('agree') || text.includes('honor') || text.includes('work is your own');
        });
    }

    function findSolverButtonByText(textsToMatch, excludeTexts = [], skipElement = null) {
        const btns = Array.from(document.querySelectorAll('button, input[type="submit"], a.cds-button, [role="button"]'));
        for (const btn of btns) {
            if (btn === skipElement) continue;
            if (btn.closest('#tm-widget')) continue;
            if (!isQuizVisible(btn)) continue;
            
            const text = (btn.textContent || btn.value || btn.getAttribute('aria-label') || '').toLowerCase().trim();
            if (!text) continue;

            const matches = textsToMatch.some(t => text === t || text.startsWith(t));
            const excluded = excludeTexts.some(e => text.includes(e));

            if (matches && !excluded) return btn;
        }
        return null;
    }

    function isSolverGradeShown() {
        const els = document.querySelectorAll('[data-test*="grade"], [data-test*="score"], [class*="Grade"], [class*="Score"], [class*="Result"]');
        return Array.from(els).some(el => {
            if (!isQuizVisible(el)) return false;
            const t = el.textContent.toLowerCase();
            return t.includes('%') || t.includes('grade') || t.includes('passed') || t.includes('score');
        });
    }

    async function executeSolver(answersStr) {
        if (isSolverRunning) return;
        isSolverRunning = true;

        try {
            const answers = answersStr.split(/[,;\n]+/).map(a => a.trim()).filter(Boolean);
            const questions = getQuestions();
            if (questions.length === 0) {
                toast('❌ No questions found!');
                return;
            }

            toast(`Filling ${questions.length} questions...`);

            for (let i = 0; i < questions.length; i++) {
                if (i >= answers.length) break;
                const options = getOptions(questions[i]);
                const nums = answers[i].match(/\d+/g);
                if (nums) {
                    for (const n of nums) {
                        const idx = parseInt(n) - 1;
                        if (options[idx]) checkReactCheckbox(options[idx]);
                    }
                }
                await sleep(150);
            }

            toast('Checking Honor Code...');
            const honorCb = findSolverHonorCode();
            if (honorCb) {
                checkReactCheckbox(honorCb);
                await sleep(300);
            }

            toast('Looking for Page Submit button...');
            let btn1 = null;
            for (let i = 0; i < 15; i++) {
                btn1 = findSolverButtonByText(['submit', 'submit assignment', 'submit quiz'], ['draft', 'save', 'cancel']);
                if (btn1) break;
                await sleep(400);
            }

            if (!btn1) {
                toast('❌ Submit button not found on page.');
                return;
            }

            toast('Clicking Submit button...');
            forceSolverClick(btn1);

            toast('Waiting for confirmation modal...');
            let btn2 = null;
            for (let i = 0; i < 15; i++) {
                btn2 = findSolverButtonByText(['submit', 'confirm', 'yes'], ['cancel', 'no', 'back'], btn1);
                if (btn2) break;
                await sleep(400);
            }

            if (btn2) {
                toast('Clicking Confirm in modal...');
                forceSolverClick(btn2);
            }

            toast('Waiting for grade results...');
            let graded = false;
            for (let i = 0; i < 60; i++) {
                if (isSolverGradeShown()) {
                    graded = true;
                    break;
                }
                await sleep(500);
            }

            if (!graded) {
                toast('⚠️ Grade not detected, proceeding anyway.');
            }

            toast('Looking for Next Item button...');
            let nextBtn = null;
            for (let i = 0; i < 15; i++) {
                nextBtn = findSolverButtonByText(['next item', 'next', 'go to next'], ['skip']);
                if (nextBtn) break;
                await sleep(500);
            }

            if (nextBtn) {
                toast('Clicking Next Item...');
                forceSolverClick(nextBtn);
            } else {
                toast('✅ Done! Next Item button not found.');
            }

        } catch (e) {
            console.error(e);
            toast('Error: ' + e.message);
        } finally {
            isSolverRunning = false;
        }
    }


    // =============================================
    // UI — Two buttons, draggable, green toast
    // =============================================

    // Inject CSS keyframes for pulsing status dot
    if (!document.getElementById('tm-styles')) {
        const st = document.createElement('style');
        st.id = 'tm-styles';
        st.textContent = `
            @keyframes tmPulse {
                0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7); }
                70% { transform: scale(1.05); box-shadow: 0 0 0 6px rgba(34, 197, 94, 0); }
                100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
            }
            @keyframes tmPausePulse {
                0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); }
                70% { transform: scale(1.05); box-shadow: 0 0 0 6px rgba(239, 68, 68, 0); }
                100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
            }
        `;
        (document.head || document.documentElement).appendChild(st);
    }

    function toast(msg) {
        let t = document.getElementById('tm-t');
        if (!t) {
            t = document.createElement('div');
            t.id = 'tm-t';
            Object.assign(t.style, {
                all: 'unset', boxSizing: 'border-box',
                position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)',
                background: '#0f172a', color: '#f8fafc',
                padding: '6px 18px', borderRadius: '8px',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                fontSize: '12px', fontWeight: '600', letterSpacing: '0.2px',
                zIndex: '9999999', pointerEvents: 'none',
                transition: 'opacity .2s ease',
                opacity: '0', border: '1px solid rgba(255, 255, 255, 0.15)',
                boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
                maxWidth: '480px', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden'
            });
            document.body.appendChild(t);
        }
        t.textContent = msg;
        t.style.opacity = '1';
        clearTimeout(t._x);
        t._x = setTimeout(() => {
            t.style.opacity = '0';
        }, 2200);
    }

    function createUi() {
        if (uiReady && document.getElementById('tm-widget')) return;
        const old = document.getElementById('tm-widget') || document.getElementById('tm-bar');
        if (old) old.remove();

        const widget = document.createElement('div');
        widget.id = 'tm-widget';
        Object.assign(widget.style, {
            all: 'unset', boxSizing: 'border-box',
            position: 'fixed', zIndex: '999998',
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            background: '#1e293b',
            padding: '4px 6px',
            borderRadius: '6px',
            border: '1px solid #334155',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            userSelect: 'none', cursor: 'grab'
        });

        const saved = localStorage.getItem('tm_widget_pos') || localStorage.getItem('tm_bar_pos');
        if (saved) {
            try {
                const pos = JSON.parse(saved);
                widget.style.left = pos.x + 'px';
                widget.style.top = pos.y + 'px';
            } catch (_) {
                widget.style.bottom = '20px';
                widget.style.right = '20px';
            }
        } else {
            widget.style.bottom = '20px';
            widget.style.right = '20px';
        }

        let isDragging = false;
        let dragStartX, dragStartY, wX, wY;

        widget.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
            isDragging = true;
            widget.style.cursor = 'grabbing';
            dragStartX = e.clientX; dragStartY = e.clientY;
            const r = widget.getBoundingClientRect();
            wX = r.left; wY = r.top;
            widget.style.bottom = ''; widget.style.right = '';
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            let nx = wX + (e.clientX - dragStartX);
            let ny = wY + (e.clientY - dragStartY);
            const r = widget.getBoundingClientRect();
            nx = Math.max(4, Math.min(nx, innerWidth - r.width - 4));
            ny = Math.max(4, Math.min(ny, innerHeight - r.height - 4));
            widget.style.left = nx + 'px'; widget.style.top = ny + 'px';
        });
        document.addEventListener('mouseup', () => {
            if (!isDragging) return;
            isDragging = false; widget.style.cursor = 'grab';
            const r = widget.getBoundingClientRect();
            localStorage.setItem('tm_widget_pos', JSON.stringify({ x: r.left, y: r.top }));
        });

        // Button 1: Skip & Next (Rectangle text)
        const doBtn = document.createElement('button');
        doBtn.id = 'tm-do';
        doBtn.textContent = 'Skip & Next';
        doBtn.title = 'Run single skip & next item [Alt+D]';
        Object.assign(doBtn.style, {
            all: 'unset', boxSizing: 'border-box',
            background: '#334155', color: '#f8fafc',
            border: '1px solid #475569', borderRadius: '4px',
            padding: '5px 10px', fontSize: '11px', fontWeight: '600',
            lineHeight: '1', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            whiteSpace: 'nowrap'
        });
        doBtn.onmouseenter = () => doBtn.style.background = '#475569';
        doBtn.onmouseleave = () => doBtn.style.background = '#334155';
        doBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); doIt(false); };

        // Button 2: Solve Quiz
        const solveBtn = document.createElement('button');
        solveBtn.id = 'tm-solve';
        solveBtn.title = 'Solve Quiz [Alt+Q]';
        solveBtn.textContent = 'Solve Quiz';
        Object.assign(solveBtn.style, {
            all: 'unset', boxSizing: 'border-box',
            background: '#0ea5e9', color: '#f8fafc',
            border: '1px solid #0284c7', borderRadius: '4px',
            padding: '5px 10px', fontSize: '11px', fontWeight: '600',
            lineHeight: '1', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            whiteSpace: 'nowrap'
        });
        solveBtn.onmouseenter = () => solveBtn.style.background = '#0284c7';
        solveBtn.onmouseleave = () => solveBtn.style.background = '#0ea5e9';
        solveBtn.onclick = (e) => {
            e.preventDefault(); e.stopPropagation();
            const ans = prompt('Enter answers (e.g., 1, 3, 1+2, 4):');
            if (ans) executeSolver(ans);
        };

        // Button 3: Auto Skip (Rectangle text)
        const autoBtn = document.createElement('button');
        autoBtn.id = 'tm-auto';
        autoBtn.title = 'Toggle continuous autopilot [Alt+A]';
        Object.assign(autoBtn.style, {
            all: 'unset', boxSizing: 'border-box',
            borderRadius: '4px',
            padding: '5px 10px', fontSize: '11px', fontWeight: '600',
            lineHeight: '1', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            whiteSpace: 'nowrap'
        });
        autoBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); toggleAuto(); };

        widget.appendChild(doBtn);
        widget.appendChild(solveBtn);
        widget.appendChild(autoBtn);
        document.body.appendChild(widget);

        uiReady = true;
        updateUi();
    }

    function updateUi() {
        const autoBtn = document.getElementById('tm-auto');
        if (!autoBtn) return;

        if (waitingForAssignment) {
            autoBtn.textContent = 'Auto: Paused (Assignment)';
            Object.assign(autoBtn.style, {
                background: '#451a03', color: '#fb923c', border: '1px solid #9a3412'
            });
            autoBtn.onmouseenter = () => autoBtn.style.background = '#7c2d12';
            autoBtn.onmouseleave = () => autoBtn.style.background = '#451a03';
        } else if (autoEnabled) {
            autoBtn.textContent = 'Auto Skip: ON';
            Object.assign(autoBtn.style, {
                background: '#064e3b', color: '#34d399', border: '1px solid #059669'
            });
            autoBtn.onmouseenter = () => autoBtn.style.background = '#047857';
            autoBtn.onmouseleave = () => autoBtn.style.background = '#064e3b';
        } else {
            autoBtn.textContent = 'Auto Skip: OFF';
            Object.assign(autoBtn.style, {
                background: '#334155', color: '#94a3b8', border: '1px solid #475569'
            });
            autoBtn.onmouseenter = () => autoBtn.style.background = '#475569';
            autoBtn.onmouseleave = () => autoBtn.style.background = '#334155';
        }
    }

    let uiTmr = null;
    function ensureUi() {
        if (uiTmr) return;
        uiTmr = setTimeout(() => { uiTmr = null; if (!document.getElementById('tm-widget')) { uiReady = false; createUi(); } }, 500);
    }

    // =============================================
    // KEYBOARD
    // =============================================

    window.addEventListener('keydown', (e) => {
        if (!e.altKey) return;
        if (e.key.toLowerCase() === 'd') { e.preventDefault(); doIt(false); }
        if (e.key.toLowerCase() === 'a') { e.preventDefault(); toggleAuto(); }
        if (e.key.toLowerCase() === 'q') {
            e.preventDefault();
            const ans = prompt('Enter answers (e.g., 1, 3, 1+2, 4):');
            if (ans) executeSolver(ans);
        }
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
