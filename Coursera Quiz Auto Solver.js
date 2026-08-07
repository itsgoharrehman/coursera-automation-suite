// ==UserScript==
// @name         Coursera Quiz Auto Solver
// @namespace    http://tampermonkey.net/
// @version      6.1
// @description  Complete automated quiz solver for Coursera. Prompts for browser input, selects options, checks agreement, clicks Submit twice (page + modal popup), waits for grade to appear, and clicks Next Item.
// @author       Gohar Rehman
// @match        *://*.coursera.org/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    let isProcessing = false;

    // Toast Notification System
    function toast(msg) {
        let t = document.getElementById('qas-t');
        if (!t) {
            t = document.createElement('div');
            t.id = 'qas-t';
            Object.assign(t.style, {
                position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)',
                background: '#0f172a', color: '#38bdf8',
                padding: '8px 20px', borderRadius: '8px',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                fontSize: '12px', fontWeight: '600', letterSpacing: '0.2px',
                zIndex: '9999999', pointerEvents: 'none',
                transition: 'opacity .2s ease', opacity: '0',
                border: '1px solid rgba(56, 189, 248, 0.3)',
                boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
                maxWidth: '500px', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden'
            });
            document.body.appendChild(t);
        }
        t.textContent = msg;
        t.style.opacity = '1';
        clearTimeout(t._x);
        t._x = setTimeout(() => { t.style.opacity = '0'; }, 3500);
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function isElementVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return true;
    }

    function clickTarget(el) {
        if (!el) return false;
        try {
            if (el.disabled) {
                el.disabled = false;
                el.removeAttribute('disabled');
            }
            if (el.scrollIntoView) {
                try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
            }
            if (el.focus) el.focus();

            const opts = { bubbles: true, cancelable: true, view: window };
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new MouseEvent('mouseup', opts));
            el.click();
            return true;
        } catch (e) {
            console.error('Click error:', e);
            return false;
        }
    }

    // Safely set checkbox/radio checked state for React without toggling back off
    function setReactCheckboxChecked(checkbox, isChecked) {
        if (!checkbox) return;
        try {
            if (checkbox.checked !== isChecked) {
                checkbox.click();
            }
            if (checkbox.checked !== isChecked) {
                const prototype = HTMLInputElement.prototype;
                const descriptor = Object.getOwnPropertyDescriptor(prototype, 'checked');

                if (descriptor && descriptor.set) {
                    descriptor.set.call(checkbox, isChecked);
                } else {
                    checkbox.checked = isChecked;
                }

                checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                checkbox.dispatchEvent(new Event('input', { bubbles: true }));
            }
        } catch (e) {
            console.error('Error setting React checkbox state:', e);
            clickTarget(checkbox);
        }
    }

    // Helper to check if an input is the Honor Code / Agreement element
    function isAgreementElement(el) {
        if (!el) return false;
        const container = el.closest('label, div, form, fieldset, section') || el.parentElement || el;
        const text = (container ? container.textContent : '').toLowerCase();
        return text.includes('agree') || text.includes('understand') || text.includes('honor') || text.includes('gohar') || text.includes('rehman') || text.includes('signature') || text.includes('i accept');
    }

    // 1. QUESTION AND OPTION FINDER
    function findQuestions() {
        let wrappers = Array.from(document.querySelectorAll('.rc-FormPartsQuestion, fieldset, [role="group"], [data-test*="question"], div[class*="Question"], div[class*="question"]'));
        wrappers = wrappers.filter(w => w.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]').length > 0);

        // Filter out parent wrappers if inner wrappers exist
        wrappers = wrappers.filter(w => !wrappers.some(other => other !== w && w.contains(other)));

        if (wrappers.length === 0) {
            const inputs = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'));
            const map = new Map();
            inputs.forEach(inp => {
                if (isAgreementElement(inp)) return;
                const parent = inp.closest('form, div[class*="Question"], div[class*="question"], fieldset') || inp.name || 'default';
                if (!map.has(parent)) map.set(parent, []);
                map.get(parent).push(inp);
            });
            return Array.from(map.values()).map(inps => ({ isFallbackGroup: true, inputs: inps }));
        }

        return wrappers;
    }

    function getQuestionOptions(questionObj) {
        if (questionObj.isFallbackGroup) return questionObj.inputs;

        let options = Array.from(questionObj.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'));
        options = options.filter(opt => !isAgreementElement(opt));

        if (options.length === 0) {
            options = Array.from(questionObj.querySelectorAll('label, [data-test*="option"], [class*="Option"], [class*="option"]'));
        }

        return options;
    }

    function selectOptionElement(optionEl) {
        if (!optionEl) return;

        let cb = optionEl;
        if (optionEl.tagName !== 'INPUT') {
            cb = optionEl.querySelector('input[type="radio"], input[type="checkbox"]');
        }

        if (cb) {
            setReactCheckboxChecked(cb, true);
        } else {
            clickTarget(optionEl);
        }
    }

    // 2. AGREEMENT CHECKBOX FORCE SYNCER
    function ensureAgreementChecked() {
        const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"], input[type="radio"]'));
        for (const cb of checkboxes) {
            if (isAgreementElement(cb)) {
                setReactCheckboxChecked(cb, true);
                return true;
            }
        }

        // Fallback label / container search
        for (const label of document.querySelectorAll('label, div, span')) {
            const text = label.textContent.toLowerCase();
            if (text.includes('understand and agree') || text.includes('honor code') || text.includes('i accept')) {
                clickTarget(label);
                return true;
            }
        }
        return false;
    }

    // Helper: Check if element is inside an active modal dialog popup
    function isInActiveModalDialog(el) {
        const modal = el.closest('[role="dialog"], [aria-modal="true"], .cds-dialog, .cds-modal-container');
        return !!(modal && isElementVisible(modal));
    }

    // 3. FIRST SUBMIT BUTTON FINDER (Page level)
    function find1stSubmitBtn() {
        const selectors = [
            '[data-test="submit-button"]', '[data-testid="submit-button"]',
            '[data-test="submit-quiz-button"]', '[data-testid="submit-quiz"]',
            'button[aria-label*="Submit"]', 'button[aria-label*="submit"]',
            'button[aria-label*="submit assignment"]', 'button[aria-label*="Submit Assignment"]'
        ];

        for (const sel of selectors) {
            for (const b of document.querySelectorAll(sel)) {
                if (b && isElementVisible(b) && !b.closest('#qas-widget, #tm-widget') && !isInActiveModalDialog(b)) {
                    return b;
                }
            }
        }

        const allBtns = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"], a.cds-button, a, div, span'));
        for (const b of allBtns) {
            if (b.closest('#qas-widget, #tm-widget') || isInActiveModalDialog(b)) continue;
            if (!isElementVisible(b)) continue;

            if ((b.tagName === 'DIV' || b.tagName === 'SPAN') && !b.getAttribute('role') && !b.className.includes('button') && !b.className.includes('Submit')) {
                continue;
            }

            const text = (b.textContent || b.value || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (text === 'submit' || text === 'submit assignment' || text === 'submit quiz' || text === 'submit for grading' || text.startsWith('submit assignment') || text.startsWith('submit quiz')) {
                return b;
            }
        }
        return null;
    }

    // 4. SECOND SUBMIT BUTTON FINDER (Modal confirmation popup)
    function find2ndModalSubmitBtn(btn1) {
        const dialogs = document.querySelectorAll('[role="dialog"], [aria-modal="true"], .cds-dialog, .cds-modal-container, div[class*="ModalOverlay"], div[class*="modal-dialog"], div[class*="dialog"]');
        for (const d of dialogs) {
            if (d.id === 'qas-widget' || d.id === 'tm-widget') continue;
            if (isElementVisible(d)) {
                const btns = d.querySelectorAll('button, [role="button"], input[type="submit"], a.cds-button, a');
                for (const b of btns) {
                    if (b === btn1) continue;
                    if (!isElementVisible(b)) continue;

                    const text = (b.textContent || b.value || '').replace(/\s+/g, ' ').trim().toLowerCase();
                    const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                    const dataTest = (b.getAttribute('data-test') || b.getAttribute('data-testid') || '').toLowerCase();

                    if (text === 'submit' || text === 'submit assignment' || text === 'submit quiz' || text === 'confirm' || text === 'yes' ||
                        text.includes('submit') || text.includes('confirm') || aria.includes('submit') || dataTest.includes('submit')) {
                        return b;
                    }
                }
            }
        }
        return null;
    }

    // 5. GRADE DISPLAY CHECKER
    function isGradeDisplayed() {
        const sel = '[data-test*="grade"], [data-test*="score"], [class*="Grade"], [class*="grade"], .rc-Score, [class*="Score"]';
        const els = document.querySelectorAll(sel);
        for (const el of els) {
            if (isElementVisible(el)) {
                const text = el.textContent.toLowerCase();
                if (text.includes('%') || text.includes('grade') || text.includes('score') || text.includes('passed') || text.includes('try again') || text.includes('submitted')) {
                    return true;
                }
            }
        }
        return false;
    }

    // 6. NEXT ITEM BUTTON FINDER
    function findNextItemBtn() {
        const selectors = [
            '[data-test="next-item-button"]', '[data-testid="next-button"]',
            '[data-test="next-button"]', 'button[aria-label*="Next"]', 'button[aria-label*="next"]',
            'a[aria-label*="Next"]', 'a[aria-label*="next"]'
        ];
        for (const sel of selectors) {
            for (const b of document.querySelectorAll(sel)) {
                if (b && isElementVisible(b) && !b.closest('#qas-widget, #tm-widget')) return b;
            }
        }

        for (const el of document.querySelectorAll('button, [role="button"], a.cds-button, a, span')) {
            if (el.closest('#qas-widget, #tm-widget')) continue;
            if (!isElementVisible(el)) continue;
            const t = (el.textContent || el.value || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();

            if (t === 'next item' || t === 'next' || t.includes('next item') || t.includes('go to next') || t.includes('continue') ||
                aria.includes('next item') || aria.includes('go to next')) {
                return el;
            }
        }
        return null;
    }

    // --- BROWSER INPUT PROMPTER ---
    function triggerPromptAndSolve() {
        if (isProcessing) {
            toast('Solver is already running...');
            return;
        }
        const inputStr = window.prompt('Enter answer numbers for each question (e.g. 1, 3, 1+2, 4):');
        if (inputStr !== null && inputStr.trim() !== '') {
            solveQuiz(inputStr.trim());
        }
    }

    // --- MAIN SOLVE FLOW ---
    async function solveQuiz(answersString) {
        if (isProcessing) return;
        isProcessing = true;

        try {
            if (!answersString || !answersString.trim()) {
                toast('No answer input provided!');
                return;
            }

            // Step 1: Parse Answers
            const rawAnswers = answersString.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
            const questions = findQuestions();

            if (questions.length === 0) {
                toast('No quiz questions found on page!');
                return;
            }

            toast(`Filling ${questions.length} questions...`);

            // Step 2: Select Answers
            for (let i = 0; i < questions.length; i++) {
                if (i >= rawAnswers.length) break;

                const q = questions[i];
                const options = getQuestionOptions(q);
                const ansStr = rawAnswers[i];
                const numbers = ansStr.match(/\d+/g);

                if (!numbers) continue;

                numbers.forEach(n => {
                    const idx = parseInt(n, 10) - 1;
                    if (idx >= 0 && idx < options.length) {
                        selectOptionElement(options[idx]);
                    }
                });

                await sleep(150);
            }

            // Step 3: Force Check Agreement Checkbox
            await sleep(300);
            ensureAgreementChecked();
            toast('Agreement checked & validated.');

            // Step 4: Click 1st Submit Button (Page Submit)
            await sleep(500);
            toast('Clicking 1st Submit button...');
            let btn1 = null;
            const t0_1 = Date.now();
            while (Date.now() - t0_1 < 6000) {
                btn1 = find1stSubmitBtn();
                if (btn1) {
                    btn1.disabled = false;
                    btn1.removeAttribute('disabled');
                    btn1.classList.remove('disabled');
                    break;
                }
                await sleep(300);
            }

            if (btn1) {
                clickTarget(btn1);
                toast('1st Submit clicked! Waiting for modal popup...');
            } else {
                toast('1st Submit button not found.');
                return;
            }

            // Step 5: Click 2nd Submit Button (Modal Confirmation Popup)
            let btn2 = null;
            const t0_2 = Date.now();
            while (Date.now() - t0_2 < 8000) {
                await sleep(400);
                btn2 = find2ndModalSubmitBtn(btn1);
                if (btn2) break;
            }

            if (btn2) {
                await sleep(300);
                clickTarget(btn2);
                toast('2nd Submit clicked in modal! Waiting for grade...');
            } else {
                toast('Submitted directly or modal auto-confirmed.');
            }

            // Step 6: Wait for Grade to appear & Click Next Item
            toast('Waiting for grade results...');
            let gradeDetected = false;
            let nextBtn = null;
            const t0_grade = Date.now();

            while (Date.now() - t0_grade < 35000) {
                await sleep(500);
                if (!gradeDetected && isGradeDisplayed()) {
                    gradeDetected = true;
                    toast('Grade detected! Looking for Next Item button...');
                }
                nextBtn = findNextItemBtn();
                if (nextBtn) break;
            }

            if (nextBtn) {
                await sleep(800);
                clickTarget(nextBtn);
                toast('Next Item clicked! Moving to next activity...');
            } else {
                toast('Quiz submitted! Click Next Item when grade appears.');
            }

        } catch (err) {
            console.error('Quiz Solver Error:', err);
            toast('Error: ' + err.message);
        } finally {
            isProcessing = false;
        }
    }

    // --- UI OVERLAY WIDGET ---
    function createUi() {
        if (document.getElementById('qas-widget')) return;

        const widget = document.createElement('div');
        widget.id = 'qas-widget';
        Object.assign(widget.style, {
            position: 'fixed', zIndex: '999998',
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            background: '#1e293b',
            padding: '4px 8px',
            borderRadius: '6px',
            border: '1px solid #334155',
            boxShadow: '0 4px 12px rgba(0,0,0,0.35)'
        });

        // Restore Position
        const saved = localStorage.getItem('qas_widget_pos');
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

        // Drag Handle Icon
        const dragHandle = document.createElement('span');
        dragHandle.textContent = '⋮⋮';
        dragHandle.title = 'Drag widget';
        Object.assign(dragHandle.style, {
            color: '#64748b', cursor: 'grab', fontSize: '13px',
            fontWeight: 'bold', userSelect: 'none', paddingRight: '2px'
        });

        let isDragging = false;
        let dragStartX, dragStartY, wX, wY;

        const startDrag = (e) => {
            if (e.target.tagName === 'BUTTON') return;
            isDragging = true;
            dragHandle.style.cursor = 'grabbing';
            dragStartX = e.clientX; dragStartY = e.clientY;
            const r = widget.getBoundingClientRect();
            wX = r.left; wY = r.top;
            widget.style.bottom = ''; widget.style.right = '';
            e.preventDefault();
        };

        widget.addEventListener('mousedown', startDrag);
        dragHandle.addEventListener('mousedown', startDrag);

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
            isDragging = false; dragHandle.style.cursor = 'grab';
            const r = widget.getBoundingClientRect();
            localStorage.setItem('qas_widget_pos', JSON.stringify({ x: r.left, y: r.top }));
        });

        const stopProp = (e) => e.stopPropagation();

        // Run Button
        const runBtn = document.createElement('button');
        runBtn.id = 'qas-run';
        runBtn.textContent = 'Solve & Submit';
        runBtn.title = 'Prompt for answers, check agreement, submit twice & go next [Alt+Q]';
        Object.assign(runBtn.style, {
            boxSizing: 'border-box',
            background: '#0284c7', color: '#f8fafc',
            border: '1px solid #0369a1', borderRadius: '4px',
            padding: '5px 10px', fontSize: '11px', fontWeight: '600',
            lineHeight: '1', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            whiteSpace: 'nowrap', userSelect: 'none'
        });

        runBtn.addEventListener('mousedown', stopProp);
        runBtn.onmouseenter = () => runBtn.style.background = '#0369a1';
        runBtn.onmouseleave = () => runBtn.style.background = '#0284c7';
        runBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            triggerPromptAndSolve();
        };

        widget.appendChild(dragHandle);
        widget.appendChild(runBtn);
        document.body.appendChild(widget);
    }

    // Shortcut (Alt + Q)
    window.addEventListener('keydown', (e) => {
        if (e.altKey && e.key.toLowerCase() === 'q') {
            e.preventDefault();
            triggerPromptAndSolve();
        }
    });

    // Init
    function init() {
        createUi();
        const obs = new MutationObserver(() => {
            if (!document.getElementById('qas-widget')) createUi();
        });
        obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
