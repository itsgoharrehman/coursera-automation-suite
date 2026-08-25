// ==UserScript==
// @name         Auto Skip Pro
// @namespace    http://tampermonkey.net/
// @version      2.3
// @description  Automates video fast-forward, reading completion, universal multi-type labs (side-by-side Guided Projects & launch-and-go LTI tools), green-checked instant skipping, and Multi-AI quiz solving (Groq & NVIDIA NIM with multi-key rotation and live models).
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

    // =============================================
    // STATE & CONFIGURATION
    // =============================================

    let isRunning = false;
    let isAiSolving = false;
    let autoEnabled = localStorage.getItem('coursera_auto_skip') !== 'false';
    let rawAiKeys = localStorage.getItem('coursera_ai_keys') || localStorage.getItem('coursera_groq_api_key') || '';
    let selectedProvider = localStorage.getItem('coursera_ai_provider') || 'auto';
    let selectedModel = localStorage.getItem('coursera_ai_model') || 'openai/gpt-oss-120b';
    let autoSubmitQuiz = localStorage.getItem('coursera_auto_submit_quiz') === 'true';

    let lastUrl = location.href;
    let currentProcessingUrl = '';
    let waitingForLabCompletion = false;
    const SECONDS_FROM_END = 3;
    const BC_CHANNEL = 'coursera_auto_skip_channel';

    const MODEL_CATALOG = {
        groq: [
            { id: 'openai/gpt-oss-120b', name: 'OpenAI GPT-OSS 120B (High Reasoning & JSON)' },
            { id: 'openai/gpt-oss-20b', name: 'OpenAI GPT-OSS 20B (Fast Reasoning)' },
            { id: 'qwen/qwen3.6-27b', name: 'Qwen 3.6 27B (High Accuracy)' },
            { id: 'meta-llama/llama-4-maverick-17b-128e-instruct', name: 'Meta Llama 4 Maverick 17B' },
            { id: 'meta-llama/llama-4-scout-17b-16e-instruct', name: 'Meta Llama 4 Scout 17B' },
            { id: 'moonshotai/kimi-k2-instruct-0905', name: 'Moonshot Kimi K2 Instruct' },
            { id: 'groq/groq/compound', name: 'Groq Compound System' }
        ],
        nvidia: [
            { id: 'meta/llama-3.3-70b-instruct', name: 'NVIDIA: Llama 3.3 70B Instruct (Top Recommended)' },
            { id: 'deepseek-ai/deepseek-r1', name: 'NVIDIA: DeepSeek R1 (Flagship Reasoning)' },
            { id: 'deepseek-ai/deepseek-v4-pro', name: 'NVIDIA: DeepSeek V4 Pro' },
            { id: 'deepseek-ai/deepseek-v4-flash', name: 'NVIDIA: DeepSeek V4 Flash' },
            { id: 'meta/llama-3.1-70b-instruct', name: 'NVIDIA: Llama 3.1 70B Instruct' },
            { id: 'meta/llama-3.1-8b-instruct', name: 'NVIDIA: Llama 3.1 8B Instruct (Ultra Fast)' },
            { id: 'mistralai/mistral-large-2-instruct', name: 'NVIDIA: Mistral Large 2 (123B)' }
        ]
    };

    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

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
        if (provider === 'nvidia') {
            return 'https://integrate.api.nvidia.com/v1/chat/completions';
        }
        return 'https://api.groq.com/openai/v1/chat/completions';
    }

    function getDefaultModelForProvider(provider) {
        if (provider === 'nvidia') {
            return 'meta/llama-3.3-70b-instruct';
        }
        return 'openai/gpt-oss-120b';
    }

    async function fetchLiveModels(apiKey, provider) {
        const prov = provider === 'auto' ? detectProviderForKey(apiKey) : provider;
        const endpoint = prov === 'nvidia'
            ? 'https://integrate.api.nvidia.com/v1/models'
            : 'https://api.groq.com/openai/v1/models';

        return new Promise((resolve, reject) => {
            const handleSuccess = (resText) => {
                try {
                    const data = JSON.parse(resText);
                    const models = (data.data || []).map(m => m.id).filter(Boolean).sort();
                    resolve(models);
                } catch (e) {
                    reject(new Error('Failed to parse models: ' + e.message));
                }
            };

            if (typeof GM_xmlhttpRequest !== 'undefined') {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: endpoint,
                    headers: { 'Authorization': `Bearer ${apiKey.trim()}` },
                    onload: (res) => {
                        if (res.status >= 200 && res.status < 300) {
                            handleSuccess(res.responseText);
                        } else {
                            reject(new Error(`HTTP ${res.status}: ${res.responseText}`));
                        }
                    },
                    onerror: reject
                });
            } else {
                fetch(endpoint, {
                    method: 'GET',
                    headers: { 'Authorization': `Bearer ${apiKey.trim()}` }
                })
                    .then(r => {
                        if (!r.ok) return r.text().then(t => { throw new Error(`HTTP ${r.status}: ${t}`); });
                        return r.text();
                    })
                    .then(handleSuccess)
                    .catch(reject);
            }
        });
    }

    // =============================================
    // TOAST NOTIFICATIONS
    // =============================================

    function createToast(msg, duration = 3000) {
        let t = document.getElementById('tm-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'tm-toast';
            Object.assign(t.style, {
                position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)',
                background: '#0f172a', color: '#f8fafc', padding: '9px 18px', borderRadius: '8px',
                zIndex: '2147483647', fontSize: '13px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                fontWeight: '600', letterSpacing: '0.2px',
                boxShadow: '0 10px 25px rgba(0,0,0,0.5)', transition: 'opacity 0.25s ease, transform 0.25s ease',
                border: '1px solid #334155', pointerEvents: 'none', opacity: '0'
            });
            document.body.appendChild(t);
        }
        t.textContent = msg;
        t.style.opacity = '1';
        t.style.transform = 'translateX(-50%) translateY(0)';
        clearTimeout(t.timer);
        t.timer = setTimeout(() => {
            t.style.opacity = '0';
            t.style.transform = 'translateX(-50%) translateY(-6px)';
        }, duration);
    }

    function isVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function smartClick(el) {
        if (!el) return;
        try {
            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        } catch (e) { }
        try {
            el.click();
        } catch (e) {
            try {
                const rect = el.getBoundingClientRect();
                const clientX = rect.left + rect.width / 2;
                const clientY = rect.top + rect.height / 2;
                const opts = { bubbles: true, cancelable: true, view: window, clientX, clientY };
                el.dispatchEvent(new MouseEvent('mousedown', opts));
                el.dispatchEvent(new MouseEvent('mouseup', opts));
                el.dispatchEvent(new MouseEvent('click', opts));
            } catch (err) { }
        }
    }

    function setNativeValue(el, value) {
        try {
            const isTextArea = el.tagName === 'TEXTAREA';
            const proto = isTextArea ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
            if (descriptor && descriptor.set) {
                descriptor.set.call(el, value);
            } else {
                el.value = value;
            }
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
            if (descriptor && descriptor.set) {
                descriptor.set.call(cb, checked);
            } else {
                cb.checked = checked;
            }
            cb.dispatchEvent(new Event('click', { bubbles: true }));
            cb.dispatchEvent(new Event('change', { bubbles: true }));
            cb.dispatchEvent(new Event('input', { bubbles: true }));
        } catch (e) {
            smartClick(cb);
        }
    }

    // =============================================
    // CROSS-TAB LAB COORDINATION
    // =============================================

    let broadcastChannel = null;
    try {
        if (typeof BroadcastChannel !== 'undefined') {
            broadcastChannel = new BroadcastChannel(BC_CHANNEL);
            broadcastChannel.onmessage = (ev) => {
                if (ev.data && ev.data.type === 'LAB_COMPLETED') {
                    handleLabCompletedSignal(ev.data);
                }
            };
        }
    } catch (e) { }

    window.addEventListener('storage', (e) => {
        if (e.key === 'coursera_lab_completed_signal') {
            try {
                const data = JSON.parse(e.newValue);
                handleLabCompletedSignal(data);
            } catch (err) { }
        }
    });

    function sendLabCompletedSignal() {
        const payload = { type: 'LAB_COMPLETED', url: location.href, time: Date.now() };
        try {
            localStorage.setItem('coursera_lab_completed_signal', JSON.stringify(payload));
            if (broadcastChannel) {
                broadcastChannel.postMessage(payload);
            }
        } catch (e) { }
    }

    async function handleLabCompletedSignal(data) {
        if (!waitingForLabCompletion) return;
        waitingForLabCompletion = false;
        createToast('Lab finished in workspace. Next item...');
        await sleep(1500);
        const nextBtn = await waitForNextButton(5000);
        if (nextBtn) smartClick(nextBtn);
    }

    function isSeparateLabTab() {
        if (window.opener !== null && window.opener !== window) return true;
        const host = location.hostname.toLowerCase();
        if (host.includes('qwiklabs.com') || host.includes('rhyme.com') || host.includes('vocareum.com') || host.includes('coursera-apps.org')) {
            return true;
        }
        if (location.pathname.toLowerCase().includes('/learn/')) {
            return false;
        }
        return false;
    }

    function closeLabTab(reason = 'Lab complete. Closing tab...') {
        createToast(reason);
        sendLabCompletedSignal();
        setTimeout(() => {
            try { window.close(); } catch (e) { }
            setTimeout(() => {
                try { window.open('', '_self', ''); window.close(); } catch (e) { }
            }, 500);
        }, 1200);
    }

    // =============================================
    // BUTTON FINDERS & DETECTION
    // =============================================

    function findNextButton() {
        const testSelectors = [
            '[data-test="next-item-button"]',
            '[data-testid="next-item-button"]',
            '[data-testid="next-button"]',
            '.rc-ItemNavigation button:last-child',
            'button[aria-label="Go to next item"]',
            'button[aria-label="Next item"]',
            'button[aria-label="Next Item"]',
            'button[aria-label="Go to next"]',
            'a[aria-label="Go to next item"]',
            'a[aria-label="Next item"]'
        ];

        for (const sel of testSelectors) {
            const el = document.querySelector(sel);
            if (el && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && isVisible(el) && !el.closest('#cas-widget-host, #tm-toast, #cas-settings-host')) {
                const text = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
                if (!text.includes('module') && !text.includes('week') && !text.includes('course') && !text.includes('lesson')) {
                    return el;
                }
            }
        }

        const candidates = document.querySelectorAll('button, [role="button"], a');
        for (const b of candidates) {
            if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
            if (b.closest('#cas-widget-host, #tm-toast, #cas-settings-host, header.rc-GlobalHeader, nav.rc-CourseNavigation, nav[role="navigation"]')) continue;
            if (!isVisible(b)) continue;

            const text = (b.textContent || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();

            if (
                text.includes('module') || text.includes('week') || text.includes('course') ||
                text.includes('lesson') || text.includes('previous') || text.includes('back') ||
                text.includes('cancel') || text.includes('submit') || text.includes('review') ||
                text.includes('feedback') || text.includes('discuss') || text.includes('search') ||
                text.includes('fill') || text.includes('solve')
            ) {
                continue;
            }

            if (text === 'go to next item' || text === 'next item' || text === 'next' || text.startsWith('go to next item') || text.startsWith('next item')) {
                return b;
            }
        }

        return null;
    }

    async function waitForNextButton(maxMs = 5000) {
        const start = Date.now();
        while (Date.now() - start < maxMs) {
            const btn = findNextButton();
            if (btn) return btn;
            await sleep(400);
        }
        return null;
    }

    function checkAgreementCheckbox() {
        const checkboxes = document.querySelectorAll('input[type="checkbox"]:not(:checked)');
        for (const cb of checkboxes) {
            if (cb.disabled) continue;
            const parent = cb.closest('label') || cb.parentElement || document.body;
            const text = (parent ? parent.textContent : '').toLowerCase();
            if (text.includes('agree') || text.includes('honor') || text.includes('responsib') || text.includes('accept') || text.includes('understand') || text.includes('own work') || text.includes('responsibly')) {
                setNativeChecked(cb, true);
                if (parent && !cb.checked) smartClick(parent);
                return true;
            }
        }
        return false;
    }

    function findLaunchButton() {
        const candidates = document.querySelectorAll('button, [role="button"], a, div[role="button"], span[role="button"]');
        for (const b of candidates) {
            if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
            if (b.closest('#cas-widget-host, #tm-toast, #cas-settings-host, header.rc-GlobalHeader, nav.rc-CourseNavigation, nav[role="navigation"]')) continue;
            if (!isVisible(b)) continue;

            const text = (b.textContent || b.getAttribute('aria-label') || b.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const testId = (b.getAttribute('data-test') || b.getAttribute('data-testid') || '').toLowerCase();

            if (text.includes('next item') || text.includes('previous') || text.includes('submit') || text.includes('module')) continue;

            if (
                text === 'launch lab' || text === 'launch app' || text === 'start lab' ||
                text === 'open lab' || text === 'open tool' || text === 'open workspace' ||
                text === 'launch workspace' || text === 'launch' ||
                text.includes('launch lab') || text.includes('launch app') || text.includes('start lab') ||
                text.includes('open lab') || text.includes('open workspace') || text.includes('launch workspace') ||
                testId.includes('launch-lab') || testId.includes('launch-app') || testId.includes('open-workspace')
            ) {
                return b;
            }
        }
        return null;
    }

    function findSideBySideButton() {
        const candidates = document.querySelectorAll('button, [role="button"], a, div[role="button"]');
        for (const b of candidates) {
            if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
            if (b.closest('#cas-widget-host, #tm-toast, #cas-settings-host, nav.rc-CourseNavigation')) continue;
            if (!isVisible(b)) continue;

            const text = (b.textContent || b.getAttribute('aria-label') || b.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const testId = (b.getAttribute('data-test') || b.getAttribute('data-testid') || '').toLowerCase();

            if (
                text === 'learn side-by-side' || text === 'learn side by side' ||
                text.includes('learn side by side') || text.includes('learn side-by-side') ||
                text === 'side by side' || text === 'side-by-side' ||
                text === 'side-by-side learning' || text === 'side by side learning' ||
                text.includes('split view') || text.includes('launch in split view') ||
                testId.includes('side-by-side') || testId.includes('sidebyside') ||
                testId.includes('split-view')
            ) {
                return b;
            }
        }
        return null;
    }

    function findOpenWorkspaceButton() {
        if (!document.body || !document.body.textContent.includes('Choose how you want to learn')) return null;
        const candidates = document.querySelectorAll('button, [role="button"], a');
        for (const b of candidates) {
            if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
            if (b.closest('#cas-widget-host, #tm-toast, #cas-settings-host, header, nav')) continue;
            if (!isVisible(b)) continue;

            const text = (b.textContent || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (text === 'open' || text.startsWith('open ') || text.includes('open workspace')) {
                return b;
            }
        }
        return null;
    }

    function findActiveMarkCompleteButton() {
        const candidates = document.querySelectorAll('button, [role="button"], a, div[role="button"]');
        for (const b of candidates) {
            if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
            if (b.closest('#cas-widget-host, #tm-toast, #cas-settings-host, header, nav.rc-CourseNavigation')) continue;
            if (!isVisible(b)) continue;

            const text = (b.textContent || b.getAttribute('aria-label') || b.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const testId = (b.getAttribute('data-test') || b.getAttribute('data-testid') || '').toLowerCase();

            if (
                text === 'completed' || text === 'marked as completed' || text === 'marked complete' ||
                text.startsWith('completed') || text.includes('✓') || text === 'submitted' || text === 'done'
            ) {
                continue;
            }

            if (
                text === 'mark as completed' || text === 'mark as complete' ||
                text === 'mark completed' || text === 'mark complete' ||
                text === 'complete step' || text === 'mark step as completed' ||
                text === 'i\'m done' || text === 'finish step' || text === 'finish lab' ||
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
            const container = markBtn.closest('div[class*="footer"], div[class*="Footer"], div[class*="action"], div[class*="Action"], div[class*="bottom"], div[class*="Bottom"]') || markBtn.parentElement;
            if (container) {
                const btns = Array.from(container.querySelectorAll('button, [role="button"]')).filter(b => b !== markBtn && isVisible(b));
                if (btns.length >= 2) {
                    const nextBtn = btns[btns.length - 1];
                    if (!nextBtn.disabled && nextBtn.getAttribute('aria-disabled') !== 'true') {
                        return nextBtn;
                    }
                } else if (btns.length === 1) {
                    const b = btns[0];
                    const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                    if (!aria.includes('prev') && !b.disabled && b.getAttribute('aria-disabled') !== 'true') {
                        return b;
                    }
                }
            }
        }

        const candidates = document.querySelectorAll('button, [role="button"]');
        for (const b of candidates) {
            if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
            if (b.closest('#cas-widget-host, #tm-toast, #cas-settings-host, nav.rc-CourseNavigation, .rc-ItemNavigation')) continue;
            if (!isVisible(b)) continue;

            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            const testId = (b.getAttribute('data-test') || b.getAttribute('data-testid') || '').toLowerCase();
            const text = (b.textContent || '').trim().toLowerCase();

            if (aria.includes('previous') || aria.includes('back') || aria.includes('close') || aria.includes('copy') || aria.includes('menu')) {
                continue;
            }

            if (
                aria === 'next step' || aria.includes('next step') ||
                aria === 'next instruction' || aria.includes('next instruction') ||
                testId === 'next-step' || testId.includes('next-step') || testId === 'step-next' ||
                testId.includes('next-instruction') ||
                text === 'next step' || text === 'next instruction' || text === '→'
            ) {
                return b;
            }
        }
        return null;
    }

    // =============================================
    // ALREADY COMPLETED (GREEN-CHECKED) DETECTION
    // =============================================

    function isItemAlreadyCompleted() {
        const url = location.href.toLowerCase();
        if (url.includes('/attempt') && !url.includes('/view-feedback')) {
            return false;
        }

        // 1. If there is an active actionable button on the page, it is NOT completed
        if (findActiveMarkCompleteButton() !== null) return false;
        if (findLaunchButton() !== null) return false;
        if (findSideBySideButton() !== null) return false;

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
            if (b.closest('#cas-widget-host, #tm-toast, #cas-settings-host')) continue;
            const t = (b.textContent || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (t === 'completed' || t === 'marked as completed' || t === 'marked complete' || t === 'completed ✓') {
                if (isVisible(b)) return true;
            }
        }

        return false;
    }

    // =============================================
    // LAB HANDLER
    // =============================================

    async function handleLabSteps() {
        createToast('Processing lab instructions...');
        let stepCount = 0;
        const maxSteps = 25;

        for (let step = 1; step <= maxSteps; step++) {
            let markBtn = findActiveMarkCompleteButton();
            if (markBtn) {
                stepCount++;
                createToast(`Marking step ${stepCount} complete...`);
                smartClick(markBtn);
                await sleep(1500);
            }

            let nextArrow = findNextInstructionArrow(markBtn);
            if (nextArrow && !nextArrow.disabled && nextArrow.getAttribute('aria-disabled') !== 'true') {
                smartClick(nextArrow);
                await sleep(2000);
            } else {
                await sleep(1000);
                let retryMark = findActiveMarkCompleteButton();
                if (retryMark) {
                    stepCount++;
                    createToast(`Marking step ${stepCount} complete...`);
                    smartClick(retryMark);
                    await sleep(1500);
                }

                let retryArrow = findNextInstructionArrow(retryMark);
                if (retryArrow && !retryArrow.disabled && retryArrow.getAttribute('aria-disabled') !== 'true') {
                    smartClick(retryArrow);
                    await sleep(2000);
                    continue;
                }

                break;
            }
        }

        createToast(`Lab finished (${stepCount} steps).`);
        await sleep(1200);
        return stepCount;
    }

    async function waitForVideo(maxMs) {
        const start = Date.now();
        while (Date.now() - start < maxMs) {
            const video = document.querySelector('video');
            if (video && video.readyState >= 1 && video.duration > 0) {
                return video;
            }
            await sleep(400);
        }
        return null;
    }

    // =============================================
    // DIALOGUE & COACH AUTOMATION
    // =============================================

    function findDialogueStart() {
        const candidates = document.querySelectorAll('button, [role="button"], a, div[role="button"], span[role="button"]');
        for (const b of candidates) {
            if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
            if (b.closest('#cas-widget-host, #tm-toast, #cas-settings-host, nav.rc-CourseNavigation')) continue;
            if (!isVisible(b)) continue;

            const text = (b.textContent || b.getAttribute('aria-label') || b.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const testId = (b.getAttribute('data-test') || b.getAttribute('data-testid') || '').toLowerCase();

            if (
                text === 'start dialogue' || text === 'start conversation' || text === 'begin dialogue' ||
                text === 'start discussion' || text.includes('start dialogue') || text.includes('start conversation') ||
                text.includes('begin dialogue') ||
                testId.includes('start-dialogue') || testId.includes('start-discussion')
            ) {
                return b;
            }
        }
        return null;
    }

    function findDialogueInput() {
        const candidates = document.querySelectorAll('textarea, input[type="text"], input:not([type]), [contenteditable="true"], [role="textbox"], div[data-placeholder], div[class*="Input"], div[class*="composer"]');
        for (const el of candidates) {
            if (el.disabled || el.readOnly || el.closest('#cas-widget-host, #tm-toast, #cas-settings-host, header.rc-GlobalHeader, nav.rc-CourseNavigation, nav[role="navigation"]')) continue;
            if (!isVisible(el)) continue;

            const ph = (el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || '').toLowerCase();
            const tag = el.tagName.toLowerCase();
            if (ph.includes('message') || ph.includes('ask') || ph.includes('type') || ph.includes('chat') || ph.includes('dialogue') || ph.includes('response') || ph.includes('say') || tag === 'textarea' || el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox') {
                return el;
            }
        }

        const textareas = document.querySelectorAll('main textarea, [role="main"] textarea, textarea');
        for (const el of textareas) {
            if (el.disabled || el.readOnly || el.closest('#cas-widget-host, #tm-toast, #cas-settings-host, header, nav')) continue;
            if (isVisible(el)) return el;
        }

        return null;
    }

    function findDialogueSendButton(inputEl) {
        if (inputEl) {
            const container = inputEl.closest('form, div[class*="input"], div[class*="chat"], div[class*="footer"], div[class*="prompt"], div[class*="composer"], div[class*="bar"], div[class*="box"]') || inputEl.parentElement?.parentElement;
            if (container) {
                const btns = container.querySelectorAll('button, [role="button"]');
                for (const b of btns) {
                    if (b.disabled || b.getAttribute('aria-disabled') === 'true' || !isVisible(b)) continue;
                    const text = (b.textContent || b.getAttribute('aria-label') || b.title || '').toLowerCase();
                    const testId = (b.getAttribute('data-test') || b.getAttribute('data-testid') || '').toLowerCase();
                    if (!text.includes('voice') && !text.includes('mic') && !text.includes('record') && !text.includes('attach') && !text.includes('stuck')) {
                        if (text.includes('send') || text.includes('submit') || testId.includes('send') || testId.includes('submit') || b.querySelector('svg')) {
                            return b;
                        }
                    }
                }
            }
        }

        const candidates = document.querySelectorAll('button, [role="button"]');
        for (const b of candidates) {
            if (b.disabled || b.getAttribute('aria-disabled') === 'true' || b.closest('#cas-widget-host, #tm-toast, #cas-settings-host, header, nav')) continue;
            if (!isVisible(b)) continue;
            const text = (b.textContent || b.getAttribute('aria-label') || b.title || '').trim().toLowerCase();
            const testId = (b.getAttribute('data-test') || b.getAttribute('data-testid') || '').toLowerCase();
            if (
                text === 'send' || text === 'send message' || text.includes('send message') ||
                testId.includes('send-message') || testId.includes('send-button')
            ) {
                return b;
            }
        }
        return null;
    }

    function findDialogueEnd() {
        const candidates = document.querySelectorAll('button, [role="button"], a, div[role="button"]');
        for (const b of candidates) {
            if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
            if (b.closest('#cas-widget-host, #tm-toast, #cas-settings-host, nav.rc-CourseNavigation')) continue;
            if (!isVisible(b)) continue;

            const text = (b.textContent || b.getAttribute('aria-label') || b.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const testId = (b.getAttribute('data-test') || b.getAttribute('data-testid') || '').toLowerCase();

            if (
                text === 'end dialogue' || text === 'end conversation' || text === 'finish dialogue' ||
                text === 'close dialogue' || text === 'exit dialogue' || text === 'stop dialogue' ||
                text.includes('end dialogue') || text.includes('end conversation') || text.includes('finish dialogue') ||
                testId.includes('end-dialogue') || testId.includes('end-conversation')
            ) {
                return b;
            }
        }
        return null;
    }

    function findDialogueConfirmEnd() {
        const modal = document.querySelector('[role="dialog"], [class*="Modal"], [class*="modal"], [class*="Overlay"], [class*="overlay"], .cds-Modal, [data-test="modal"]');
        if (modal) {
            const btns = modal.querySelectorAll('button, [role="button"], a');
            for (const b of btns) {
                if (b.disabled || b.getAttribute('aria-disabled') === 'true' || !isVisible(b)) continue;
                const text = (b.textContent || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
                if (text.includes('cancel') || text.includes('close') || text.includes('stay') || text.includes('dismiss')) continue;
                if (text.includes('yes') || text.includes('end') || text.includes('confirm') || text.includes('finish') || text.includes('leave')) {
                    return b;
                }
            }
        }

        const candidates = document.querySelectorAll('button, [role="button"], a');
        for (const b of candidates) {
            if (b.disabled || b.getAttribute('aria-disabled') === 'true' || b.closest('#cas-widget-host, #tm-toast, #cas-settings-host')) continue;
            if (!isVisible(b)) continue;
            const text = (b.textContent || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (
                text === 'yes, end the dialogue' || text === 'yes, end dialogue' ||
                text.includes('yes, end the dialogue') || text.includes('yes, end dialogue') ||
                text.includes('yes, end') || text.includes('yes end')
            ) {
                return b;
            }
        }
        return null;
    }

    async function handleDialogue() {
        createToast('Dialogue detected...');

        let startBtn = null;
        for (let i = 0; i < 12; i++) {
            startBtn = findDialogueStart();
            if (startBtn) break;
            if (findDialogueInput() || findDialogueEnd()) break;
            await sleep(400);
        }

        if (startBtn) {
            smartClick(startBtn);
            await sleep(3000);
        }

        let inputEl = null;
        for (let i = 0; i < 15; i++) {
            inputEl = findDialogueInput();
            if (inputEl) break;
            if (findDialogueEnd()) break;
            await sleep(400);
        }

        if (inputEl) {
            try {
                inputEl.focus();
                const msg = "I understand the lesson thoroughly, thank you!";
                if (inputEl.isContentEditable || inputEl.getAttribute('contenteditable') === 'true') {
                    inputEl.focus();
                    try { document.execCommand('selectAll', false, null); } catch (e) { }
                    try { document.execCommand('insertText', false, msg); } catch (e) { }
                    inputEl.textContent = msg;
                    inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: msg }));
                    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
                } else {
                    setNativeValue(inputEl, msg);
                }
                await sleep(800);

                const sendBtn = findDialogueSendButton(inputEl);
                if (sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true') {
                    smartClick(sendBtn);
                } else {
                    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
                    inputEl.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
                    inputEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
                }
                await sleep(2500);
            } catch (e) {
                console.error('[Auto Skip Pro] Error in dialogue:', e);
            }
        }

        let endBtn = null;
        for (let i = 0; i < 15; i++) {
            endBtn = findDialogueEnd();
            if (endBtn) break;
            await sleep(400);
        }

        if (endBtn) {
            smartClick(endBtn);
            await sleep(1500);

            let confirmBtn = null;
            for (let i = 0; i < 15; i++) {
                confirmBtn = findDialogueConfirmEnd();
                if (confirmBtn) break;
                await sleep(400);
            }

            if (confirmBtn) {
                smartClick(confirmBtn);
                await sleep(2500);
            }
        }

        const nextBtn = await waitForNextButton(6000);
        if (nextBtn) smartClick(nextBtn);
    }

    // =============================================
    // CLEAN QUESTION EXTRACTOR & MULTI-AI ENGINE
    // =============================================

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
        blocks = blocks.filter(b => b.querySelector('input, textarea') && isVisible(b));
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
- For "radio" questions, provide the 1-based index in "choice".
- For "checkbox" questions, provide an array of 1-based indices in "choices".
- For "text" questions, provide an array of string values in "values" corresponding to each blank in order.
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
                    const content = data.choices[0].message.content;
                    const parsed = JSON.parse(content);
                    resolve(parsed);
                } catch (e) {
                    reject(new Error('Failed to parse AI JSON response: ' + e.message));
                }
            };

            const handleError = (err) => {
                reject(new Error(err && err.message ? err.message : String(err)));
            };

            if (typeof GM_xmlhttpRequest !== 'undefined') {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: endpoint,
                    headers: {
                        'Authorization': `Bearer ${apiKey.trim()}`,
                        'Content-Type': 'application/json'
                    },
                    data: JSON.stringify(payload),
                    onload: (res) => {
                        if (res.status >= 200 && res.status < 300) {
                            handleSuccess(res.responseText);
                        } else {
                            reject(new Error(`API Error HTTP ${res.status}: ${res.responseText}`));
                        }
                    },
                    onerror: handleError
                });
            } else {
                fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${apiKey.trim()}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                })
                    .then(res => {
                        if (!res.ok) return res.text().then(t => { throw new Error(`HTTP ${res.status}: ${t}`); });
                        return res.text();
                    })
                    .then(handleSuccess)
                    .catch(handleError);
            }
        });
    }

    async function callAiWithKeyRotation(questions) {
        const keyList = parseApiKeys(rawAiKeys);
        if (keyList.length === 0) {
            throw new Error('No API keys configured. Open Settings to enter your Groq or NVIDIA key.');
        }

        let lastErr = null;
        for (let i = 0; i < keyList.length; i++) {
            const currentKey = keyList[i];
            const provider = detectProviderForKey(currentKey);
            const modelToUse = selectedModel;

            try {
                createToast(`Querying ${provider.toUpperCase()} (${modelToUse}) with Key ${i + 1}/${keyList.length}...`, 6000);
                const result = await sendSingleAiRequest(currentKey, provider, modelToUse, questions);
                return result;
            } catch (err) {
                lastErr = err;
                console.warn(`[Auto Skip Pro AI] Key ${i + 1} (${provider}) failed:`, err);
                if (i < keyList.length - 1) {
                    createToast(`Key ${i + 1} rate-limited. Rotating to Key ${i + 2}...`, 3000);
                    await sleep(1000);
                }
            }
        }

        throw new Error(`All ${keyList.length} API key(s) failed: ${lastErr ? lastErr.message : 'Unknown error'}`);
    }

    async function handleAiQuizSolve() {
        if (isAiSolving) return;

        const keyList = parseApiKeys(rawAiKeys);
        if (keyList.length === 0) {
            openSettingsModal('Enter your Groq (gsk_...) or NVIDIA (nvapi-...) API Key:');
            return;
        }

        isAiSolving = true;
        createToast('Scanning questions on page...');

        try {
            const questions = extractQuestionsFromDOM();
            if (questions.length === 0) {
                createToast('No questions found on this page.');
                return;
            }

            const result = await callAiWithKeyRotation(questions);
            const answers = result && result.answers ? result.answers : [];

            if (answers.length === 0) {
                createToast('AI did not return answers.');
                return;
            }

            createToast(`Filling ${questions.length} questions...`);

            answers.forEach(ans => {
                const qIdx = ans.q - 1;
                if (qIdx < 0 || qIdx >= questions.length) return;
                const q = questions[qIdx];

                if (q.type === 'radio' && typeof ans.choice === 'number') {
                    const optIdx = ans.choice - 1;
                    if (optIdx >= 0 && optIdx < q.options.length) {
                        smartClick(q.options[optIdx].element);
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
                        if (idx < values.length) {
                            setNativeValue(el, values[idx]);
                        } else if (values.length === 1) {
                            setNativeValue(el, values[0]);
                        }
                    });
                }
            });

            checkAgreementCheckbox();
            await sleep(600);

            createToast('Answers filled successfully.');

            if (autoSubmitQuiz) {
                await submitQuizFlow();
            }
        } catch (err) {
            console.error('[Auto Skip Pro AI Solve]', err);
            createToast('AI Error: ' + err.message, 6000);
        } finally {
            isAiSolving = false;
        }
    }

    async function submitQuizFlow() {
        createToast('Submitting assignment...');
        const mainContainer = document.querySelector('main, [role="main"], .rc-Assignment, .rc-Quiz, .rc-Attempt') || document.body;

        checkAgreementCheckbox();
        await sleep(400);

        let submitBtn = null;
        for (let k = 0; k < 10; k++) {
            submitBtn = Array.from(mainContainer.querySelectorAll('button, input[type="submit"], [role="button"]')).find(b => {
                if (b.closest('#cas-widget-host, #cas-settings-host') || b.disabled) return false;
                const t = (b.textContent || b.value || b.getAttribute('aria-label') || '').trim().toLowerCase();
                if (t.includes('search') || t.includes('unsubmit') || t.includes('review') || t.includes('save draft')) return false;
                return (t === 'submit' || t.startsWith('submit ') || t.startsWith('submit assignment') || t.startsWith('submit quiz')) && isVisible(b);
            });
            if (submitBtn) break;
            await sleep(400);
        }

        if (submitBtn) {
            smartClick(submitBtn);
            createToast('Submitting quiz...');

            let modalSubmitBtn = null;
            for (let j = 0; j < 15; j++) {
                modalSubmitBtn = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]')).find(b => {
                    if (b.closest('#cas-widget-host, #cas-settings-host') || b.disabled) return false;
                    const t = (b.textContent || b.value || b.getAttribute('aria-label') || '').trim().toLowerCase();
                    if (t.includes('search') || t.includes('unsubmit') || t.includes('review') || t.includes('cancel') || t.includes('close')) return false;
                    return (t === 'submit' || t.startsWith('submit ') || t === 'yes' || t === 'confirm' || t === 'submit anyway') && b !== submitBtn && isVisible(b);
                });
                if (modalSubmitBtn) break;
                await sleep(150);
            }

            if (modalSubmitBtn) {
                smartClick(modalSubmitBtn);
                createToast('Submission confirmed. Advancing...');
            }

            for (let waitCount = 0; waitCount < 40; waitCount++) {
                await sleep(300);

                const nextBtn = findNextButton();
                if (nextBtn) {
                    createToast('Advancing to next item...');
                    smartClick(nextBtn);
                    return;
                }

                const continueBtn = Array.from(document.querySelectorAll('button, a, [role="button"]')).find(b => {
                    if (b.closest('#cas-widget-host, #cas-settings-host') || b.disabled) return false;
                    const t = (b.textContent || b.getAttribute('aria-label') || '').trim().toLowerCase();
                    return (t === 'view feedback' || t === 'continue' || t === 'go to next item' || t === 'next item' || t === 'next') && isVisible(b);
                });

                if (continueBtn) {
                    createToast('Advancing to next item...');
                    smartClick(continueBtn);
                    return;
                }
            }
        }
    }

    async function handleManualFillAndSubmit() {
        try {
            const questions = [];
            const processedEls = new Set();

            const mainContainer = document.querySelector('main, [role="main"], .rc-Assignment, .rc-Quiz, .rc-Attempt') || document.body;
            const allInputs = Array.from(mainContainer.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled])'));

            const relevantInputs = allInputs.filter(el => {
                const text = (el.closest('label') || el.parentElement || el).textContent.toLowerCase();
                const placeholder = (el.placeholder || '').toLowerCase();
                if (el.type === 'search' || placeholder.includes('search') || el.closest('form[role="search"]') || el.name === 'q') return false;
                if (el.type === 'checkbox' && (text.includes('understand and agree') || text.includes('honor code') || text.includes('my own work'))) {
                    return false;
                }
                return true;
            });

            let blocks = Array.from(mainContainer.querySelectorAll('.rc-FormPartsQuestion, fieldset, [data-test*="question"], div[class*="Question"], [role="group"]'));
            blocks = blocks.filter(b => b.querySelector('input, textarea') && isVisible(b));
            const questionContainers = blocks.filter(b => !blocks.some(parent => parent !== b && parent.contains(b)));

            questionContainers.forEach(container => {
                const containerInputs = relevantInputs.filter(el => container.contains(el) && !processedEls.has(el));
                if (containerInputs.length === 0) return;

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

                    Object.values(groupsByName).forEach(g => {
                        questions.push({ type: g[0].type, elements: g });
                        g.forEach(el => processedEls.add(el));
                    });

                    if (noNameGroup.length > 0) {
                        questions.push({ type: noNameGroup[0].type, elements: noNameGroup });
                        noNameGroup.forEach(el => processedEls.add(el));
                    }
                }

                if (textInputs.length > 0) {
                    questions.push({ type: 'text', elements: textInputs });
                    textInputs.forEach(el => processedEls.add(el));
                }
            });

            if (questions.length === 0) {
                createToast('No questions found.');
                return;
            }

            const inputStr = prompt(`Found ${questions.length} questions.\nFormat: answers separated by commas, + for multiple options/blanks.\nQuotes for text with commas.\nExample: 1, 1+3, "Hello, world", 5+10`);
            if (!inputStr) return;

            const answers = [];
            let curr = '';
            let inQuotes = false;
            for (let i = 0; i < inputStr.length; i++) {
                const char = inputStr[i];
                if (char === '"') inQuotes = !inQuotes;
                else if (char === ',' && !inQuotes) {
                    answers.push(curr.trim());
                    curr = '';
                } else {
                    curr += char;
                }
            }
            answers.push(curr.trim());

            for (let i = 0; i < Math.min(answers.length, questions.length); i++) {
                const ans = answers[i].trim();
                if (!ans) continue;

                const q = questions[i];
                if (q.type === 'radio') {
                    const idx = parseInt(ans) - 1;
                    if (idx >= 0 && idx < q.elements.length) {
                        smartClick(q.elements[idx]);
                    }
                } else if (q.type === 'checkbox') {
                    const parts = ans.split('+').map(p => parseInt(p.trim()) - 1);
                    q.elements.forEach((cb, idx) => {
                        const shouldBeChecked = parts.includes(idx);
                        if (cb.checked !== shouldBeChecked) {
                            setNativeChecked(cb, shouldBeChecked);
                        }
                    });
                } else if (q.type === 'text') {
                    const parts = ans.split('+').map(p => {
                        let text = p.trim();
                        if (text.startsWith('"') && text.endsWith('"')) {
                            text = text.substring(1, text.length - 1);
                        }
                        return text;
                    });

                    q.elements.forEach((el, idx) => {
                        if (idx < parts.length) {
                            setNativeValue(el, parts[idx]);
                        } else if (parts.length === 1) {
                            setNativeValue(el, parts[0]);
                        }
                    });
                }
            }

            checkAgreementCheckbox();
            await sleep(500);
            await submitQuizFlow();
        } catch (err) {
            console.error('[Auto Skip Pro]', err);
            createToast('Error filling assignment.');
        }
    }

    // =============================================
    // MAIN PAGE PROCESSOR
    // =============================================

    async function processPage(force = false) {
        if (isRunning || isAiSolving) return;
        if (!force && !autoEnabled) return;
        if (!force && waitingForLabCompletion) return;

        const thisUrl = location.href;
        if (!force && currentProcessingUrl === thisUrl) return;

        const url = thisUrl.toLowerCase();
        const isAttempt = url.includes('/attempt');
        const isViewFeedback = url.includes('/view-feedback');
        const isAssignmentStart = (url.includes('/assignment-submission') || url.includes('/exam') || url.includes('/quiz')) && !isAttempt && !isViewFeedback;
        const isDialogue = url.includes('/coach') || url.includes('/dialogue') || url.includes('/discussionprompt') ||
            findDialogueStart() !== null || findDialogueEnd() !== null ||
            ((document.body ? document.body.textContent : '').includes('Start Dialogue'));
        const isVideo = (url.includes('/lecture') || (document.querySelector('video') !== null && !url.includes('/ungradedlab') && !url.includes('/lab') && !url.includes('/workspace'))) && !isDialogue;
        const isReading = (url.includes('/supplement') || url.includes('/programming')) && !isDialogue;
        const isLab = (url.includes('/ungradedlab') || url.includes('/ungradedwidget') ||
            url.includes('/gradedlti') || url.includes('/ungradedlti') ||
            url.includes('/workspace') || url.includes('qwiklabs.com') ||
            url.includes('rhyme.com') || url.includes('vocareum.com') ||
            (isSeparateLabTab() && !isVideo && !isReading && !isAssignmentStart)) && !isDialogue;

        if (!isVideo && !isReading && !isAssignmentStart && !isAttempt && !isViewFeedback && !isLab && !isDialogue) return;

        isRunning = true;
        currentProcessingUrl = thisUrl;

        try {
            if (isVideo) {
                const video = await waitForVideo(10000);
                if (!video) return;

                if (video.duration > 0 && video.currentTime >= video.duration - 1) {
                    createToast('Video already completed.');
                } else {
                    video.muted = true;
                    video.playbackRate = 2.0;

                    const skipTo = Math.max(0, video.duration - SECONDS_FROM_END);
                    if (video.currentTime < skipTo) {
                        video.currentTime = skipTo;
                    }

                    if (video.paused) {
                        try { await video.play(); } catch (e) { }
                    }

                    await new Promise(resolve => {
                        const check = setInterval(() => {
                            if (!video || video.ended || video.currentTime >= video.duration - 0.5) {
                                clearInterval(check);
                                resolve();
                            }
                        }, 400);
                        setTimeout(() => { clearInterval(check); resolve(); }, 8000);
                    });

                    createToast('Video completed.');
                }

                await sleep(1000);
                const nextBtn = await waitForNextButton(5000);
                if (nextBtn) smartClick(nextBtn);

            } else if (isReading) {
                await sleep(1200);

                const markBtn = findActiveMarkCompleteButton();
                if (markBtn) {
                    smartClick(markBtn);
                    createToast('Marked as complete.');
                    await sleep(1000);
                }

                const nextBtn = await waitForNextButton(5000);
                if (nextBtn) smartClick(nextBtn);

            } else if (isDialogue) {
                await handleDialogue();

            } else if (isLab) {
                let labStage = null;
                let activeBtn = null;

                for (let poll = 0; poll < 12; poll++) {
                    const sbs = findSideBySideButton() || findOpenWorkspaceButton();
                    const liveText = (document.body ? document.body.textContent : '');
                    if (sbs || liveText.includes('Choose how you want to learn')) {
                        labStage = 'choice';
                        activeBtn = sbs;
                        if (activeBtn) break;
                    }

                    if (findActiveMarkCompleteButton() !== null) {
                        labStage = 'workspace';
                        break;
                    }

                    const launch = findLaunchButton();
                    if (launch) {
                        labStage = 'launch';
                        activeBtn = launch;
                        break;
                    }

                    checkAgreementCheckbox();
                    await sleep(400);
                }

                if (labStage === 'choice' || (!labStage && (document.body ? document.body.textContent : '').includes('Choose how you want to learn'))) {
                    if (!activeBtn) {
                        for (let k = 0; k < 8; k++) {
                            activeBtn = findSideBySideButton() || findOpenWorkspaceButton();
                            if (activeBtn) break;
                            await sleep(400);
                        }
                    }

                    if (activeBtn) {
                        smartClick(activeBtn);
                        await sleep(3500);
                    }

                    await handleLabSteps();

                    if (isSeparateLabTab()) {
                        closeLabTab();
                        return;
                    } else {
                        const nextBtn = await waitForNextButton(5000);
                        if (nextBtn) smartClick(nextBtn);
                        return;
                    }
                }

                if (labStage === 'workspace' || findActiveMarkCompleteButton() !== null) {
                    await handleLabSteps();
                    if (isSeparateLabTab()) {
                        closeLabTab();
                        return;
                    } else {
                        const nextBtn = await waitForNextButton(5000);
                        if (nextBtn) smartClick(nextBtn);
                        return;
                    }
                }

                if (labStage === 'launch' || findLaunchButton() !== null) {
                    checkAgreementCheckbox();
                    let launchBtn = activeBtn || findLaunchButton();
                    if (launchBtn && !launchBtn.dataset.tmLaunched) {
                        launchBtn.dataset.tmLaunched = 'true';
                        smartClick(launchBtn);
                        await sleep(2500);

                        const currentBody = (document.body ? document.body.textContent : '');
                        if (currentBody.includes('Choose how you want to learn') || findSideBySideButton() !== null) {
                            let sbsBtn = findSideBySideButton() || findOpenWorkspaceButton();
                            if (sbsBtn) {
                                smartClick(sbsBtn);
                                await sleep(3500);
                                await handleLabSteps();
                            }
                        } else {
                            const inlineMark = findActiveMarkCompleteButton();
                            if (inlineMark) {
                                smartClick(inlineMark);
                                await sleep(1000);
                            }
                        }

                        const nextBtn = await waitForNextButton(5000);
                        if (nextBtn) smartClick(nextBtn);
                    }
                    return;
                }

                if (isSeparateLabTab()) {
                    closeLabTab();
                    return;
                }

            } else if (isAssignmentStart) {
                if (isItemAlreadyCompleted()) {
                    createToast('Assignment already passed. Next item...');
                    await sleep(1000);
                    const nextBtn = await waitForNextButton(5000);
                    if (nextBtn) {
                        smartClick(nextBtn);
                        return;
                    }
                }

                let startBtn = null;
                for (let i = 0; i < 10; i++) {
                    startBtn = Array.from(document.querySelectorAll('button, a, [role="button"]')).find(b => {
                        if (b.disabled || !isVisible(b)) return false;
                        const t = (b.textContent || '').trim().toLowerCase();
                        return t === 'start' || t === 'resume' || t.includes('start assignment') || t.includes('resume assignment') || t.includes('start quiz');
                    });
                    if (startBtn) break;
                    await sleep(400);
                }

                if (startBtn) {
                    smartClick(startBtn);
                    createToast('Starting assignment...');
                }

            } else if (isAttempt) {
                createToast('Quiz attempt active.');

            } else if (isViewFeedback) {
                createToast('Feedback page. Next item...');
                await sleep(1500);
                const nextBtn = await waitForNextButton(5000);
                if (nextBtn) smartClick(nextBtn);
            }

        } catch (err) {
            console.error('[Auto Skip Pro]', err);
        } finally {
            isRunning = false;
        }
    }

    // =============================================
    // SHADOW DOM SETTINGS MODAL (100% ISOLATED & EDITABLE)
    // =============================================

    function openSettingsModal(customNotice = '') {
        let old = document.getElementById('cas-settings-host');
        if (old) old.remove();

        const host = document.createElement('div');
        host.id = 'cas-settings-host';
        host.style.position = 'fixed';
        host.style.top = '0';
        host.style.left = '0';
        host.style.width = '100vw';
        host.style.height = '100vh';
        host.style.zIndex = '2147483647';
        host.style.pointerEvents = 'auto';

        const shadow = host.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = `
            * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
            .backdrop {
                position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
                background: rgba(0, 0, 0, 0.75); backdrop-filter: blur(8px);
                display: flex; align-items: center; justify-content: center;
            }
            .modal-card {
                background: #0f172a; color: #f8fafc; border: 1px solid #334155;
                border-radius: 12px; width: 460px; max-width: 92vw; max-height: 90vh;
                overflow-y: auto; padding: 22px; display: flex; flex-direction: column; gap: 14px;
                box-shadow: 0 25px 50px rgba(0, 0, 0, 0.7);
            }
            .header { display: flex; justify-content: space-between; align-items: center; }
            .header h3 { font-size: 15px; font-weight: 600; color: #38bdf8; }
            .close-btn { background: transparent; border: none; color: #94a3b8; font-size: 18px; cursor: pointer; padding: 2px 6px; line-height: 1; }
            .close-btn:hover { color: #f8fafc; }
            .notice { font-size: 12px; color: #fbbf24; background: #451a03; padding: 8px 12px; border-radius: 6px; border: 1px solid #78350f; }
            label { font-size: 12px; font-weight: 600; color: #cbd5e1; display: block; margin-bottom: 4px; }
            textarea, select {
                width: 100%; background: #1e293b; color: #f8fafc; border: 1px solid #334155;
                border-radius: 6px; padding: 9px 11px; font-size: 13px; outline: none; transition: border 0.15s;
            }
            textarea:focus, select:focus { border-color: #0284c7; }
            textarea { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; resize: vertical; min-height: 80px; font-size: 12px; }
            .checkbox-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #cbd5e1; cursor: pointer; user-select: none; }
            .checkbox-row input { width: auto; cursor: pointer; }
            .footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
            .save-btn { background: #0284c7; color: #fff; border: none; border-radius: 6px; padding: 8px 18px; font-weight: 600; font-size: 13px; cursor: pointer; }
            .save-btn:hover { background: #0369a1; }
        `;
        shadow.appendChild(style);

        const backdrop = document.createElement('div');
        backdrop.className = 'backdrop';

        const card = document.createElement('div');
        card.className = 'modal-card';

        // Header
        const header = document.createElement('div');
        header.className = 'header';
        const title = document.createElement('h3');
        title.textContent = 'Settings';
        const closeX = document.createElement('button');
        closeX.className = 'close-btn';
        closeX.textContent = '✕';
        closeX.onclick = () => host.remove();
        header.appendChild(title);
        header.appendChild(closeX);
        card.appendChild(header);

        if (customNotice) {
            const notice = document.createElement('div');
            notice.className = 'notice';
            notice.textContent = customNotice;
            card.appendChild(notice);
        }

        // 1. Provider / Router Select
        const provGroup = document.createElement('div');
        const provLabel = document.createElement('label');
        provLabel.textContent = 'AI Provider / Router:';
        const provSelect = document.createElement('select');
        [
            { id: 'auto', name: 'Auto-Detect (Based on Key prefix)' },
            { id: 'groq', name: 'Groq Cloud' },
            { id: 'nvidia', name: 'NVIDIA NIM' }
        ].forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.name;
            if (p.id === selectedProvider) opt.selected = true;
            provSelect.appendChild(opt);
        });
        provGroup.appendChild(provLabel);
        provGroup.appendChild(provSelect);
        card.appendChild(provGroup);

        // 2. Keys Row
        const keyGroup = document.createElement('div');
        const keyLabel = document.createElement('label');
        keyLabel.textContent = 'API Key(s) (Groq or NVIDIA NIM):';
        const keyTextarea = document.createElement('textarea');
        keyTextarea.rows = 3;
        keyTextarea.placeholder = 'Paste Groq (gsk_...) or NVIDIA (nvapi-...) API key(s) here';
        keyTextarea.value = rawAiKeys;
        keyGroup.appendChild(keyLabel);
        keyGroup.appendChild(keyTextarea);
        card.appendChild(keyGroup);

        // 3. Model Dropdown Row with Dynamic Live Fetch
        const modelGroup = document.createElement('div');
        const modelLabelRow = document.createElement('div');
        modelLabelRow.style.display = 'flex';
        modelLabelRow.style.justifyContent = 'space-between';
        modelLabelRow.style.alignItems = 'center';
        modelLabelRow.style.marginBottom = '4px';

        const modelLabel = document.createElement('label');
        modelLabel.textContent = 'AI Model:';
        modelLabel.style.marginBottom = '0';

        const fetchBtn = document.createElement('button');
        fetchBtn.textContent = '🔄 Fetch Live Models';
        fetchBtn.style.background = '#1e293b';
        fetchBtn.style.border = '1px solid #334155';
        fetchBtn.style.color = '#38bdf8';
        fetchBtn.style.borderRadius = '4px';
        fetchBtn.style.padding = '2px 8px';
        fetchBtn.style.fontSize = '11px';
        fetchBtn.style.cursor = 'pointer';

        modelLabelRow.appendChild(modelLabel);
        modelLabelRow.appendChild(fetchBtn);
        modelGroup.appendChild(modelLabelRow);

        const modelSelect = document.createElement('select');

        function populateModels(models) {
            modelSelect.innerHTML = '';
            models.forEach(m => {
                const opt = document.createElement('option');
                opt.value = typeof m === 'string' ? m : m.id;
                opt.textContent = typeof m === 'string' ? m : m.name;
                if (opt.value === selectedModel) opt.selected = true;
                modelSelect.appendChild(opt);
            });
        }

        const initialList = selectedProvider === 'nvidia' ? MODEL_CATALOG.nvidia : selectedProvider === 'groq' ? MODEL_CATALOG.groq : [...MODEL_CATALOG.groq, ...MODEL_CATALOG.nvidia];
        populateModels(initialList);

        async function triggerLiveFetch() {
            const firstKey = parseApiKeys(keyTextarea.value)[0];
            if (!firstKey) return;
            fetchBtn.textContent = '⏳ Fetching...';
            try {
                const prov = provSelect.value === 'auto' ? detectProviderForKey(firstKey) : provSelect.value;
                const liveModels = await fetchLiveModels(firstKey, prov);
                if (liveModels && liveModels.length > 0) {
                    populateModels(liveModels);
                    createToast(`Loaded ${liveModels.length} live models from ${prov.toUpperCase()}`);
                }
            } catch (err) {
                console.warn('[Auto Skip Pro] Live fetch error:', err);
                createToast('Could not fetch live models: ' + err.message);
            } finally {
                fetchBtn.textContent = '🔄 Fetch Live Models';
            }
        }

        fetchBtn.onclick = (e) => {
            e.preventDefault();
            triggerLiveFetch();
        };

        provSelect.onchange = () => {
            const p = provSelect.value;
            const cur = p === 'nvidia' ? MODEL_CATALOG.nvidia : p === 'groq' ? MODEL_CATALOG.groq : [...MODEL_CATALOG.groq, ...MODEL_CATALOG.nvidia];
            populateModels(cur);
            triggerLiveFetch();
        };

        keyTextarea.onchange = () => {
            triggerLiveFetch();
        };

        modelGroup.appendChild(modelSelect);
        card.appendChild(modelGroup);

        // 4. Auto submit checkbox
        const submitWrap = document.createElement('label');
        submitWrap.className = 'checkbox-row';
        const submitCb = document.createElement('input');
        submitCb.type = 'checkbox';
        submitCb.checked = autoSubmitQuiz;
        const submitText = document.createElement('span');
        submitText.textContent = 'Auto Submit & Proceed after AI fills quiz';
        submitWrap.appendChild(submitCb);
        submitWrap.appendChild(submitText);
        card.appendChild(submitWrap);

        // 5. Footer
        const footer = document.createElement('div');
        footer.className = 'footer';
        const saveBtn = document.createElement('button');
        saveBtn.className = 'save-btn';
        saveBtn.textContent = 'Save Settings';
        saveBtn.onclick = () => {
            rawAiKeys = keyTextarea.value.trim();
            selectedProvider = provSelect.value;
            selectedModel = modelSelect.value;
            autoSubmitQuiz = submitCb.checked;

            localStorage.setItem('coursera_ai_keys', rawAiKeys);
            localStorage.setItem('coursera_groq_api_key', rawAiKeys);
            localStorage.setItem('coursera_ai_provider', selectedProvider);
            localStorage.setItem('coursera_ai_model', selectedModel);
            localStorage.setItem('coursera_auto_submit_quiz', autoSubmitQuiz ? 'true' : 'false');

            const count = parseApiKeys(rawAiKeys).length;
            createToast(`Saved (${count} key(s), ${selectedProvider.toUpperCase()}, ${selectedModel})`);
            host.remove();
        };

        footer.appendChild(saveBtn);
        card.appendChild(footer);

        backdrop.appendChild(card);
        shadow.appendChild(backdrop);
        document.body.appendChild(host);

        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) host.remove();
        });

        setTimeout(() => {
            try { keyTextarea.focus(); } catch (e) { }
        }, 100);
    }

    // =============================================
    // UI WIDGET (CENTERED BOTTOM DOCK & CIRCULAR BUTTONS)
    // =============================================

    function createWidget() {
        let old = document.getElementById('cas-widget-host');
        if (old) old.remove();

        const host = document.createElement('div');
        host.id = 'cas-widget-host';
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
                -webkit-backdrop-filter: blur(12px);
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
            .btn:hover {
                transform: scale(1.08);
                background: #334155;
            }
            .btn:active {
                transform: scale(0.95);
            }
            .btn-auto-on {
                background: #059669 !important;
                color: #ffffff !important;
            }
            .btn-auto-off {
                background: #475569 !important;
                color: #94a3b8 !important;
            }
            .btn-ai {
                background: #6366f1;
            }
            .btn-ai:hover {
                background: #4f46e5;
            }
            .btn-manual {
                background: #334155;
            }
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

        // 1. Auto Skip Power/Play Button
        const toggleBtn = document.createElement('button');
        toggleBtn.className = `btn ${autoEnabled ? 'btn-auto-on' : 'btn-auto-off'}`;
        toggleBtn.title = autoEnabled ? 'Auto Skip: Active (Click to Pause)' : 'Auto Skip: Inactive (Click to Activate)';
        toggleBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>`;
        toggleBtn.onclick = () => {
            autoEnabled = !autoEnabled;
            localStorage.setItem('coursera_auto_skip', autoEnabled);
            toggleBtn.className = `btn ${autoEnabled ? 'btn-auto-on' : 'btn-auto-off'}`;
            toggleBtn.title = autoEnabled ? 'Auto Skip: Active (Click to Pause)' : 'Auto Skip: Inactive (Click to Activate)';
            createToast(autoEnabled ? 'Auto Skip: Active' : 'Auto Skip: Inactive');
            if (autoEnabled) {
                currentProcessingUrl = '';
                processPage(true);
            }
        };

        // 2. Skip Now Button
        const skipBtn = document.createElement('button');
        skipBtn.className = 'btn';
        skipBtn.title = 'Skip Current Item';
        skipBtn.innerHTML = `<svg viewBox="0 0 24 24"><polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19"></line></svg>`;
        skipBtn.onclick = () => {
            if (!isRunning) {
                waitingForLabCompletion = false;
                currentProcessingUrl = '';
                processPage(true);
            }
        };

        // 3. AI Solve Button (Attempt page)
        const aiBtn = document.createElement('button');
        aiBtn.className = 'btn btn-ai';
        aiBtn.title = 'AI Solve Quiz';
        aiBtn.innerHTML = `<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"></rect><rect x="9" y="9" width="6" height="6"></rect><line x1="9" y1="1" x2="9" y2="4"></line><line x1="15" y1="1" x2="15" y2="4"></line><line x1="9" y1="20" x2="9" y2="23"></line><line x1="15" y1="20" x2="15" y2="23"></line><line x1="20" y1="9" x2="23" y2="9"></line><line x1="20" y1="14" x2="23" y2="14"></line><line x1="1" y1="9" x2="4" y2="9"></line><line x1="1" y1="14" x2="4" y2="14"></line></svg>`;
        aiBtn.style.display = location.href.includes('/attempt') ? 'flex' : 'none';
        aiBtn.onclick = handleAiQuizSolve;

        // 4. Manual Fill Button (Attempt page)
        const fillBtn = document.createElement('button');
        fillBtn.className = 'btn btn-manual';
        fillBtn.title = 'Manual Answer Input';
        fillBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;
        fillBtn.style.display = location.href.includes('/attempt') ? 'flex' : 'none';
        fillBtn.onclick = handleManualFillAndSubmit;

        // 5. Settings Button
        const settingsBtn = document.createElement('button');
        settingsBtn.className = 'btn';
        settingsBtn.title = 'Settings (Click: Modal, Right-Click: Fast Key Prompt)';
        settingsBtn.innerHTML = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;
        settingsBtn.onclick = () => openSettingsModal();
        settingsBtn.oncontextmenu = (e) => {
            e.preventDefault();
            const manual = prompt('Enter your Groq (gsk_...) or NVIDIA (nvapi-...) API key(s):', rawAiKeys);
            if (manual !== null) {
                rawAiKeys = manual.trim();
                localStorage.setItem('coursera_ai_keys', rawAiKeys);
                localStorage.setItem('coursera_groq_api_key', rawAiKeys);
                createToast('API Keys updated.');
            }
        };

        dock.appendChild(toggleBtn);
        dock.appendChild(skipBtn);
        dock.appendChild(aiBtn);
        dock.appendChild(fillBtn);
        dock.appendChild(settingsBtn);
        shadow.appendChild(dock);
        document.body.appendChild(host);
    }

    // =============================================
    // ROUTE & INITIALIZATION LISTENERS
    // =============================================

    function handleLocationChange() {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            isRunning = false;
            currentProcessingUrl = '';
            waitingForLabCompletion = false;

            const host = document.getElementById('cas-widget-host');
            if (host && host.shadowRoot) {
                const aiBtn = host.shadowRoot.querySelector('.btn-ai');
                const fillBtn = host.shadowRoot.querySelector('.btn-manual');
                const isAttempt = location.href.includes('/attempt');
                if (aiBtn) aiBtn.style.display = isAttempt ? 'flex' : 'none';
                if (fillBtn) fillBtn.style.display = isAttempt ? 'flex' : 'none';
            }

            if (autoEnabled) {
                setTimeout(() => processPage(false), 1200);
            }
        }
    }

    const origPushState = history.pushState;
    history.pushState = function () {
        origPushState.apply(this, arguments);
        handleLocationChange();
    };
    const origReplaceState = history.replaceState;
    history.replaceState = function () {
        origReplaceState.apply(this, arguments);
        handleLocationChange();
    };
    window.addEventListener('popstate', handleLocationChange);
    setInterval(handleLocationChange, 1000);

    let initTimer = setInterval(() => {
        if (document.body) {
            clearInterval(initTimer);
            createWidget();
            if (autoEnabled) {
                setTimeout(() => processPage(false), 1500);
            }
        }
    }, 200);

})();
