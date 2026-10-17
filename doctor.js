// Firebase Realtime Database URL (without trailing slash)
const FIREBASE_URL = "https://careflowai-2bd8b-default-rtdb.firebaseio.com";

// Cookie Helpers
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

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Load or Initialize Doctor Cookie Session
let currentUser = getCookie('careflow_user');
if (!currentUser || currentUser.role !== 'doctor') {
    currentUser = {
        role: 'doctor',
        name: currentUser?.name || 'Dr. Ananya Sharma',
        userId: currentUser?.userId || ('DOC-' + Math.floor(100 + Math.random() * 900)),
        clinicCode: currentUser?.clinicCode || 'CARE-101',
        department: currentUser?.department || 'All',
        savedClinics: ['CARE-101', 'CITY-202', 'METRO-303', 'AIIMS-DEL']
    };
    setCookie('careflow_user', currentUser, 30);
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

let currentClinic = currentUser.clinicCode || 'CARE-101';
let currentDepartment = currentUser.department || 'All';
let currentCasesList = []; // Ordered list currently displayed
let pendingPriorityConfirmation = null;
let pendingParamedicCase = null;

const PRIORITY_TIER_WEIGHT = {
    CRITICAL: 3,
    URGENT: 2,
    ROUTINE: 1
};

function initDoctorProfileBar() {
    docNameInput.value = currentUser.name || 'Dr. Sharma';
    docClinicCode.value = currentClinic;
    docDepartment.value = currentDepartment;

    const displayDocName = currentUser.name.toLowerCase().startsWith('dr')
        ? currentUser.name
        : `Dr. ${currentUser.name}`;

    doctorGreetingHeader.innerHTML = `
        <span class="user-chip">
            🩺 Welcome, <strong>${escapeHtml(displayDocName)}</strong>
            <small>(${escapeHtml(currentUser.userId)} • Clinic: ${escapeHtml(currentClinic)})</small>
        </span>
        <a href="index.html" class="ghost-btn sm-btn">Switch Role / Profile</a>
    `;

    // Populate saved clinics in quick switcher
    const clinics = Array.from(new Set([...(currentUser.savedClinics || []), currentClinic, 'CARE-101', 'CITY-202', 'METRO-303']));
    quickClinicSelect.innerHTML = `<option value="">Switch Clinic...</option>` +
        clinics.map(c => `<option value="${escapeHtml(c)}" ${c === currentClinic ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('');
}

quickClinicSelect.addEventListener('change', () => {
    if (quickClinicSelect.value) {
        docClinicCode.value = quickClinicSelect.value;
        doctorFilterForm.dispatchEvent(new Event('submit'));
    }
});

doctorFilterForm.addEventListener('submit', (e) => {
    e.preventDefault();
    currentClinic = docClinicCode.value.trim().toUpperCase();
    currentDepartment = docDepartment.value;
    const docName = docNameInput.value.trim() || 'Dr. Sharma';

    currentUser.name = docName;
    currentUser.clinicCode = currentClinic;
    currentUser.department = currentDepartment;
    if (!Array.isArray(currentUser.savedClinics)) currentUser.savedClinics = [];
    if (!currentUser.savedClinics.includes(currentClinic)) {
        currentUser.savedClinics.push(currentClinic);
    }
    setCookie('careflow_user', currentUser, 30);
    initDoctorProfileBar();
    fetchCloudQueue();
});

refreshQueueBtn.addEventListener('click', fetchCloudQueue);
docDepartment.addEventListener('change', () => doctorFilterForm.dispatchEvent(new Event('submit')));
docStatusFilter.addEventListener('change', fetchCloudQueue);

// Sort comparator: strictly by Priority Tier (CRITICAL > URGENT > ROUTINE), then by manualOrderOffset (high to low), then newest timestamp
function sortCasesByPriority(cases) {
    return cases.sort((a, b) => {
        const prioA = (a.triage && a.triage.priority) || 'ROUTINE';
        const prioB = (b.triage && b.triage.priority) || 'ROUTINE';
        const weightDiff = (PRIORITY_TIER_WEIGHT[prioB] || 1) - (PRIORITY_TIER_WEIGHT[prioA] || 1);
        if (weightDiff !== 0) return weightDiff;

        const offsetA = typeof a.manualOrderOffset === 'number' ? a.manualOrderOffset : 0;
        const offsetB = typeof b.manualOrderOffset === 'number' ? b.manualOrderOffset : 0;
        if (offsetB !== offsetA) return offsetB - offsetA;

        return new Date(b.timestamp) - new Date(a.timestamp);
    });
}

// Fetch and Render Prioritized Cases
async function fetchCloudQueue() {
    triageQueue.innerHTML = '<div class="loading-box">Syncing prioritized queue from hospital cloud...</div>';

    try {
        const response = await fetch(`${FIREBASE_URL}/clinics/${currentClinic}/cases.json`);
        const data = await response.json();

        if (!data) {
            updateQueueStats([]);
            triageQueue.innerHTML = `<div class="empty-state"><h3>No cases found in clinic ${escapeHtml(currentClinic)}</h3><p>Switch clinics above or wait for new patient submissions.</p></div>`;
            return;
        }

        const allCases = Object.values(data).filter(Boolean);
        const statusFilter = docStatusFilter.value;

        const filtered = allCases.filter(c => {
            const dept = (c.triage && c.triage.suggestedDepartment) || 'General Medicine';
            const matchDept = currentDepartment === 'All' || dept.toLowerCase().includes(currentDepartment.toLowerCase());

            let matchStatus = true;
            if (statusFilter === 'ACTIVE') {
                matchStatus = c.status !== 'DISSOLVED';
            } else if (statusFilter !== 'ALL') {
                matchStatus = c.status === statusFilter;
            }
            return matchDept && matchStatus;
        });

        currentCasesList = sortCasesByPriority(filtered);
        updateQueueStats(currentCasesList);

        triageQueue.innerHTML = '';
        if (currentCasesList.length === 0) {
            triageQueue.innerHTML = `<div class="empty-state"><h3>No matching cases for ${escapeHtml(currentDepartment)} (${escapeHtml(statusFilter)})</h3></div>`;
            return;
        }

        currentCasesList.forEach((caseData, index) => {
            triageQueue.appendChild(renderDoctorCaseCard(caseData, index, currentCasesList.length));
        });
    } catch (err) {
        triageQueue.innerHTML = `<div class="status-banner status-error">Error loading cloud queue: ${escapeHtml(err.message)}</div>`;
    }
}

function updateQueueStats(cases) {
    document.getElementById('countCritical').textContent = cases.filter(c => c.triage?.priority === 'CRITICAL').length;
    document.getElementById('countUrgent').textContent = cases.filter(c => c.triage?.priority === 'URGENT').length;
    document.getElementById('countRoutine').textContent = cases.filter(c => (c.triage?.priority || 'ROUTINE') === 'ROUTINE').length;
    document.getElementById('countTotal').textContent = cases.length;
}

// Render Each Triage Card with Reddit-Style Upvote/Downvote, Source Links, Conflict/Uncertainty Flags, Chat, & Paramedic Controls
function renderDoctorCaseCard(caseData, index, totalCount) {
    const t = caseData.triage || {};
    const priority = t.priority || 'ROUTINE';
    const priorityClass = `priority-${priority.toLowerCase()}`;
    const isDissolved = caseData.status === 'DISSOLVED';
    const isEmergency = caseData.status === 'EMERGENCY_DISPATCHED' || !!caseData.paramedicDispatch;

    const symptomsHtml = Array.isArray(t.standardizedSymptoms) && t.standardizedSymptoms.length
        ? t.standardizedSymptoms.map(s => `<li>${escapeHtml(s)}</li>`).join('')
        : '<li>None extracted</li>';

    const warningSignsHtml = Array.isArray(t.warningSigns) && t.warningSigns.length
        ? `<div class="warning-signs-box">🚨 <strong>Red Flag Warning Signs:</strong> ${t.warningSigns.map(w => `<span class="red-flag-chip">${escapeHtml(w)}</span>`).join(' ')}</div>`
        : '';

    // Source Links (Connecting extracted info to Patient Text, Voice Recording, Report OCR, or Chat)
    const sourceLinks = Array.isArray(t.sourceLinks) && t.sourceLinks.length
        ? t.sourceLinks
        : [
            ...(caseData.symptomsText ? [{ claim: caseData.symptomsText, source: 'Patient Text', confidence: 'High' }] : []),
            ...(caseData.hasAudio ? [{ claim: 'Audio symptom description', source: 'Voice Recording', confidence: 'High' }] : []),
            ...(caseData.hasImage ? [{ claim: 'Uploaded clinical document', source: 'Medical Report OCR', confidence: 'Medium' }] : [])
        ];

    const sourcesHtml = sourceLinks.map(s => `
        <div class="source-link-item">
            <span class="source-tag"></span>
            <span>${escapeHtml(s.claim)}</span>
            <small class="conf-tag">Confidence: ${escapeHtml(s.confidence || 'High')}</small>
        </div>
    `).join('');

    // Vitals
    const vitals = t.extractedVitals || {};
    const vitalsHtml = `
        <div class="vitals-strip">
            <span>🌡️ Temp: <strong>${escapeHtml(vitals.temperature || 'N/A')}</strong></span>
            <span>❤️ HR: <strong>${escapeHtml(vitals.heart_rate || 'N/A')}</strong></span>
            <span>🩸 BP: <strong>${escapeHtml(vitals.blood_pressure || 'N/A')}</strong></span>
            <span>🫁 SpO₂: <strong>${escapeHtml(vitals.spo2 || 'N/A')}</strong></span>
        </div>
    `;

    // Flags for Missing, Conflicting, Uncertain, or Suspicious Instructions
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

    // AI Follow-Up Questions (Click to insert into chat)
    const questionsHtml = Array.isArray(t.followUpQuestions) && t.followUpQuestions.length
        ? t.followUpQuestions.map(q => `
            <li class="followup-item">
                <span>${escapeHtml(q)}</span>
                <button type="button" class="chip-btn" onclick="askFollowUpInChat('${caseData.id}',${JSON.stringify(q).replace(/"/g, '&quot;')})">Ask in Chat ↵</button>
            </li>
        `).join('')
        : '<li>None suggested</li>';

    // Messages
    const messages = Array.isArray(caseData.messages) ? caseData.messages : [];
    const chatHtml = messages.map(m => `
        <div class="chat-bubble ${m.senderRole === 'doctor' ? 'chat-doctor' : (m.senderRole === 'system' ? 'chat-system' : 'chat-patient')}">
            <div class="chat-meta">
                <strong>${escapeHtml(m.senderName)}</strong>
                <span>${new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <div class="chat-text">${escapeHtml(m.text)}</div>
        </div>
    `).join('');

    // Audit Log
    const audits = Array.isArray(caseData.auditLog) ? caseData.auditLog : [];
    const auditHtml = audits.map(a => `
        <li><strong>${new Date(a.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong> — <em>${escapeHtml(a.actor)}:</em>${escapeHtml(a.action)}</li>
    `).join('');

    const card = document.createElement('div');
    card.className = `triage-card ${priorityClass}${isDissolved ? 'case-dissolved' : ''}`;
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
                            <span class="status-pill status-${(caseData.status \vert{}\vert{} 'PENDING_REVIEW').toLowerCase()}">${escapeHtml((caseData.status || 'PENDING_REVIEW').replace(/_/g, ' '))}</span>
                        </h3>
                        <div class="patient-meta">
                            Case <strong>#${escapeHtml(caseData.id)}</strong> \vert{} Clinic: <strong>${escapeHtml(caseData.clinicCode)}</strong> |
                            Submitted: ${new Date(caseData.timestamp).toLocaleString()} |
                            Dept: <strong>${escapeHtml(t.suggestedDepartment || 'General Medicine')}</strong>
                        </div>
                    </div>

                    <div class="header-badges">
                        <span class="priority-badge">${escapeHtml(priority)}</span>
                        <select class="priority-select-inline" onchange="handleDirectPrioritySelect('${caseData.id}', this.value)" title="Change Priority Tier">
                            <option value="CRITICAL" ${priority === 'CRITICAL' ? 'selected' : ''}>🔴 CRITICAL</option>
                            <option value="URGENT" ${priority === 'URGENT' ? 'selected' : ''}>🟠 URGENT</option>
                            <option value="ROUTINE" ${priority === 'ROUTINE' ? 'selected' : ''}>🟢 ROUTINE</option>
                        </select>
                    </div>
                </div>

                ${isEmergency ? `
                    <div class="emergency-banner">
                        🚑 <strong>PARAMEDIC TEAM DISPATCHED:</strong> Forwarded by ${escapeHtml(caseData.paramedicDispatch?.dispatchedBy || 'Doctor')} at ${escapeHtml(caseData.paramedicDispatch?.dispatchedAt || '')} (Dispatch Ref: ${escapeHtml(caseData.paramedicDispatch?.dispatchId || 'EMS-911')}).
                    </div>
                ` : ''}

                ${warningSignsHtml}${vitalsHtml}

                <div class="card-body-grid">
                    <div>
                        <div class="section-title">Structured Clinical Summary &amp; Timeline</div>
                        <div class="clinical-summary-box">
                            <p style="margin:0 0 6px 0;">${escapeHtml(t.clinicalSummary || caseData.symptomsText || 'No summary available.')}</p>
                            <small><strong>Onset &amp; Progression:</strong> ${escapeHtml(t.symptomTimeline || caseData.symptomOnset || 'Not specified')}</small>
                        </div>

                        <div class="section-title">Standardized Symptoms</div>
                        <ul>${symptomsHtml}</ul>

                        <div class="section-title">Source Attribution Links</div>
                        <div class="sources-list">${sourcesHtml}</div>

                        ${caseData.imagePreviewData ? `
                            <div style="margin-top:8px;">
                                <div class="section-title">Attached Medical Report (OCR Source)</div>
                                <img src="${caseData.imagePreviewData}" alt="Attached Report" style="max-height:120px; border-radius:6px; border:1px solid #cbd5e1;">
                            </div>
                        ` : ''}
                    </div>

                    <div>
                        <div class="section-title">AI Suggested Follow-Up Questions</div>
                        <ul class="followup-list">${questionsHtml}</ul>

                        ${alertHtml}

                        <div class="ai-chat-summary-box">
                            <strong>🤖 AI Live Chat Analysis:</strong>
                            <p style="margin:4px 0 0 0;">${escapeHtml(caseData.chatAiSummary || 'No follow-up patient chat updates yet.')}</p>
                        </div>
                    </div>
                </div>

                <!-- Doctor-Patient Case Chat -->
                <div class="chat-section doctor-chat-section">
                    <div class="chat-header-bar">
                        <span>💬 Direct Patient Consultation Chat (${messages.length})</span>
                        <small>Patient replies are automatically summarized &amp; re-triaged by AI</small>
                    </div>
                    <div class="chat-messages-box" id="docChatBox_${caseData.id}">
                        ${chatHtml}
                    </div>
                    ${!isDissolved ? `
                        <div class="chat-input-row">
                            <input type="text" id="docChatInput_${caseData.id}" placeholder="Update patient on health, suggest medicines, or ask follow-up questions...">
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

    // Check if moving a CRITICAL case below an URGENT or ROUTINE case (or URGENT below ROUTINE)
    if (direction === 'down' && PRIORITY_TIER_WEIGHT[movingPrio] > PRIORITY_TIER_WEIGHT[neighborPrio]) {
        openPriorityDowngradeModal(movingCase, neighborCase, neighborPrio);
        return;
    }

    // Check if moving a lower-priority case above a higher-priority case
    if (direction === 'up' && PRIORITY_TIER_WEIGHT[movingPrio] < PRIORITY_TIER_WEIGHT[neighborPrio]) {
        openPriorityDowngradeModal(movingCase, neighborCase, neighborPrio, true);
        return;
    }

    // Same priority tier: swap their manualOrderOffset values to reorder immediately
    await swapOrderWithinTier(movingCase, neighborCase, direction);
};

async function swapOrderWithinTier(movingCase, neighborCase, direction, forcedNewPriority = null) {
    const currentNeighborOffset = typeof neighborCase.manualOrderOffset === 'number' ? neighborCase.manualOrderOffset : 0;
    const newMovingOffset = direction === 'up' ? currentNeighborOffset + 1 : currentNeighborOffset - 1;
    const newNeighborOffset = direction === 'up' ? currentNeighborOffset - 1 : currentNeighborOffset + 1;

    const updatedPriority = forcedNewPriority || movingCase.triage?.priority || 'ROUTINE';
    const nowIso = new Date().toISOString();
    const docActor = `Dr. ${docNameInput.value.trim() || currentUser.name}`;

    const auditLog = Array.isArray(movingCase.auditLog) ? movingCase.auditLog : [];
    auditLog.push({
        timestamp: nowIso,
        actor: docActor,
        action: forcedNewPriority
            ? `Moved case ${direction} across tier and confirmed priority change from ${movingCase.triage?.priority} → ${forcedNewPriority}.`
            : `Reordered case ${direction} in clinic queue via priority arrow.`
    });

    const updatedTriage = {
        ...(movingCase.triage || {}),
        priority: updatedPriority
    };

    await Promise.all([
        fetch(`${FIREBASE_URL}/clinics/${currentClinic}/cases/${movingCase.id}.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                manualOrderOffset: newMovingOffset,
                triage: updatedTriage,
                auditLog
            })
        }),
        fetch(`${FIREBASE_URL}/clinics/${currentClinic}/cases/${neighborCase.id}.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                manualOrderOffset: newNeighborOffset
            })
        })
    ]);

    await fetchCloudQueue();
}

function openPriorityDowngradeModal(movingCase, neighborCase, targetPriority, isUpgrade = false) {
    const currentPrio = movingCase.triage?.priority || 'ROUTINE';
    pendingPriorityConfirmation = { movingCase, neighborCase, targetPriority, direction: isUpgrade ? 'up' : 'down' };

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

// Direct dropdown priority change (also confirms if downgrading from CRITICAL)
window.handleDirectPrioritySelect = async function(caseId, newPriority) {
    const caseData = currentCasesList.find(c => c.id === caseId);
    if (!caseData) return;
    const oldPriority = caseData.triage?.priority || 'ROUTINE';
    if (oldPriority === newPriority) return;

    if (oldPriority === 'CRITICAL' && (newPriority === 'URGENT' || newPriority === 'ROUTINE')) {
        const ok = confirm(`CONFIRM DOWNGRADE:\nCase #${caseId} (${caseData.patientName}) is currently marked CRITICAL.\nAre you sure you want to downgrade its priority rating to${newPriority}?`);
        if (!ok) {
            fetchCloudQueue();
            return;
        }
    }

    const nowIso = new Date().toISOString();
    const docActor = docNameInput.value.trim() || currentUser.name;
    const auditLog = Array.isArray(caseData.auditLog) ? caseData.auditLog : [];
    auditLog.push({
        timestamp: nowIso,
        actor: docActor,
        action: `Changed case priority from ${oldPriority} →${newPriority}.`
    });

    await fetch(`${FIREBASE_URL}/clinics/${currentClinic}/cases/${caseId}.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            triage: { ...(caseData.triage || {}), priority: newPriority },
            auditLog
        })
    });
    await fetchCloudQueue();
};

// ============================================================================
// DOCTOR-PATIENT CHATTING & FOLLOW-UPINSERTION
// ============================================================================
window.askFollowUpInChat = function(caseId, questionText) {
    const input = document.getElementById(`docChatInput_${caseId}`);
    if (input) {
        input.value = questionText;
        input.focus();
    }
};

window.sendDoctorChatMessage = async function(caseId) {
    const input = document.getElementById(`docChatInput_${caseId}`);
    const text = input.value.trim();
    if (!text) return;

    const caseData = currentCasesList.find(c => c.id === caseId);
    if (!caseData) return;

    const docName = docNameInput.value.trim() || currentUser.name || 'Dr. Sharma';
    const nowIso = new Date().toISOString();

    const messages = Array.isArray(caseData.messages) ? caseData.messages : [];
    messages.push({
        id: 'MSG-' + Date.now(),
        senderRole: 'doctor',
        senderName: docName.toLowerCase().startsWith('dr') ? docName : `Dr. ${docName}`,
        text,
        timestamp: nowIso
    });

    const auditLog = Array.isArray(caseData.auditLog) ? caseData.auditLog : [];
    auditLog.push({
        timestamp: nowIso,
        actor: docName,
        action: `Sent clinical chat update to patient: "${text.substring(0, 80)}"`
    });

    try {
        await fetch(`${FIREBASE_URL}/clinics/${currentClinic}/cases/${caseId}.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages, auditLog })
        });
        input.value = '';
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

    const note = document.getElementById(`doctorNote_${caseId}`).value.trim();
    const docName = docNameInput.value.trim() || currentUser.name || 'Dr. Sharma';
    const nowIso = new Date().toISOString();

    const auditLog = Array.isArray(caseData.auditLog) ? caseData.auditLog : [];
    auditLog.push({
        timestamp: nowIso,
        actor: docName,
        action: `Approved and finalized triage/referral note.`
    });

    try {
        await fetch(`${FIREBASE_URL}/clinics/${currentClinic}/cases/${caseId}.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                status: caseData.status === 'EMERGENCY_DISPATCHED' ? 'EMERGENCY_DISPATCHED' : 'APPROVED',
                doctorNote: note || "Triage validated. Proceed to OPD consultation.",
                reviewedBy: docName,
                reviewedAt: new Date().toLocaleTimeString(),
                auditLog
            })
        });
        await fetchCloudQueue();
    } catch (err) {
        alert("Failed to save approval: " + err.message);
    }
};

// Ask Patient to Close/Dissolve Case if Recovered
window.requestPatientClosure = async function(caseId) {
    const caseData = currentCasesList.find(c => c.id === caseId);
    if (!caseData) return;

    const docName = docNameInput.value.trim() || currentUser.name || 'Dr. Sharma';
    const nowIso = new Date().toISOString();

    const messages = Array.isArray(caseData.messages) ? caseData.messages : [];
    messages.push({
        id: 'MSG-' + Date.now(),
        senderRole: 'doctor',
        senderName: docName,
        text: 'Have your symptoms resolved? If you have recovered, please confirm using the closure prompt on your portal to dissolve this case.',
        timestamp: nowIso
    });

    const auditLog = Array.isArray(caseData.auditLog) ? caseData.auditLog : [];
    auditLog.push({
        timestamp: nowIso,
        actor: docName,
        action: 'Requested patient confirmation to close/dissolve case upon recovery.'
    });

    await fetch(`${FIREBASE_URL}/clinics/${currentClinic}/cases/${caseId}.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            status: 'CLOSURE_REQUESTED',
            closureRequestedBy: docName,
            messages,
            auditLog
        })
    });
    await fetchCloudQueue();
};

// Doctor Dissolves Case Directly
window.dissolveCaseDirectly = async function(caseId) {
    const caseData = currentCasesList.find(c => c.id === caseId);
    if (!caseData) return;
    if (!confirm(`Dissolve and close Case #${caseId} (${caseData.patientName})?`)) return;

    const docName = docNameInput.value.trim() || currentUser.name || 'Dr. Sharma';
    const nowIso = new Date().toISOString();

    const messages = Array.isArray(caseData.messages) ? caseData.messages : [];
    messages.push({
        id: 'MSG-' + Date.now(),
        senderRole: 'system',
        senderName: 'CareFlow System',
        text: `Case #${caseId} was marked as resolved and dissolved by${docName}.`,
        timestamp: nowIso
    });

    const auditLog = Array.isArray(caseData.auditLog) ? caseData.auditLog : [];
    auditLog.push({
        timestamp: nowIso,
        actor: docName,
        action: 'Dissolved/closed case directly.'
    });

    await fetch(`${FIREBASE_URL}/clinics/${currentClinic}/cases/${caseId}.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            status: 'DISSOLVED',
            messages,
            auditLog
        })
    });
    await fetchCloudQueue();
};

// Doctor Purges Case Completely from Cloud Storage
window.purgeRecord = async function(caseId) {
    const caseData = currentCasesList.find(c => c.id === caseId);
    if (!confirm(`PRIVACY & DATA PURGE WARNING:\nPermanently delete Case #${caseId} from Firebase cloud storage? This action cannot be undone.`)) {
        return;
    }

    try {
        await fetch(`${FIREBASE_URL}/clinics/${currentClinic}/cases/${caseId}.json`, { method: 'DELETE' });
        if (caseData && caseData.patientUserId) {
            await fetch(`${FIREBASE_URL}/patients/${caseData.patientUserId}/cases/${caseId}.json`, { method: 'DELETE' });
        }
        await fetchCloudQueue();
    } catch (err) {
        alert("Failed to purge record: " + err.message);
    }
};

// Doctor-Initiated Emergency Paramedic Dispatch Modal
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
            <div><strong>AI Triage Category:</strong> ${escapeHtml(t.priority \vert{}\vert{} 'CRITICAL')} (${escapeHtml(t.suggestedDepartment || 'Emergency')})</div>
            <div><strong>Primary Symptoms:</strong> ${escapeHtml((t.standardizedSymptoms || [caseData.symptomsText]).join(', '))}</div>
            <div><strong>Extracted Vitals:</strong> Temp: ${escapeHtml(v.temperature \vert{}\vert{} 'N/A')} \vert{} HR:${escapeHtml(v.heart_rate || 'N/A')} | BP: ${escapeHtml(v.blood_pressure \vert{}\vert{} 'N/A')} \vert{} SpO₂:${escapeHtml(v.spo2 || 'N/A')}</div>
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
    const docName = docNameInput.value.trim() || currentUser.name || 'Dr. Sharma';
    const dispatchNote = document.getElementById('paramedicNotesInput')?.value || 'Immediate ALS Paramedic response requested.';
    const dispatchId = 'EMS-' + Math.floor(10000 + Math.random() * 90000);
    const nowTime = new Date().toLocaleTimeString();
    const nowIso = new Date().toISOString();

    const paramedicDispatch = {
        dispatchId,
        dispatchedBy: docName,
        dispatchedAt: nowTime,
        instructions: dispatchNote
    };

    const messages = Array.isArray(caseData.messages) ? caseData.messages : [];
    messages.push({
        id: 'MSG-' + Date.now(),
        senderRole: 'system',
        senderName: '🚨 Paramedic Dispatch Desk',
        text: `EMERGENCY ALERT: ${docName} has marked this case as an Emergency and forwarded your patient details to the Hospital Paramedic Team (Ref: ${dispatchId}). Instructions: ${dispatchNote}`,
        timestamp: nowIso
    });

    const auditLog = Array.isArray(caseData.auditLog) ? caseData.auditLog : [];
    auditLog.push({
        timestamp: nowIso,
        actor: docName,
        action: `Marked case as EMERGENCY and dispatched Hospital Paramedic Team (Ref: ${dispatchId}).`
    });

    await fetch(`${FIREBASE_URL}/clinics/${currentClinic}/cases/${caseData.id}.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            status: 'EMERGENCY_DISPATCHED',
            triage: { ...(caseData.triage || {}), priority: 'CRITICAL' },
            paramedicDispatch,
            messages,
            auditLog
        })
    });

    const banner = document.getElementById('paramedicDispatchConfirmationBanner');
    if (banner) {
        banner.style.display = 'block';
        banner.innerHTML = `✅ <strong>Patient Details Forwarded to Hospital Paramedic Team!</strong><br>Dispatch ID: <strong>${dispatchId}</strong> | Authorized by: <strong>${escapeHtml(docName)}</strong> at${nowTime}.`;
    }
    confirmParamedicDispatchBtn.style.display = 'none';
    await fetchCloudQueue();
});

closeParamedicModalBtn.addEventListener('click', () => {
    paramedicModal.style.display = 'none';
    pendingParamedicCase = null;
});

// Initialize on load
initDoctorProfileBar();
fetchCloudQueue();
