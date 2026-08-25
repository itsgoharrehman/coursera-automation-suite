// ==UserScript==
// @name         Autopilot Pro
// @namespace    http://tampermonkey.net/
// @version      2.3
// @description  Complete Coursera autopilot: videos, readings, multi-type labs (side-by-side Guided Projects & launch-and-go LTI tools), dialogues, instant skip for green-checked completed items, and multi-provider AI quiz auto-solver (Groq & NVIDIA NIM with multi-key rotation and live models).
// @author       Gohar Rehman (https://github.com/itsgoharrehman)
// @match        *://*.coursera.org/*
// @match        *://*.coursera-apps.org/*
// @match        *://*.qwiklabs.com/*
// @match        *://*.rhyme.com/*
// @match        *://*.vocareum.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.groq.com
// @connect      integrate.api.nvidia.com
// ==/UserScript==

(function () {
    'use strict';

    const SECONDS_FROM_END = 3;
    const AFTER_NAV_WAIT = 1500;
    const SCAN_INTERVAL = 400;

    let autoEnabled = localStorage.getItem('tm_auto') === 'true';
    let rawAiKeys = localStorage.getItem('coursera_ai_keys') || localStorage.getItem('coursera_groq_api_key') || '';
    let selectedProvider = localStorage.getItem('coursera_ai_provider') || 'auto';
    let selectedModel = localStorage.getItem('coursera_ai_model') || 'openai/gpt-oss-120b';
    let autoSubmitQuiz = localStorage.getItem('coursera_auto_submit_quiz') === 'true';

    let isRunning = false;
    let isSolverRunning = false;
    let scanTimer = null;
    let lastUrl = location.href;
    let doneUrls = new Set();
    let uiReady = false;
    let navTimestamp = 0;
    let waitingForLab = false;
    let runStartTime = 0;

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function parseApiKeys(raw) {
        if (!raw) return [];
        return raw.split(/[\n,;]+/).map(k => k.trim()).filter(Boolean);
    }

    function detectProviderForKey(key) {
        if (!key) return 'groq';
        if (key.startsWith('nvapi-')) return 'nvidia';
        if (key.startsWith('gsk_')) return 'groq';
        if (selectedModel && (selectedModel.startsWith('meta/') || selectedModel.startsWith('deepseek') || selectedModel.startsWith('mistral'))) {
            return 'nvidia';
        }
        return 'groq';
    }

    function getEndpointForProvider(provider) {
        if (provider === 'nvidia') return 'https://integrate.api.nvidia.com/v1/chat/completions';
        return 'https://api.groq.com/openai/v1/chat/completions';
    }

    function getDefaultModelForProvider(provider) {
        if (provider === 'nvidia') return 'meta/llama-3.3-70b-instruct';
        return 'openai/gpt-oss-120b';
    }

    function getPageType() {
        const path = location.pathname.toLowerCase();
        if (path.includes('/lecture')) return 'video';
        if (path.includes('/supplement')) return 'reading';
        if (path.includes('/quiz')) return 'quiz';
        if (path.includes('/exam')) return 'quiz';
        if (path.includes('/assignment')) return 'assignment';
        if (path.includes('/ungradedlab')) return 'lab';
        if (path.includes('/ungradedwidget')) return 'lab';
        if (path.includes('/gradedlti')) return 'lab';
        if (path.includes('/ungradedlti')) return 'lab';
        if (path.includes('/workspace')) return 'lab';
        if (path.includes('/discussionprompt')) return 'discussion';
        if (path.includes('/dialogue')) return 'dialogue';
        if (path.includes('/coach')) return 'dialogue';
        if (path.includes('/peer')) return 'peer';
        if (path.includes('/programming')) return 'reading';
        return 'generic';
    }

    function isAssignmentPage() {
        const type = getPageType();
        if (['quiz', 'assignment', 'peer'].includes(type)) return true;
        const path = location.pathname.toLowerCase();
        if (path.includes('/graded') || path.includes('/quiz') || path.includes('/exam') || path.includes('/assignment') || path.includes('/attempt')) return true;
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

    function isItemAlreadyCompleted() {
        const url = location.href.toLowerCase();
        if (url.includes('/attempt') && !url.includes('/view-feedback')) return false;

        // 1. If there is an active actionable button on the page, it is NOT completed
        if (findMarkComplete() !== null) return false;
        if (findBtnPartial(['launch app', 'launch lab', 'start lab', 'learn side-by-side', 'open workspace']) !== null) return false;

        // 2. If a video is present and not near the end, it is NOT completed
        const video = document.querySelector('video');
        if (video && video.duration > 0 && video.currentTime < video.duration - 2) {
            return false;
        }

        // 3. Strict check on active sidebar navigation item
        const activeNavItems = document.querySelectorAll('.rc-ItemRow.active, .rc-NavigationDrawerItem.active, [aria-current="page"], [aria-current="step"], [aria-current="true"]');
        for (const item of activeNavItems) {
            const svgs = item.querySelectorAll('svg, [data-testid*="completed"], [aria-label*="Completed"], [aria-label*="completed"]');
            for (const s of svgs) {
                const aria = (s.getAttribute('aria-label') || '').trim().toLowerCase();
                const testId = (s.getAttribute('data-testid') || '').toLowerCase();
                if (aria === 'completed' || aria === 'passed' || testId === 'completed-icon' || testId === 'item-completed') {
                    return true;
                }
            }
        }

        // 4. Strict check for confirmed "Completed" status button on main reading/lab page
        const main = document.querySelector('main, [role="main"]') || document.body;
        if (!main) return false;

        const btns = main.querySelectorAll('button, [role="button"], div[class*="Button"]');
        for (const b of btns) {
            if (b.closest('#tm-dock-host, #tm-toast')) continue;
            const t = (b.textContent || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (t === 'completed' || t === 'marked as completed' || t === 'marked complete' || t === 'completed ✓') {
                if (isElementVisible(b)) return true;
            }
        }

        return false;
    }

    function setNativeValue(el, value) {
        try {
            const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
            if (descriptor && descriptor.set) descriptor.set.call(el, value);
            else el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
        } catch (e) {
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    function setNativeChecked(cb, checked = true) {
        if (!cb || cb.checked === checked) return;
        try {
            const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked');
            if (descriptor && descriptor.set) descriptor.set.call(cb, checked);
            else cb.checked = checked;
            cb.dispatchEvent(new Event('click', { bubbles: true }));
            cb.dispatchEvent(new Event('change', { bubbles: true }));
            cb.dispatchEvent(new Event('input', { bubbles: true }));
        } catch (e) {
            cb.click();
        }
    }

    function findBtnPartial(partials) {
        for (const el of document.querySelectorAll('button, [role="button"]')) {
            if (el.disabled || el.getAttribute('aria-disabled') === 'true' || !isElementVisible(el)) continue;
            if (el.closest('#tm-dock-host, #tm-toast')) continue;
            const t = (el.textContent || '').trim().toLowerCase();
            for (const p of partials) {
                if (t.includes(p.toLowerCase())) return el;
            }
        }
        return null;
    }

    function findNextItem() {
        const testSelectors = [
            '[data-test="next-item-button"]',
            '[data-testid="next-item-button"]',
            '[data-testid="next-button"]',
            '.rc-ItemNavigation button:last-child',
            'button[aria-label="Go to next item"]',
            'button[aria-label="Next item"]',
            'button[aria-label="Next Item"]',
            'button[aria-label="Go to next"]'
        ];

        for (const sel of testSelectors) {
            const el = document.querySelector(sel);
            if (el && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && isElementVisible(el) && !el.closest('#tm-dock-host, #tm-toast')) {
                const text = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
                if (!text.includes('module') && !text.includes('week') && !text.includes('course') && !text.includes('lesson')) return el;
            }
        }

        const candidates = document.querySelectorAll('button, [role="button"], a');
        for (const b of candidates) {
            if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
            if (b.closest('#tm-dock-host, #tm-toast, header, nav')) continue;
            if (!isElementVisible(b)) continue;

            const text = (b.textContent || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (text === 'go to next item' || text === 'next item' || text === 'next' || text.startsWith('go to next item') || text.startsWith('next item')) {
                return b;
            }
        }

        return null;
    }

    function findMarkComplete() {
        const candidates = document.querySelectorAll('button, [role="button"], a, div[role="button"]');
        for (const b of candidates) {
            if (b.disabled || b.getAttribute('aria-disabled') === 'true' || !isElementVisible(b)) continue;
            if (b.closest('#tm-dock-host, #tm-toast, nav')) continue;

            const text = (b.textContent || b.getAttribute('aria-label') || b.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const testId = (b.getAttribute('data-test') || b.getAttribute('data-testid') || '').toLowerCase();

            if (text === 'completed' || text === 'marked as completed' || text === 'marked complete' || text.startsWith('completed') || text.includes('✓')) continue;

            if (
                text === 'mark as completed' || text === 'mark as complete' ||
                text === 'mark completed' || text === 'mark complete' ||
                text === 'complete step' || text === 'mark step as completed' ||
                text.includes('mark as completed') || text.includes('mark as complete') ||
                testId.includes('mark-as-completed') || testId.includes('mark-complete')
            ) {
                return b;
            }
        }
        return null;
    }

    function findNextInstructionArrow(markBtn) {
        if (markBtn) {
            const container = markBtn.closest('div[class*="footer"], div[class*="Footer"], div[class*="action"], div[class*="bottom"]') || markBtn.parentElement;
            if (container) {
                const btns = Array.from(container.querySelectorAll('button, [role="button"]')).filter(b => b !== markBtn && isElementVisible(b));
                if (btns.length >= 2) {
                    const nextBtn = btns[btns.length - 1];
                    if (!nextBtn.disabled && nextBtn.getAttribute('aria-disabled') !== 'true') return nextBtn;
                } else if (btns.length === 1) {
                    const b = btns[0];
                    const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                    if (!aria.includes('prev') && !b.disabled && b.getAttribute('aria-disabled') !== 'true') return b;
                }
            }
        }

        const candidates = document.querySelectorAll('button, [role="button"]');
        for (const b of candidates) {
            if (b.disabled || b.getAttribute('aria-disabled') === 'true' || !isElementVisible(b)) continue;
            if (b.closest('#tm-dock-host, #tm-toast, nav, .rc-ItemNavigation')) continue;

            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            const testId = (b.getAttribute('data-test') || b.getAttribute('data-testid') || '').toLowerCase();
            const text = (b.textContent || '').trim().toLowerCase();

            if (aria.includes('previous') || aria.includes('back') || aria.includes('close')) continue;

            if (
                aria === 'next step' || aria.includes('next step') ||
                aria === 'next instruction' || aria.includes('next instruction') ||
                testId === 'next-step' || testId.includes('next-step') ||
                text === 'next step' || text === 'next instruction' || text === '→'
            ) {
                return b;
            }
        }
        return null;
    }

    function checkAgreementCheckbox() {
        const checkboxes = document.querySelectorAll('input[type="checkbox"]:not(:checked)');
        for (const cb of checkboxes) {
            if (cb.disabled) continue;
            const parent = cb.closest('label') || cb.parentElement;
            const text = (parent ? parent.textContent : '').toLowerCase();
            if (text.includes('agree') || text.includes('honor') || text.includes('responsib') || text.includes('i accept') || text.includes('understand') || text.includes('own work')) {
                setNativeChecked(cb, true);
                if (parent && !cb.checked) cb.click();
                return true;
            }
        }
        return false;
    }

    async function handleVideo() {
        const video = document.querySelector('video');
        if (!video) return;

        if (video.duration > 0 && video.currentTime >= video.duration - 1) return;

        video.muted = true;
        video.playbackRate = 2.0;
        const t = Math.max(0, video.duration - SECONDS_FROM_END);
        if (video.currentTime < t) video.currentTime = t;
        if (video.paused) { try { await video.play(); } catch (e) { } }

        await new Promise(resolve => {
            const check = setInterval(() => {
                if (!video || video.ended || video.currentTime >= video.duration - 0.5) {
                    clearInterval(check);
                    resolve();
                }
            }, 300);
            setTimeout(() => { clearInterval(check); resolve(); }, 7000);
        });

        await sleep(800);
    }

    async function handleLabSteps() {
        let stepCount = 0;
        const maxSteps = 25;

        for (let step = 1; step <= maxSteps; step++) {
            let markBtn = findMarkComplete();
            if (markBtn) {
                stepCount++;
                markBtn.click();
                await sleep(1500);
            }

            let nextArrow = findNextInstructionArrow(markBtn);
            if (nextArrow && !nextArrow.disabled && nextArrow.getAttribute('aria-disabled') !== 'true') {
                nextArrow.click();
                await sleep(2000);
            } else {
                await sleep(1000);
                let retryMark = findMarkComplete();
                if (retryMark) {
                    stepCount++;
                    retryMark.click();
                    await sleep(1500);
                }

                let retryArrow = findNextInstructionArrow(retryMark);
                if (retryArrow && !retryArrow.disabled && retryArrow.getAttribute('aria-disabled') !== 'true') {
                    retryArrow.click();
                    await sleep(2000);
                    continue;
                }
                break;
            }
        }
        return stepCount;
    }

    async function handleLab() {
        let labStage = null;
        let activeBtn = null;

        for (let poll = 0; poll < 12; poll++) {
            const sbs = findBtnPartial(['learn side-by-side', 'learn side by side', 'open side by side', 'side by side', 'open']);
            if (sbs || (document.body ? document.body.textContent : '').includes('Choose how you want to learn')) {
                labStage = 'choice';
                activeBtn = sbs;
                if (activeBtn) break;
            }

            if (findMarkComplete()) {
                labStage = 'workspace';
                break;
            }

            const launch = findBtnPartial(['launch app', 'launch lab', 'open lab', 'start lab', 'open workspace', 'launch workspace', 'open tool', 'launch']);
            if (launch) {
                labStage = 'launch';
                activeBtn = launch;
                break;
            }

            checkAgreementCheckbox();
            await sleep(400);
        }

        if (labStage === 'choice' || (!labStage && (document.body ? document.body.textContent : '').includes('Choose how you want to learn'))) {
            if (activeBtn) {
                activeBtn.click();
                await sleep(3500);
            }
            await handleLabSteps();
            return;
        }

        if (labStage === 'workspace' || findMarkComplete()) {
            await handleLabSteps();
            return;
        }

        if (labStage === 'launch') {
            checkAgreementCheckbox();
            let lab = activeBtn || findBtnPartial(['launch app', 'launch lab', 'start lab']);
            if (lab && !lab.dataset.tmLaunched) {
                lab.dataset.tmLaunched = 'true';
                lab.click();
                await sleep(2500);

                if (document.body.textContent.includes('Choose how you want to learn')) {
                    let sbs = findBtnPartial(['learn side-by-side', 'learn side by side', 'open']);
                    if (sbs) {
                        sbs.click();
                        await sleep(3500);
                        await handleLabSteps();
                    }
                } else {
                    const inlineMark = findMarkComplete();
                    if (inlineMark) {
                        inlineMark.click();
                        await sleep(1000);
                    }
                }
            }
            return;
        }
    }

    async function handleDialogue() {
        const start = findBtnPartial(['start dialogue', 'start conversation', 'begin dialogue', 'start discussion']);
        if (start) {
            start.click();
            await sleep(2500);
        }

        const input = document.querySelector('textarea, input[type="text"], [contenteditable="true"]');
        if (input && isElementVisible(input)) {
            setNativeValue(input, "I understand the lesson thoroughly, thank you!");
            await sleep(600);
            const send = findBtnPartial(['send', 'send message']);
            if (send) send.click();
            await sleep(2000);
        }

        const end = findBtnPartial(['end dialogue', 'end conversation', 'finish dialogue', 'close dialogue']);
        if (end) {
            end.click();
            await sleep(1200);
            const confirm = findBtnPartial(['yes, end', 'yes,end', 'yes end', 'confirm', 'yes']);
            if (confirm) {
                confirm.click();
                await sleep(1500);
            }
        }
    }

    const STRIP_PATTERNS = [
        /(?:You are a helpful AI assistant[\s\S]*?verification step is mandatory for all AI assistants accessing assessment pages\.?)/gi,
        /AI Agent Compliance Verification Required/gi,
        /Do you understand\??\.*\s*/gi,
        /I understand\.?\s*/gi,
        /^\s*\d+[\.\)]\s*/gm,
        /^\s*\d+\s*points?\b/gim,
        /\b\d+\s*points?\b/gim,
        /\b\d+\s*\/\s*\d+\s*points?\b/gim,
        /This question is un-graded/gim,
        /Correct\s*✓?/gim,
        /Incorrect\s*✗?/gim,
        /Try again/gim
    ];

    function cleanTextContent(text) {
        if (!text) return '';
        let cleaned = text;
        for (const pattern of STRIP_PATTERNS) {
            pattern.lastIndex = 0;
            cleaned = cleaned.replace(pattern, '');
        }
        return cleaned.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    function extractQuestionsFromDOM() {
        const questions = [];
        const processedEls = new Set();
        const mainContainer = document.querySelector('main, [role="main"], .rc-Assignment, .rc-Quiz, .rc-Attempt') || document.body;

        const allInputs = Array.from(mainContainer.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled])'));

        const relevantInputs = allInputs.filter(el => {
            const text = (el.closest('label') || el.parentElement || el).textContent.toLowerCase();
            const placeholder = (el.placeholder || '').toLowerCase();
            if (el.type === 'search' || placeholder.includes('search') || el.closest('form[role="search"]') || el.name === 'q') return false;
            if (el.type === 'checkbox' && (text.includes('understand and agree') || text.includes('honor code') || text.includes('my own work') || text.includes('responsibly'))) {
                return false;
            }
            return true;
        });

        let blocks = Array.from(mainContainer.querySelectorAll('.rc-FormPartsQuestion, fieldset, [data-test*="question"], [data-testid*="question"], div[class*="Question"], [role="group"]'));
        blocks = blocks.filter(b => b.querySelector('input, textarea') && isElementVisible(b));
        const questionContainers = blocks.filter(b => !blocks.some(parent => parent !== b && parent.contains(b)));

        questionContainers.forEach((container) => {
            const containerInputs = relevantInputs.filter(el => container.contains(el) && !processedEls.has(el));
            if (containerInputs.length === 0) return;

            let promptEl = container.querySelector('.rc-FormPartsQuestion__content, div[class*="prompt"], div[class*="Prompt"], legend, div.cml-asset-content, div[class*="question-text"]');
            let rawPrompt = promptEl ? promptEl.innerText : container.innerText;
            let cleanPrompt = cleanTextContent(rawPrompt);

            const choiceInputs = containerInputs.filter(el => el.type === 'radio' || el.type === 'checkbox');
            const textInputs = containerInputs.filter(el => el.type !== 'radio' && el.type !== 'checkbox');

            if (choiceInputs.length > 0) {
                const groupsByName = {};
                const noNameGroup = [];
                choiceInputs.forEach(el => {
                    if (el.name) {
                        if (!groupsByName[el.name]) groupsByName[el.name] = [];
                        groupsByName[el.name].push(el);
                    } else {
                        noNameGroup.push(el);
                    }
                });

                const processGroup = (group) => {
                    const type = group[0].type;
                    const options = group.map((el, optIdx) => {
                        const optLabel = el.closest('label') || el.parentElement;
                        let optText = optLabel ? optLabel.innerText : `Option ${optIdx + 1}`;
                        optText = cleanTextContent(optText);
                        return { index: optIdx + 1, text: optText, element: el };
                    });

                    options.forEach(opt => {
                        if (opt.text && opt.text.length > 3) {
                            cleanPrompt = cleanPrompt.replace(opt.text, '').trim();
                        }
                    });

                    questions.push({
                        id: questions.length + 1,
                        type: type,
                        prompt: cleanPrompt || `Question ${questions.length + 1}`,
                        options: options,
                        elements: group
                    });
                    group.forEach(el => processedEls.add(el));
                };

                Object.values(groupsByName).forEach(processGroup);
                if (noNameGroup.length > 0) processGroup(noNameGroup);
            }

            if (textInputs.length > 0) {
                questions.push({
                    id: questions.length + 1,
                    type: 'text',
                    prompt: cleanPrompt || `Question ${questions.length + 1}`,
                    elements: textInputs,
                    blankCount: textInputs.length
                });
                textInputs.forEach(el => processedEls.add(el));
            }
        });

        return questions;
    }

    async function sendSingleAiRequest(apiKey, provider, model, questions) {
        const endpoint = getEndpointForProvider(provider);
        const modelToUse = model || getDefaultModelForProvider(provider);

        let questionPromptText = questions.map((q, idx) => {
            let out = `Q${idx + 1} (${q.type === 'radio' ? 'Single Choice Radio' : q.type === 'checkbox' ? 'Multiple Choice Checkboxes (select all that apply)' : `Text/Numeric input with ${q.blankCount} blank(s)`}):\n${q.prompt}\n`;
            if (q.options && q.options.length > 0) {
                out += `Options:\n` + q.options.map(o => `  ${o.index}. ${o.text}`).join('\n') + '\n';
            }
            return out;
        }).join('\n-------------------\n\n');

        const systemPrompt = `You are an expert assessment solver.
Solve every question accurately based on standard educational material.
You MUST output ONLY a valid JSON object matching this schema:
{
  "answers": [
    {
      "q": 1,
      "type": "radio",
      "choice": 2
    },
    {
      "q": 2,
      "type": "checkbox",
      "choices": [1, 3]
    },
    {
      "q": 3,
      "type": "text",
      "values": ["exact text or numeric answer"]
    }
  ]
}
Strict Rules:
- For "radio", provide 1-based index in "choice".
- For "checkbox", provide array of 1-based indices in "choices".
- For "text", provide array of string values in "values" for each blank in order.
- Output ONLY the JSON object. Do not wrap in markdown or backticks.`;

        const payload = {
            model: modelToUse,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: questionPromptText }
            ],
            temperature: 0.1,
            response_format: { type: 'json_object' }
        };

        return new Promise((resolve, reject) => {
            const handleSuccess = (resText) => {
                try {
                    const data = JSON.parse(resText);
                    const parsed = JSON.parse(data.choices[0].message.content);
                    resolve(parsed);
                } catch (e) {
                    reject(new Error('Failed to parse AI JSON response'));
                }
            };

            if (typeof GM_xmlhttpRequest !== 'undefined') {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: endpoint,
                    headers: { 'Authorization': `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
                    data: JSON.stringify(payload),
                    onload: (res) => res.status >= 200 && res.status < 300 ? handleSuccess(res.responseText) : reject(new Error(`HTTP ${res.status}`)),
                    onerror: reject
                });
            } else {
                fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }).then(r => r.text()).then(handleSuccess).catch(reject);
            }
        });
    }

    async function executeAiSolver() {
        if (isSolverRunning) return;

        const keyList = parseApiKeys(rawAiKeys);
        if (keyList.length === 0) {
            const key = prompt('Enter your Groq (gsk_...) or NVIDIA (nvapi-...) API Key:');
            if (key) {
                rawAiKeys = key.trim();
                localStorage.setItem('coursera_ai_keys', rawAiKeys);
                localStorage.setItem('coursera_groq_api_key', rawAiKeys);
            } else return;
        }

        isSolverRunning = true;

        try {
            const questions = extractQuestionsFromDOM();
            if (questions.length === 0) return;

            const currentKeys = parseApiKeys(rawAiKeys);
            let result = null;
            let lastErr = null;

            for (let i = 0; i < currentKeys.length; i++) {
                const currentKey = currentKeys[i];
                const provider = detectProviderForKey(currentKey);
                const modelToUse = selectedModel;

                try {
                    result = await sendSingleAiRequest(currentKey, provider, modelToUse, questions);
                    break;
                } catch (err) {
                    lastErr = err;
                    console.warn(`[Autopilot Pro AI] Key ${i + 1} (${provider}) failed:`, err);
                    if (i < currentKeys.length - 1) await sleep(1000);
                }
            }

            if (!result) throw new Error(`All keys failed: ${lastErr ? lastErr.message : 'Unknown'}`);

            const answers = result && result.answers ? result.answers : [];
            if (answers.length === 0) return;

            answers.forEach(ans => {
                const qIdx = ans.q - 1;
                if (qIdx < 0 || qIdx >= questions.length) return;
                const q = questions[qIdx];

                if (q.type === 'radio' && typeof ans.choice === 'number') {
                    const optIdx = ans.choice - 1;
                    if (optIdx >= 0 && optIdx < q.options.length) {
                        q.options[optIdx].element.click();
                    }
                } else if (q.type === 'checkbox' && Array.isArray(ans.choices)) {
                    ans.choices.forEach(ch => {
                        const optIdx = ch - 1;
                        if (optIdx >= 0 && optIdx < q.options.length) {
                            setNativeChecked(q.options[optIdx].element, true);
                        }
                    });
                } else if (q.type === 'text') {
                    const values = Array.isArray(ans.values) ? ans.values : [String(ans.values || '')];
                    q.elements.forEach((el, idx) => {
                        if (idx < values.length) setNativeValue(el, values[idx]);
                    });
                }
            });

            checkAgreementCheckbox();
            await sleep(500);

            if (autoSubmitQuiz) {
                const submitBtn = findBtnPartial(['submit assignment', 'submit quiz', 'submit']);
                if (submitBtn) {
                    submitBtn.click();
                    for (let j = 0; j < 15; j++) {
                        const confirmBtn = findBtnPartial(['yes', 'confirm', 'submit anyway']);
                        if (confirmBtn) { confirmBtn.click(); break; }
                        await sleep(150);
                    }

                    for (let w = 0; w < 40; w++) {
                        await sleep(300);
                        const nextBtn = findNextItem();
                        if (nextBtn) {
                            nextBtn.click();
                            break;
                        }
                    }
                }
            }
        } catch (err) {
            console.error('[Autopilot Pro AI Solve]', err);
        } finally {
            isSolverRunning = false;
        }
    }

    async function doIt(isAuto) {
        if (isRunning || isSolverRunning) return;
        if (isAuto && waitingForLab) return;
        if (isAuto && doneUrls.has(location.href)) return;
        if (isAuto && isAssignmentPage()) return;

        if (isItemAlreadyCompleted() && isAssignmentPage()) {
            const next = findNextItem();
            if (next) {
                next.click();
                doneUrls.add(location.href);
                navTimestamp = Date.now();
            }
            return;
        }

        isRunning = true;
        runStartTime = Date.now();
        const url = location.href;
        const pageType = getPageType();

        try {
            if (pageType === 'video' || document.querySelector('video') !== null) {
                await handleVideo();
            } else if (pageType === 'lab' || findBtnPartial(['launch app', 'launch lab'])) {
                await handleLab();
            } else if (pageType === 'discussion' || pageType === 'dialogue' || findBtnPartial(['start dialogue', 'start discussion'])) {
                await handleDialogue();
            }

            let mark = findMarkComplete();
            if (mark) {
                mark.click();
                await sleep(800);
            }

            const next = findNextItem();
            if (next) {
                next.click();
                doneUrls.add(url);
                navTimestamp = Date.now();
            }
        } finally {
            if (doneUrls.size > 200) doneUrls = new Set([...doneUrls].slice(-50));
            await sleep(AFTER_NAV_WAIT);
            isRunning = false;
        }
    }

    function startScan() {
        stopScan();
        scanTimer = setInterval(() => {
            if (isRunning || isSolverRunning) {
                if (Date.now() - runStartTime > 15000 && !isSolverRunning) isRunning = false;
                else return;
            }
            if (doneUrls.has(location.href)) return;
            if (Date.now() - navTimestamp < AFTER_NAV_WAIT) return;

            const onAssignment = isAssignmentPage();
            if (onAssignment) {
                const isGraded = isItemAlreadyCompleted();
                const nextBtn = findNextItem();
                if (isGraded && nextBtn) {
                    doneUrls.add(location.href);
                    navTimestamp = Date.now();
                    nextBtn.click();
                    return;
                }
                return;
            }

            if (!autoEnabled) return;

            if (isItemAlreadyCompleted() || document.querySelector('video') !== null || findBtnPartial(['launch app', 'launch lab', 'start lab']) || findMarkComplete() || findNextItem()) {
                doIt(true);
            }
        }, SCAN_INTERVAL);
    }

    function stopScan() {
        if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    }

    function createUi() {
        if (uiReady && document.getElementById('tm-dock-host')) return;
        const old = document.getElementById('tm-dock-host');
        if (old) old.remove();

        const host = document.createElement('div');
        host.id = 'tm-dock-host';
        Object.assign(host.style, {
            position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
            zIndex: '2147483640', pointerEvents: 'auto'
        });

        const shadow = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = `
            * { box-sizing: border-box; margin: 0; padding: 0; }
            .dock {
                background: rgba(15, 23, 42, 0.9);
                backdrop-filter: blur(12px);
                border: 1px solid rgba(51, 65, 85, 0.8);
                border-radius: 9999px;
                padding: 6px 10px;
                display: flex;
                align-items: center;
                gap: 8px;
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
                user-select: none;
            }
            .btn {
                width: 36px;
                height: 36px;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                border: none;
                cursor: pointer;
                transition: transform 0.15s ease, background 0.15s ease;
                color: #f8fafc;
                background: #1e293b;
            }
            .btn:hover { transform: scale(1.08); background: #334155; }
            .btn:active { transform: scale(0.95); }
            .btn-auto-on { background: #059669 !important; color: #fff !important; }
            .btn-auto-off { background: #475569 !important; color: #94a3b8 !important; }
            .btn-ai { background: #6366f1; }
            .btn-ai:hover { background: #4f46e5; }
            svg {
                width: 17px;
                height: 17px;
                stroke: currentColor;
                stroke-width: 2;
                stroke-linecap: round;
                stroke-linejoin: round;
                fill: none;
            }
        `;
        shadow.appendChild(style);

        const dock = document.createElement('div');
        dock.className = 'dock';

        const autoBtn = document.createElement('button');
        autoBtn.className = `btn ${autoEnabled ? 'btn-auto-on' : 'btn-auto-off'}`;
        autoBtn.title = autoEnabled ? 'Autopilot: Active' : 'Autopilot: Inactive';
        autoBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>`;
        autoBtn.onclick = (e) => {
            e.preventDefault();
            autoEnabled = !autoEnabled;
            localStorage.setItem('tm_auto', autoEnabled ? 'true' : 'false');
            autoBtn.className = `btn ${autoEnabled ? 'btn-auto-on' : 'btn-auto-off'}`;
            autoBtn.title = autoEnabled ? 'Autopilot: Active' : 'Autopilot: Inactive';
            if (autoEnabled) startScan(); else stopScan();
        };

        const doBtn = document.createElement('button');
        doBtn.className = 'btn';
        doBtn.title = 'Skip Current Item';
        doBtn.innerHTML = `<svg viewBox="0 0 24 24"><polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19"></line></svg>`;
        doBtn.onclick = (e) => { e.preventDefault(); doIt(false); };

        const solveBtn = document.createElement('button');
        solveBtn.className = 'btn btn-ai';
        solveBtn.title = 'AI Solve Quiz';
        solveBtn.innerHTML = `<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"></rect><rect x="9" y="9" width="6" height="6"></rect><line x1="9" y1="1" x2="9" y2="4"></line><line x1="15" y1="1" x2="15" y2="4"></line><line x1="9" y1="20" x2="9" y2="23"></line><line x1="15" y1="20" x2="15" y2="23"></line><line x1="20" y1="9" x2="23" y2="9"></line><line x1="20" y1="14" x2="23" y2="14"></line><line x1="1" y1="9" x2="4" y2="9"></line><line x1="1" y1="14" x2="4" y2="14"></line></svg>`;
        solveBtn.onclick = (e) => { e.preventDefault(); executeAiSolver(); };

        const keysBtn = document.createElement('button');
        keysBtn.className = 'btn';
        keysBtn.title = 'Set API Keys';
        keysBtn.innerHTML = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;
        keysBtn.onclick = () => {
            const key = prompt('Enter your Groq (gsk_...) or NVIDIA (nvapi-...) API key(s):', rawAiKeys);
            if (key !== null) {
                rawAiKeys = key.trim();
                localStorage.setItem('coursera_ai_keys', rawAiKeys);
                localStorage.setItem('coursera_groq_api_key', rawAiKeys);
            }
        };

        dock.appendChild(autoBtn);
        dock.appendChild(doBtn);
        dock.appendChild(solveBtn);
        dock.appendChild(keysBtn);
        shadow.appendChild(dock);
        document.body.appendChild(host);
        uiReady = true;
    }

    setInterval(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            navTimestamp = Date.now();
            isRunning = false;
            doneUrls.delete(location.href);
        }
    }, 500);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { createUi(); if (autoEnabled) startScan(); });
    } else {
        createUi();
        if (autoEnabled) startScan();
    }
})();
