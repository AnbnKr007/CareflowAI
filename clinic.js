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

// Deterministic fallback + SHA-256 hash for clinic passcodes
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

// Cookie & Session Helpers
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

// State
let activeClinicInfo = null; // { clinicCode, clinicName, passcode, passHash, location, createdAt }
let clinicDoctorsMap = {};   // docId -> { id, name, department, joinedAt, lastActiveAt }
let clinicCasesList = [];    // Array of case objects
let passVisible = false;
let currentMainView = 'doctors'; // 'doctors' | 'cases'
let dashboardInterval = null;

const PRIORITY_WEIGHT = { CRITICAL: 3, URGENT: 2, ROUTINE: 1 };

// ============================================================================
// AUTH GATE: SWITCH TABS, REGISTER CLINIC, OR SIGN IN TO CLINIC
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

// Enforce numeric 4-digit input on pass fields
['signInClinicPass', 'regClinicPass', 'newClinicPassInput'].forEach(id => {
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
        errBox.textContent = 'Clinic Code must be at least 3 characters (letters, numbers, hyphens).';
        errBox.style.display = 'block';
        return;
    }
    if (!/^\d{4}$/.test(passcode)) {
        errBox.textContent = 'Clinic Pass must be进而 exactly 4 numeric digits (0-9).';
        errBox.style.display = 'block';
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Registering Clinic...';

    try {
        // Check if this clinic code is already registered
        const existingRes = await fbFetch(`${FIREBASE_URL}/clinics/${clinicCode}/info.json`);
        const existingInfo = await existingRes.json();

        if (existingInfo && (existingInfo.passHash || existingInfo.passcode)) {
            errBox.textContent = `Clinic code "${clinicCode}" is already registered (${existingInfo.clinicName || clinicCode}). Please use the "Sign In to Clinic" tab with its 4-digit pass.`;
            errBox.style.display = 'block';
            submitBtn.disabled = false;
            submitBtn.textContent = 'Register Clinic & Open Console →';
            return;
        }

        const passHash = await hashClinicPass(clinicCode, passcode);
        const nowIso = new Date().toISOString();
        const clinicInfo = {
            clinicCode,
            clinicName,
            location: location || 'General Healthcare Facility',
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

        setClinicSession({
            clinicCode,
            clinicName,
            passcode,
            loginAt: Date.now()
        });

        setCookie('careflow_user', {
            role: 'clinic',
            name: clinicName,
            userId: clinicCode,
            clinicCode
        }, 30);

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
        errBox.textContent = 'Passcode must be exactly 4 digits.';
        errBox.style.display = 'block';
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Verifying Credentials...';

    try {
        const res = await fbFetch(`${FIREBASE_URL}/clinics/${clinicCode}/info.json`);
        const info = await res.json();

        if (!info || (!info.passHash && !info.passcode)) {
            errBox.textContent = `Clinic "${clinicCode}" is not registered yet. Switch to "Register New Clinic" to set up ${clinicCode} and its 4-digit pass.`;
            errBox.style.display = 'block';
            document.getElementById('regClinicCode').value = clinicCode;
            return;
        }

        const enteredHash = await hashClinicPass(clinicCode, passcode);
        const isMatch = (info.passHash && info.passHash === enteredHash) || (info.passcode && String(info.passcode) === passcode);

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
        submitBtn.textContent = 'Access Clinic Console →';
    }
});

// ============================================================================
// UNLOCK CONSOLE & LOAD DOCTORS + CASES
// ============================================================================
async function unlockAndStartClinicConsole(info) {
    activeClinicInfo = info;
    document.body.classList.remove('clinic-locked');

    renderClinicHeaderAndBanner();
    await syncClinicDashboard();

    if (dashboardInterval) clearInterval(dashboardInterval);
    dashboardInterval = setInterval(() => {
        const modalOpen = document.getElementById('changePassModal').style.display !== 'none';
        if (!modalOpen && !document.hidden) {
            syncClinicDashboard(true);
        }
    }, 10000);
}

function renderClinicHeaderAndBanner() {
    if (!activeClinicInfo) return;

    document.getElementById('clinicDisplayName').textContent = activeClinicInfo.clinicName || activeClinicInfo.clinicCode;
    const locBadge = document.getElementById('clinicLocationBadge');
    locBadge.textContent = activeClinicInfo.location || 'Registered Facility';

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

window.openChangePassModal = function() {
    if (!activeClinicInfo) return;
    document.getElementById('modalClinicCodeLabel').textContent = activeClinicInfo.clinicCode;
    document.getElementById('newClinicPassInput').value = '';
    document.getElementById('changePassModal').style.display = 'flex';
};

window.closeChangePassModal = function() {
    document.getElementById('changePassModal').style.display = 'none';
};

document.getElementById('changePassForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const newPass = document.getElementById('newClinicPassInput').value.trim();
    if (!/^\d{4}$/.test(newPass)) {
        alert('Please enter a valid 4-digit numeric passcode.');
        return;
    }

    try {
        const clinicCode = activeClinicInfo.clinicCode;
        const passHash = await hashClinicPass(clinicCode, newPass);
        const updatedAt = new Date().toISOString();

        await fbFetch(`${FIREBASE_URL}/clinics/${clinicCode}/info.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ passcode: newPass, passHash, updatedAt })
        });

        activeClinicInfo.passcode = newPass;
        activeClinicInfo.passHash = passHash;
        setClinicSession({
            clinicCode,
            clinicName: activeClinicInfo.clinicName,
            passcode: newPass,
            loginAt: Date.now()
        });

        closeChangePassModal();
        passVisible = true;
        renderClinicHeaderAndBanner();
    } catch (err) {
        alert('Failed to update clinic pass: ' + err.message);
    }
});

// ============================================================================
// FETCH & SYNC DOCTORS AND CASES UNDER THIS CLINIC
// ============================================================================
window.syncClinicDashboard = async function(silent = false) {
    if (!activeClinicInfo) return;
    const clinicCode = activeClinicInfo.clinicCode;

    if (!silent) {
        document.getElementById('doctorsRosterContainer').innerHTML =
            '<div class="loading-box">Syncing clinic doctors and patient cases from Firebase...</div>';
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

        // Build unified map of associated doctors
        const mergedDocs = {};
        if (docsData && typeof docsData === 'object') {
            Object.entries(docsData).forEach(([key, d]) => {
                if (d && d.name) {
                    const id = d.id || key;
                    mergedDocs[id] = {
                        id,
                        name: d.name.toLowerCase().startsWith('dr') ? d.name : `Dr. ${d.name}`,
                        department: d.department || 'All',
                        joinedAt: d.joinedAt || null,
                        lastActiveAt: d.lastActiveAt || d.joinedAt || null
                    };
                }
            });
        }

        // Parse all cases for this clinic
        const rawCases = casesData ? Object.values(casesData).filter(Boolean) : [];
        clinicCasesList = rawCases.sort((a, b) => {
            const pA = PRIORITY_WEIGHT[a.triage?.priority || 'ROUTINE'] || 1;
            const pB = PRIORITY_WEIGHT[b.triage?.priority || 'ROUTINE'] || 1;
            if (pB !== pA) return pB - pA;
            return new Date(b.timestamp) - new Date(a.timestamp);
        });

        // Also ensure any doctor who reviewed or was assigned a case appears in the roster
        clinicCasesList.forEach(c => {
            const docName = c.assignedDoctorName || c.reviewedBy;
            if (docName) {
                const docKey = c.assignedDoctorId || normalizeDoctorKey(docName);
                if (!mergedDocs[docKey]) {
                    mergedDocs[docKey] = {
                        id: docKey,
                        name: docName.toLowerCase().startsWith('dr') ? docName : `Dr. ${docName}`,
                        department: c.triage?.suggestedDepartment || 'All',
                        joinedAt: c.timestamp,
                        lastActiveAt: c.reviewedAt || c.timestamp
                    };
                }
            }
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
        docs.map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)} (${escapeHtml(d.department)})</option>`).join('') +
        `<option value="UNASSIGNED">⏳ Unassigned Cases Only</option>`;

    if (Array.from(sel.options).some(o => o.value === prev)) {
        sel.value = prev;
    }
}

function getResolvedDoctorIdForCase(caseData) {
    if (caseData.assignedDoctorId && clinicDoctorsMap[caseData.assignedDoctorId]) {
        return caseData.assignedDoctorId;
    }
    const handlerName = caseData.assignedDoctorName || caseData.reviewedBy;
    if (handlerName) {
        const key = normalizeDoctorKey(handlerName);
        if (clinicDoctorsMap[key]) return key;
    }
    // Check if a doctor sent messages in the case chat
    if (Array.isArray(caseData.messages)) {
        const docMsg = [...caseData.messages].reverse().find(m => m.senderRole === 'doctor' && m.senderName);
        if (docMsg) {
            const key = normalizeDoctorKey(docMsg.senderName);
            if (clinicDoctorsMap[key]) return key;
        }
    }
    return null;
}

function updateClinicMetrics() {
    const docsCount = Object.keys(clinicDoctorsMap).length;
    const activeCases = clinicCasesList.filter(c => c.status !== 'DISSOLVED');
    const unassignedCount = activeCases.filter(c => !getResolvedDoctorIdForCase(c)).length;

    document.getElementById('statTotalDoctors').textContent = docsCount;
    document.getElementById('statTotalCases').textContent = clinicCasesList.length;
    document.getElementById('statCriticalCases').textContent = clinicCasesList.filter(c => c.triage?.priority === 'CRITICAL').length;
    document.getElementById('statUrgentCases').textContent = clinicCasesList.filter(c => c.triage?.priority === 'URGENT').length;
    document.getElementById('statRoutineCases').textContent = clinicCasesList.filter(c => (c.triage?.priority || 'ROUTINE') === 'ROUTINE').length;
    document.getElementById('statUnassignedCases').textContent = unassignedCount;
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

    if (statusFilter === 'ACTIVE' && c.status === 'DISSOLVED') return false;
    if (statusFilter !== 'ACTIVE' && statusFilter !== 'ALL' && c.status !== statusFilter) return false;

    const assignedDocId = getResolvedDoctorIdForCase(c);
    if (docFilter === 'UNASSIGNED' && assignedDocId) return false;
    if (docFilter !== 'ALL' && docFilter !== 'UNASSIGNED' && assignedDocId !== docFilter) return false;

    return true;
}

// ============================================================================
// RENDER DOCTORS & CASES UNDER THEM + UNASSIGNED QUEUE
// ============================================================================
window.renderClinicViews = function() {
    const filteredCases = clinicCasesList.filter(filterCaseByToolbar);
    const doctors = Object.values(clinicDoctorsMap);
    const docFilter = document.getElementById('clinicDoctorFilter').value;

    // 1. Render Unassigned Cases Section
    const unassignedSection = document.getElementById('unassignedCasesSection');
    const unassignedCases = filteredCases.filter(c => !getResolvedDoctorIdForCase(c));

    if (unassignedCases.length > 0 && (docFilter === 'ALL' || docFilter === 'UNASSIGNED')) {
        unassignedSection.style.display = 'block';
        unassignedSection.innerHTML = `
            <div class="clinic-unassigned-panel">
                <div class="clinic-unassigned-header">
                    <div>
                        <h3>⏳ Incoming / Unassigned Patient Cases (${unassignedCases.length})</h3>
                        <p>These cases were sent by patients using code <strong>${escapeHtml(activeClinicInfo.clinicCode)}</strong> and are awaiting doctor assignment or claim.</p>
                    </div>
                </div>
                <div class="clinic-mini-cases-grid">
                    ${unassignedCases.map(c => renderClinicCaseItem(c, doctors)).join('')}
                </div>
            </div>
        `;
    } else {
        unassignedSection.style.display = 'none';
        unassignedSection.innerHTML = '';
    }

    // 2. Render Doctors Roster & Cases Under Each Doctor
    const rosterContainer = document.getElementById('doctorsRosterContainer');
    const visibleDoctors = doctors.filter(d => docFilter === 'ALL' || docFilter === d.id);

    if (docFilter === 'UNASSIGNED') {
        rosterContainer.innerHTML = '';
    } else if (visibleDoctors.length === 0) {
        rosterContainer.innerHTML = `
            <div class="empty-state" style="grid-column: 1 / -1;">
                <h3>No Doctors Associated With ${escapeHtml(activeClinicInfo.clinicCode)} Yet</h3>
                <p>Share Clinic Code <strong>${escapeHtml(activeClinicInfo.clinicCode)}</strong> and your 4-Digit Pass with your doctors.<br>
                As soon as a doctor signs into the <strong>Clinician Dashboard</strong> with your code and pass, they will appear here automatically along with all cases under them.</p>
            </div>
        `;
    } else {
        rosterContainer.innerHTML = visibleDoctors.map(doc => {
            // Direct cases assigned to or reviewed by this doctor
            const directCases = filteredCases.filter(c => getResolvedDoctorIdForCase(c) === doc.id);

            // Department-matched unassigned cases (helpful context if doctor specializes in a dept)
            const deptMatches = filteredCases.filter(c => {
                if (getResolvedDoctorIdForCase(c)) return false;
                if (!doc.department || doc.department === 'All') return false;
                const caseDept = (c.triage?.suggestedDepartment || '').toLowerCase();
                return caseDept.includes(doc.department.toLowerCase());
            });

            const critCount = directCases.filter(c => c.triage?.priority === 'CRITICAL').length;
            const urgCount = directCases.filter(c => c.triage?.priority === 'URGENT').length;
            const routCount = directCases.filter(c => (c.triage?.priority || 'ROUTINE') === 'ROUTINE').length;

            return `
                <div class="clinic-doctor-card">
                    <div class="clinic-doctor-header">
                        <div class="doc-identity">
                            <div class="doc-avatar">🩺</div>
                            <div>
                                <h3>${escapeHtml(doc.name)}</h3>
                                <div class="doc-meta-line">
                                    <span class="badge badge-doctor">${escapeHtml(doc.department || 'All Departments')}</span>
                                    <small class="text-muted">ID: ${escapeHtml(doc.id)}</small>
                                </div>
                                <small class="text-muted" style="display:block; margin-top:3px;">
                                    Last Active: ${escapeHtml(fmtDateTime(doc.lastActiveAt))}
                                </small>
                            </div>
                        </div>

                        <div class="doc-stats-cluster">
                            <span class="doc-case-count-pill">${directCases.length} Case${directCases.length === 1 ? '' : 's'} Under Doctor</span>
                            <div class="doc-mini-prio-row">
                                <span title="Critical">🔴 ${critCount}</span>
                                <span title="Urgent">🟠 ${urgCount}</span>
                                <span title="Routine">🟢 ${routCount}</span>
                            </div>
                        </div>
                    </div>

                    <div class="clinic-doctor-cases-body">
                        <div class="section-title" style="margin-top:0;">
                            📋 Cases Assigned / Handled by ${escapeHtml(doc.name)} (${directCases.length})
                        </div>
                        ${directCases.length > 0 ? `
                            <div class="clinic-doc-case-list">
                                ${directCases.map(c => renderClinicCaseItem(c, doctors)).join('')}
                            </div>
                        ` : `
                            <div class="clinic-empty-subbox">
                                No cases directly assigned or reviewed by ${escapeHtml(doc.name)} matching current filters.
                            </div>
                        `}

                        ${deptMatches.length > 0 ? `
                            <div class="section-title" style="margin-top:14px; color:#1d4ed8;">
                                🎯 Unassigned ${escapeHtml(doc.department)} Queue (${deptMatches.length})
                            </div>
                            <div class="clinic-doc-case-list">
                                ${deptMatches.map(c => renderClinicCaseItem(c, doctors)).join('')}
                            </div>
                        ` : ''}
                    </div>
                </div>
            `;
        }).join('');
    }

    // 3. Render All Clinic Cases View
    const allCasesContainer = document.getElementById('allClinicCasesContainer');
    if (filteredCases.length === 0) {
        allCasesContainer.innerHTML = `<div class="empty-state"><h3>No patient cases match the selected filters</h3></div>`;
    } else {
        allCasesContainer.innerHTML = filteredCases.map(c => renderClinicCaseItem(c, doctors, true)).join('');
    }
};

function renderClinicCaseItem(caseData, doctors, expanded = false) {
    const t = caseData.triage || {};
    const priority = t.priority || 'ROUTINE';
    const prioClass = `priority-${priority.toLowerCase()}`;
    const resolvedDocId = getResolvedDoctorIdForCase(caseData);
    const assignedDocObj = resolvedDocId ? clinicDoctorsMap[resolvedDocId] : null;
    const assignedDocLabel = assignedDocObj
        ? assignedDocObj.name
        : (caseData.assignedDoctorName || caseData.reviewedBy || 'Unassigned');

    const doctorOptionsHtml = `<option value="">-- Unassigned --</option>` +
        doctors.map(d => `<option value="${escapeHtml(d.id)}" ${resolvedDocId === d.id ? 'selected' : ''}>${escapeHtml(d.name)} (${escapeHtml(d.department)})</option>`).join('');

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
                    <span class="priority-badge">${escapeHtml(priority)}</span>
                    <span class="status-pill status-${(caseData.status || 'PENDING_REVIEW').toLowerCase()}">${escapeHtml((caseData.status || 'PENDING_REVIEW').replace(/_/g, ' '))}</span>
                </div>
            </div>

            <div class="clinic-case-summary">
                ${escapeHtml(t.clinicalSummary || caseData.symptomsText || 'Multimodal symptom intake submitted.')}
            </div>

            ${caseData.doctorNote ? `
                <div class="doctor-rx-box" style="margin:6px 0; padding:7px 10px;">
                    <strong>🩺 Doctor's Note (${escapeHtml(caseData.reviewedBy || assignedDocLabel)}):</strong>
                    <span>${escapeHtml(caseData.doctorNote)}</span>
                </div>
            ` : ''}

            <div class="clinic-case-footer">
                <small class="text-muted">
                    Submitted: ${escapeHtml(fmtDateTime(caseData.timestamp))} •
                    Doctor: <strong>${escapeHtml(assignedDocLabel)}</strong>
                </small>

                <div class="clinic-assign-control">
                    <label style="font-size:0.75rem; font-weight:700; color:#475569;">Doctor:</label>
                    <select class="priority-select-inline" onchange="assignCaseToDoctor('${caseData.id}', this.value)">
                        ${doctorOptionsHtml}
                    </select>
                </div>
            </div>
        </div>
    `;
}

// Clinic Admin can assign or reassign any case to an associated doctor
window.assignCaseToDoctor = async function(caseId, docId) {
    if (!activeClinicInfo) return;
    const clinicCode = activeClinicInfo.clinicCode;
    const caseData = clinicCasesList.find(c => c.id === caseId);
    if (!caseData) return;

    const docObj = docId ? clinicDoctorsMap[docId] : null;
    const nowIso = new Date().toISOString();
    const auditLog = Array.isArray(caseData.auditLog) ? [...caseData.auditLog] : [];

    auditLog.push({
        timestamp: nowIso,
        actor: `Clinic Admin (${activeClinicInfo.clinicName || clinicCode})`,
        action: docObj
            ? `Assigned case to ${docObj.name} (${docObj.department}).`
            : `Cleared doctor assignment (returned to unassigned queue).`
    });

    try {
        await fbFetch(`${FIREBASE_URL}/clinics/${clinicCode}/cases/${caseId}.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                assignedDoctorId: docObj ? docObj.id : null,
                assignedDoctorName: docObj ? docObj.name : null,
                auditLog
            })
        });
        await syncClinicDashboard(true);
    } catch (err) {
        alert('Failed to assign doctor: ' + err.message);
    }
};

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
