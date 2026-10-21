// Firebase Realtime Database URL (without trailing slash)
const FIREBASE_URL = "https://careflowai-2bd8b-default-rtdb.firebaseio.com";

async function fbFetch(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) {
        throw new Error(res.status === 401 || res.status === 403
            ? `Firebase rejected the request (${res.status}). Open Firebase Console > Realtime Database > Rules and allow read/write.`
            : `Firebase error ${res.status}`);
    }
    return res;
}

function cleanClinicCode(v) {
    return String(v || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
}

function setCookie(name, value, days = 30) {
    const d = new Date();
    d.setTime(d.getTime() + (days * 24 * 60 * 60 * 1000));
    document.cookie = `${name}=${encodeURIComponent(JSON.stringify(value))};expires=${d.toUTCString()};path=/;SameSite=Lax`;
    try { localStorage.setItem(name, JSON.stringify(value)); } catch (e) {}
}

function getCookie(name) {
    const nameEQ = name + "=";
    const ca = document.cookie.split(';');
    for (let i = 0; i < ca.length; i++) {
        let c = ca[i].trim();
        if (c.indexOf(nameEQ) === 0) {
            try { return JSON.parse(decodeURIComponent(c.substring(nameEQ.length))); } catch (e) {}
        }
    }
    try {
        const local = localStorage.getItem(name);
        return local ? JSON.parse(local) : null;
    } catch (e) { return null; }
}

// Calls /api/gemini and retries transient failures (network drop, timeout, 429, 5xx) with back-off.
async function fetchGeminiRetry(body, maxTries = 3) {
    let lastResp = null, lastErr = null;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
        if (attempt > 1) await new Promise(r => setTimeout(r, 1200 * (attempt - 1)));
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 60000);
        try {
            const resp = await fetch('/api/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: ctrl.signal
            });
            clearTimeout(timer);
            if (resp.ok || ![408, 429, 500, 502, 503, 504].includes(resp.status)) return resp;
            lastResp = resp;
        } catch (e) {
            clearTimeout(timer);
            lastErr = e;
        }
    }
    if (lastResp) return lastResp;
    throw lastErr || new Error('AI request failed');
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// DOM Elements
const doctorGreetingHeader = document.getElementById('doctorGreetingHeader');
const doctorFilterForm = document.getElementById('doctorFilterForm');
const docNameInput = document.getElementById('docNameInput');
const docClinicCode = document.getElementById('docClinicCode');
const quickClinicSelect = document.getElementById('quickClinicSelect');
const docDepartment = document.getElementById('docDepartment');
const docStatusFilter = document.getElementById('docStatusFilter');
const refreshQueueBtn = document.getElementById('refreshQueueBtn');
const triageQueue = document.getElementById('triageQueue');

// Modals
const priorityConfirmModal = document.getElementById('priorityConfirmModal');
const priorityConfirmBody = document.getElementById('priorityConfirmBody');
const confirmPriorityChangeBtn = document.getElementById('confirmPriorityChangeBtn');
const cancelPriorityChangeBtn = document.getElementById('cancelPriorityChangeBtn');

const paramedicModal = document.getElementById('paramedicModal');
const paramedicModalBody = document.getElementById('paramedicModalBody');
const confirmParamedicDispatchBtn = document.getElementById('confirmParamedicDispatchBtn');
const closeParamedicModalBtn = document.getElementById('closeParamedicModalBtn');

const clinicPassModal = document.getElementById('clinicPassModal');
const clinicSwitchPassForm = document.getElementById('clinicSwitchPassForm');
const switchTargetClinicLabel = document.getElementById('switchTargetClinicLabel');
const switchClinicPassInput = document.getElementById('switchClinicPassInput');
const switchClinicPassError = document.getElementById('switchClinicPassError');
const cancelClinicSwitchBtn = document.getElementById('cancelClinicSwitchBtn');

let currentUser = getCookie('careflow_user') || {
    role: 'doctor',
    name: 'Dr. Ananya Sharma',
    userId: 'DOC_ANANYA_SHARMA',
    clinicCode: 'CARE-101',
    department: 'All'
};

let currentClinic = cleanClinicCode(currentUser.clinicCode) || 'CARE-101';
let currentDepartment = 'All';
let currentCasesList = [];
let pendingPriorityConfirmation = null;
let pendingParamedicCase = null;
let pendingSwitchClinicCode = null;

// Cache for one-click English translations so auto-refreshes preserve translated messages
const doctorChatTranslationCache = {};

const PRIORITY_TIER_WEIGHT = {
    CRITICAL: 3,
    URGENT: 2,
    ROUTINE: 1
};

function getFormattedDocName() {
    const raw = (docNameInput && docNameInput.value.trim()) || currentUser.name || 'Dr. Sharma';
    return raw.toLowerCase().startsWith('dr') ? raw : `Dr. ${raw}`;
}

function getCurrentDoctorId() {
    if (window.CareFlowDoctorAuth && window.CareFlowDoctorAuth.buildDoctorId) {
        return window.CareFlowDoctorAuth.buildDoctorId(getFormattedDocName());
    }
    return currentUser.userId || 'DOC_CLINICIAN';
}

async function recordDoctorActivityInClinic(actionSummary) {
    if (!currentClinic) return;
    const docId = getCurrentDoctorId();
    const displayDocName = getFormattedDocName();
    const nowIso = new Date().toISOString();

    try {
        await fbFetch(`${FIREBASE_URL}/clinics/${currentClinic}/doctors/${docId}.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: docId,
                name: displayDocName,
                department: 'All Departments',
                clinicCode: currentClinic,
                lastActiveAt: nowIso,
                lastAction: actionSummary || 'Active in clinic console'
            })
        });
    } catch (e) {}
}

function buildDoctorActionEntry(caseData, actionLabel, detailsText = '') {
    const docName = getFormattedDocName();
    const docId = getCurrentDoctorId();
    const nowIso = new Date().toISOString();

    const doctorActions = Array.isArray(caseData.doctorActions) ? [...caseData.doctorActions] : [];
    doctorActions.push({
        doctorId: docId,
        doctorName: docName,
        action: actionLabel,
        details: detailsText,
        timestamp: nowIso
    });

    return {
        attendingDoctorId: docId,
        attendingDoctorName: docName,
        lastActionBy: docName,
        lastActionById: docId,
        lastActionType: actionLabel,
        lastActionDetails: detailsText,
        lastActionAt: nowIso,
        doctorActions
    };
}

function initDoctorProfileBar() {
    const displayDocName = getFormattedDocName();

    docNameInput.value = displayDocName;
    docClinicCode.value = currentClinic;
    docDepartment.value = currentDepartment || 'All';

    doctorGreetingHeader.innerHTML = `
        <span class="user-chip">
            🩺 <strong>${escapeHtml(displayDocName)}</strong>
            <small>(Clinic: <strong>${escapeHtml(currentClinic)}</strong> • All Departments)</small>
        </span>
        <a href="clinic.html" class="ghost-btn sm-btn">🏥 View Clinic Console</a>
        <a href="index.html" class="ghost-btn sm-btn">Switch Role</a>
        <button type="button" class="ghost-btn sm-btn" onclick="CareFlowDoctorAuth.signOut()">Sign out</button>
    `;

    const unlockedList = (window.CareFlowDoctorAuth && window.CareFlowDoctorAuth.getUnlockedClinics)
        ? window.CareFlowDoctorAuth.getUnlockedClinics()
        : [currentClinic];
    const clinics = Array.from(new Set([...unlockedList, currentClinic])).filter(Boolean);
    quickClinicSelect.innerHTML = `<option value="">Unlocked Clinics (${clinics.length})...</option>` +
        clinics.map(c => `<option value="${escapeHtml(c)}" ${c === currentClinic ? 'selected' : ''}>🔐 ${escapeHtml(c)}</option>`).join('');
}

quickClinicSelect.addEventListener('change', () => {
    if (quickClinicSelect.value) {
        docClinicCode.value = quickClinicSelect.value;
        doctorFilterForm.dispatchEvent(new Event('submit'));
    }
});

doctorFilterForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const requestedClinic = cleanClinicCode(docClinicCode.value) || currentClinic;
    const requestedDept = docDepartment.value || 'All';
    const docName = getFormattedDocName();

    if (window.CareFlowDoctorAuth && !window.CareFlowDoctorAuth.isClinicUnlocked(requestedClinic)) {
        pendingSwitchClinicCode = requestedClinic;
        switchTargetClinicLabel.textContent = requestedClinic;
        switchClinicPassInput.value = '';
        switchClinicPassError.style.display = 'none';
        clinicPassModal.style.display = 'flex';
        switchClinicPassInput.focus();
        return;
    }

    currentClinic = requestedClinic;
    currentDepartment = requestedDept;
    currentUser = {
        ...currentUser,
        role: 'doctor',
        name: docName,
        userId: getCurrentDoctorId(),
        clinicCode: currentClinic,
        department: currentDepartment
    };
    setCookie('careflow_user', currentUser, 30);

    initDoctorProfileBar();
    await recordDoctorActivityInClinic('Loaded clinic triage queue');
    fetchCloudQueue();
});

if (switchClinicPassInput) {
    switchClinicPassInput.addEventListener('input', () => {
        switchClinicPassInput.value = switchClinicPassInput.value.replace(/\D/g, '').slice(0, 4);
        switchClinicPassError.style.display = 'none';
    });
}

if (clinicSwitchPassForm) {
    clinicSwitchPassForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!pendingSwitchClinicCode) return;

        const pin = switchClinicPassInput.value.trim();
        const docName = getFormattedDocName();
        const submitBtn = document.getElementById('switchClinicSubmitBtn');

        submitBtn.disabled = true;
        submitBtn.textContent = 'Verifying...';

        const res = await window.CareFlowDoctorAuth.verifyClinicAndAssociateDoctor(
            docName,
            pendingSwitchClinicCode,
            pin
        );

        submitBtn.disabled = false;
        submitBtn.textContent = 'Verify & Load Clinic';

        if (!res.ok) {
            switchClinicPassError.textContent = res.reason;
            switchClinicPassError.style.display = 'block';
            switchClinicPassInput.value = '';
            switchClinicPassInput.focus();
            return;
        }

        window.CareFlowDoctorAuth.markClinicUnlocked(
            res.clinicCode,
            res.clinicName,
            res.displayName,
            res.doctorId
        );

        clinicPassModal.style.display = 'none';
        currentClinic = res.clinicCode;
        currentDepartment = 'All';
        docDepartment.value = 'All';

        currentUser = {
            ...currentUser,
            role: 'doctor',
            name: res.displayName,
            userId: res.doctorId,
            clinicCode: currentClinic,
            department: 'All'
        };
        setCookie('careflow_user', currentUser, 30);

        pendingSwitchClinicCode = null;
        initDoctorProfileBar();
        fetchCloudQueue();
    });
}

if (cancelClinicSwitchBtn) {
    cancelClinicSwitchBtn.addEventListener('click', () => {
        clinicPassModal.style.display = 'none';
        pendingSwitchClinicCode = null;
        docClinicCode.value = currentClinic;
        quickClinicSelect.value = currentClinic;
    });
}

refreshQueueBtn.addEventListener('click', () => fetchCloudQueue());
docDepartment.addEventListener('change', () => {
    currentDepartment = docDepartment.value || 'All';
    fetchCloudQueue();
});
docStatusFilter.addEventListener('change', () => fetchCloudQueue());

function sortCasesByPriority(cases) {
    return cases.sort((a, b) => {
        const prioA = (a.triage && a.triage.priority) || 'ROUTINE';
        const prioB = (b.triage && b.triage.priority) || 'ROUTINE';
        const weightDiff = (PRIORITY_TIER_WEIGHT[prioB] || 1) - (PRIORITY_TIER_WEIGHT[prioA] || 1);
        if (weightDiff !== 0) return weightDiff;

        const offsetA = typeof a.manualOrderOffset === 'number' ? a.manualOrderOffset : 0;
        const offsetB = typeof b.manualOrderOffset === 'number' ? b.manualOrderOffset : 0;
        if (offsetB !== offsetA) return offsetB - offsetA;

        // Within the same tier, the lower ESI number (more acute) comes first: ESI 1 before ESI 2, ESI 4 before ESI 5
        const lvlDiff = CareflowESI.levelOfCase(a.triage) - CareflowESI.levelOfCase(b.triage);
        if (lvlDiff !== 0) return lvlDiff;

        return new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
    });
}

async function fetchCloudQueue(silent = false) {
    const activeClinic = cleanClinicCode(currentClinic || docClinicCode.value);
    if (!activeClinic) return;
    currentClinic = activeClinic;

    if (!silent) {
        triageQueue.innerHTML = `<div class="loading-box">Syncing all cases for clinic <strong>${escapeHtml(currentClinic)}</strong>...</div>`;
    }

    try {
        const response = await fbFetch(`${FIREBASE_URL}/clinics/${currentClinic}/cases.json`);
        const data = await response.json();

        if (!data || typeof data !== 'object') {
            updateQueueStats([]);
            triageQueue.innerHTML = `
                <div class="empty-state">
                    <h3>No patient cases found in clinic ${escapeHtml(currentClinic)}</h3>
                    <p>Patients can submit cases to this clinic on the Patient Portal using code <strong>${escapeHtml(currentClinic)}</strong>.</p>
                </div>`;
            return;
        }

        const allCases = Object.entries(data)
            .filter(([, val]) => val && typeof val === 'object')
            .map(([key, val]) => ({
                ...val,
                id: val.id || key,
                clinicCode: val.clinicCode || currentClinic
            }));

        const statusFilter = docStatusFilter.value || 'ALL';
        const deptFilter = docDepartment.value || 'All';

        const filtered = allCases.filter(c => {
            const dept = (c.triage && c.triage.suggestedDepartment) || 'General Medicine';
            const matchDept = deptFilter === 'All' || dept.toLowerCase().includes(deptFilter.toLowerCase());

            let matchStatus = true;
            if (statusFilter === 'ACTIVE') {
                matchStatus = c.status !== 'DISSOLVED';
            } else if (statusFilter !== 'ALL') {
                matchStatus = (c.status || 'PENDING_REVIEW') === statusFilter;
            }
            return matchDept && matchStatus;
        });

        currentCasesList = sortCasesByPriority(filtered);
        updateQueueStats(currentCasesList);

        triageQueue.innerHTML = '';
        if (currentCasesList.length === 0) {
            triageQueue.innerHTML = `
                <div class="empty-state">
                    <h3>No cases match the selected filter (${escapeHtml(deptFilter)} • ${escapeHtml(statusFilter)})</h3>
                    <p>Total cases in clinic <strong>${escapeHtml(currentClinic)}</strong>: ${allCases.length}. Set filters above to "All Departments" and "All Cases" to see all cases.</p>
                </div>`;
            return;
        }

        currentCasesList.forEach((caseData, index) => {
            triageQueue.appendChild(renderDoctorCaseCard(caseData, index, currentCasesList.length));
        });
    } catch (err) {
        triageQueue.innerHTML = `<div class="status-banner status-error">Error loading clinic queue: ${escapeHtml(err.message)}</div>`;
    }
}

function updateQueueStats(cases) {
    document.getElementById('countCritical').textContent = cases.filter(c => c.triage?.priority === 'CRITICAL').length;
    document.getElementById('countUrgent').textContent = cases.filter(c => c.triage?.priority === 'URGENT').length;
    document.getElementById('countRoutine').textContent = cases.filter(c => (c.triage?.priority || 'ROUTINE') === 'ROUTINE').length;
    const attEl = document.getElementById('countAttending');
    if (attEl) {
        attEl.textContent = cases.filter(c => c.status === 'ATTENDING' || c.attendingDoctorName || c.reviewedBy).length;
    }
    document.getElementById('countTotal').textContent = cases.length;
}

// ============================================================================
// ONE-CLICK PATIENT MESSAGE TRANSLATION TO CLEAN ENGLISH (DOCTOR VIEW)
// ============================================================================
window.translatePatientMsgToEnglish = async function(caseId, msgIndex) {
    const caseData = currentCasesList.find(c => c.id === caseId);
    if (!caseData || !Array.isArray(caseData.messages) || !caseData.messages[msgIndex]) return;

    const msg = caseData.messages[msgIndex];
    const cacheKey = `${caseId}_${msgIndex}`;
    const btn = document.getElementById(`docTransBtn_${cacheKey}`);
    const outBox = document.getElementById(`docTransBox_${cacheKey}`);

    if (!outBox) return;

    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Translating...';
    }

    try {
        const res = await fetchGeminiRetry({
                mode: 'translate',
                text: msg.text,
                targetLanguage: 'English',
                viewerRole: 'doctor'
            });

        if (!res.ok) {
            let errDetail = '';
            try { const j = await res.json(); errDetail = j.details || j.error || ''; } catch (_) {}
            throw new Error(errDetail || `HTTP ${res.status}`);
        }

        const data = await res.json();
        const translatedText = data.translatedText || msg.text;
        const detectedLanguage = data.detectedLanguage || 'Mixed / Regional';

        doctorChatTranslationCache[cacheKey] = {
            translatedText,
            detectedLanguage
        };

        outBox.style.display = 'block';
        outBox.innerHTML = `
            <div class="translated-meta">🌐 Clean English Translation <small>(from ${escapeHtml(detectedLanguage)})</small>:</div>
            <div class="translated-text">${escapeHtml(translatedText)}</div>
        `;
        if (btn) {
            btn.disabled = false;
            btn.textContent = '✓ Translated to English';
        }
    } catch (err) {
        outBox.style.display = 'block';
        outBox.innerHTML = `<span class="src-unsure">⚠️ Translation unavailable: ${escapeHtml(err.message)}</span>`;
        if (btn) {
            btn.disabled = false;
            btn.textContent = '🌐 Retry Translate';
        }
    }
};

window.translateAllPatientMsgsInCase = async function(caseId) {
    const caseData = currentCasesList.find(c => c.id === caseId);
    if (!caseData || !Array.isArray(caseData.messages)) return;

    const tasks = [];
    caseData.messages.forEach((m, idx) => {
        if (m.senderRole === 'patient' && m.text) {
            tasks.push(window.translatePatientMsgToEnglish(caseId, idx));
        }
    });
    await Promise.all(tasks);
};

// ============================================================================
// SOURCE LINKS, VOICE PLAYBACK & DATE FORMATTING HELPERS
// ============================================================================
function fmtDateTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function sourceKey(label) {
    const s = String(label || '').toLowerCase();
    if (s.includes('voice')) return 'voice';
    if (s.includes('report') || s.includes('ocr')) return 'report';
    if (s.includes('chat')) return 'chat';
    return 'patient';
}

function safeDataUrl(u, kind) {
    return (typeof u === 'string' && u.startsWith(`data:${kind}/`) && !/["'<>\s]/.test(u)) ? u : '';
}

function audioPlayerHtml(url) {
    return `<audio controls preload="none" src="${url}" style="width:100%;"></audio>`;
}

const voiceCache = {};
const sourcePanelState = {};

window.trackSourcePanel = function(caseId, isOpen) {
    sourcePanelState[caseId] = !!isOpen;
};

window.jumpToSource = function(caseId, key) {
    let target;
    if (key === 'chat') {
        target = document.getElementById(`docChatBox_${caseId}`);
    } else {
        const panel = document.getElementById(`srcPanel_${caseId}`);
        if (panel && !panel.open) { panel.open = true; sourcePanelState[caseId] = true; }
        target = document.getElementById(`src_${caseId}_${key}`);
    }
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('source-flash');
    setTimeout(() => target.classList.remove('source-flash'), 1800);
};

window.loadVoiceNote = async function(caseId) {
    const box = document.getElementById(`voiceBox_${caseId}`);
    if (!box) return;
    box.innerHTML = '<span class="text-muted">Loading voice note…</span>';
    try {
        const res = await fbFetch(`${FIREBASE_URL}/clinics/${currentClinic}/media/${caseId}.json`);
        const media = await res.json();
        const url = media ? safeDataUrl(media.audio, 'audio') : '';
        if (!url) {
            box.innerHTML = '<span class="src-unsure">Voice note not available (it may not have been saved, or was deleted).</span>';
            return;
        }
        voiceCache[caseId] = url;
        box.innerHTML = audioPlayerHtml(url);
    } catch (err) {
        box.innerHTML = `<span class="src-unsure">Could not load voice note: ${escapeHtml(err.message)}</span>`;
    }
};

// ============================================================================
// 3 DYNAMIC AI SUGGESTION BUBBLES INSIDE DOCTOR CHAT
// ============================================================================
function getFollowUpState(caseData) {
    const fu = caseData.followUps || null;
    const history = fu && Array.isArray(fu.history) ? fu.history : [];
    const active = fu
        ? (Array.isArray(fu.active) ? fu.active.slice(0, 3) : [])
        : (Array.isArray(caseData.triage && caseData.triage.followUpQuestions)
            ? caseData.triage.followUpQuestions.slice(0, 3)
            : []);
    return { active, history };
}

function normQ(s) {
    return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function wordOverlap(a, b) {
    const A = new Set(normQ(a).split(' ').filter(Boolean));
    const B = new Set(normQ(b).split(' ').filter(Boolean));
    if (!A.size || !B.size) return 0;
    let hit = 0;
    A.forEach(w => { if (B.has(w)) hit++; });
    return hit / Math.min(A.size, B.size);
}

function findUsedSuggestions(text, active) {
    const nm = normQ(text);
    const words = nm ? nm.split(' ').length : 0;
    return active.filter(q => {
        const nq = normQ(q);
        if (!nq || !nm) return false;
        if (nm.includes(nq)) return true;
        if (nm.length >= 12 && nq.includes(nm)) return true;
        return words >= 4 && wordOverlap(text, q) >= 0.8;
    });
}

// Click on any of the 3 suggestion bubbles inside chat -> Immediately sends to patient & keeps other bubbles visible
window.sendSuggestedBubble = async function(caseId, bubbleIdx) {
    const caseData = currentCasesList.find(c => c.id === caseId);
    if (!caseData) return;

    const fuState = getFollowUpState(caseData);
    const questionText = fuState.active[bubbleIdx];
    if (!questionText) return;

    const btnEl = document.getElementById(`docBubbleBtn_${caseId}_${bubbleIdx}`);
    if (btnEl) {
        btnEl.disabled = true;
        btnEl.textContent = '⏳ Sending to patient...';
    }

    const docName = getFormattedDocName();
    const nowIso = new Date().toISOString();

    const messages = Array.isArray(caseData.messages) ? [...caseData.messages] : [];
    messages.push({
        id: 'MSG-' + Date.now(),
        senderRole: 'doctor',
        senderName: docName,
        text: questionText,
        timestamp: nowIso
    });

    // Remove only the clicked bubble; keep the remaining 1 or 2 bubbles visible for the doctor
    const remainingActive = fuState.active.filter((_, i) => i !== bubbleIdx);
    const updatedHistory = [
        ...fuState.history,
        {
            question: questionText,
            status: 'ASKED',
            askedAt: nowIso,
            askedBy: docName
        }
    ];

    const auditLog = Array.isArray(caseData.auditLog) ? [...caseData.auditLog] : [];
    auditLog.push({
        timestamp: nowIso,
        actor: docName,
        action: `Sent AI-suggested follow-up bubble in chat: "${questionText.substring(0, 90)}"`
    });

    const actionMeta = buildDoctorActionEntry(caseData, 'Attending & Asked Follow-Up in Chat', questionText.substring(0, 120));

    try {
        await fbFetch(`${FIREBASE_URL}/clinics/${currentClinic}/cases/${caseId}.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                status: caseData.status === 'PENDING_REVIEW' ? 'ATTENDING' : caseData.status,
                messages,
                followUps: {
                    active: remainingActive,
                    history: updatedHistory,
                    updatedAt: (caseData.followUps && caseData.followUps.updatedAt) || caseData.timestamp || nowIso
                },
                auditLog,
                ...actionMeta
            })
        });
        await recordDoctorActivityInClinic(`Asked follow-up question on Case #${caseId}`);
        await fetchCloudQueue();
    } catch (err) {
        alert("Failed to send suggested question: " + err.message);
        if (btnEl) {
            btnEl.disabled = false;
            btnEl.textContent = questionText;
        }
    }
};

function renderDoctorCaseCard(caseData, index, totalCount) {
    const t = caseData.triage || {};
    const priority = t.priority || 'ROUTINE';
    const priorityClass = `priority-${priority.toLowerCase()}`;
    const isDissolved = caseData.status === 'DISSOLVED';
    const isEmergency = caseData.status === 'EMERGENCY_DISPATCHED' || !!caseData.paramedicDispatch;

    const handlerDoc = caseData.attendingDoctorName || caseData.reviewedBy || caseData.lastActionBy || null;
    const lastActionLabel = caseData.lastActionType || (caseData.status === 'ATTENDING' ? 'Attending Case' : null);

    const symptomsHtml = Array.isArray(t.standardizedSymptoms) && t.standardizedSymptoms.length
        ? t.standardizedSymptoms.map(s => `<li>${escapeHtml(s)}</li>`).join('')
        : '<li>None extracted</li>';

    const warningSignsHtml = Array.isArray(t.warningSigns) && t.warningSigns.length
        ? `<div class="warning-signs-box">🚨 <strong>Red Flag Warning Signs:</strong> ${t.warningSigns.map(w => `<span class="red-flag-chip">${escapeHtml(w)}</span>`).join(' ')}</div>`
        : '';

    const sourceLinks = Array.isArray(t.sourceLinks) && t.sourceLinks.length
        ? t.sourceLinks
        : [
            ...(caseData.symptomsText ? [{ claim: caseData.symptomsText, source: 'Patient Text', confidence: 'High' }] : []),
            ...(caseData.hasAudio ? [{ claim: 'Audio symptom description', source: 'Voice Recording', confidence: 'High' }] : []),
            ...(caseData.hasImage ? [{ claim: 'Uploaded clinical document', source: 'Medical Report OCR', confidence: 'Medium' }] : [])
        ];

    const sourcesHtml = sourceLinks.map(s => `
        <div class="source-link-item">
            <button type="button" class="source-tag source-tag-btn" title="Jump to the original source" onclick="jumpToSource('${caseData.id}', '${sourceKey(s.source)}')">${escapeHtml(s.source || 'Unknown source')} ↗</button>
            <span>${escapeHtml(s.claim)}</span>
            <small class="conf-tag">Confidence: ${escapeHtml(s.confidence || 'High')}</small>
            ${s.evidence ? `<div class="source-evidence">“${escapeHtml(s.evidence)}”</div>` : ''}
        </div>
    `).join('');

    const esiLevelNow = CareflowESI.levelOfCase(t);
    const esiInfo = t.esi || null;
    const esiBasisHtml = `
        <details class="esi-basis">
            <summary>🧭 ESI triage basis &mdash; <strong>${escapeHtml(CareflowESI.levelDisplay(esiLevelNow))}</strong> → ${escapeHtml(priority)}${t.esiOverride ? ' (clinician override)' : ''}</summary>
            ${esiInfo ? `
                <div class="esi-basis-body">
                    <div><strong>Standard:</strong> ${escapeHtml(esiInfo.standard || 'ESI v4')} &bull; <strong>Decision point:</strong> ${escapeHtml(String(esiInfo.decisionPoint || 'n/a'))}</div>
                    <ul>${(esiInfo.rationale || []).map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
                    ${(esiInfo.resources && esiInfo.resources.categories && esiInfo.resources.categories.length) ? `<div><strong>Expected resources (${escapeHtml(String(esiInfo.resources.count))}):</strong> ${esiInfo.resources.categories.map(r => escapeHtml(r.label + (r.reason ? ' — ' + r.reason : ''))).join('; ')}</div>` : ''}
                    ${(esiInfo.dangerZone && esiInfo.dangerZone.exceeded) ? `<div><strong>Danger-zone vitals:</strong> ${esiInfo.dangerZone.details.map(escapeHtml).join('; ')}</div>` : ''}
                    ${esiInfo.fallback ? '<div><em>AI was unavailable — rule-based ESI fallback; please verify manually.</em></div>' : ''}
                </div>` : `<div class="esi-basis-body"><em>Legacy case (triaged before ESI was introduced) — tier shown only.</em></div>`}
        </details>`;

    const vitals = t.extractedVitals || {};
    const vitalsHtml = `
        <div class="vitals-strip">
            <span>🌡️ Temp: <strong>${escapeHtml(vitals.temperature || 'N/A')}</strong></span>
            <span>❤️ HR: <strong>${escapeHtml(vitals.heart_rate || 'N/A')}</strong></span>
            <span>🩸 BP: <strong>${escapeHtml(vitals.blood_pressure || 'N/A')}</strong></span>
            <span>🫁 SpO₂: <strong>${escapeHtml(vitals.spo2 || 'N/A')}</strong></span>
        </div>
    `;

    const flagItems = [];
    if (Array.isArray(t.missingInformation) && t.missingInformation.length) {
        flagItems.push(`<div><strong>Missing Clinical Context:</strong> ${escapeHtml(t.missingInformation.join('; '))}</div>`);
    }
    if (Array.isArray(t.conflictsDetected) && t.conflictsDetected.length) {
        flagItems.push(`<div><strong>⚠️ Conflicting Information Detected:</strong> ${escapeHtml(t.conflictsDetected.join('; '))}</div>`);
    }
    if (Array.isArray(t.uncertaintyNotes) && t.uncertaintyNotes.length) {
        flagItems.push(`<div><strong>🔍 Transcription / OCR Uncertainty:</strong> ${escapeHtml(t.uncertaintyNotes.join('; '))}</div>`);
    }
    if (t.suspiciousInputFlag) {
        flagItems.push(`<div><strong>🛡️ Security Alert:</strong> Input contained suspicious or adversarial prompt instructions. Verify raw patient input carefully.</div>`);
    }

    const alertHtml = (flagItems.length > 0 || t.confidenceFlag === false)
        ? `<div class="alert-box">${flagItems.join('') || '⚠️ Low AI confidence flag triggered. Manual verification required.'}</div>`
        : '';

    // 3 AI Suggested Question Bubbles (rendered inside the chat box)
    const fuState = getFollowUpState(caseData);
    const suggestionBubblesHtml = (!isDissolved && fuState.active.length > 0) ? `
        <div class="doc-chat-suggestions-bar">
            <div class="doc-suggestions-header">
                <span>🤖 <strong>AI Quick-Ask Bubbles (${fuState.active.length}/3):</strong> Click any bubble to send immediately — all 3 refresh dynamically when the patient replies</span>
            </div>
            <div class="doc-suggestion-bubbles">
                ${fuState.active.map((q, qIdx) => `
                    <button
                        type="button"
                        id="docBubbleBtn_${caseData.id}_${qIdx}"
                        class="doc-suggestion-bubble-btn"
                        title="Click to send this question to the patient"
                        onclick="sendSuggestedBubble('${caseData.id}', ${qIdx})"
                    >
                        <span class="bubble-q-text">${escapeHtml(q)}</span>
                        <span class="bubble-send-icon">Send ➤</span>
                    </button>
                `).join('')}
            </div>
        </div>
    ` : (!isDissolved ? `
        <div class="doc-chat-suggestions-bar">
            <div class="doc-suggestions-header">
                <span>⏳ All 3 suggested questions sent — 3 new clinical questions will appear automatically as soon as the patient replies.</span>
            </div>
        </div>
    ` : '');

    // Messages with 1-Click "Translate to English" on Patient messages
    const messages = Array.isArray(caseData.messages) ? caseData.messages : [];
    const chatHtml = messages.map((m, idx) => {
        const isPatientMsg = m.senderRole === 'patient';
        const cacheKey = `${caseData.id}_${idx}`;
        const cached = doctorChatTranslationCache[cacheKey];

        return `
            <div class="chat-bubble ${m.senderRole === 'doctor' ? 'chat-doctor' : (m.senderRole === 'system' ? 'chat-system' : 'chat-patient')}">
                <div class="chat-meta">
                    <strong>${escapeHtml(m.senderName)}</strong>
                    <span>${fmtDateTime(m.timestamp)}</span>
                </div>
                <div class="chat-text">${escapeHtml(m.text)}</div>
                ${isPatientMsg ? `
                    <div class="chat-translate-row">
                        <button type="button" id="docTransBtn_${cacheKey}" class="translate-chip-btn" onclick="translatePatientMsgToEnglish('${caseData.id}', ${idx})">
                            ${cached ? '✓ Translated to English' : '🌐 Translate to English'}
                        </button>
                    </div>
                    <div id="docTransBox_${cacheKey}" class="chat-translated-box" style="display: ${cached ? 'block' : 'none'};">
                        ${cached ? `
                            <div class="translated-meta">🌐 Clean English Translation <small>(from ${escapeHtml(cached.detectedLanguage)})</small>:</div>
                            <div class="translated-text">${escapeHtml(cached.translatedText)}</div>
                        ` : ''}
                    </div>
                ` : ''}
            </div>
        `;
    }).join('');

    const audits = Array.isArray(caseData.auditLog) ? caseData.auditLog : [];
    const auditHtml = audits.map(a => `
        <li><strong>${fmtDateTime(a.timestamp)}</strong> — <em>${escapeHtml(a.actor)}:</em> ${escapeHtml(a.action)}</li>
    `).join('');

    const src = t.sources || {};
    const srcPatient = src.patientText || {};
    const srcVoice = src.voice || {};
    const srcReport = src.report || {};
    const listText = (arr) => (Array.isArray(arr) && arr.length) ? arr.map(escapeHtml).join('; ') : '';
    const cachedVoice = voiceCache[caseData.id];

    const patientBlock = caseData.symptomsText ? `
        <div class="src-block" id="src_${caseData.id}_patient">
            <div class="src-title">📝 Patient Text</div>
            <div class="src-text"><strong>Original${srcPatient.language ? ' (' + escapeHtml(srcPatient.language) + ')' : ''}:</strong> ${escapeHtml(caseData.symptomsText)}</div>
            ${(srcPatient.english && String(srcPatient.english).trim() !== String(caseData.symptomsText).trim()) ? `<div class="src-text"><strong>English translation:</strong> ${escapeHtml(srcPatient.english)}</div>` : ''}
        </div>` : '';

    const voiceBlock = caseData.hasAudio ? `
        <div class="src-block" id="src_${caseData.id}_voice">
            <div class="src-title">🎙️ Voice Recording</div>
            <div id="voiceBox_${caseData.id}">${cachedVoice ? audioPlayerHtml(cachedVoice) : `<button type="button" class="chip-btn" onclick="loadVoiceNote('${caseData.id}')">▶ Load voice note</button>`}</div>
            ${srcVoice.transcript ? `<div class="src-text"><strong>Transcript${srcVoice.language ? ' (' + escapeHtml(srcVoice.language) + ')' : ''}:</strong> ${escapeHtml(srcVoice.transcript)}</div>` : ''}
            ${srcVoice.english ? `<div class="src-text"><strong>English translation:</strong> ${escapeHtml(srcVoice.english)}</div>` : ''}
            ${listText(srcVoice.unclearParts) ? `<div class="src-unsure">❓ Unclear: ${listText(srcVoice.unclearParts)}</div>` : ''}
        </div>` : '';

    const reportImg = safeDataUrl(caseData.imagePreviewData, 'image');
    const reportBlock = (caseData.hasImage || srcReport.extractedText) ? `
        <div class="src-block" id="src_${caseData.id}_report">
            <div class="src-title">📄 Medical Report</div>
            ${reportImg ? `<img class="report-thumb" src="${reportImg}" alt="Attached medical report" title="Click to enlarge / shrink" onclick="this.classList.toggle('report-thumb-big')">` : ''}
            ${srcReport.extractedText ? `<div class="src-text"><strong>Text read from the report (OCR):</strong> ${escapeHtml(srcReport.extractedText)}</div>` : ''}
            ${listText(srcReport.unreadableParts) ? `<div class="src-unsure">❓ Hard to read: ${listText(srcReport.unreadableParts)}</div>` : ''}
        </div>` : '';

    const panelOpen = (caseData.id in sourcePanelState) ? sourcePanelState[caseData.id] : !!t.translationUncertain;
    const sourcesPanelHtml = (patientBlock || voiceBlock || reportBlock) ? `
        <details class="original-sources" id="srcPanel_${caseData.id}" ${panelOpen ? 'open' : ''} ontoggle="trackSourcePanel('${caseData.id}', this.open)">
            <summary>🔎 Original sources &mdash; verify what the AI read</summary>
            ${patientBlock}${voiceBlock}${reportBlock}
        </details>` : '';

    const firstSourceKey = caseData.symptomsText ? 'patient' : (caseData.hasAudio ? 'voice' : 'report');
    const translationBannerHtml = t.translationUncertain ? `
        <div class="translation-banner">
            🌐 <strong>Translation / transcription uncertain &mdash; please verify against the original input.</strong>
            ${(Array.isArray(t.translationUncertaintyReasons) && t.translationUncertaintyReasons.length) ? `<ul>${t.translationUncertaintyReasons.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : ''}
            <button type="button" class="chip-btn" onclick="jumpToSource('${caseData.id}', '${firstSourceKey}')">See original input ↗</button>
        </div>` : '';

    const card = document.createElement('div');
    card.className = `triage-card ${priorityClass} ${isDissolved ? 'case-dissolved' : ''}`;
    card.innerHTML = `
        <div class="triage-card-layout">
            <!-- Left Reddit-Style Upvote / Downvote Priority Column -->
            <div class="vote-column">
                <button type="button" class="vote-btn vote-up" title="Move Case Higher in Priority Queue" onclick="moveCaseOrder('${caseData.id}', 'up')" ${index === 0 ? 'disabled' : ''}>▲</button>
                <span class="queue-rank-num">#${index + 1}</span>
                <button type="button" class="vote-btn vote-down" title="Move Case Lower in Priority Queue" onclick="moveCaseOrder('${caseData.id}', 'down')" ${index === totalCount - 1 ? 'disabled' : ''}>▼</button>
            </div>

            <!-- Right Main Case Content -->
            <div class="case-main-column">
                <div class="card-header">
                    <div class="patient-info">
                        <h3>
                            ${escapeHtml(caseData.patientName)}
                            <span class="demog-pill">${escapeHtml(caseData.patientAge)}y • ${escapeHtml(caseData.patientGender)}</span>
                            <span class="status-pill status-${(caseData.status || 'PENDING_REVIEW').toLowerCase()}">${escapeHtml((caseData.status || 'PENDING_REVIEW').replace(/_/g, ' '))}</span>
                            <span class="doctor-owner-pill ${handlerDoc ? 'owner-me' : ''}">
                                🩺 ${handlerDoc ? `${escapeHtml(handlerDoc)}${lastActionLabel ? ' • ' + escapeHtml(lastActionLabel) : ''}` : 'Awaiting Doctor Attendance'}
                            </span>
                        </h3>
                        <div class="patient-meta">
                            Case <strong>#${escapeHtml(caseData.id)}</strong> | Clinic: <strong>${escapeHtml(caseData.clinicCode)}</strong> |
                            Submitted: ${new Date(caseData.timestamp).toLocaleString()} |
                            Dept: <strong>${escapeHtml(t.suggestedDepartment || 'General Medicine')}</strong>
                        </div>
                    </div>

                    <div class="header-badges">
                        <span class="priority-badge">${escapeHtml(priority)} · ESI ${esiLevelNow}</span>
                        <select class="priority-select-inline" onchange="handleDirectPrioritySelect('${caseData.id}', this.value)" title="Change ESI level (1-2 Critical, 3 Urgent, 4-5 Routine)">
                            <option value="1" ${esiLevelNow === 1 ? 'selected' : ''}>🔴 ESI 1 · Resuscitation</option>
                            <option value="2" ${esiLevelNow === 2 ? 'selected' : ''}>🔴 ESI 2 · Emergent</option>
                            <option value="3" ${esiLevelNow === 3 ? 'selected' : ''}>🟠 ESI 3 · Urgent</option>
                            <option value="4" ${esiLevelNow === 4 ? 'selected' : ''}>🟢 ESI 4 · Less urgent</option>
                            <option value="5" ${esiLevelNow === 5 ? 'selected' : ''}>🟢 ESI 5 · Non-urgent</option>
                        </select>
                    </div>
                </div>

                ${isEmergency ? `
                    <div class="emergency-banner">
                        🚑 <strong>PARAMEDIC TEAM DISPATCHED:</strong> Forwarded by ${escapeHtml(caseData.paramedicDispatch?.dispatchedBy || 'Doctor')} at ${escapeHtml(caseData.paramedicDispatch?.dispatchedAt || '')} (Dispatch Ref: ${escapeHtml(caseData.paramedicDispatch?.dispatchId || 'EMS-911')}).
                    </div>
                ` : ''}

                ${translationBannerHtml}${warningSignsHtml}${esiBasisHtml}${vitalsHtml}

                <div class="card-body-grid">
                    <div>
                        <div class="section-title">Structured Clinical Summary &amp; Timeline</div>
                        <div class="clinical-summary-box">
                            <p style="margin:0 0 6px 0;">${escapeHtml(t.clinicalSummary || caseData.symptomsText || 'No summary available.')}</p>
                            <small><strong>Onset &amp; Progression:</strong> ${escapeHtml(t.symptomTimeline || caseData.symptomOnset || 'Not specified')}</small>
                        </div>

                        <div class="section-title">Standardized Symptoms</div>
                        <ul>${symptomsHtml}</ul>
                    </div>

                    <div>
                        <div class="section-title">Source Attribution Links</div>
                        <div class="sources-list">${sourcesHtml}</div>

                        ${sourcesPanelHtml}

                        ${alertHtml}

                        <div class="ai-chat-summary-box">
                            <strong>🤖 AI Live Chat Analysis:</strong>
                            <p style="margin:4px 0 0 0;">${escapeHtml(caseData.chatAiSummary || 'No follow-up patient chat updates yet.')}</p>
                        </div>
                    </div>
                </div>

                <!-- Doctor-Patient Case Chat (with 3 Click-to-Send AI Suggestion Bubbles inside) -->
                <div class="chat-section doctor-chat-section">
                    <div class="chat-header-bar">
                        <span>💬 Direct Patient Consultation Chat (${messages.length})</span>
                        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                            <button type="button" class="translate-chip-btn" onclick="translateAllPatientMsgsInCase('${caseData.id}')">🌐 Translate All Patient Messages → English</button>
                            <small>Patient replies are automatically summarized &amp; re-triaged by AI</small>
                        </div>
                    </div>
                    <div class="chat-messages-box" id="docChatBox_${caseData.id}">
                        ${chatHtml}
                    </div>

                    <!-- 3 Click-to-Send AI Suggested Question Bubbles Inside Chat -->
                    ${suggestionBubblesHtml}

                    ${!isDissolved ? `
                        <div class="chat-input-row">
                            <input type="text" id="docChatInput_${caseData.id}" placeholder="Or type a custom message / medicine advice to the patient...">
                            <button type="button" class="primary-btn sm-btn" onclick="sendDoctorChatMessage('${caseData.id}')">Send to Patient</button>
                        </div>
                    ` : ''}
                </div>

                <!-- Editable Final Referral / Triage Note -->
                <div class="referral-note-box">
                    <label for="doctorNote_${caseData.id}">✍️ Final Clinician Triage &amp; Referral Note (Review, Edit &amp; Approve):</label>
                    <textarea id="doctorNote_${caseData.id}" rows="2" placeholder="Approve or edit AI triage note, prescribe initial relief (e.g. Tab Paracetamol 650mg SOS), or refer to OPD/ER...">${escapeHtml(caseData.doctorNote || t.clinicalSummary || '')}</textarea>
                </div>

                <!-- Action Controls -->
                <div class="card-actions-bar">
                    ${!isDissolved ? `
                        <button type="button" class="secondary-btn" onclick="attendToCase('${caseData.id}')">🩺 Attend Case</button>
                    ` : ''}
                    <button type="button" class="approve-btn" onclick="approveAndSend('${caseData.id}')">✓ Approve &amp; Save Referral Note</button>
                    <button type="button" class="emergency-btn" onclick="openParamedicDispatchModal('${caseData.id}')">🚨 Mark Emergency (Paramedic Team)</button>
                    ${!isDissolved ? `
                        <button type="button" class="override-btn" onclick="requestPatientClosure('${caseData.id}')">📩 Ask Patient to Close</button>
                        <button type="button" class="override-btn" onclick="dissolveCaseDirectly('${caseData.id}')">✓ Dissolve Case</button>
                    ` : ''}
                    <button type="button" class="delete-btn" onclick="purgeRecord('${caseData.id}')">🗑️ Purge Record</button>
                </div>

                <!-- Collapsible Audit Trail -->
                <details class="audit-details">
                    <summary>🛡️ View Clinical &amp; AI Audit Trail (${audits.length} events)</summary>
                    <ul class="audit-list">${auditHtml}</ul>
                </details>
            </div>
        </div>
    `;

    return card;
}

// ============================================================================
// DOCTOR ACTION: ATTEND TO CASE (ANY DEPARTMENT)
// ============================================================================
window.attendToCase = async function(caseId) {
    const caseData = currentCasesList.find(c => c.id === caseId);
    if (!caseData) return;

    const docName = getFormattedDocName();
    const nowIso = new Date().toISOString();
    const dept = caseData.triage?.suggestedDepartment || 'General Medicine';

    const messages = Array.isArray(caseData.messages) ? [...caseData.messages] : [];
    messages.push({
        id: 'MSG-' + Date.now(),
        senderRole: 'system',
        senderName: 'CareFlow Clinic Console',
        text: `${docName} is now attending to your case (#${caseId} • ${dept}).`,
        timestamp: nowIso
    });

    const auditLog = Array.isArray(caseData.auditLog) ? [...caseData.auditLog] : [];
    auditLog.push({
        timestamp: nowIso,
        actor: docName,
        action: `Started attending case (#${caseId} • ${dept}).`
    });

    const actionMeta = buildDoctorActionEntry(caseData, 'Attending Case', `Attending ${dept} case`);

    try {
        await fbFetch(`${FIREBASE_URL}/clinics/${currentClinic}/cases/${caseId}.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                status: caseData.status === 'EMERGENCY_DISPATCHED' ? 'EMERGENCY_DISPATCHED' : 'ATTENDING',
                ...actionMeta,
                messages,
                auditLog
            })
        });
        await recordDoctorActivityInClinic(`Attending Case #${caseId} (${caseData.patientName})`);
        await fetchCloudQueue();
    } catch (err) {
        alert('Failed to mark case as attending: ' + err.message);
    }
};

// ============================================================================
// REDDIT-STYLE UPVOTE / DOWNVOTE QUEUE ORDERING & CRITICAL CONFIRMATION POPUP
// ============================================================================
window.moveCaseOrder = async function(caseId, direction) {
    const idx = currentCasesList.findIndex(c => c.id === caseId);
    if (idx === -1) return;

    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= currentCasesList.length) return;

    const movingCase = currentCasesList[idx];
    const neighborCase = currentCasesList[targetIdx];

    const movingPrio = movingCase.triage?.priority || 'ROUTINE';
    const neighborPrio = neighborCase.triage?.priority || 'ROUTINE';

    if (direction === 'down' && PRIORITY_TIER_WEIGHT[movingPrio] > PRIORITY_TIER_WEIGHT[neighborPrio]) {
        openPriorityDowngradeModal(movingCase, neighborCase, neighborPrio);
        return;
    }

    if (direction === 'up' && PRIORITY_TIER_WEIGHT[movingPrio] < PRIORITY_TIER_WEIGHT[neighborPrio]) {
        openPriorityDowngradeModal(movingCase, neighborCase, neighborPrio, true);
        return;
    }

    await swapOrderWithinTier(movingCase, neighborCase, direction);
};

async function swapOrderWithinTier(movingCase, neighborCase, direction, forcedNewPriority = null) {
    const currentNeighborOffset = typeof neighborCase.manualOrderOffset === 'number' ? neighborCase.manualOrderOffset : 0;
    const newMovingOffset = direction === 'up' ? currentNeighborOffset + 1 : currentNeighborOffset - 1;
    const newNeighborOffset = direction === 'up' ? currentNeighborOffset - 1 : currentNeighborOffset + 1;

    const updatedPriority = forcedNewPriority || movingCase.triage?.priority || 'ROUTINE';
    const updatedEsiLevel = forcedNewPriority ? CareflowESI.levelOfCase(neighborCase.triage) : CareflowESI.levelOfCase(movingCase.triage);
    const nowIso = new Date().toISOString();
    const docActor = getFormattedDocName();

    const auditLog = Array.isArray(movingCase.auditLog) ? [...movingCase.auditLog] : [];
    const actionDesc = forcedNewPriority
        ? `Moved case ${direction} and changed priority from ${CareflowESI.levelDisplay(CareflowESI.levelOfCase(movingCase.triage))} (${movingCase.triage?.priority}) → ${CareflowESI.levelDisplay(updatedEsiLevel)} (${forcedNewPriority})`
        : `Reordered case ${direction} in clinic queue`;

    auditLog.push({
        timestamp: nowIso,
        actor: docActor,
        action: actionDesc
    });

    const updatedTriage = {
        ...(movingCase.triage || {}),
        priority: updatedPriority,
        esiLevel: updatedEsiLevel,
        ...(forcedNewPriority ? { esiOverride: { by: docActor, at: nowIso, from: CareflowESI.levelOfCase(movingCase.triage), to: updatedEsiLevel } } : {})
    };

    const actionMeta = buildDoctorActionEntry(movingCase, 'Reordered / Reprioritized Queue', actionDesc);

    await Promise.all([
        fbFetch(`${FIREBASE_URL}/clinics/${currentClinic}/cases/${movingCase.id}.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                manualOrderOffset: newMovingOffset,
                triage: updatedTriage,
                ...actionMeta,
                auditLog
            })
        }),
        fbFetch(`${FIREBASE_URL}/clinics/${currentClinic}/cases/${neighborCase.id}.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                manualOrderOffset: newNeighborOffset
            })
        })
    ]);

    await recordDoctorActivityInClinic(`${actionDesc} (#${movingCase.id})`);
    await fetchCloudQueue();
}

function openPriorityDowngradeModal(movingCase, neighborCase, targetPriority, isUpgrade = false) {
    const currentPrio = `${movingCase.triage?.priority || 'ROUTINE'} · ESI ${CareflowESI.levelOfCase(movingCase.triage)}`;
    targetPriority = `${targetPriority} · ESI ${CareflowESI.levelOfCase(neighborCase.triage)}`;
    const targetTierOnly = String(targetPriority).split(' ')[0];
    pendingPriorityConfirmation = { movingCase, neighborCase, targetPriority: targetTierOnly, direction: isUpgrade ? 'up' : 'down' };

    priorityConfirmBody.innerHTML = `
        <p style="margin-top:0;">
            You are moving <strong>Case #${escapeHtml(movingCase.id)} (${escapeHtml(movingCase.patientName)})</strong>
            currently rated <span class="priority-badge">${escapeHtml(currentPrio)}</span>
            ${isUpgrade ? 'above' : 'below'} <strong>Case #${escapeHtml(neighborCase.id)}</strong> (<span class="priority-badge">${escapeHtml(targetPriority)}</span>).
        </p>
        <div class="alert-box" style="margin-top:10px;">
            ⚠️ <strong>Clinical Confirmation Required:</strong> Proceeding will reclassify Case #${escapeHtml(movingCase.id)}'s priority rating from <strong>${escapeHtml(currentPrio)}</strong> to <strong>${escapeHtml(targetPriority)}</strong> and record this override in the audit log.
        </div>
    `;
    priorityConfirmModal.style.display = 'flex';
}

confirmPriorityChangeBtn.addEventListener('click', async () => {
    if (!pendingPriorityConfirmation) return;
    const { movingCase, neighborCase, targetPriority, direction } = pendingPriorityConfirmation;
    priorityConfirmModal.style.display = 'none';
    pendingPriorityConfirmation = null;
    await swapOrderWithinTier(movingCase, neighborCase, direction, targetPriority);
});

cancelPriorityChangeBtn.addEventListener('click', () => {
    priorityConfirmModal.style.display = 'none';
    pendingPriorityConfirmation = null;
});

window.handleDirectPrioritySelect = async function(caseId, newLevelRaw) {
    const caseData = currentCasesList.find(c => c.id === caseId);
    if (!caseData) return;
    const newLevel = CareflowESI.clampLevel(newLevelRaw);
    if (!newLevel) return;
    const oldLevel = CareflowESI.levelOfCase(caseData.triage);
    if (oldLevel === newLevel) return;
    const oldPriority = CareflowESI.tierForLevel(oldLevel);
    const newPriority = CareflowESI.tierForLevel(newLevel);

    if (oldPriority === 'CRITICAL' && newPriority !== 'CRITICAL') {
        const ok = confirm(`CONFIRM DOWNGRADE:\nCase #${caseId} (${caseData.patientName}) is currently ${CareflowESI.levelDisplay(oldLevel)} (CRITICAL).\nAre you sure you want to downgrade it to ${CareflowESI.levelDisplay(newLevel)} (${newPriority})?`);
        if (!ok) {
            fetchCloudQueue();
            return;
        }
    }

    const nowIso = new Date().toISOString();
    const docActor = getFormattedDocName();
    const auditLog = Array.isArray(caseData.auditLog) ? [...caseData.auditLog] : [];
    auditLog.push({
        timestamp: nowIso,
        actor: docActor,
        action: `Changed ESI level from ${CareflowESI.levelDisplay(oldLevel)} (${oldPriority}) → ${CareflowESI.levelDisplay(newLevel)} (${newPriority}).`
    });

    const actionMeta = buildDoctorActionEntry(caseData, `Changed ESI Level (ESI ${oldLevel} → ESI ${newLevel})`, `ESI level set to ${newLevel} (${newPriority})`);

    await fbFetch(`${FIREBASE_URL}/clinics/${currentClinic}/cases/${caseId}.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            triage: { ...(caseData.triage || {}), priority: newPriority, esiLevel: newLevel, esiOverride: { by: docActor, at: nowIso, from: oldLevel, to: newLevel } },
            ...actionMeta,
            auditLog
        })
    });
    await recordDoctorActivityInClinic(`Changed ESI level of Case #${caseId} to ESI ${newLevel} (${newPriority})`);
    await fetchCloudQueue();
};

// ============================================================================
// DOCTOR CUSTOM CHAT MESSAGE SENDING
// ============================================================================
window.sendDoctorChatMessage = async function(caseId) {
    const input = document.getElementById(`docChatInput_${caseId}`);
    const text = input.value.trim();
    if (!text) return;

    const caseData = currentCasesList.find(c => c.id === caseId);
    if (!caseData) return;

    const docName = getFormattedDocName();
    const nowIso = new Date().toISOString();

    const messages = Array.isArray(caseData.messages) ? [...caseData.messages] : [];
    messages.push({
        id: 'MSG-' + Date.now(),
        senderRole: 'doctor',
        senderName: docName,
        text,
        timestamp: nowIso
    });

    const auditLog = Array.isArray(caseData.auditLog) ? [...caseData.auditLog] : [];
    auditLog.push({
        timestamp: nowIso,
        actor: docName,
        action: `Sent clinical chat update to patient: "${text.substring(0, 80)}"`
    });

    const actionMeta = buildDoctorActionEntry(caseData, 'Attending & Chatted with Patient', text.substring(0, 120));

    const fuState = getFollowUpState(caseData);
    const usedQs = findUsedSuggestions(text, fuState.active);
    const patch = {
        status: caseData.status === 'PENDING_REVIEW' ? 'ATTENDING' : caseData.status,
        messages,
        auditLog,
        ...actionMeta
    };
    if (usedQs.length) {
        patch.followUps = {
            active: fuState.active.filter(q => !usedQs.includes(q)),
            history: [
                ...fuState.history,
                ...usedQs.map(q => ({ question: q, status: 'ASKED', askedAt: nowIso, askedBy: docName }))
            ],
            updatedAt: (caseData.followUps && caseData.followUps.updatedAt) || caseData.timestamp || nowIso
        };
    }

    try {
        await fbFetch(`${FIREBASE_URL}/clinics/${currentClinic}/cases/${caseId}.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch)
        });
        input.value = '';
        await recordDoctorActivityInClinic(`Messaged patient on Case #${caseId}`);
        await fetchCloudQueue();
    } catch (err) {
        alert("Failed to send chat message: " + err.message);
    }
};

// ============================================================================
// APPROVE REFERRAL NOTE, DISSOLVE CASE, PURGE, & PARAMEDIC DISPATCH
// ============================================================================
window.approveAndSend = async function(caseId) {
    const caseData = currentCasesList.find(c => c.id === caseId);
    if (!caseData) return;

    const note = document.getElementById(`doctorNote_${caseId}`).value.trim() || "Triage validated. Proceed to OPD consultation.";
    const docName = getFormattedDocName();
    const nowIso = new Date().toISOString();

    const auditLog = Array.isArray(caseData.auditLog) ? [...caseData.auditLog] : [];
    auditLog.push({
        timestamp: nowIso,
        actor: docName,
        action: `Approved and finalized triage/referral note.`
    });

    const actionMeta = buildDoctorActionEntry(caseData, 'Approved Referral Note', note.substring(0, 140));

    try {
        await fbFetch(`${FIREBASE_URL}/clinics/${currentClinic}/cases/${caseId}.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                status: caseData.status === 'EMERGENCY_DISPATCHED' ? 'EMERGENCY_DISPATCHED' : 'APPROVED',
                doctorNote: note,
                reviewedBy: docName,
                reviewedAt: new Date().toLocaleString(),
                ...actionMeta,
                auditLog
            })
        });
        await recordDoctorActivityInClinic(`Approved referral note on Case #${caseId}`);
        await fetchCloudQueue();
    } catch (err) {
        alert("Failed to save approval: " + err.message);
    }
};

window.requestPatientClosure = async function(caseId) {
    const caseData = currentCasesList.find(c => c.id === caseId);
    if (!caseData) return;

    const docName = getFormattedDocName();
    const nowIso = new Date().toISOString();

    const messages = Array.isArray(caseData.messages) ? [...caseData.messages] : [];
    messages.push({
        id: 'MSG-' + Date.now(),
        senderRole: 'doctor',
        senderName: docName,
        text: 'Have your symptoms resolved? If you have recovered, please confirm using the closure prompt on your portal to dissolve this case.',
        timestamp: nowIso
    });

    const auditLog = Array.isArray(caseData.auditLog) ? [...caseData.auditLog] : [];
    auditLog.push({
        timestamp: nowIso,
        actor: docName,
        action: 'Requested patient confirmation to close/dissolve case upon recovery.'
    });

    const actionMeta = buildDoctorActionEntry(caseData, 'Requested Patient Closure', 'Asked patient to confirm recovery');

    await fbFetch(`${FIREBASE_URL}/clinics/${currentClinic}/cases/${caseId}.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            status: 'CLOSURE_REQUESTED',
            closureRequestedBy: docName,
            ...actionMeta,
            messages,
            auditLog
        })
    });
    await recordDoctorActivityInClinic(`Requested closure on Case #${caseId}`);
    await fetchCloudQueue();
};

window.dissolveCaseDirectly = async function(caseId) {
    const caseData = currentCasesList.find(c => c.id === caseId);
    if (!caseData) return;
    if (!confirm(`Dissolve and close Case #${caseId} (${caseData.patientName})?`)) return;

    const docName = getFormattedDocName();
    const nowIso = new Date().toISOString();

    const messages = Array.isArray(caseData.messages) ? [...caseData.messages] : [];
    messages.push({
        id: 'MSG-' + Date.now(),
        senderRole: 'system',
        senderName: 'CareFlow System',
        text: `Case #${caseId} was marked as resolved and dissolved by ${docName}.`,
        timestamp: nowIso
    });

    const auditLog = Array.isArray(caseData.auditLog) ? [...caseData.auditLog] : [];
    auditLog.push({
        timestamp: nowIso,
        actor: docName,
        action: 'Dissolved/closed case directly.'
    });

    const actionMeta = buildDoctorActionEntry(caseData, 'Dissolved Case', `Marked Case #${caseId} as resolved and dissolved`);

    await fbFetch(`${FIREBASE_URL}/clinics/${currentClinic}/cases/${caseId}.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            status: 'DISSOLVED',
            dissolvedBy: docName,
            dissolvedAt: nowIso,
            ...actionMeta,
            messages,
            auditLog
        })
    });
    await recordDoctorActivityInClinic(`Dissolved Case #${caseId} (${caseData.patientName})`);
    await fetchCloudQueue();
};

window.purgeRecord = async function(caseId) {
    const caseData = currentCasesList.find(c => c.id === caseId);
    if (!confirm(`PRIVACY & DATA PURGE WARNING:\nPermanently delete Case #${caseId} from Firebase cloud storage? This action cannot be undone.`)) {
        return;
    }

    try {
        await fbFetch(`${FIREBASE_URL}/clinics/${currentClinic}/cases/${caseId}.json`, { method: 'DELETE' });
        await fbFetch(`${FIREBASE_URL}/clinics/${currentClinic}/media/${caseId}.json`, { method: 'DELETE' });
        delete voiceCache[caseId];
        if (caseData && caseData.patientUserId) {
            await fbFetch(`${FIREBASE_URL}/patients/${caseData.patientUserId}/cases/${caseId}.json`, { method: 'DELETE' });
        }
        await recordDoctorActivityInClinic(`Purged Case #${caseId}`);
        await fetchCloudQueue();
    } catch (err) {
        alert("Failed to purge record: " + err.message);
    }
};

window.openParamedicDispatchModal = function(caseId) {
    const caseData = currentCasesList.find(c => c.id === caseId);
    if (!caseData) return;
    pendingParamedicCase = caseData;

    const t = caseData.triage || {};
    const v = t.extractedVitals || {};

    paramedicModalBody.innerHTML = `
        <p style="margin-top:0; color:#7f1d1d;">
            <strong>Human-in-the-Loop Emergency Escalation:</strong> Only an attending healthcare professional can authorize paramedic dispatch. Review the patient packet below before transmitting to the hospital Paramedic Team:
        </p>
        <div class="paramedic-packet-box">
            <div><strong>Patient Name:</strong> ${escapeHtml(caseData.patientName)} (${escapeHtml(caseData.patientAge)}y / ${escapeHtml(caseData.patientGender)})</div>
            <div><strong>Case ID &amp; Clinic:</strong> #${escapeHtml(caseData.id)} • Clinic ${escapeHtml(caseData.clinicCode)}</div>
            <div><strong>AI Triage Category:</strong> ${escapeHtml(t.priority || 'CRITICAL')} (${escapeHtml(t.suggestedDepartment || 'Emergency')})</div>
            <div><strong>Primary Symptoms:</strong> ${escapeHtml((t.standardizedSymptoms || [caseData.symptomsText]).join(', '))}</div>
            <div><strong>Extracted Vitals:</strong> Temp: ${escapeHtml(v.temperature || 'N/A')} | HR: ${escapeHtml(v.heart_rate || 'N/A')} | BP: ${escapeHtml(v.blood_pressure || 'N/A')} | SpO₂: ${escapeHtml(v.spo2 || 'N/A')}</div>
            <div style="margin-top:8px;">
                <label for="paramedicNotesInput" style="font-weight:700; display:block; margin-bottom:4px;">Emergency Dispatch Instructions for Paramedics:</label>
                <input type="text" id="paramedicNotesInput" value="Suspected acute cardiorespiratory/medical emergency (e.g. chest pain / breathlessness). Dispatch ALS ambulance immediately with O2 & ECG monitor." style="width:100%; padding:8px; border:1px solid #fca5a5; border-radius:6px; box-sizing:border-box;">
            </div>
        </div>
        <div id="paramedicDispatchConfirmationBanner" style="display:none; margin-top:12px;" class="emergency-banner"></div>
    `;
    confirmParamedicDispatchBtn.style.display = 'inline-block';
    paramedicModal.style.display = 'flex';
};

confirmParamedicDispatchBtn.addEventListener('click', async () => {
    if (!pendingParamedicCase) return;
    const caseData = pendingParamedicCase;
    const docName = getFormattedDocName();
    const dispatchNote = document.getElementById('paramedicNotesInput')?.value || 'Immediate ALS Paramedic response requested.';
    const dispatchId = 'EMS-' + Math.floor(10000 + Math.random() * 90000);
    const nowTime = new Date().toLocaleString();
    const nowIso = new Date().toISOString();

    const paramedicDispatch = {
        dispatchId,
        dispatchedBy: docName,
        dispatchedAt: nowTime,
        instructions: dispatchNote
    };

    const messages = Array.isArray(caseData.messages) ? [...caseData.messages] : [];
    messages.push({
        id: 'MSG-' + Date.now(),
        senderRole: 'system',
        senderName: '🚨 Paramedic Dispatch Desk',
        text: `EMERGENCY ALERT: ${docName} has marked this case as an Emergency and forwarded your patient details to the Hospital Paramedic Team (Ref: ${dispatchId}). Instructions: ${dispatchNote}`,
        timestamp: nowIso
    });

    const auditLog = Array.isArray(caseData.auditLog) ? [...caseData.auditLog] : [];
    auditLog.push({
        timestamp: nowIso,
        actor: docName,
        action: `Marked case as EMERGENCY and dispatched Hospital Paramedic Team (Ref: ${dispatchId}).`
    });

    const actionMeta = buildDoctorActionEntry(caseData, 'Emergency Paramedic Dispatched', `Ref ${dispatchId}: ${dispatchNote}`);

    await fbFetch(`${FIREBASE_URL}/clinics/${currentClinic}/cases/${caseData.id}.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            status: 'EMERGENCY_DISPATCHED',
            triage: { ...(caseData.triage || {}), priority: 'CRITICAL', esiLevel: Math.min(CareflowESI.levelOfCase(caseData.triage), 2) },
            paramedicDispatch,
            ...actionMeta,
            messages,
            auditLog
        })
    });

    const banner = document.getElementById('paramedicDispatchConfirmationBanner');
    if (banner) {
        banner.style.display = 'block';
        banner.innerHTML = `✅ <strong>Patient Details Forwarded to Hospital Paramedic Team!</strong><br>Dispatch ID: <strong>${dispatchId}</strong> | Authorized by: <strong>${escapeHtml(docName)}</strong> at ${nowTime}.`;
    }
    confirmParamedicDispatchBtn.style.display = 'none';
    await recordDoctorActivityInClinic(`Dispatched Paramedics (${dispatchId}) on Case #${caseData.id}`);
    await fetchCloudQueue();
});

closeParamedicModalBtn.addEventListener('click', () => {
    paramedicModal.style.display = 'none';
    pendingParamedicCase = null;
});

// ============================================================================
// START-UP
// ============================================================================
let dashboardStarted = false;

window.startDoctorDashboard = function(sessionDetail) {
    const session = sessionDetail || (window.CareFlowDoctorAuth && window.CareFlowDoctorAuth.getSession());
    if (session) {
        currentClinic = cleanClinicCode(session.clinicCode) || currentClinic;
        currentDepartment = 'All';
        currentUser = {
            role: 'doctor',
            name: session.name || currentUser.name,
            userId: session.doctorId || currentUser.userId,
            clinicCode: currentClinic,
            department: 'All'
        };
        setCookie('careflow_user', currentUser, 30);
    }

    if (docDepartment) docDepartment.value = 'All';
    if (docStatusFilter) docStatusFilter.value = 'ALL';

    initDoctorProfileBar();
    fetchCloudQueue();

    if (!dashboardStarted) {
        dashboardStarted = true;
        setInterval(() => {
            const modalOpen = priorityConfirmModal.style.display !== 'none' ||
                paramedicModal.style.display !== 'none' ||
                (clinicPassModal && clinicPassModal.style.display !== 'none');
            const typing = Array.from(document.querySelectorAll('.chat-input-row input')).some(i => i.value || i === document.activeElement);
            const editing = Array.from(document.querySelectorAll('.referral-note-box textarea')).some(t => t.value !== t.defaultValue || t === document.activeElement);
            const playing = Array.from(document.querySelectorAll('audio')).some(a => !a.paused && !a.ended);
            if (!modalOpen && !typing && !editing && !playing && !document.hidden) fetchCloudQueue(true);
        }, 10000);
    }
};

if (window.CareFlowDoctorAuth && window.CareFlowDoctorAuth.isAuthenticated()) {
    window.startDoctorDashboard();
} else {
    window.addEventListener('careflow-doctor-login', (e) => window.startDoctorDashboard(e.detail), { once: true });
}
