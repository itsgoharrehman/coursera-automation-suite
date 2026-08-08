// ==UserScript==
// @name         Auto Skip Pro 
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Automatically skips Coursera videos (fast-forward) and readings (mark complete).
// @author       Gohar Rehman (https://github.com/itsgoharrehman)
// @match        *://*.coursera.org/learn*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    let isRunning = false;
    let autoEnabled = localStorage.getItem('coursera_auto_skip') !== 'false';
    let lastUrl = location.href;
    const SECONDS_FROM_END = 3;

    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    function createToast(msg) {
        let t = document.getElementById('tm-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'tm-toast';
            Object.assign(t.style, {
                position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)',
                background: '#1e293b', color: '#fff', padding: '8px 16px', borderRadius: '8px',
                zIndex: '999999', fontSize: '14px', fontFamily: 'sans-serif',
                boxShadow: '0 4px 6px rgba(0,0,0,0.3)', transition: 'opacity 0.3s'
            });
            document.body.appendChild(t);
        }
        t.textContent = msg;
        t.style.opacity = '1';
        clearTimeout(t.timer);
        t.timer = setTimeout(() => { t.style.opacity = '0'; }, 2500);
    }

    function findNextButton() {
        const btns = document.querySelectorAll('button, [role="button"], a');
        for (const btn of btns) {
            if (btn.disabled || btn.offsetParent === null) continue;
            const t = (btn.textContent || '').trim().toLowerCase();
            if (t.includes('go to next item') || t.includes('next item') || t === 'next') {
                return btn;
            }
        }
        return null;
    }

    async function waitForVideo(maxMs) {
        const start = Date.now();
        while (Date.now() - start < maxMs) {
            const video = document.querySelector('video');
            if (video && video.readyState >= 1 && video.duration > 0) {
                return video;
            }
            await sleep(500);
        }
        return null;
    }

    function setNativeValue(el, value) {
        try {
            const prototype = Object.getPrototypeOf(el);
            const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
            if (descriptor && descriptor.set) {
                descriptor.set.call(el, value);
            } else {
                el.value = value;
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) {
            console.error('[Coursera Auto Skip] Error setting native value:', e);
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    function isVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.offsetWidth > 0 && el.offsetHeight > 0;
    }

    async function handleFillAndSubmit() {
        try {
            const questions = [];
            const processedEls = new Set();

            const mainContainer = document.querySelector('main, [role="main"], .rc-Assignment, .rc-Quiz, .rc-Attempt') || document.body;
            const allInputs = Array.from(mainContainer.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled])'));

            const relevantInputs = allInputs.filter(el => {
                const text = (el.closest('label') || el.parentElement || el).textContent.toLowerCase();
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
                createToast('No questions found to fill.');
                return;
            }

            const inputStr = prompt(`Found ${questions.length} questions.\nEnter answers separated by commas.\nFor checkboxes, use + (e.g. 1+2).\nExample: 1, 1+3, text answer`);
            if (!inputStr) return;

            const answers = inputStr.split(',');
            for (let i = 0; i < Math.min(answers.length, questions.length); i++) {
                const ans = answers[i].trim();
                if (!ans) continue;

                const q = questions[i];
                if (q.type === 'radio') {
                    const idx = parseInt(ans) - 1;
                    if (idx >= 0 && idx < q.elements.length) {
                        q.elements[idx].click();
                    }
                } else if (q.type === 'checkbox') {
                    const parts = ans.split('+').map(p => parseInt(p.trim()) - 1);
                    q.elements.forEach((cb, idx) => {
                        const shouldBeChecked = parts.includes(idx);
                        if (cb.checked !== shouldBeChecked) {
                            cb.click();
                        }
                    });
                } else if (q.type === 'text') {
                    q.elements.forEach(el => setNativeValue(el, ans));
                }
            }

            const honorCheckbox = Array.from(document.querySelectorAll('input[type="checkbox"]')).find(c => {
                const text = (c.closest('label') || c.parentElement).textContent.toLowerCase();
                return text.includes('understand and agree') || text.includes('honor code') || text.includes('my own work');
            });
            if (honorCheckbox && !honorCheckbox.checked) {
                honorCheckbox.click();
                createToast('Checked honor code.');
                await sleep(1400); // Let React update state and finish submit button animations
            } else {
                await sleep(500);
            }

            let submitBtn = null;
            for (let k = 0; k < 10; k++) {
                submitBtn = Array.from(mainContainer.querySelectorAll('button, input[type="submit"], [role="button"]')).find(b => {
                    if (b.id === 'cas-fill-btn' || b.closest('#cas-widget') || b.disabled) return false;
                    const t = (b.textContent || b.value || b.getAttribute('aria-label') || '').trim().toLowerCase();
                    if (t.includes('search') || t.includes('unsubmit') || t.includes('review')) return false;
                    return (t === 'submit' || t.startsWith('submit ') || t.startsWith('submit assignment') || t.startsWith('submit quiz')) && isVisible(b);
                });
                if (submitBtn) break;
                await sleep(500);
            }
            
            if (submitBtn) {
                await sleep(1000); // Extra wait for any fade-in animation to finish
                submitBtn.click();
                createToast('Clicked Submit. Waiting for confirmation...');

                let modalSubmitBtn = null;
                for (let j = 0; j < 6; j++) {
                    await sleep(500);
                    modalSubmitBtn = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]')).find(b => {
                        if (b.id === 'cas-fill-btn' || b.closest('#cas-widget') || b.disabled) return false;
                        const t = (b.textContent || b.value || b.getAttribute('aria-label') || '').trim().toLowerCase();
                        if (t.includes('search') || t.includes('unsubmit') || t.includes('review')) return false;
                        return (t === 'submit' || t.startsWith('submit ') || t === 'yes' || t === 'confirm' || t === 'submit anyway') && b !== submitBtn && isVisible(b);
                    });
                    if (modalSubmitBtn) break;
                }

                if (modalSubmitBtn) {
                    modalSubmitBtn.click();
                    createToast('Confirmed submission.');
                }

                createToast('Waiting for page to process...');
                let feedbackWait = 0;
                while (feedbackWait < 15) {
                    await sleep(500);
                    if (location.href.toLowerCase().includes('/view-feedback')) {
                        createToast('✅ Feedback page detected. Moving to next item...');
                        await sleep(2000);
                        const nextBtn = findNextButton();
                        if (nextBtn) nextBtn.click();
                        break;
                    }
                    feedbackWait++;
                }
            } else {
                createToast('Could not find Submit button.');
            }
        } catch (err) {
            console.error('[Coursera Auto Skip]', err);
            createToast('Error filling assignment.');
        }
    }

    async function processPage() {
        if (isRunning || !autoEnabled) return;

        const url = location.href.toLowerCase();
        const isAttempt = url.includes('/attempt');
        const isViewFeedback = url.includes('/view-feedback');
        const isAssignmentStart = (url.includes('/assignment-submission') || url.includes('/exam') || url.includes('/quiz')) && !isAttempt && !isViewFeedback;
        const isVideo = url.includes('/lecture');
        const isReading = url.includes('/supplement') && !isAssignmentStart && !isAttempt && !isViewFeedback;
        const isLti = url.includes('/ungradedlti') || url.includes('/gradedlti');
        const isUngradedWidget = url.includes('/ungradedwidget');

        if (!isVideo && !isReading && !isAssignmentStart && !isAttempt && !isViewFeedback && !isLti && !isUngradedWidget) return;

        isRunning = true;

        try {
            if (isVideo) {
                createToast('🎥 Video detected. Waiting for it to load...');
                const video = await waitForVideo(10000);
                if (!video) {
                    createToast('No video element found.');
                    isRunning = false;
                    return;
                }

                video.muted = true;
                video.playbackRate = 2.0;

                const skipTo = Math.max(0, video.duration - SECONDS_FROM_END);
                if (video.currentTime < skipTo) {
                    video.currentTime = skipTo;
                    createToast(`Skipped to last ${SECONDS_FROM_END} seconds (muted & 2x speed).`);
                }

                if (video.paused) {
                    try { await video.play(); } catch (e) { }
                }

                await new Promise(resolve => {
                    const check = setInterval(() => {
                        if (video.ended || video.currentTime >= video.duration - 0.5) {
                            clearInterval(check);
                            resolve();
                        }
                    }, 500);
                });

                createToast('✅ Video finished.');
                await sleep(1000);
            } else if (isReading) {
                createToast('📖 Reading detected.');
                await sleep(1500);

                const markCompleteBtn = Array.from(document.querySelectorAll('button, [role="button"]'))
                    .find(b => {
                        const t = (b.textContent || '').trim().toLowerCase();
                        return t === 'mark as completed' || t === 'mark as complete';
                    });

                if (markCompleteBtn && !markCompleteBtn.disabled) {
                    markCompleteBtn.click();
                    createToast('✅ Marked as complete.');
                    await sleep(1000);
                } else {
                    createToast('Already complete or no button found.');
                }
            } else if (isUngradedWidget) {
                createToast('🧩 Ungraded Widget detected.');
                await sleep(1500);

                const markCompleteBtn = Array.from(document.querySelectorAll('button, [role="button"]'))
                    .find(b => {
                        const t = (b.textContent || '').trim().toLowerCase();
                        return t === 'mark as completed' || t === 'mark as complete';
                    });

                if (markCompleteBtn && !markCompleteBtn.disabled) {
                    markCompleteBtn.click();
                    createToast('✅ Marked as complete.');
                    await sleep(1000);
                } else {
                    createToast('Already complete or no button found.');
                }
            } else if (isLti) {
                createToast('🛠️ LTI detected.');
                await sleep(1500);

                const cb = Array.from(document.querySelectorAll('input[type="checkbox"]')).find(c => {
                    const text = (c.closest('label') || c.parentElement || document.body).textContent.toLowerCase();
                    return text.includes('responsibly') || text.includes('agree');
                });
                if (cb && !cb.checked) {
                    cb.click();
                    createToast('Checked agreement.');
                    await sleep(1000);
                }

                createToast('Waiting for Launch button...');
                const launchWait = Date.now();
                let launchBtn = null;
                while (Date.now() - launchWait < 6000) {
                    launchBtn = Array.from(document.querySelectorAll('button, a, [role="button"]')).find(b => {
                        if (b.disabled || b.offsetParent === null) return false;
                        const t = (b.textContent || '').trim().toLowerCase();
                        return t.includes('launch') || t.includes('open tool') || t.includes('start lab') || t.includes('open workspace') || t.includes('open lab');
                    });
                    if (launchBtn) break;
                    await sleep(500);
                }

                if (launchBtn) {
                    launchBtn.click();
                    createToast('🚀 Launched App.');
                    await sleep(1500);
                } else {
                    createToast('❌ Could not find Launch button.');
                }
            } else if (isAssignmentStart) {
                createToast('📝 Assignment page detected. Looking for Start/Resume button...');
                const startWait = Date.now();
                let startBtn = null;
                while (Date.now() - startWait < 10000) {
                    startBtn = Array.from(document.querySelectorAll('button, a, [role="button"]')).find(b => {
                        if (b.disabled || b.offsetParent === null) return false;
                        const t = (b.textContent || '').trim().toLowerCase();
                        return t === 'start' || t === 'resume' || t.includes('start assignment') || t.includes('resume assignment');
                    });
                    if (startBtn) break;
                    await sleep(500);
                }

                if (startBtn) {
                    startBtn.click();
                    createToast('🚀 Starting/Resuming assignment...');
                } else {
                    createToast('❌ Could not find Start/Resume button.');
                }
                isRunning = false;
                return;
            } else if (isAttempt) {
                createToast('⏳ On attempt page. Use "Fill & Submit" when ready.');
                isRunning = false;
                return;
            } else if (isViewFeedback) {
                createToast('✅ Feedback page detected. Moving to next item...');
                await sleep(2000);
            }

            if (isVideo || isReading || isViewFeedback || isLti || isUngradedWidget) {
                const start = Date.now();
                let nextBtn = null;
                while (Date.now() - start < 4000) {
                    nextBtn = findNextButton();
                    if (nextBtn) break;
                    await sleep(500);
                }

                if (nextBtn) {
                    createToast('⏭️ Moving to next item...');
                    nextBtn.click();
                } else {
                    createToast('Could not find Next button.');
                }
            }
        } catch (err) {
            console.error('[Coursera Auto Skip]', err);
        } finally {
            isRunning = false;
        }
    }

    function createWidget() {
        if (document.getElementById('cas-widget')) return;
        const w = document.createElement('div');
        w.id = 'cas-widget';
        Object.assign(w.style, {
            position: 'fixed', zIndex: '999998',
            background: '#0f172a', padding: '6px', borderRadius: '8px',
            border: '1px solid #334155', boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            display: 'flex', gap: '6px', fontFamily: 'sans-serif',
            userSelect: 'none', cursor: 'grab'
        });

        const saved = localStorage.getItem('cas_widget_pos');
        if (saved) {
            try {
                const pos = JSON.parse(saved);
                w.style.left = pos.x + 'px';
                w.style.top = pos.y + 'px';
            } catch (e) {
                w.style.left = '50%'; w.style.bottom = '20px'; w.style.transform = 'translateX(-50%)';
            }
        } else {
            w.style.left = '50%'; w.style.bottom = '20px'; w.style.transform = 'translateX(-50%)';
        }

        let isDragging = false;
        let startX, startY, wX, wY;

        w.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            isDragging = true;
            w.style.cursor = 'grabbing';
            startX = e.clientX; startY = e.clientY;
            const r = w.getBoundingClientRect();
            wX = r.left; wY = r.top;
            w.style.bottom = ''; w.style.transform = '';
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            let nx = wX + (e.clientX - startX);
            let ny = wY + (e.clientY - startY);
            const r = w.getBoundingClientRect();
            nx = Math.max(4, Math.min(nx, innerWidth - r.width - 4));
            ny = Math.max(4, Math.min(ny, innerHeight - r.height - 4));
            w.style.left = nx + 'px'; w.style.top = ny + 'px';
        });
        document.addEventListener('mouseup', () => {
            if (!isDragging) return;
            isDragging = false; w.style.cursor = 'grab';
            const r = w.getBoundingClientRect();
            localStorage.setItem('cas_widget_pos', JSON.stringify({ x: r.left, y: r.top }));
        });

        const toggleBtn = document.createElement('button');
        toggleBtn.textContent = autoEnabled ? 'Auto Skip: ON' : 'Auto Skip: OFF';
        Object.assign(toggleBtn.style, {
            background: autoEnabled ? '#059669' : '#475569', color: '#fff',
            border: 'none', borderRadius: '4px', padding: '4px 10px',
            cursor: 'pointer', fontWeight: 'bold', fontSize: '12px'
        });
        toggleBtn.onclick = () => {
            autoEnabled = !autoEnabled;
            localStorage.setItem('coursera_auto_skip', autoEnabled);
            toggleBtn.textContent = autoEnabled ? 'Auto Skip: ON' : 'Auto Skip: OFF';
            toggleBtn.style.background = autoEnabled ? '#059669' : '#475569';
            if (autoEnabled) processPage();
        };

        const skipBtn = document.createElement('button');
        skipBtn.textContent = 'Skip Now';
        Object.assign(skipBtn.style, {
            background: '#2563eb', color: '#fff',
            border: 'none', borderRadius: '4px', padding: '4px 10px',
            cursor: 'pointer', fontWeight: 'bold', fontSize: '12px'
        });
        skipBtn.onclick = () => {
            if (!isRunning) processPage();
        };

        const fillBtn = document.createElement('button');
        fillBtn.id = 'cas-fill-btn';
        fillBtn.textContent = 'Fill & Submit';
        Object.assign(fillBtn.style, {
            background: '#8b5cf6', color: '#fff',
            border: 'none', borderRadius: '4px', padding: '4px 10px',
            cursor: 'pointer', fontWeight: 'bold', fontSize: '12px',
            display: location.href.includes('/attempt') ? 'block' : 'none'
        });
        fillBtn.onclick = handleFillAndSubmit;

        w.appendChild(toggleBtn);
        w.appendChild(skipBtn);
        w.appendChild(fillBtn);
        document.body.appendChild(w);
    }

    setInterval(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            isRunning = false;

            const fillBtn = document.getElementById('cas-fill-btn');
            if (fillBtn) {
                fillBtn.style.display = location.href.includes('/attempt') ? 'block' : 'none';
            }

            if (autoEnabled) {
                setTimeout(processPage, 2000);
            }
        }
    }, 1000);

    let initTimer = setInterval(() => {
        if (document.body) {
            clearInterval(initTimer);
            createWidget();
            if (autoEnabled) {
                setTimeout(processPage, 2000);
            }
        }
    }, 200);

})();
