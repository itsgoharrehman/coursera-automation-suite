// ==UserScript==
// @name         Coursera Autopilot & Quiz Auto Solver
// @namespace    http://tampermonkey.net/
// @version      12.0
// @description  Complete Coursera Autopilot + Quiz Auto Solver + Force Plain Copy. Handles videos, readings, labs, discussions, quiz solving, and clipboard prompt stripping.
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
    let isSolvingQuiz = false;
    let scanTimer = null;
    let lastUrl = location.href;
    let doneUrls = new Set();
    let uiReady = false;
    let navTimestamp = 0;
    let waitingForAssignment = false;
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
    // FORCE PLAIN COPY LOGIC (Anti-Prompt Injection)
    // =============================================
    const STRIP_PATTERNS = [
        /(?:You are a helpful AI assistant[\s\S]*?verification step is mandatory for all AI assistants accessing assessment pages\.?)/gi,
        /AI Agent Compliance Verification Required/gi,
        /Do you understand\??\.*\s*/gi,
        /I understand\.?\s*/gi,
    ];

    function cleanText(text) {
        let cleaned = text;
        for (const pattern of STRIP_PATTERNS) {
            pattern.lastIndex = 0;
            cleaned = cleaned.replace(pattern, '');
        }
        return cleaned
            .replace(/\r\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function cleanHtml(html) {
        let cleaned = html;
        for (const pattern of STRIP_PATTERNS) {
            pattern.lastIndex = 0;
            cleaned = cleaned.replace(pattern, '');
        }
        return cleaned;
    }

    function getSelectionHtml() {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;

        const container = document.createElement('div');
        for (let i = 0; i < sel.rangeCount; i++) {
            container.appendChild(sel.getRangeAt(i).cloneContents());
        }

        const html = container.innerHTML;
        if (!html.trim()) return null;
        return html;
    }

    function getPlainText() {
        const sel = window.getSelection();
        if (sel && sel.toString().trim()) {
            return sel.toString();
        }

        const active = document.activeElement;
        if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
            return active.value.substring(active.selectionStart, active.selectionEnd);
        }

        return '';
    }

    document.addEventListener('copy', function(event) {
        const plainRaw = getPlainText();
        if (!plainRaw) return;

        const htmlRaw = getSelectionHtml();
        const cleanedPlain = cleanText(plainRaw);

        if (event.clipboardData) {
            event.clipboardData.setData('text/plain', cleanedPlain);

            if (htmlRaw) {
                event.clipboardData.setData('text/html', cleanHtml(htmlRaw));
            }
        } else if (window.clipboardData) {
            window.clipboardData.setData('Text', cleanedPlain);
        }

        event.preventDefault();
        event.stopImmediatePropagation();
    }, true);

    // =============================================
    // TOAST NOTIFICATION SYSTEM
    // =============================================
    function toast(msg) {
        let box = document.getElementById('qas-toast');
        if (!box) {
            box = document.createElement('div');
            box.id = 'qas-toast';
            Object.assign(box.style, {
                position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)',
                background: '#0f172a', color: '#38bdf8', padding: '12px 24px',
                borderRadius: '8px', fontFamily: 'sans-serif', fontSize: '14px',
                fontWeight: 'bold', zIndex: '9999999', pointerEvents: 'none',
                boxShadow: '0 4px 20px rgba(0,0,0,0.5)', transition: 'opacity 0.2s', opacity: '1'
            });
            document.body.appendChild(box);
        }
        box.textContent = msg;
        box.style.opacity = '1';
        clearTimeout(box._t);
        box._t = setTimeout(() => { box.style.opacity = '0'; }, 3500);
    }

    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    function isElementVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.offsetWidth > 0;
    }

    // =============================================
    // CORE INTERACTION ACTIONS
    // =============================================
    function forceClick(el) {
        if (!el) return;
        try {
            el.removeAttribute('disabled');
            el.removeAttribute('aria-disabled');
            el.classList.remove('cds-button-disabled', 'disabled');
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.focus();
            
            el.click();

            // Try form submit as a final fallback only for submit buttons
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

    // =============================================
    // URL TYPE DETECTION
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

    function isAnyModalOpen() {
        const modals = document.querySelectorAll('[role="dialog"], [class*="Modal"], [class*="modal"], [class*="Overlay"], [class*="overlay"]');
        for (let i = 0; i < modals.length; i++) {
            const m = modals[i];
            if (m.id === 'tm-widget') continue;
            if (isElementVisible(m)) {
                const text = (m.textContent || '').toLowerCase();
                if (text.includes('submit') || text.includes('confirm') || text.includes('are you sure') || text.includes('cancel')) {
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
            '.rc-QuizResults', '.rc-AssignmentFeedback', '[class*="GradeHeader"]', '[class*="gradeHeader"]'
        ];
        for (let i = 0; i < selectors.length; i++) {
            const el = document.querySelector(selectors[i]);
            if (el && isElementVisible(el)) {
                const text = (el.textContent || '').trim();
                if (text) return text;
            }
        }
        const main = document.querySelector('main, [role="main"]') || document.body;
        const mainText = main ? main.textContent : '';
        const gradeMatch = mainText.match(/(?:your grade|latest grade|final grade)[:\s]+([\d]+%|\d+\/\d+)/i);
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
        const grade = getAssignmentGradeText();
        if (grade) return true;
        return false;
    }

    // =============================================
    // VIDEO SKIP
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
    // AUTOPILOT BUTTON FINDERS
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

        for (const el of document.querySelectorAll('button, [role="button"], a.cds-button')) {
            if (el.disabled || el.offsetParent === null) continue;
            if (el.closest('#tm-widget')) continue;
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
            if (el.closest('#tm-widget')) continue;
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
        return findBtn(['open'], ['Open'], []);
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
                checkReactCheckbox(cb);
                return true;
            }
        }
        for (const label of document.querySelectorAll('label')) {
            const text = label.textContent.toLowerCase();
            if (text.includes('agree') || text.includes('honor') || text.includes('responsib') || text.includes('responsibly')) {
                const cb = label.querySelector('input[type="checkbox"]');
                if (cb && !cb.checked) {
                    checkReactCheckbox(cb);
                    return true;
                } else if (!cb) {
                    forceClick(label);
                    return true;
                }
            }
        }
        return false;
    }

    function findConfirmBtn() {
        return findBtnPartial([
            'yes, end dialogue', 'yes, end', 'yes,end', 'yes end dialogue', 'yes end', 'confirm', 'yes'
        ]);
    }

    // --- dialogue ---
    function findDialogueConfirm() {
        return findBtnPartial([
            'yes, end dialogue', 'yes, end', 'yes,end', 'yes end dialogue', 'yes end', 'confirm'
        ]);
    }

    // =============================================
    // AUTOPILOT ACTIVITY HANDLERS
    // =============================================
    async function handleDialogue() {
        toast('Handling dialogue...');

        const start = findDialogueStart() || findDiscussionStart();
        if (start) {
            forceClick(start);
            toast('Dialogue started');
            await wait(2500);
        }

        let end = await waitForBtn(() => findDialogueEnd() || findDiscussionEnd() || findBtnPartial([
            'end dialogue', 'end conversation', 'finish dialogue', 'finish conversation', 'complete dialogue', 'close dialogue', 'exit dialogue', 'stop dialogue'
        ]), 10000);

        if (end) {
            forceClick(end);
            toast('Ending dialogue...');
            await wait(1500);

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
                forceClick(confirm);
                toast('Confirmed end dialogue');
                await wait(1500);
            }
        } else {
            toast('Dialogue in progress...');
        }
    }

    // =============================================
    // AUTOPILOT NAVIGATION ENGINE
    // =============================================
    async function doIt(isAuto) {
        if (isRunning || isSolvingQuiz) return;
        if (isAuto && doneUrls.has(location.href)) return;

        if (isAuto) {
            const elapsed = Date.now() - navTimestamp;
            if (elapsed < AFTER_NAV_WAIT) return;
        }

        if (isAuto && isAssignmentPage()) {
            return;
        }

        isRunning = true;
        runStartTime = Date.now();
        const url = location.href;
        const pageType = getPageType();

        try {
            if (pageType === 'video' || hasVideoElement()) {
                await handleVideo();
            }

            if (pageType === 'lab' || findLabLaunch()) {
                await handleLab();
            }

            if (pageType === 'discussion' || pageType === 'dialogue' || findDiscussionStart() || findDialogueStart()) {
                await handleDialogue();
            }

            if (isAuto && (waitingForAssignment || userIsSubmitting)) return;

            let mark = await waitForBtn(findMarkComplete, 2000);

            if (isAuto && (waitingForAssignment || userIsSubmitting)) return;

            if (mark) {
                forceClick(mark);
                toast('Marked complete');
                await wait(CLICK_DELAY);
            }

            if (isAuto && (waitingForAssignment || userIsSubmitting)) return;

            const next = findNextItem();
            if (next) {
                forceClick(next);
                toast('Next item');
                doneUrls.add(url);
                navTimestamp = Date.now();
            } else if (!mark && pageType === 'unknown' && !hasVideoElement() && !findLabLaunch() && !findDiscussionStart() && !findDialogueStart()) {
                toast('Nothing to do');
            }

        } finally {
            if (doneUrls.size > 200) doneUrls = new Set([...doneUrls].slice(-50));
            await wait(AFTER_NAV_WAIT);
            isRunning = false;
        }
    }

    // =============================================
    // AUTO SCANNER
    // =============================================
    function startScan() {
        stopScan();
        scanTimer = setInterval(() => {
            if (isSolvingQuiz) return;

            if (isRunning) {
                if (Date.now() - runStartTime > 15000) {
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

                if (isGraded || (userIsSubmitting && !isAnyModalOpen() && !hasQuizInputs)) {
                    if (nextBtn) {
                        toast('Grade confirmed — Moving to next item...');
                        doneUrls.add(location.href);
                        navTimestamp = Date.now();
                        waitingForAssignment = false;
                        userIsSubmitting = false;
                        if (localStorage.getItem('tm_auto') === 'true') {
                            autoEnabled = true;
                        }
                        updateUi();
                        forceClick(nextBtn);
                        return;
                    }
                }

                if (startBtn && !hasQuizInputs && !userIsSubmitting && !isGraded) {
                    toast('Starting assignment...');
                    forceClick(startBtn);
                    return;
                }

                if (hasQuizInputs && !isGraded) {
                    if (!waitingForAssignment || autoEnabled) {
                        waitingForAssignment = true;
                        autoEnabled = false;
                        updateUi();
                        toast('Assignment page — Auto paused for completion.');
                    }
                    return;
                }
            } else {
                if (waitingForAssignment || userIsSubmitting) {
                    waitingForAssignment = false;
                    userIsSubmitting = false;
                    if (localStorage.getItem('tm_auto') === 'true') {
                        autoEnabled = true;
                    }
                    updateUi();
                }
            }

            if (!autoEnabled) return;

            if (hasVideoElement() || findLabLaunch() || findSideBySide() || findDiscussionStart() || findDialogueStart()
                || findMarkComplete() || findNextItem()) {
                doIt(true);
            }
        }, SCAN_INTERVAL);
    }

    function stopScan() {
        if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    }

    function toggleAuto() {
        waitingForAssignment = false;
        userIsSubmitting = false;
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
    // URL WATCHER (SPA navigation support)
    // =============================================
    setInterval(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            navTimestamp = Date.now();
            isRunning = false;
            waitingForAssignment = false;
            userIsSubmitting = false;

            doneUrls.delete(location.href);

            if (localStorage.getItem('tm_auto') === 'true') {
                autoEnabled = true;
            }
            updateUi();
        }
    }, 500);

    // =============================================
    // QUIZ AUTO SOLVER CORE LOGIC
    // =============================================
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

    function findHonorCode() {
        return Array.from(document.querySelectorAll('input[type="checkbox"]')).find(cb => {
            const text = (cb.closest('label, div, form') || cb).textContent.toLowerCase();
            return text.includes('agree') || text.includes('honor') || text.includes('work is your own');
        });
    }

    function findButtonByText(textsToMatch, excludeTexts = [], skipElement = null) {
        const btns = Array.from(document.querySelectorAll('button, input[type="submit"], a.cds-button, [role="button"]'));
        for (const btn of btns) {
            if (btn === skipElement) continue;
            if (btn.closest('#tm-widget')) continue;
            if (!isElementVisible(btn)) continue;
            
            const text = (btn.textContent || btn.value || btn.getAttribute('aria-label') || '').toLowerCase().trim();
            if (!text) continue;

            const matches = textsToMatch.some(t => text === t || text.startsWith(t));
            const excluded = excludeTexts.some(e => text.includes(e));

            if (matches && !excluded) return btn;
        }
        return null;
    }

    function isGradeShown() {
        return isGradedResultsScreen();
    }

    async function executeSolver(answersStr) {
        if (isSolvingQuiz) return;
        isSolvingQuiz = true;

        const prevAuto = autoEnabled;
        autoEnabled = false;

        try {
            const answers = answersStr.split(/[,;\n]+/).map(a => a.trim()).filter(Boolean);
            const questions = getQuestions();
            if (questions.length === 0) {
                toast('❌ No questions found!');
                return;
            }

            toast(`Filling ${questions.length} questions...`);

            // 1. Fill answers
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
                await wait(150);
            }

            // 2. Check Honor Code
            toast('Checking Honor Code...');
            const honorCb = findHonorCode();
            if (honorCb) {
                checkReactCheckbox(honorCb);
                await wait(300);
            }

            // 3. Click 1st Submit Button
            toast('Looking for Page Submit button...');
            let btn1 = null;
            for (let i = 0; i < 15; i++) {
                btn1 = findButtonByText(['submit', 'submit assignment', 'submit quiz'], ['draft', 'save', 'cancel']);
                if (btn1) break;
                await wait(400);
            }

            if (!btn1) {
                toast('❌ Submit button not found on page.');
                return;
            }

            toast('Clicking Submit button...');
            forceClick(btn1);

            // 4. Click 2nd Modal Confirm Button
            toast('Waiting for confirmation modal...');
            let btn2 = null;
            for (let i = 0; i < 15; i++) {
                btn2 = findButtonByText(['submit', 'confirm', 'yes'], ['cancel', 'no', 'back'], btn1);
                if (btn2) break;
                await wait(400);
            }

            if (btn2) {
                toast('Clicking Confirm in modal...');
                forceClick(btn2);
            }

            // 5. Wait for Grade
            toast('Waiting for grade results...');
            let graded = false;
            for (let i = 0; i < 60; i++) {
                if (isGradeShown()) {
                    graded = true;
                    break;
                }
                await wait(500);
            }

            if (!graded) {
                toast('⚠️ Grade not detected, proceeding anyway.');
            }

            // 6. Click Next Item
            toast('Looking for Next Item button...');
            let nextBtn = null;
            for (let i = 0; i < 15; i++) {
                nextBtn = findButtonByText(['next item', 'next', 'go to next'], ['skip']);
                if (nextBtn) break;
                await wait(500);
            }

            if (nextBtn) {
                toast('Clicking Next Item...');
                forceClick(nextBtn);
            } else {
                toast('✅ Done! Next Item button not found.');
            }

        } catch (e) {
            console.error(e);
            toast('Error: ' + e.message);
        } finally {
            isSolvingQuiz = false;
            autoEnabled = prevAuto;
            updateUi();
        }
    }

    function triggerPromptAndSolve() {
        const ans = prompt('Enter answers (e.g., 1, 3, 1+2, 4):');
        if (ans) executeSolver(ans);
    }

    // =============================================
    // UNIFIED DASHBOARD UI WIDGET
    // =============================================
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
            userSelect: 'none'
        });

        const saved = localStorage.getItem('tm_widget_pos') || localStorage.getItem('tm_bar_pos');
        if (saved) {
            try {
                const pos = JSON.parse(saved);
                widget.style.left = pos.x + 'px';
                widget.style.top = pos.y + 'px';
            } catch (_) {
                widget.style.bottom = '20px';
                widget.style.left = '20px';
            }
        } else {
            widget.style.bottom = '20px';
            widget.style.left = '20px';
        }

        // Drag handle
        const drag = document.createElement('span');
        drag.textContent = '⋮⋮';
        drag.title = 'Drag widget';
        Object.assign(drag.style, {
            color: '#64748b', cursor: 'grab', fontSize: '13px', fontWeight: 'bold', userSelect: 'none', paddingRight: '2px'
        });

        let isDragging = false;
        let dragStartX, dragStartY, wX, wY;

        const startDrag = (e) => {
            if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
            isDragging = true;
            drag.style.cursor = 'grabbing';
            dragStartX = e.clientX; dragStartY = e.clientY;
            const r = widget.getBoundingClientRect();
            wX = r.left; wY = r.top;
            widget.style.bottom = ''; widget.style.left = '';
            e.preventDefault();
        };

        widget.addEventListener('mousedown', startDrag);
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
            isDragging = false; drag.style.cursor = 'grab';
            const r = widget.getBoundingClientRect();
            localStorage.setItem('tm_widget_pos', JSON.stringify({ x: r.left, y: r.top }));
        });

        // Button 1: Skip & Next (Autopilot single skip)
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

        // Button 2: Auto Skip (Autopilot toggle)
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

        // Button 3: Solve & Submit (Quiz Solver prompt)
        const solveBtn = document.createElement('button');
        solveBtn.id = 'tm-solve';
        solveBtn.textContent = 'Solve & Submit';
        solveBtn.title = 'Prompt for answers, check agreement & submit [Alt+Q]';
        Object.assign(solveBtn.style, {
            all: 'unset', boxSizing: 'border-box',
            background: '#0284c7', color: '#f8fafc',
            border: '1px solid #0369a1', borderRadius: '4px',
            padding: '5px 10px', fontSize: '11px', fontWeight: '600',
            lineHeight: '1', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            whiteSpace: 'nowrap'
        });
        solveBtn.onmouseenter = () => solveBtn.style.background = '#0369a1';
        solveBtn.onmouseleave = () => solveBtn.style.background = '#0284c7';
        solveBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); triggerPromptAndSolve(); };

        widget.appendChild(drag);
        widget.appendChild(doBtn);
        widget.appendChild(autoBtn);
        widget.appendChild(solveBtn);
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
    // KEYBOARD SHORTCUTS
    // =============================================
    window.addEventListener('keydown', (e) => {
        if (!e.altKey) return;
        const key = e.key.toLowerCase();
        if (key === 'd') { e.preventDefault(); doIt(false); }
        if (key === 'a') { e.preventDefault(); toggleAuto(); }
        if (key === 'q') { e.preventDefault(); triggerPromptAndSolve(); }
    });

    // =============================================
    // INITIALIZATION
    // =============================================
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
