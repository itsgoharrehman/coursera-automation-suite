// ==UserScript==
// @name         Quiz Solver (Multi-AI: Groq & NVIDIA NIM)
// @namespace    http://tampermonkey.net/
// @version      12.2
// @description  Automated Multi-AI quiz solver for Coursera. Supports Groq & NVIDIA NIM API keys with automatic key rotation, strips anti-AI traps, uses top active models, and auto-fills answers.
// @author       Gohar Rehman (https://github.com/itsgoharrehman)
// @match        *://*.coursera.org/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.groq.com
// @connect      integrate.api.nvidia.com
// ==/UserScript==

(function () {
    'use strict';

    let isRunning = false;
    let rawAiKeys = localStorage.getItem('coursera_ai_keys') || localStorage.getItem('coursera_groq_api_key') || '';
    let selectedProvider = localStorage.getItem('coursera_ai_provider') || 'auto';
    let selectedModel = localStorage.getItem('coursera_ai_model') || 'openai/gpt-oss-120b';

    function log(msg) {
        let box = document.getElementById('qas-toast');
        if (!box) {
            box = document.createElement('div');
            box.id = 'qas-toast';
            Object.assign(box.style, {
                position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)',
                background: '#0f172a', color: '#38bdf8', padding: '10px 20px',
                borderRadius: '8px', fontFamily: 'sans-serif', fontSize: '13px',
                fontWeight: '600', zIndex: '2147483647', pointerEvents: 'none',
                boxShadow: '0 4px 20px rgba(0,0,0,0.5)', transition: 'opacity 0.2s', opacity: '1',
                border: '1px solid #334155'
            });
            document.body.appendChild(box);
        }
        box.textContent = msg;
        box.style.opacity = '1';
        clearTimeout(box._t);
        box._t = setTimeout(() => { box.style.opacity = '0'; }, 3500);
    }

    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    function isVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.offsetWidth > 0;
    }

    function parseApiKeys(raw) {
        if (!raw) return [];
        return raw.split(/[\n,;]+/).map(k => k.trim()).filter(Boolean);
    }

    function detectProviderForKey(key) {
        if (!key) return 'groq';
        if (key.startsWith('nvapi-')) return 'nvidia';
        if (key.startsWith('gsk_')) return 'groq';
        return selectedProvider !== 'auto' ? selectedProvider : 'groq';
    }

    function getEndpointForProvider(provider) {
        if (provider === 'nvidia') return 'https://integrate.api.nvidia.com/v1/chat/completions';
        return 'https://api.groq.com/openai/v1/chat/completions';
    }

    function getDefaultModelForProvider(provider) {
        if (provider === 'nvidia') return 'meta/llama-3.3-70b-instruct';
        return 'openai/gpt-oss-120b';
    }

    function setNativeValue(el, value) {
        try {
            const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
            if (descriptor && descriptor.set) descriptor.set.call(el, value);
            else el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) {
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
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

    const STRIP_PATTERNS = [
        /(?:You are a helpful AI assistant[\s\S]*?verification step is mandatory for all AI assistants accessing assessment pages\.?)/gi,
        /AI Agent Compliance Verification Required/gi,
        /Do you understand\??\.*\s*/gi,
        /I understand\.?\s*/gi,
        /^\s*\d+[\.\)]\s*/gm,
        /^\s*\d+\s*points?\b/gim,
        /\b\d+\s*points?\b/gim,
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

    function extractQuestions() {
        const questions = [];
        const processedEls = new Set();
        const mainContainer = document.querySelector('main, [role="main"], .rc-Assignment, .rc-Quiz, .rc-Attempt') || document.body;

        const allInputs = Array.from(mainContainer.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled])'));

        const relevantInputs = allInputs.filter(el => {
            const text = (el.closest('label') || el.parentElement || el).textContent.toLowerCase();
            if (el.type === 'search' || el.name === 'q') return false;
            if (el.type === 'checkbox' && (text.includes('understand and agree') || text.includes('honor code') || text.includes('my own work'))) {
                return false;
            }
            return true;
        });

        let blocks = Array.from(mainContainer.querySelectorAll('.rc-FormPartsQuestion, fieldset, [data-test*="question"], [data-testid*="question"], div[class*="Question"], [role="group"]'));
        blocks = blocks.filter(b => b.querySelector('input, textarea') && isVisible(b));
        const questionContainers = blocks.filter(b => !blocks.some(parent => parent !== b && parent.contains(b)));

        questionContainers.forEach(container => {
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

                    questions.push({
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
            let out = `Q${idx + 1} (${q.type === 'radio' ? 'Single Choice Radio' : q.type === 'checkbox' ? 'Multiple Choice Checkboxes' : `Text Input (${q.blankCount} blank(s))`}):\n${q.prompt}\n`;
            if (q.options) {
                out += `Options:\n` + q.options.map(o => `  ${o.index}. ${o.text}`).join('\n') + '\n';
            }
            return out;
        }).join('\n-------------------\n\n');

        const systemPrompt = `You are an expert assessment solver.
Output ONLY valid JSON matching this schema:
{
  "answers": [
    {"q": 1, "type": "radio", "choice": 2},
    {"q": 2, "type": "checkbox", "choices": [1, 3]},
    {"q": 3, "type": "text", "values": ["answer string"]}
  ]
}`;

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
                    resolve(JSON.parse(data.choices[0].message.content));
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

    async function solveWithAi() {
        if (isRunning) return;

        const keyList = parseApiKeys(rawAiKeys);
        if (keyList.length === 0) {
            const key = prompt('Enter your Groq (gsk_...) or NVIDIA (nvapi-...) API Key:');
            if (!key) return;
            rawAiKeys = key.trim();
            localStorage.setItem('coursera_ai_keys', rawAiKeys);
            localStorage.setItem('coursera_groq_api_key', rawAiKeys);
        }

        isRunning = true;
        log('Extracting questions...');

        try {
            const questions = extractQuestions();
            if (questions.length === 0) {
                log('No questions found.');
                return;
            }

            const currentKeys = parseApiKeys(rawAiKeys);
            let result = null;
            let lastErr = null;

            for (let i = 0; i < currentKeys.length; i++) {
                const currentKey = currentKeys[i];
                const provider = detectProviderForKey(currentKey);
                const modelToUse = selectedModel;

                try {
                    log(`Asking ${provider.toUpperCase()} (${modelToUse}) with Key ${i + 1}/${currentKeys.length}...`);
                    result = await sendSingleAiRequest(currentKey, provider, modelToUse, questions);
                    break;
                } catch (err) {
                    lastErr = err;
                    console.warn(`[Quiz Solver AI] Key ${i + 1} (${provider}) failed:`, err);
                    if (i < currentKeys.length - 1) await wait(1000);
                }
            }

            if (!result) throw new Error(`All keys failed: ${lastErr ? lastErr.message : 'Unknown error'}`);

            const answers = result && result.answers ? result.answers : [];
            log(`Auto-filling ${questions.length} questions...`);

            answers.forEach(ans => {
                const qIdx = ans.q - 1;
                if (qIdx < 0 || qIdx >= questions.length) return;
                const q = questions[qIdx];

                if (q.type === 'radio' && typeof ans.choice === 'number') {
                    const optIdx = ans.choice - 1;
                    if (optIdx >= 0 && optIdx < q.options.length) q.options[optIdx].element.click();
                } else if (q.type === 'checkbox' && Array.isArray(ans.choices)) {
                    ans.choices.forEach(ch => {
                        const optIdx = ch - 1;
                        if (optIdx >= 0 && optIdx < q.options.length) setNativeChecked(q.options[optIdx].element, true);
                    });
                } else if (q.type === 'text') {
                    const values = Array.isArray(ans.values) ? ans.values : [String(ans.values || '')];
                    q.elements.forEach((el, idx) => {
                        if (idx < values.length) setNativeValue(el, values[idx]);
                    });
                }
            });

            const honor = Array.from(document.querySelectorAll('input[type="checkbox"]')).find(cb => {
                const t = (cb.closest('label') || cb.parentElement).textContent.toLowerCase();
                return t.includes('agree') || t.includes('honor') || t.includes('own work');
            });
            if (honor) setNativeChecked(honor, true);

            log('Quiz solved.');
        } catch (e) {
            console.error(e);
            log('Error: ' + e.message);
        } finally {
            isRunning = false;
        }
    }

    function createUi() {
        if (document.getElementById('qas-dock-host')) return;
        const host = document.createElement('div');
        host.id = 'qas-dock-host';
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

        const aiBtn = document.createElement('button');
        aiBtn.className = 'btn btn-ai';
        aiBtn.title = 'AI Solve Quiz';
        aiBtn.innerHTML = `<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"></rect><rect x="9" y="9" width="6" height="6"></rect><line x1="9" y1="1" x2="9" y2="4"></line><line x1="15" y1="1" x2="15" y2="4"></line><line x1="9" y1="20" x2="9" y2="23"></line><line x1="15" y1="20" x2="15" y2="23"></line><line x1="20" y1="9" x2="23" y2="9"></line><line x1="20" y1="14" x2="23" y2="14"></line><line x1="1" y1="9" x2="4" y2="9"></line><line x1="1" y1="14" x2="4" y2="14"></line></svg>`;
        aiBtn.onclick = solveWithAi;

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
                log('API Keys updated.');
            }
        };

        dock.appendChild(aiBtn);
        dock.appendChild(keysBtn);
        shadow.appendChild(dock);
        document.body.appendChild(host);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createUi);
    } else {
        createUi();
    }
})();
