// ==UserScript==
// @name         Coursera Quiz Auto Solver (Ultra Reliable)
// @namespace    http://tampermonkey.net/
// @version      10.0
// @description  Automated quiz solver for Coursera. Selects options, checks honor code, clicks Submit (page + modal popup), waits for grade to appear, and clicks Next Item.
// @author       Gohar Rehman
// @match        *://*.coursera.org/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    let isRunning = false;

    // ----- UI & LOGGING -----
    function log(msg) {
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
        box._t = setTimeout(() => { box.style.opacity = '0'; }, 4000);
    }

    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    function isVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.offsetWidth > 0;
    }

    // ----- CORE INTERACTION ACTIONS -----
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

    // ----- ELEMENT FINDERS -----
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
            if (btn.closest('#qas-widget')) continue;
            if (!isVisible(btn)) continue;
            
            const text = (btn.textContent || btn.value || btn.getAttribute('aria-label') || '').toLowerCase().trim();
            if (!text) continue;

            const matches = textsToMatch.some(t => text === t || text.startsWith(t));
            const excluded = excludeTexts.some(e => text.includes(e));

            if (matches && !excluded) return btn;
        }
        return null;
    }

    function isGradeShown() {
        const els = document.querySelectorAll('[data-test*="grade"], [data-test*="score"], [class*="Grade"], [class*="Score"], [class*="Result"]');
        return Array.from(els).some(el => {
            if (!isVisible(el)) return false;
            const t = el.textContent.toLowerCase();
            return t.includes('%') || t.includes('grade') || t.includes('passed') || t.includes('score');
        });
    }

    // ----- MAIN WORKFLOW -----
    async function executeSolver(answersStr) {
        if (isRunning) return;
        isRunning = true;

        try {
            const answers = answersStr.split(/[,;\n]+/).map(a => a.trim()).filter(Boolean);
            const questions = getQuestions();
            if (questions.length === 0) {
                log('❌ No questions found!');
                return;
            }

            log(`Filling ${questions.length} questions...`);

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
            log('Checking Honor Code...');
            const honorCb = findHonorCode();
            if (honorCb) {
                checkReactCheckbox(honorCb);
                await wait(300);
            }

            // 3. Click 1st Submit Button
            log('Looking for Page Submit button...');
            let btn1 = null;
            for (let i = 0; i < 15; i++) {
                btn1 = findButtonByText(['submit', 'submit assignment', 'submit quiz'], ['draft', 'save', 'cancel']);
                if (btn1) break;
                await wait(400);
            }

            if (!btn1) {
                log('❌ Submit button not found on page.');
                return;
            }

            log('Clicking Submit button...');
            forceClick(btn1);

            // 4. Click 2nd Modal Confirm Button
            log('Waiting for confirmation modal...');
            let btn2 = null;
            for (let i = 0; i < 15; i++) {
                btn2 = findButtonByText(['submit', 'confirm', 'yes'], ['cancel', 'no', 'back'], btn1);
                if (btn2) break;
                await wait(400);
            }

            if (btn2) {
                log('Clicking Confirm in modal...');
                forceClick(btn2);
            }

            // 5. Wait for Grade
            log('Waiting for grade results...');
            let graded = false;
            for (let i = 0; i < 60; i++) {
                if (isGradeShown()) {
                    graded = true;
                    break;
                }
                await wait(500);
            }

            if (!graded) {
                log('⚠️ Grade not detected, proceeding anyway.');
            }

            // 6. Click Next Item
            log('Looking for Next Item button...');
            let nextBtn = null;
            for (let i = 0; i < 15; i++) {
                nextBtn = findButtonByText(['next item', 'next', 'go to next'], ['skip']);
                if (nextBtn) break;
                await wait(500);
            }

            if (nextBtn) {
                log('Clicking Next Item...');
                forceClick(nextBtn);
            } else {
                log('✅ Done! Next Item button not found.');
            }

        } catch (e) {
            console.error(e);
            log('Error: ' + e.message);
        } finally {
            isRunning = false;
        }
    }

    // ----- UI WIDGET -----
    function createWidget() {
        if (document.getElementById('qas-widget')) return;
        const w = document.createElement('div');
        w.id = 'qas-widget';
        Object.assign(w.style, {
            position: 'fixed', bottom: '20px', left: '20px', zIndex: '999999',
            background: '#1e293b', border: '1px solid #334155', borderRadius: '8px',
            padding: '6px 10px', display: 'flex', alignItems: 'center', gap: '8px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)', userSelect: 'none'
        });

        const btn = document.createElement('button');
        btn.textContent = 'Solve & Submit';
        Object.assign(btn.style, {
            background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: '4px',
            padding: '6px 12px', fontSize: '13px', fontWeight: 'bold', cursor: 'pointer'
        });
        btn.onclick = () => {
            const ans = prompt('Enter answers (e.g., 1, 3, 1+2, 4):');
            if (ans) executeSolver(ans);
        };

        w.appendChild(btn);
        document.body.appendChild(w);
    }

    window.addEventListener('keydown', (e) => {
        if (e.altKey && e.key === 'q') {
            const ans = prompt('Enter answers (e.g., 1, 3, 1+2, 4):');
            if (ans) executeSolver(ans);
        }
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createWidget);
    } else {
        createWidget();
    }
})();
