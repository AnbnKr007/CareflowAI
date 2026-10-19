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

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function fmtDateTime(iso) {
    if (!iso) return 'N/A';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return d.toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function hashClinicPass(clinicCode, pin) {
    const raw = `${cleanClinicCode(clinicCode)}:${String(pin).trim()}`;
    if (window.crypto && window.crypto.subtle) {
        try {
            const data = new TextEncoder().encode(raw);
            const digest = await crypto.subtle.digest('SHA-256', data);
            return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) {}
    }
    let h = 2166136261;
    for (let i = 0; i < raw.length; i++) {
        h ^= raw.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return 'fnv1a_' + (h >>> 0).toString(16);
}

function normalizeDoctorKey(name) {
    const cleaned = String(name || '')
        .toLowerCase()
        .replace(/\./g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^dr\s+/, '');
    return 'DOC_' + (cleaned.replace(/[^a-z0-9]+/g, '_').toUpperCase() || 'UNKNOWN');
}

const CLINIC_SESSION_KEY = 'careflow_clinic_session';

function getClinicSession() {
    try {
        const raw = sessionStorage.getItem(CLINIC_SESSION_KEY);
        if (!raw) return null;
        const s = JSON.parse(raw);
        if (!s || !s.clinicCode) return null;
        return s;
    } catch (e) {
        return null;
    }
}

function setClinicSession(sessionObj) {
    try {
        sessionStorage.setItem(CLINIC_SESSION_KEY, JSON.stringify(sessionObj));
    } catch (e) {}
}

function clearClinicSession() {
    try {
        sessionStorage.removeItem(CLINIC_SESSION_KEY);
    } catch (e) {}
}

function setCookie(name, value, days = 30) {
    const d = new Date();
    d.setTime(d.getTime() + (days * 24 * 60 * 60 * 1000));
    document.cookie = `${name}=${encodeURIComponent(JSON.stringify(value))};expires=${d.toUTCString()};path=/;SameSite=Lax`;
    try { localStorage.setItem(name, JSON.stringify(value)); } catch (e) {}
}

let activeClinicInfo = null;
let clinicDoctorsMap = {};
let clinicCasesList = [];
let passVisible = false;
let currentMainView = 'doctors';
let dashboardInterval = null;

const PRIORITY_WEIGHT = { CRITICAL: 3, URGENT: 2, ROUTINE: 1 };

// ============================================================================
// AUTH GATE: REGISTER CLINIC OR SIGN IN
// ============================================================================
window.switchClinicAuthTab = function(tab) {
    const signInForm = document.getElementById('clinicSignInForm');
    const registerForm = document.getElementById('clinicRegisterForm');
    const tabSignIn = document.getElementById('tabClinicSignIn');
    const tabRegister = document.getElementById('tabClinicRegister');

    document.getElementById('clinicSignInError').style.display = 'none';
    document.getElementById('clinicRegisterError').style.display = 'none';

    if (tab === 'register') {
        signInForm.style.display = 'none';
        registerForm.style.display = 'flex';
        tabSignIn.classList.remove('active');
        tabRegister.classList.add('active');
    } else {
        signInForm.style.display = 'flex';
        registerForm.style.display = 'none';
        tabSignIn.classList.add('active');
        tabRegister.classList.remove('active');
    }
};

['signInClinicPass', 'regClinicPass'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener('input', () => {
            el.value = el.value.replace(/\D/g, '').slice(0, 4);
        });
    }
});

// Register New Clinic
document.getElementById('clinicRegisterForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('clinicRegisterError');
    const submitBtn = document.getElementById('clinicRegisterBtn');
    errBox.style.display = 'none';

    const clinicName = document.getElementById('regClinicName').value.trim();
    const clinicCode = cleanClinicCode(document.getElementById('regClinicCode').value);
    const passcode = document.getElementById('regClinicPass').value.trim();
    const location = document.getElementById('regClinicLocation').value.trim();

    if (!clinicName) {
        errBox.textContent = 'Please enter the clinic or hospital name.';
        errBox.style.display = 'block';
        return;
    }
    if (clinicCode.length < 3) {
        errBox.textContent = 'Clinic Code must be at least 3 characters.';
        errBox.style.display = 'block';
        return;
    }
    if (!/^\d{4}$/.test(passcode)) {
        errBox.textContent = 'Clinic Pass must be exactly 4 numeric digits (0-9).';
        errBox.style.display = 'block';
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Registering Clinic...';

    try {
        const existingRes = await fbFetch(`${FIREBASE_URL}/clinics/${clinicCode}/info.json`);
        const existingInfo = await existingRes.json();

        if (existingInfo && (existingInfo.passHash || existingInfo.passcode)) {
            errBox.textContent = `Clinic code "${clinicCode}" is already registered. Please sign in using the "Sign In to Clinic" tab.`;
            errBox.style.display = 'block';
            return;
        }

        const passHash = await hashClinicPass(clinicCode, passcode);
        const nowIso = new Date().toISOString();
        const clinicInfo = {
            clinicCode,
            clinicName,
            location: location || 'Healthcare Facility',
            passcode,
            passHash,
            createdAt: nowIso,
            updatedAt: nowIso
        };

        await fbFetch(`${FIREBASE_URL}/clinics/${clinicCode}/info.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(clinicInfo)
        });

        setClinicSession({ clinicCode, clinicName, passcode, loginAt: Date.now() });
        setCookie('careflow_user', { role: 'clinic', name: clinicName, userId: clinicCode, clinicCode }, 30);

        unlockAndStartClinicConsole(clinicInfo);
    } catch (err) {
        errBox.textContent = 'Registration failed: ' + err.message;
        errBox.style.display = 'block';
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Register Clinic & Open Console →';
    }
});

// Sign In to Existing Clinic
document.getElementById('clinicSignInForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('clinicSignInError');
    const submitBtn = document.getElementById('clinicSignInBtn');
    errBox.style.display = 'none';

    const clinicCode = cleanClinicCode(document.getElementById('signInClinicCode').value);
    const passcode = document.getElementById('signInClinicPass').value.trim();

    if (!clinicCode) {
        errBox.textContent = 'Please enter your Clinic Code.';
        errBox.style.display = 'block';
        return;
    }
    if (!/^\d{4}$/.test(passcode)) {
        errBox.textContent = 'Passcode must be进而 exactly 4 digits.';
        errBox.style.display = 'block';
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Verifying Credentials...';

    try {
        const res = await fbFetch(`${FIREBASE_URL}/clinics/${clinicCode}/info.json`);
        const info = await res.json();

        if (!info || (!info.passHash && !info.passcode)) {
            errBox.textContent = `Clinic "${clinicCode}" is not registered yet. Switch to "Register New Clinic" to create it.`;
            errBox.style.display = 'block';
            document.getElementById('regClinicCode').value = clinicCode;
            return;
        }

        const enteredHash = await hashClinicPass(clinicCode, passcode);
        const isMatch = (info.passcode && String(info.passcode).trim() === passcode) ||
            (info.passHash && info.passHash === enteredHash);

        if (!isMatch) {
            errBox.textContent = 'Invalid 4-digit pass for this clinic.';
            errBox.style.display = 'block';
            document.getElementById('signInClinicPass').value = '';
            return;
        }

        info.passcode = passcode;
        setClinicSession({
            clinicCode: info.clinicCode || clinicCode,
            clinicName: info.clinicName || clinicCode,
            passcode,
            loginAt: Date.now()
        });

        setCookie('careflow_user', {
            role: 'clinic',
            name: info.clinicName || clinicCode,
            userId: clinicCode,
            clinicCode
        }, 30);

        unlockAndStartClinicConsole(info);
    } catch (err) {
        errBox.textContent = 'Sign-in error: ' + err.message;
        errBox.style.display = 'block';
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Open Clinic Oversight Console →';
    }
});

// ============================================================================
// UNLOCK CONSOLE & LOAD DOCTORS + CASES + DOCTOR ACTIONS
// ============================================================================
async function unlockAndStartClinicConsole(info) {
    activeClinicInfo = info;
    document.body.classList.remove('clinic-locked');

    renderClinicHeaderAndBanner();
    await syncClinicDashboard();

    if (dashboardInterval) clearInterval(dashboardInterval);
    dashboardInterval = setInterval(() => {
        if (!document.hidden) {
            syncClinicDashboard(true);
        }
    }, 8000);
}

function renderClinicHeaderAndBanner() {
    if (!activeClinicInfo) return;

    document.getElementById('clinicDisplayName').textContent = activeClinicInfo.clinicName || activeClinicInfo.clinicCode;
    document.getElementById('clinicLocationBadge').textContent = activeClinicInfo.location || 'Registered Facility';

    document.getElementById('bannerClinicCode').textContent = activeClinicInfo.clinicCode;
    document.getElementById('bannerClinicPass').textContent = passVisible
        ? (activeClinicInfo.passcode || '••••')
        : '••••';
    document.getElementById('togglePassBtn').textContent = passVisible ? '🙈 Hide' : '👁️ Show';

    document.getElementById('clinicHeaderRight').innerHTML = `
        <span class="user-chip">
            🏥 <strong>${escapeHtml(activeClinicInfo.clinicName || activeClinicInfo.clinicCode)}</strong>
            <small>(Code: ${escapeHtml(activeClinicInfo.clinicCode)})</small>
        </span>
        <a href="doctor.html" class="ghost-btn sm-btn">🩺 Doctor Portal</a>
        <button type="button" class="ghost-btn sm-btn" onclick="signOutClinic()">Sign Out</button>
    `;
}

window.signOutClinic = function() {
    clearClinicSession();
    window.location.reload();
};

window.copyClinicCode = function() {
    if (!activeClinicInfo) return;
    navigator.clipboard?.writeText(activeClinicInfo.clinicCode);
    alert(`Clinic Code "${activeClinicInfo.clinicCode}" copied to clipboard!`);
};

window.togglePassVisibility = function() {
    passVisible = !passVisible;
    renderClinicHeaderAndBanner();
};

// Extract all doctors who touched a case + what they did to it
function getDoctorsWhoActedOnCase(caseData) {
    const map = {}; // docId -> { docId, docName, lastAction, lastTimestamp, actions: [] }

    function addEntry(name, idHint, actionText, timestamp) {
        if (!name) return;
        const cleanName = name.toLowerCase().startsWith('dr') ? name : `Dr. ${name}`;
        const docId = idHint || normalizeDoctorKey(cleanName);
        if (!map[docId]) {
            map[docId] = {
                docId,
                docName: cleanName,
                lastAction: actionText,
                lastTimestamp: timestamp,
                actions: []
            };
        }
        map[docId].actions.push({ action: actionText, timestamp });
        map[docId].lastAction = actionText;
        map[docId].lastTimestamp = timestamp || map[docId].lastTimestamp;
    }

    if (Array.isArray(caseData.doctorActions)) {
        caseData.doctorActions.forEach(da => {
            addEntry(da.doctorName, da.doctorId, `${da.action}${da.details ? ': ' + da.details : ''}`, da.timestamp);
        });
    }

    if (caseData.attendingDoctorName) {
        addEntry(caseData.attendingDoctorName, caseData.attendingDoctorId, caseData.lastActionType || 'Attending Case', caseData.lastActionAt || caseData.timestamp);
    }
    if (caseData.reviewedBy) {
        addEntry(caseData.reviewedBy, null, `Approved Referral Note${caseData.doctorNote ? ': "' + caseData.doctorNote + '"' : ''}`, caseData.reviewedAt || caseData.timestamp);
    }
    if (caseData.paramedicDispatch && caseData.paramedicDispatch.dispatchedBy) {
        addEntry(caseData.paramedicDispatch.dispatchedBy, null, `Dispatched Paramedic Unit (${caseData.paramedicDispatch.dispatchId})`, caseData.paramedicDispatch.dispatchedAt);
    }
    if (caseData.dissolvedBy) {
        addEntry(caseData.dissolvedBy, null, 'Dissolved / Closed Case', caseData.dissolvedAt || caseData.timestamp);
    }
    if (Array.isArray(caseData.messages)) {
        caseData.messages.filter(m => m.senderRole === 'doctor' && m.senderName).forEach(m => {
            addEntry(m.senderName, null, `Chatted with patient: "${m.text}"`, m.timestamp);
        });
    }

    return Object.values(map);
}

// ============================================================================
// FETCH & SYNC DOCTORS AND CASES UNDER THIS CLINIC
// ============================================================================
window.syncClinicDashboard = async function(silent = false) {
    if (!activeClinicInfo) return;
    const clinicCode = activeClinicInfo.clinicCode;

    if (!silent) {
        document.getElementById('doctorsRosterContainer').innerHTML =
            '<div class="loading-box">Syncing clinic doctors, cases, and doctor actions from Firebase...</div>';
    }

    try {
        const [infoRes, docsRes, casesRes] = await Promise.all([
            fbFetch(`${FIREBASE_URL}/clinics/${clinicCode}/info.json`),
            fbFetch(`${FIREBASE_URL}/clinics/${clinicCode}/doctors.json`),
            fbFetch(`${FIREBASE_URL}/clinics/${clinicCode}/cases.json`)
        ]);

        const [freshInfo, docsData, casesData] = await Promise.all([
            infoRes.json(),
            docsRes.json(),
            casesRes.json()
        ]);

        if (freshInfo) {
            activeClinicInfo = { ...activeClinicInfo, ...freshInfo };
            renderClinicHeaderAndBanner();
        }

        const mergedDocs = {};
        if (docsData && typeof docsData === 'object') {
            Object.entries(docsData).forEach(([key, d]) => {
                if (d && d.name) {
                    const id = d.id || key;
                    mergedDocs[id] = {
                        id,
                        name: d.name.toLowerCase().startsWith('dr') ? d.name : `Dr. ${d.name}`,
                        joinedAt: d.joinedAt || null,
                        lastActiveAt: d.lastActiveAt || d.joinedAt || null,
                        lastAction: d.lastAction || 'Signed in to clinic'
                    };
                }
            });
        }

        const rawCases = (casesData && typeof casesData === 'object')
            ? Object.entries(casesData)
                .filter(([, val]) => val && typeof val === 'object')
                .map(([key, val]) => ({ ...val, id: val.id || key, clinicCode: val.clinicCode || clinicCode }))
            : [];

        clinicCasesList = rawCases.sort((a, b) => {
            const pA = PRIORITY_WEIGHT[a.triage?.priority || 'ROUTINE'] || 1;
            const pB = PRIORITY_WEIGHT[b.triage?.priority || 'ROUTINE'] || 1;
            if (pB !== pA) return pB - pA;
            return new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
        });

        // Also include any doctor who has acted on a case in the clinic
        clinicCasesList.forEach(c => {
            const actors = getDoctorsWhoActedOnCase(c);
            actors.forEach(act => {
                if (!mergedDocs[act.docId]) {
                    mergedDocs[act.docId] = {
                        id: act.docId,
                        name: act.docName,
                        joinedAt: c.timestamp,
                        lastActiveAt: act.lastTimestamp || c.timestamp,
                        lastAction: act.lastAction
                    };
                }
            });
        });

        clinicDoctorsMap = mergedDocs;
        populateDoctorFilterDropdown();
        updateClinicMetrics();
        renderClinicViews();
    } catch (err) {
        document.getElementById('doctorsRosterContainer').innerHTML =
            `<div class="status-banner status-error">Error syncing clinic data: ${escapeHtml(err.message)}</div>`;
    }
};

function populateDoctorFilterDropdown() {
    const sel = document.getElementById('clinicDoctorFilter');
    const prev = sel.value || 'ALL';
    const docs = Object.values(clinicDoctorsMap);

    sel.innerHTML = `<option value="ALL">All Associated Doctors (${docs.length})</option>` +
        docs.map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join('') +
        `<option value="UNATTENDED">⏳ Unattended Cases Only</option>`;

    if (Array.from(sel.options).some(o => o.value === prev)) {
        sel.value = prev;
    }
}

function updateClinicMetrics() {
    const docsCount = Object.keys(clinicDoctorsMap).length;
    const attendedCount = clinicCasesList.filter(c => getDoctorsWhoActedOnCase(c).length > 0 || c.status === 'ATTENDING' || c.status === 'APPROVED').length;
    const dissolvedCount = clinicCasesList.filter(c => c.status === 'DISSOLVED').length;

    document.getElementById('statTotalDoctors').textContent = docsCount;
    document.getElementById('statTotalCases').textContent = clinicCasesList.length;
    document.getElementById('statAttendedCases').textContent = attendedCount;
    document.getElementById('statDissolvedCases').textContent = dissolvedCount;
    document.getElementById('statCriticalCases').textContent = clinicCasesList.filter(c => c.triage?.priority === 'CRITICAL').length;
    document.getElementById('statUrgentCases').textContent = clinicCasesList.filter(c => c.triage?.priority === 'URGENT').length;
    document.getElementById('statRoutineCases').textContent = clinicCasesList.filter(c => (c.triage?.priority || 'ROUTINE') === 'ROUTINE').length;

    document.getElementById('tabDocCount').textContent = docsCount;
    document.getElementById('tabCaseCount').textContent = clinicCasesList.length;
}

window.setClinicMainView = function(view) {
    currentMainView = view;
    document.getElementById('viewTabDoctors').classList.toggle('active', view === 'doctors');
    document.getElementById('viewTabAllCases').classList.toggle('active', view === 'cases');
    document.getElementById('doctorsWithCasesView').style.display = view === 'doctors' ? 'block' : 'none';
    document.getElementById('allClinicCasesView').style.display = view === 'cases' ? 'block' : 'none';
    renderClinicViews();
};

function filterCaseByToolbar(c) {
    const prioFilter = document.getElementById('clinicPriorityFilter').value;
    const statusFilter = document.getElementById('clinicStatusFilter').value;
    const docFilter = document.getElementById('clinicDoctorFilter').value;

    const prio = c.triage?.priority || 'ROUTINE';
    if (prioFilter !== 'ALL' && prio !== prioFilter) return false;

    if (statusFilter !== 'ALL' && (c.status || 'PENDING_REVIEW') !== statusFilter) return false;

    const actors = getDoctorsWhoActedOnCase(c);
    if (docFilter === 'UNATTENDED' && actors.length > 0) return false;
    if (docFilter !== 'ALL' && docFilter !== 'UNATTENDED' && !actors.some(a => a.docId === docFilter)) return false;

    return true;
}

function summarizeDoctorOutcomeBadge(caseData) {
    const status = caseData.status || 'PENDING_REVIEW';
    const doc = caseData.attendingDoctorName || caseData.reviewedBy || caseData.dissolvedBy || caseData.lastActionBy || '';
    const byText = doc ? ` by ${escapeHtml(doc)}` : '';

    if (status === 'DISSOLVED') {
        return `<span class="outcome-pill outcome-dissolved">🔒 Dissolved${byText}</span>`;
    }
    if (status === 'EMERGENCY_DISPATCHED' || caseData.paramedicDispatch) {
        return `<span class="outcome-pill outcome-emergency">🚨 Paramedics Dispatched${byText}</span>`;
    }
    if (status === 'APPROVED') {
        return `<span class="outcome-pill outcome-approved">✓ Approved &amp; Referral Sent${byText}</span>`;
    }
    if (status === 'CLOSURE_REQUESTED') {
        return `<span class="outcome-pill outcome-attending">📩 Closure Requested${byText}</span>`;
    }
    if (status === 'ATTENDING' || doc) {
        return `<span class="outcome-pill outcome-attending">🩺 Attending${byText}</span>`;
    }
    return `<span class="outcome-pill outcome-pending">⏳ Awaiting Doctor Attendance</span>`;
}

// ============================================================================
// RENDER READ-ONLY CLINIC OVERSIGHT VIEWS
// ============================================================================
window.renderClinicViews = function() {
    const filteredCases = clinicCasesList.filter(filterCaseByToolbar);
    const doctors = Object.values(clinicDoctorsMap);
    const docFilter = document.getElementById('clinicDoctorFilter').value;

    // 1. Unattended Cases Banner
    const unattendedBanner = document.getElementById('unattendedCasesBanner');
    const unattendedCases = filteredCases.filter(c => getDoctorsWhoActedOnCase(c).length === 0);

    if (unattendedCases.length > 0 && (docFilter === 'ALL' || docFilter === 'UNATTENDED')) {
        unattendedBanner.style.display = 'block';
        unattendedBanner.innerHTML = `
            <div class="clinic-unassigned-panel">
                <div class="clinic-unassigned-header">
                    <h3>⏳ Cases Awaiting Doctor Attendance (${unattendedCases.length})</h3>
                    <p>These cases have been submitted by patients to <strong>${escapeHtml(activeClinicInfo.clinicCode)}</strong> and are visible to all signed-in doctors.</p>
                </div>
                <div class="clinic-mini-cases-grid">
                    ${unattendedCases.map(c => renderReadOnlyCaseCard(c)).join('')}
                </div>
            </div>
        `;
    } else {
        unattendedBanner.style.display = 'none';
        unattendedBanner.innerHTML = '';
    }

    // 2. Associated Doctors & What They Did to Cases
    const rosterContainer = document.getElementById('doctorsRosterContainer');
    const visibleDoctors = doctors.filter(d => docFilter === 'ALL' || docFilter === d.id);

    if (docFilter === 'UNATTENDED') {
        rosterContainer.innerHTML = '';
    } else if (visibleDoctors.length === 0) {
        rosterContainer.innerHTML = `
            <div class="empty-state" style="grid-column: 1 / -1;">
                <h3>No Doctors Signed In to ${escapeHtml(activeClinicInfo.clinicCode)} Yet</h3>
                <p>Share Clinic Code <strong>${escapeHtml(activeClinicInfo.clinicCode)}</strong> and your 4-Digit Pass with your doctors.<br>
                When doctors sign in on the Clinician Dashboard, they and every action they take on patient cases will appear here live.</p>
            </div>
        `;
    } else {
        rosterContainer.innerHTML = visibleDoctors.map(doc => {
            const doctorCases = filteredCases.filter(c =>
                getDoctorsWhoActedOnCase(c).some(a => a.docId === doc.id)
            );

            const attendingCount = doctorCases.filter(c => c.status === 'ATTENDING').length;
            const approvedCount = doctorCases.filter(c => c.status === 'APPROVED').length;
            const dissolvedCount = doctorCases.filter(c => c.status === 'DISSOLVED').length;
            const emergencyCount = doctorCases.filter(c => c.status === 'EMERGENCY_DISPATCHED' || c.paramedicDispatch).length;

            return `
                <div class="clinic-doctor-card">
                    <div class="clinic-doctor-header">
                        <div class="doc-identity">
                            <div class="doc-avatar">🩺</div>
                            <div>
                                <h3>${escapeHtml(doc.name)}</h3>
                                <div class="doc-meta-line">
                                    <span class="badge badge-doctor">All Departments Access</span>
                                    <small class="text-muted">ID: ${escapeHtml(doc.id)}</small>
                                </div>
                                <small class="text-muted" style="display:block; margin-top:4px;">
                                    Last Active: <strong>${escapeHtml(fmtDateTime(doc.lastActiveAt))}</strong>
                                    ${doc.lastAction ? ` • Latest: <em>${escapeHtml(doc.lastAction)}</em>` : ''}
                                </small>
                            </div>
                        </div>

                        <div class="doc-stats-cluster">
                            <span class="doc-case-count-pill">${doctorCases.length} Case${doctorCases.length === 1 ? '' : 's'} Handled</span>
                            <div class="doc-mini-prio-row">
                                <span title="Attending">🩺 ${attendingCount}</span>
                                <span title="Approved">✓ ${approvedCount}</span>
                                <span title="Emergency">🚨 ${emergencyCount}</span>
                                <span title="Dissolved">🔒 ${dissolvedCount}</span>
                            </div>
                        </div>
                    </div>

                    <div class="clinic-doctor-cases-body">
                        <div class="section-title" style="margin-top:0;">
                            📋 Cases Attended / Acted On by ${escapeHtml(doc.name)} (${doctorCases.length})
                        </div>
                        ${doctorCases.length > 0 ? `
                            <div class="clinic-doc-case-list">
                                ${doctorCases.map(c => renderReadOnlyCaseCard(c, doc.id)).join('')}
                            </div>
                        ` : `
                            <div class="clinic-empty-subbox">
                                ${escapeHtml(doc.name)} is signed in and associated with this clinic, and has not yet acted on any cases matching the current filter.
                            </div>
                        `}
                    </div>
                </div>
            `;
        }).join('');
    }

    // 3. All Clinic Cases View
    const allCasesContainer = document.getElementById('allClinicCasesContainer');
    if (filteredCases.length === 0) {
        allCasesContainer.innerHTML = `<div class="empty-state"><h3>No patient cases found in clinic ${escapeHtml(activeClinicInfo.clinicCode)}</h3></div>`;
    } else {
        allCasesContainer.innerHTML = filteredCases.map(c => renderReadOnlyCaseCard(c)).join('');
    }
};

function renderReadOnlyCaseCard(caseData, focusDoctorId = null) {
    const t = caseData.triage || {};
    const priority = t.priority || 'ROUTINE';
    const prioClass = `priority-${priority.toLowerCase()}`;
    const actors = getDoctorsWhoActedOnCase(caseData);

    // Build chronological list of what doctors did to this case
    const doctorActionItems = [];
    if (Array.isArray(caseData.doctorActions) && caseData.doctorActions.length > 0) {
        caseData.doctorActions.forEach(da => {
            if (!focusDoctorId || da.doctorId === focusDoctorId) {
                doctorActionItems.push(`
                    <li>
                        <strong>${escapeHtml(da.doctorName)}:</strong>
                        <span class="doc-action-highlight">${escapeHtml(da.action)}</span>
                        ${da.details ? ` — <em>${escapeHtml(da.details)}</em>` : ''}
                        <small class="text-muted">(${escapeHtml(fmtDateTime(da.timestamp))})</small>
                    </li>
                `);
            }
        });
    } else {
        actors.forEach(a => {
            if (!focusDoctorId || a.docId === focusDoctorId) {
                a.actions.forEach(act => {
                    doctorActionItems.push(`
                        <li>
                            <strong>${escapeHtml(a.docName)}:</strong>
                            <span>${escapeHtml(act.action)}</span>
                            <small class="text-muted">(${escapeHtml(fmtDateTime(act.timestamp))})</small>
                        </li>
                    `);
                });
            }
        });
    }

    return `
        <div class="clinic-case-row ${prioClass}">
            <div class="clinic-case-top">
                <div>
                    <strong>#${escapeHtml(caseData.id)}</strong> •
                    <strong>${escapeHtml(caseData.patientName)}</strong>
                    <span class="demog-pill">${escapeHtml(caseData.patientAge)}y / ${escapeHtml(caseData.patientGender)}</span>
                    <span class="dept-tag">${escapeHtml(t.suggestedDepartment || 'General Medicine')}</span>
                </div>
                <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
                    ${summarizeDoctorOutcomeBadge(caseData)}
                    <span class="priority-badge">${escapeHtml(priority)}</span>
                </div>
            </div>

            <div class="clinic-case-summary">
                <strong>Clinical Summary:</strong> ${escapeHtml(t.clinicalSummary || caseData.symptomsText || 'Multimodal symptom intake submitted.')}
            </div>

            ${caseData.doctorNote ? `
                <div class="doctor-rx-box" style="margin:4px 0; padding:7px 10px;">
                    <strong>🩺 Doctor's Official Note (${escapeHtml(caseData.reviewedBy || caseData.attendingDoctorName || 'Doctor')}):</strong>
                    <span>${escapeHtml(caseData.doctorNote)}</span>
                </div>
            ` : ''}

            ${doctorActionItems.length > 0 ? `
                <div class="clinic-doc-activity-box">
                    <div class="activity-box-title">🛠️ What Doctor(s) Did on This Case:</div>
                    <ul class="clinic-doc-activity-list">
                        ${doctorActionItems.join('')}
                    </ul>
                </div>
            ` : ''}

            <div class="clinic-case-footer">
                <small class="text-muted">
                    Submitted: ${escapeHtml(fmtDateTime(caseData.timestamp))}
                </small>
                <small class="text-muted">
                    Status: <strong>${escapeHtml((caseData.status || 'PENDING_REVIEW').replace(/_/g, ' '))}</strong>
                </small>
            </div>
        </div>
    `;
}

// Auto-restore clinic session if already authenticated in this tab
(async function initClinicPortal() {
    const savedSession = getClinicSession();
    if (savedSession && savedSession.clinicCode) {
        try {
            const res = await fbFetch(`${FIREBASE_URL}/clinics/${savedSession.clinicCode}/info.json`);
            const info = await res.json();
            if (info) {
                info.passcode = savedSession.passcode || info.passcode;
                unlockAndStartClinicConsole(info);
                return;
            }
        } catch (e) {}
    }
})();
