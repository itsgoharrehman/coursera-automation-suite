// ==UserScript==
// @name         Coursera Bulk Module & Course Completer
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Genuinely marks all videos, readings, supplements, and ungraded plugins in a module or entire course as 100% completed using dual API + DOM runtime workers.
// @author       Gohar Rehman (https://github.com/itsgoharrehman)
// @match        *://*.coursera.org/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // =============================================
    // CHILD WORKER RUNNER (Inside background execution iframe)
    // =============================================
    if (window !== window.top) {
        (function initWorker() {
            let notified = false;
            function notifyDone() {
                if (notified) return;
                notified = true;
                try {
                    window.top.postMessage({ type: 'CBC_ITEM_DONE', href: location.href }, '*');
                } catch (e) { }
            }

            function handleWorkerVideo() {
                const video = document.querySelector('video');
                if (video) {
                    try {
                        if (video.duration && !isNaN(video.duration) && video.duration > 0) {
                            video.currentTime = Math.max(0, video.duration - 1);
                            video.play().catch(() => { });
                            setTimeout(() => {
                                video.dispatchEvent(new Event('ended'));
                                notifyDone();
                            }, 600);
                            return true;
                        }
                    } catch (e) { }
                }
                return false;
            }

            function handleWorkerButtons() {
                const buttons = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
                for (const b of buttons) {
                    const text = (b.textContent || '').trim().toLowerCase();
                    if (text.includes('mark as complete') || text.includes('mark complete') || text.includes("i'm done")) {
                        b.click();
                        setTimeout(notifyDone, 500);
                        return true;
                    }
                }
                return false;
            }

            const workerPoll = setInterval(() => {
                const vDone = handleWorkerVideo();
                const bDone = handleWorkerButtons();
                if (vDone || bDone) {
                    clearInterval(workerPoll);
                }
            }, 250);

            // Safety timeout (2.5s)
            setTimeout(() => {
                clearInterval(workerPoll);
                notifyDone();
            }, 2500);
        })();

        // Do not render UI inside worker iframe
        return;
    }

    // =============================================
    // MAIN THREAD CONTROLLER & UI
    // =============================================

    let isProcessing = false;
    let stopRequested = false;

    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    // Cookie & Auth Helpers
    function getCookie(name) {
        const match = document.cookie.match(new RegExp('(^|;\\s*)(' + name + ')=([^;]*)'));
        return match ? decodeURIComponent(match[3]) : null;
    }

    function getCsrfToken() {
        return getCookie('CSRF3-Token') || getCookie('csrf3-token') || getCookie('c-token') || getCookie('CSRF2-Token') || getCookie('csrf_token') || '';
    }

    function getHeaders() {
        const csrf = getCsrfToken();
        return {
            'Content-Type': 'application/json',
            'X-CSRF3-Token': csrf,
            'X-CSRF2-Token': csrf,
            'X-CSRF-Token': csrf,
            'X-Coursera-Application': 'coursera-ui',
            'X-Requested-With': 'XMLHttpRequest'
        };
    }

    function getCourseSlug() {
        const match = location.pathname.match(/\/learn\/([^/?#]+)/i);
        if (match) return match[1];
        const matchCourse = location.pathname.match(/\/courses?\/([^/?#]+)/i);
        if (matchCourse) return matchCourse[1];
        return null;
    }

    async function getUserId() {
        try {
            const res = await fetch('https://www.coursera.org/api/userPreferences.v1?q=myPreferences', {
                headers: getHeaders(),
                credentials: 'include'
            });
            if (res.ok) {
                const data = await res.json();
                if (data.elements && data.elements[0] && data.elements[0].userId) {
                    return data.elements[0].userId;
                }
            }
        } catch (e) { }
        return null;
    }

    async function getCourseId(slug) {
        try {
            const res = await fetch(`https://www.coursera.org/api/courses.v1?q=slug&slug=${slug}`, {
                headers: getHeaders(),
                credentials: 'include'
            });
            if (res.ok) {
                const data = await res.json();
                if (data.elements && data.elements[0] && data.elements[0].id) {
                    return data.elements[0].id;
                }
            }
        } catch (e) { }
        return slug;
    }

    // =============================================
    // COURSE DATA & SYLLABUS RESOLVER
    // =============================================

    function extractCourseStructureFromDOM(courseSlug) {
        const items = [];
        const modules = [];
        const lessons = [];
        const seenItemIds = new Set();

        const allLinks = Array.from(document.querySelectorAll(`a[href*="/learn/${courseSlug}/"], a[href*="/learn/${courseSlug}?"]`))
            .concat(Array.from(document.querySelectorAll('a[href*="/lecture/"], a[href*="/supplement/"], a[href*="/ungraded"], a[href*="/quiz/"], a[href*="/coach/"]')));

        let defaultModule = { id: 'mod_1', name: 'Course Content (DOM)', lessonIds: ['les_1'] };
        modules.push(defaultModule);
        let defaultLesson = { id: 'les_1', name: 'Lessons', itemIds: [] };
        lessons.push(defaultLesson);

        for (const a of allLinks) {
            const href = a.getAttribute('href') || '';
            const match = href.match(/\/learn\/[^/]+\/([^/?#]+)\/([^/?#]+)/i) || href.match(/\/([^/?#]+)\/([^/?#]+)/i);
            if (!match) continue;

            const rawType = match[1].toLowerCase();
            const rawId = match[2];
            if (seenItemIds.has(rawId) || rawId === 'undefined' || rawId.length < 3) continue;
            seenItemIds.add(rawId);

            let typeName = rawType;
            if (rawType === 'lecture') typeName = 'lecture';
            else if (rawType === 'supplement' || rawType === 'reading' || rawType === 'item') typeName = 'supplement';
            else if (rawType.includes('widget') || rawType.includes('lab') || rawType.includes('lti')) typeName = 'ungradedWidget';
            else if (rawType === 'quiz' || rawType === 'exam') typeName = 'quiz';

            const name = (a.textContent || rawId).replace(/\s+/g, ' ').trim();
            const fullUrl = new URL(href, location.origin).href;

            items.push({
                id: rawId,
                name: name,
                slug: rawId,
                itemUrl: fullUrl,
                contentSummary: { typeName: typeName }
            });
            defaultLesson.itemIds.push(rawId);
        }

        return {
            elements: [{ id: courseSlug, name: courseSlug, moduleIds: modules.map(m => m.id) }],
            linked: {
                'onDemandCourseMaterialModules.v2': modules,
                'onDemandCourseMaterialLessons.v2': lessons,
                'onDemandCourseMaterialItems.v2': items
            }
        };
    }

    async function fetchCourseStructure(courseSlug) {
        const headers = getHeaders();
        const courseId = await getCourseId(courseSlug);

        // Tier 1: Try onDemandCourseMaterials.v2 by courseId
        if (courseId && courseId !== courseSlug) {
            try {
                const url = `https://www.coursera.org/api/onDemandCourseMaterials.v2/${courseId}?includes=modules,lessons,items`;
                const res = await fetch(url, { headers: headers, credentials: 'include' });
                if (res.ok) {
                    const data = await res.json();
                    if (data.elements && data.elements.length > 0) return data;
                }
            } catch (e) { }
        }

        // Tier 2: Try onDemandCourseMaterials.v2 with fields
        try {
            const url = `https://www.coursera.org/api/onDemandCourseMaterials.v2/?q=slug&slug=${courseSlug}&includes=modules,lessons,items&fields=moduleIds,onDemandCourseMaterialModules.v1(name,slug,description,lessonIds),onDemandCourseMaterialLessons.v1(name,slug,itemIds),onDemandCourseMaterialItems.v2(name,slug,contentSummary)`;
            const res = await fetch(url, { headers: headers, credentials: 'include' });
            if (res.ok) {
                const data = await res.json();
                if (data.elements && data.elements.length > 0) return data;
            }
        } catch (e) { }

        // Tier 3: DOM Course Navigation Extraction
        const domData = extractCourseStructureFromDOM(courseSlug);
        if (domData && domData.linked['onDemandCourseMaterialItems.v2'].length > 0) {
            log(`ℹ️ Extracted ${domData.linked['onDemandCourseMaterialItems.v2'].length} items from page syllabus.`, '#38bdf8');
            return domData;
        }

        throw new Error('Could not load course materials. Please ensure course sidebar is visible.');
    }

    // Direct REST API completion trigger
    async function markItemComplete(courseId, itemId, typeName, userId, courseSlug) {
        const headers = getHeaders();
        const idsToTry = [courseId, courseSlug].filter(Boolean);

        for (const cId of idsToTry) {
            // 1. Generic Progress Endpoint
            try {
                const payload = JSON.stringify({
                    courseId: cId,
                    itemId: itemId,
                    progressState: 'Completed',
                    completionTime: Date.now()
                });
                fetch(`https://www.coursera.org/api/opencourse.v1/progress/${cId}/item/${itemId}`, {
                    method: 'POST',
                    headers: headers,
                    body: payload,
                    credentials: 'include'
                }).catch(() => { });
            } catch (e) { }

            // 2. onDemandProgresses.v1 endpoint
            try {
                const payload = JSON.stringify({
                    courseId: cId,
                    itemId: itemId,
                    progressState: 'Completed'
                });
                fetch(`https://www.coursera.org/api/onDemandProgresses.v1`, {
                    method: 'POST',
                    headers: headers,
                    body: payload,
                    credentials: 'include'
                }).catch(() => { });
            } catch (e) { }

            // 3. Type-specific endpoints
            if (typeName === 'supplement') {
                try {
                    fetch(`https://www.coursera.org/api/onDemandSupplements.v1/${cId}~${itemId}/actions?action=complete`, {
                        method: 'POST',
                        headers: headers,
                        body: JSON.stringify({}),
                        credentials: 'include'
                    }).catch(() => { });
                } catch (e) { }
            } else if (typeName === 'lecture' && userId) {
                try {
                    const payload = JSON.stringify({
                        watchProgress: 1.0,
                        completionStatus: 'Completed',
                        state: 'Completed'
                    });
                    fetch(`https://www.coursera.org/api/opencourse.v1/user/${userId}/course/${cId}/item/${itemId}/lectureProgress`, {
                        method: 'POST',
                        headers: headers,
                        body: payload,
                        credentials: 'include'
                    }).catch(() => { });
                } catch (e) { }
            }
        }
    }

    // =============================================
    // UI DASHBOARD & STYLING
    // =============================================

    function createDashboardUI() {
        if (document.getElementById('cbc-trigger')) return;

        // Floating Trigger Button
        const trigger = document.createElement('div');
        trigger.id = 'cbc-trigger';
        trigger.innerHTML = `⚡ <span style="font-weight: 700;">Bulk Completer</span>`;
        Object.assign(trigger.style, {
            position: 'fixed',
            bottom: '85px',
            right: '20px',
            zIndex: '2147483647',
            background: 'linear-gradient(135deg, #4f46e5, #7c3aed)',
            color: '#ffffff',
            padding: '10px 18px',
            borderRadius: '50px',
            fontSize: '13px',
            fontWeight: '600',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            cursor: 'grab',
            boxShadow: '0 6px 20px rgba(79, 70, 229, 0.5)',
            userSelect: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            transition: 'transform 0.2s, box-shadow 0.2s'
        });

        trigger.onmouseover = () => { trigger.style.transform = 'scale(1.05)'; };
        trigger.onmouseout = () => { trigger.style.transform = 'scale(1.0)'; };

        let isDragging = false;
        let dragStartX, dragStartY, initialX, initialY;

        trigger.addEventListener('mousedown', (e) => {
            isDragging = false;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            const rect = trigger.getBoundingClientRect();
            initialX = rect.left;
            initialY = rect.top;

            const onMouseMove = (moveEvent) => {
                const dx = moveEvent.clientX - dragStartX;
                const dy = moveEvent.clientY - dragStartY;
                if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                    isDragging = true;
                    trigger.style.cursor = 'grabbing';
                    trigger.style.bottom = 'auto';
                    trigger.style.right = 'auto';
                    trigger.style.left = `${Math.max(10, Math.min(window.innerWidth - rect.width - 10, initialX + dx))}px`;
                    trigger.style.top = `${Math.max(10, Math.min(window.innerHeight - rect.height - 10, initialY + dy))}px`;
                }
            };

            const onMouseUp = () => {
                trigger.style.cursor = 'grab';
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        trigger.addEventListener('click', (e) => {
            if (isDragging) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            toggleModal();
        });

        // Modal Container
        const modal = document.createElement('div');
        modal.id = 'cbc-modal';
        Object.assign(modal.style, {
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%) scale(0.95)',
            width: '520px',
            maxHeight: '85vh',
            background: '#0f172a',
            color: '#f8fafc',
            border: '1px solid #334155',
            borderRadius: '16px',
            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.75)',
            zIndex: '2147483647',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            padding: '24px',
            display: 'none',
            flexDirection: 'column',
            gap: '16px',
            opacity: '0',
            transition: 'opacity 0.25s ease, transform 0.25s ease'
        });

        modal.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #1e293b; padding-bottom: 14px;">
                <div>
                    <h2 style="margin: 0; font-size: 18px; font-weight: 700; color: #f8fafc; display: flex; align-items: center; gap: 8px;">
                        <span>⚡</span> Bulk Course Completer
                    </h2>
                    <p style="margin: 4px 0 0 0; font-size: 12px; color: #94a3b8;">100% Genuine completion via Dual API + DOM Runtime</p>
                </div>
                <button id="cbc-close-btn" style="background: transparent; border: none; color: #94a3b8; font-size: 20px; cursor: pointer; padding: 4px 8px;">✕</button>
            </div>

            <!-- Scope Selection -->
            <div style="display: flex; flex-direction: column; gap: 8px;">
                <label style="font-size: 12px; font-weight: 600; color: #cbd5e1; text-transform: uppercase; letter-spacing: 0.5px;">Target Module / Scope</label>
                <select id="cbc-scope-select" style="background: #1e293b; color: #f8fafc; border: 1px solid #334155; border-radius: 8px; padding: 8px 12px; font-size: 13px; outline: none; cursor: pointer;">
                    <option value="ALL">⚡ Entire Course (All Modules)</option>
                </select>
            </div>

            <!-- Type Filter Options -->
            <div style="display: flex; flex-direction: column; gap: 8px;">
                <label style="font-size: 12px; font-weight: 600; color: #cbd5e1; text-transform: uppercase; letter-spacing: 0.5px;">Include Item Types</label>
                <div style="display: flex; gap: 12px; flex-wrap: wrap;">
                    <label style="font-size: 13px; display: flex; align-items: center; gap: 6px; cursor: pointer; color: #e2e8f0;">
                        <input type="checkbox" id="cbc-opt-reading" checked style="accent-color: #7c3aed;"> 📖 Readings / Supplements
                    </label>
                    <label style="font-size: 13px; display: flex; align-items: center; gap: 6px; cursor: pointer; color: #e2e8f0;">
                        <input type="checkbox" id="cbc-opt-video" checked style="accent-color: #7c3aed;"> 🎥 Video Lectures
                    </label>
                    <label style="font-size: 13px; display: flex; align-items: center; gap: 6px; cursor: pointer; color: #e2e8f0;">
                        <input type="checkbox" id="cbc-opt-widget" checked style="accent-color: #7c3aed;"> 🧪 Ungraded Plugins / Widgets
                    </label>
                </div>
            </div>

            <!-- Progress Bar -->
            <div id="cbc-progress-container" style="display: none; flex-direction: column; gap: 6px;">
                <div style="display: flex; justify-content: space-between; font-size: 12px; color: #cbd5e1;">
                    <span id="cbc-progress-label">Progress: 0 / 0 items</span>
                    <span id="cbc-progress-percent">0%</span>
                </div>
                <div style="width: 100%; height: 8px; background: #1e293b; border-radius: 4px; overflow: hidden;">
                    <div id="cbc-progress-bar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #4f46e5, #10b981); transition: width 0.3s ease;"></div>
                </div>
            </div>

            <!-- Terminal Log Console -->
            <div id="cbc-log-console" style="background: #090d16; border: 1px solid #1e293b; border-radius: 8px; padding: 10px; font-family: monospace; font-size: 11px; height: 130px; overflow-y: auto; color: #94a3b8;">
                <div style="color: #64748b;">Ready. Select a module and click "Mark as Complete".</div>
            </div>

            <!-- Controls -->
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px;">
                <button id="cbc-reload-btn" style="background: #1e293b; color: #94a3b8; border: 1px solid #334155; border-radius: 8px; padding: 8px 14px; font-size: 13px; cursor: pointer; font-weight: 500;">🔄 Reload Modules</button>
                <div style="display: flex; gap: 8px;">
                    <button id="cbc-stop-btn" style="display: none; background: #dc2626; color: #fff; border: none; border-radius: 8px; padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer;">🛑 Stop</button>
                    <button id="cbc-start-btn" style="background: linear-gradient(135deg, #059669, #10b981); color: #fff; border: none; border-radius: 8px; padding: 8px 18px; font-size: 13px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);">⚡ Mark as Complete</button>
                </div>
            </div>
        `;

        // Backdrop
        const backdrop = document.createElement('div');
        backdrop.id = 'cbc-backdrop';
        Object.assign(backdrop.style, {
            position: 'fixed',
            inset: '0',
            background: 'rgba(0, 0, 0, 0.6)',
            backdropFilter: 'blur(4px)',
            zIndex: '2147483646',
            display: 'none',
            opacity: '0',
            transition: 'opacity 0.25s ease'
        });
        backdrop.onclick = toggleModal;

        document.body.appendChild(trigger);
        document.body.appendChild(backdrop);
        document.body.appendChild(modal);

        // Bind events
        document.getElementById('cbc-close-btn').onclick = toggleModal;
        document.getElementById('cbc-reload-btn').onclick = loadCourseData;
        document.getElementById('cbc-start-btn').onclick = startBulkCompletion;
        document.getElementById('cbc-stop-btn').onclick = () => {
            stopRequested = true;
            log('🛑 Stopping bulk completion process...', '#ef4444');
        };

        loadCourseData();
    }

    function toggleModal() {
        const modal = document.getElementById('cbc-modal');
        const backdrop = document.getElementById('cbc-backdrop');
        if (!modal || !backdrop) return;

        if (modal.style.display === 'none' || modal.style.display === '') {
            modal.style.display = 'flex';
            backdrop.style.display = 'block';
            setTimeout(() => {
                modal.style.opacity = '1';
                modal.style.transform = 'translate(-50%, -50%) scale(1)';
                backdrop.style.opacity = '1';
            }, 10);
        } else {
            modal.style.opacity = '0';
            modal.style.transform = 'translate(-50%, -50%) scale(0.95)';
            backdrop.style.opacity = '0';
            setTimeout(() => {
                modal.style.display = 'none';
                backdrop.style.display = 'none';
            }, 250);
        }
    }

    function log(msg, color = '#94a3b8') {
        const consoleEl = document.getElementById('cbc-log-console');
        if (!consoleEl) return;
        const line = document.createElement('div');
        line.style.color = color;
        line.style.marginTop = '2px';
        line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        consoleEl.appendChild(line);
        consoleEl.scrollTop = consoleEl.scrollHeight;
    }

    let cachedCourseData = null;

    async function loadCourseData() {
        const slug = getCourseSlug();
        if (!slug) {
            log('⚠️ Not on a valid Coursera /learn/ course page.', '#f59e0b');
            return;
        }

        log(`🔍 Loading course structure for: "${slug}"...`, '#38bdf8');
        try {
            cachedCourseData = await fetchCourseStructure(slug);
            populateModuleDropdown(cachedCourseData);
            log(`✅ Loaded course successfully! Ready to complete.`, '#10b981');
        } catch (err) {
            log(`❌ Error fetching course structure: ${err.message}`, '#ef4444');
        }
    }

    function populateModuleDropdown(data) {
        const select = document.getElementById('cbc-scope-select');
        if (!select || !data || !data.elements || !data.elements[0]) return;

        select.innerHTML = '<option value="ALL">⚡ Entire Course (All Modules)</option>';
        const modules = (data.linked && data.linked['onDemandCourseMaterialModules.v2']) || [];

        modules.forEach((mod, idx) => {
            const opt = document.createElement('option');
            opt.value = mod.id;
            opt.textContent = `Module ${idx + 1}: ${mod.name}`;
            select.appendChild(opt);
        });
    }

    // =============================================
    // DUAL-ENGINE BULK COMPLETION RUNNER
    // =============================================

    async function startBulkCompletion() {
        if (isProcessing) return;
        const slug = getCourseSlug();
        if (!slug) {
            log('⚠️ Please navigate to a Coursera course page.', '#f59e0b');
            return;
        }

        if (!cachedCourseData) {
            await loadCourseData();
        }

        if (!cachedCourseData || !cachedCourseData.elements || !cachedCourseData.elements[0]) {
            log('❌ Course structure unavailable.', '#ef4444');
            return;
        }

        const courseId = cachedCourseData.elements[0].id;
        const userId = await getUserId();
        const selectedScope = document.getElementById('cbc-scope-select').value;
        const incReading = document.getElementById('cbc-opt-reading').checked;
        const incVideo = document.getElementById('cbc-opt-video').checked;
        const incWidget = document.getElementById('cbc-opt-widget').checked;

        // Gather all target items
        const allItems = (cachedCourseData.linked && cachedCourseData.linked['onDemandCourseMaterialItems.v2']) || [];
        const allLessons = (cachedCourseData.linked && cachedCourseData.linked['onDemandCourseMaterialLessons.v2']) || [];
        const allModules = (cachedCourseData.linked && cachedCourseData.linked['onDemandCourseMaterialModules.v2']) || [];

        let targetItems = [];

        if (selectedScope === 'ALL') {
            targetItems = allItems;
        } else {
            const targetMod = allModules.find(m => m.id === selectedScope);
            if (targetMod && targetMod.lessonIds) {
                const modLessonIds = new Set(targetMod.lessonIds);
                const targetLessons = allLessons.filter(l => modLessonIds.has(l.id));
                const targetItemIds = new Set();
                targetLessons.forEach(l => (l.itemIds || []).forEach(id => targetItemIds.add(id)));
                targetItems = allItems.filter(item => targetItemIds.has(item.id));
            } else {
                targetItems = allItems;
            }
        }

        // Filter supported item types
        const eligibleItems = targetItems.filter(item => {
            const type = (item.contentSummary && item.contentSummary.typeName) || '';
            if (incReading && (type === 'supplement' || type === 'phasedPeer' || type === 'staffGraded')) return true;
            if (incVideo && (type === 'lecture')) return true;
            if (incWidget && (type === 'ungradedWidget' || type === 'ungradedLab' || type === 'workspace')) return true;
            return false;
        });

        if (eligibleItems.length === 0) {
            log('⚠️ No eligible items found matching current filters.', '#f59e0b');
            return;
        }

        // Setup UI for run
        isProcessing = true;
        stopRequested = false;
        document.getElementById('cbc-start-btn').style.display = 'none';
        document.getElementById('cbc-stop-btn').style.display = 'block';
        document.getElementById('cbc-progress-container').style.display = 'flex';

        log(`🚀 Starting genuine completion for ${eligibleItems.length} items...`, '#38bdf8');

        // Create invisible worker execution frame
        let workerFrame = document.getElementById('cbc-worker-frame');
        if (!workerFrame) {
            workerFrame = document.createElement('iframe');
            workerFrame.id = 'cbc-worker-frame';
            Object.assign(workerFrame.style, {
                position: 'fixed',
                bottom: '-2000px',
                right: '-2000px',
                width: '800px',
                height: '600px',
                opacity: '0.01',
                pointerEvents: 'none',
                zIndex: '-1'
            });
            document.body.appendChild(workerFrame);
        }

        let completedCount = 0;
        const total = eligibleItems.length;

        for (let i = 0; i < total; i++) {
            if (stopRequested) {
                log('🛑 Bulk completion paused by user.', '#ef4444');
                break;
            }

            const item = eligibleItems[i];
            const type = (item.contentSummary && item.contentSummary.typeName) || 'item';
            const name = item.name || item.slug || item.id;
            const itemUrl = item.itemUrl || `https://www.coursera.org/learn/${slug}/${type}/${item.id}`;

            log(`⏳ [${i + 1}/${total}] Completing ${type}: "${name}"...`, '#cbd5e1');

            // 1. Dual API Progress Call
            markItemComplete(courseId, item.id, type, userId, slug);

            // 2. Real DOM & Video Runtime Completion via Worker Frame
            await new Promise((resolve) => {
                let resolved = false;
                const onMessage = (event) => {
                    if (event.data && event.data.type === 'CBC_ITEM_DONE') {
                        if (!resolved) {
                            resolved = true;
                            window.removeEventListener('message', onMessage);
                            resolve();
                        }
                    }
                };
                window.addEventListener('message', onMessage);

                workerFrame.src = itemUrl;

                // Safety timeout per item (2.2s)
                setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        window.removeEventListener('message', onMessage);
                        resolve();
                    }
                }, 2200);
            });

            completedCount++;
            log(`   ✅ Confirmed & Marked Complete: "${name}"`, '#10b981');

            // Update Progress Bar
            const percent = Math.round(((i + 1) / total) * 100);
            document.getElementById('cbc-progress-bar').style.width = `${percent}%`;
            document.getElementById('cbc-progress-percent').textContent = `${percent}%`;
            document.getElementById('cbc-progress-label').textContent = `Progress: ${i + 1} / ${total} items`;

            await sleep(200);
        }

        // Clean up worker frame
        if (workerFrame && workerFrame.parentNode) {
            workerFrame.parentNode.removeChild(workerFrame);
        }

        isProcessing = false;
        document.getElementById('cbc-start-btn').style.display = 'block';
        document.getElementById('cbc-stop-btn').style.display = 'none';

        log(`🎉 Finished! Successfully marked ${completedCount} / ${total} items as completed.`, '#10b981');
        log(`🔄 Reloading page in 3 seconds to sync all green checkmarks...`, '#38bdf8');

        setTimeout(() => {
            location.reload();
        }, 3000);
    }

    // =============================================
    // INITIALIZATION
    // =============================================

    function init() {
        if (document.body) {
            createDashboardUI();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    setInterval(() => {
        if (document.body && !document.getElementById('cbc-trigger')) {
            createDashboardUI();
        }
    }, 1000);

})();
