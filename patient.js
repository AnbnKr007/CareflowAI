// Firebase Realtime Database URL (without trailing slash)
const FIREBASE_URL = "https://careflowai-2bd8b-default-rtdb.firebaseio.com";

// Firebase fetch wrapper: fetch() does NOT throw on 401/403, so a locked-down DB
// would silently "succeed". This makes permission/network failures visible.
async function fbFetch(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) {
        throw new Error(res.status === 401 || res.status === 403
            ? `Firebase rejected the request (${res.status}). Open Firebase Console > Realtime Database > Rules and allow read/write.`
            : `Firebase error ${res.status}`);
    }
    return res;
}
// Unguessable random ID (e.g. PAT-K7M2QX9P). Replaces 4-digit IDs that collided and could be guessed.
function randomId(prefix, len = 8) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars, no 0/O/1/I confusion
    const a = new Uint32Array(len);
    crypto.getRandomValues(a);
    return prefix + '-' + Array.from(a, n => chars[n % chars.length]).join('');
}
function cleanClinicCode(v) { return String(v || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, ''); }

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

// Initialize or load Patient Cookie Profile
let currentUser = getCookie('careflow_user');
if (!currentUser) {
    currentUser = {
        role: 'patient',
        name: '',
        userId: randomId('USR'),
        age: '',
        gender: '',
        knownCases: [] // [{ clinicCode, caseId }]
    };
    setCookie('careflow_user', currentUser, 30);
}
if (!Array.isArray(currentUser.knownCases)) {
    currentUser.knownCases = [];
}

// DOM Elements
const patientGreetingHeader = document.getElementById('patientGreetingHeader');
const recordBtn = document.getElementById('recordBtn');
const stopRecordBtn = document.getElementById('stopRecordBtn');
const clearAudioBtn = document.getElementById('clearAudioBtn');
const recordingStatus = document.getElementById('recordingStatus');
const audioPreview = document.getElementById('audioPreview');
const reportImageInput = document.getElementById('reportImage');
const imagePreview = document.getElementById('imagePreview');
const imagePreviewContainer = document.getElementById('imagePreviewContainer');
const clearImageBtn = document.getElementById('clearImageBtn');
const patientForm = document.getElementById('patientForm');
const statusMessage = document.getElementById('statusMessage');
const myCasesByClinicContainer = document.getElementById('myCasesByClinicContainer');
const refreshMyCasesBtn = document.getElementById('refreshMyCasesBtn');

let mediaRecorder;
let audioChunks = [];
let audioBase64 = null;
let audioMime = 'audio/webm';
let recordTimer = null;
const MAX_RECORD_SECONDS = 120; // auto-stops long recordings
let imageBase64 = null;

// Populate Greeting & Pre-fill Form from Cookie
function initPatientSessionUI() {
    if (currentUser.name) {
        patientGreetingHeader.innerHTML = `
            <span class="user-chip">👋 Hello, <strong>${escapeHtml(currentUser.name)}</strong> <small>(${currentUser.userId})</small></span>
            <a href="index.html" class="ghost-btn sm-btn">Switch User</a>
        `;
        document.getElementById('patientName').value = currentUser.name;
        if (currentUser.age) document.getElementById('patientAge').value = currentUser.age;
        if (currentUser.gender) document.getElementById('patientGender').value = currentUser.gender;
        document.getElementById('myCasesHeader').textContent = `${currentUser.name}'s Cases`;
    } else {
        patientGreetingHeader.innerHTML = `
            <span class="user-chip">Guest Session <small>(${currentUser.userId})</small></span>
            <a href="index.html" class="ghost-btn sm-btn">Sign In</a>
        `;
    }
}

window.setClinicInput = function(code) {
    document.getElementById('clinicCode').value = code;
};

// Date + time for chat/audit style timestamps (e.g. "18 Oct 2026, 05:12 pm")
function fmtDateTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Audio Recorder
recordBtn.addEventListener('click', async () => {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Use a format this browser really supports (Chrome: webm, Safari: mp4) and remember it
        const preferredTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
        const chosenType = preferredTypes.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
        mediaRecorder = chosenType ? new MediaRecorder(stream, { mimeType: chosenType }) : new MediaRecorder(stream);
        audioChunks = [];

        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) audioChunks.push(event.data);
        };

        mediaRecorder.onstop = () => {
            audioMime = (mediaRecorder.mimeType || 'audio/webm').split(';')[0];
            const audioBlob = new Blob(audioChunks, { type: audioMime });
            audioPreview.src = URL.createObjectURL(audioBlob);
            audioPreview.style.display = 'block';
            clearAudioBtn.style.display = 'inline-block';

            const reader = new FileReader();
            reader.readAsDataURL(audioBlob);
            reader.onloadend = () => {
                audioBase64 = reader.result.split(',')[1];
            };
            stream.getTracks().forEach(track => track.stop());
        };

        mediaRecorder.start();
        clearTimeout(recordTimer);
        recordTimer = setTimeout(() => { if (!stopRecordBtn.disabled) stopRecordBtn.click(); }, MAX_RECORD_SECONDS * 1000);
        recordBtn.disabled = true;
        stopRecordBtn.disabled = false;
        recordingStatus.textContent = `● Recording... speak now (auto-stops at ${MAX_RECORD_SECONDS}s)`;
        recordingStatus.style.color = "#ef4444";
    } catch (err) {
        alert("Microphone access denied or unavailable in this browser.");
    }
});

stopRecordBtn.addEventListener('click', () => {
    clearTimeout(recordTimer);
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
        recordBtn.disabled = false;
        stopRecordBtn.disabled = true;
        recordingStatus.textContent = "Voice recording attached ✓";
        recordingStatus.style.color = "#16a34a";
    }
});

clearAudioBtn.addEventListener('click', () => {
    audioBase64 = null;
    audioPreview.src = '';
    audioPreview.style.display = 'none';
    clearAudioBtn.style.display = 'none';
    recordingStatus.textContent = 'Idle';
    recordingStatus.style.color = '#64748b';
});

// Image OCR Converter: downscale to max 1280px JPEG so the request stays under Vercel's ~4.5MB body limit
function compressImage(file, maxDim = 1280, quality = 0.8) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(url);
            resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
        img.src = url;
    });
}

reportImageInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
        const dataUrl = await compressImage(file);
        imageBase64 = dataUrl.split(',')[1];
        imagePreview.src = dataUrl;
        imagePreviewContainer.style.display = 'block';
    } catch (err) {
        alert('Could not process this image: ' + err.message + ' (try JPG or PNG)');
        reportImageInput.value = '';
    }
});

clearImageBtn.addEventListener('click', () => {
    reportImageInput.value = '';
    imageBase64 = null;
    imagePreview.src = '';
    imagePreviewContainer.style.display = 'none';
});

// Fallback client-side triage if running purely statically without Vercel serverless backend
function buildClientFallbackTriage(payload) {
    const raw = `${payload.symptomsText || ''} ${payload.symptomOnset || ''}`.toLowerCase();
    const isCritical = /chest pain|saans|breathless|unconscious|stroke|bleeding|seizure|heart attack|severe|chक्कर|सीने में दर्द/.test(raw);
    const isUrgent = /fever|bukhar|बुखार|vomiting|fracture|infection|pain|दर्द|dizziness|102|103/.test(raw);

    let priority = 'ROUTINE';
    let dept = 'General Medicine';
    if (isCritical) {
        priority = 'CRITICAL';
        dept = /chest|heart|सीने/.test(raw) ? 'Cardiology' : (/saans|breath|lung/.test(raw) ? 'Pulmonology' : 'Emergency & Trauma');
    } else if (isUrgent) {
        priority = 'URGENT';
        if (/bone|joint|fracture|knee/.test(raw)) dept = 'Orthopedics';
        else if (/child|baby/.test(raw)) dept = 'Pediatrics';
        else if (/skin|rash/.test(raw)) dept = 'Dermatology';
        else if (/stomach|abdomen|vomit/.test(raw)) dept = 'Gastroenterology';
    }

    const sources = [];
    if (payload.symptomsText) sources.push({ claim: payload.symptomsText, source: 'Patient Text', confidence: 'High' });
    if (payload.audioBase64) sources.push({ claim: 'Voice note attached by patient', source: 'Voice Recording', confidence: 'Medium (Pending clinician listen)' });
    if (payload.imageBase64) sources.push({ claim: 'Medical report image uploaded', source: 'Medical Report OCR', confidence: 'Medium (Visual inspection recommended)' });

    const missing = [];
    if (!payload.symptomOnset) missing.push('Exact symptom onset duration and progression timeline');
    if (!/allergy|medication|dawa/.test(raw)) missing.push('Current medications and known drug allergies');

    return {
        priority,
        suggestedDepartment: dept,
        clinicalSummary: `Patient (${payload.patientName}, ${payload.patientAge}y/${payload.patientGender}) presented with: ${payload.symptomsText || 'multimodal audio/image submission'}. Onset/Progression: ${payload.symptomOnset || 'Not specified'}.`,
        symptomTimeline: payload.symptomOnset || 'Onset timeline not explicitly stated by patient.',
        standardizedSymptoms: payload.symptomsText ? [payload.symptomsText] : ['Multimodal input submitted (see attached voice/report)'],
        warningSigns: isCritical ? ['Potential high-acuity cardiorespiratory or systemic warning sign detected'] : [],
        extractedVitals: { temperature: null, heart_rate: null, blood_pressure: null, spo2: null },
        sourceLinks: sources,
        missingInformation: missing,
        conflictsDetected: [],
        uncertaintyNotes: payload.audioBase64 || payload.imageBase64 ? ['Serverless AI endpoint unreachable; verify attached audio/image directly.'] : [],
        suspiciousInputFlag: false,
        followUpQuestions: [
            'Have these symptoms worsened suddenly in the last 2–4 hours?',
            'Do you have any existing conditions such as diabetes, hypertension, or asthma?',
            'Have you taken any medication for these symptoms yet?'
        ],
        confidenceFlag: missing.length === 0
    };
}

// Submit New Intake Form
patientForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!document.getElementById('symptomsText').value.trim() && !audioBase64 && !imageBase64) {
        alert("Please provide at least one input: symptom text, a voice recording, or a medical report image.");
        return;
    }

    const submitBtn = document.getElementById('submitBtn');
    submitBtn.disabled = true;
    submitBtn.textContent = "⏳ Running Multimodal AI Triage...";

    const clinicCode = cleanClinicCode(document.getElementById('clinicCode').value);
    const patientName = document.getElementById('patientName').value.trim();
    const patientAge = document.getElementById('patientAge').value;
    const patientGender = document.getElementById('patientGender').value;
    const symptomOnset = document.getElementById('symptomOnset').value.trim();
    const rawSymptoms = document.getElementById('symptomsText').value.trim();
    const caseId = randomId('PAT');
    const nowIso = new Date().toISOString();

    // Update Cookie with latest patient identity
    currentUser.role = 'patient';
    currentUser.name = patientName;
    currentUser.age = patientAge;
    currentUser.gender = patientGender;
    if (!currentUser.knownCases.some(c => c.caseId === caseId && c.clinicCode === clinicCode)) {
        currentUser.knownCases.unshift({ clinicCode, caseId });
    }
    setCookie('careflow_user', currentUser, 30);
    initPatientSessionUI();

    const payload = {
        mode: 'intake',
        clinicCode,
        patientName,
        patientAge,
        patientGender,
        symptomOnset,
        symptomsText: rawSymptoms,
        audioBase64,
        audioMime,
        imageBase64,
        timestamp: nowIso
    };

    try {
        let triagedResult;
        try {
            const aiResponse = await fetch('/api/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!aiResponse.ok) {
                let detail = '';
                try { const j = await aiResponse.json(); detail = j.details || j.error || ''; } catch (_) {}
                throw new Error(`API status ${aiResponse.status}${detail ? ': ' + String(detail).slice(0, 300) : ''}`);
            }
            triagedResult = await aiResponse.json();
        } catch (apiErr) {
            console.warn("Falling back to local safety triage rules:", apiErr.message);
            triagedResult = buildClientFallbackTriage(payload);
            triagedResult.aiFallback = true;
            triagedResult.uncertaintyNotes = [`AI UNAVAILABLE (${apiErr.message}) - rule-based triage only; image/audio NOT analysed. Review attachments manually.`, ...(triagedResult.uncertaintyNotes || [])];
        }

        // Priority base score for queue sorting (CRITICAL=300, URGENT=200, ROUTINE=100)
        const priorityRankMap = { CRITICAL: 300, URGENT: 200, ROUTINE: 100 };
        const initialScore = priorityRankMap[triagedResult.priority] || 100;

        const fullCaseRecord = {
            id: caseId,
            clinicCode,
            patientUserId: currentUser.userId,
            patientName,
            patientAge,
            patientGender,
            symptomOnset: symptomOnset || 'Not specified',
            symptomsText: rawSymptoms,
            hasAudio: !!audioBase64,
            hasImage: !!imageBase64,
            imagePreviewData: imageBase64 ? `data:image/jpeg;base64,${imageBase64}` : null,
            timestamp: nowIso,
            triage: triagedResult,
            manualOrderOffset: 0,
            queueScore: initialScore,
            status: 'PENDING_REVIEW', // PENDING_REVIEW | APPROVED | EMERGENCY_DISPATCHED | CLOSURE_REQUESTED | DISSOLVED
            consentGiven: true,
            consentTimestamp: nowIso,
            doctorNote: null,
            reviewedBy: null,
            reviewedAt: null,
            paramedicDispatch: null,
            closureRequestedBy: null,
            chatAiSummary: 'Initial intake completed. No follow-up chat messages yet.',
            messages: [
                {
                    id: 'MSG-' + Date.now(),
                    senderRole: 'patient',
                    senderName: patientName,
                    text: rawSymptoms || '[Submitted Multimodal Voice/Report Intake]',
                    timestamp: nowIso
                }
            ],
            auditLog: [
                {
                    timestamp: nowIso,
                    actor: `Patient (${patientName})`,
                    action: 'Consent granted & multimodal intake submitted.'
                },
                {
                    timestamp: nowIso,
                    actor: 'CareFlow AI Triage Engine',
                    action: `Initial triage categorized as ${triagedResult.priority || 'ROUTINE'} → Routed to ${triagedResult.suggestedDepartment || 'General Medicine'}.`
                },
                ...(triagedResult.translationUncertain ? [{
                    timestamp: nowIso,
                    actor: 'CareFlow AI Triage Engine',
                    action: `Flagged uncertain translation/transcription for clinician verification: ${(triagedResult.translationUncertaintyReasons || []).join('; ') || 'see original sources'}.`
                }] : [])
            ]
        };

        // 0. Store the voice note in a separate node (keeps the doctor's queue light) so clinicians can play it back
        if (audioBase64) {
            try {
                await fbFetch(`${FIREBASE_URL}/clinics/${clinicCode}/media/${caseId}.json`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ audio: `data:${audioMime};base64,${audioBase64}`, mime: audioMime, savedAt: nowIso })
                });
            } catch (mediaErr) {
                console.warn('Voice note could not be stored for playback:', mediaErr.message);
            }
        }

        // 1. Save to Clinic Queue in Firebase
        await fbFetch(`${FIREBASE_URL}/clinics/${clinicCode}/cases/${caseId}.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fullCaseRecord)
        });

        // 2. Save index reference under Patient's User ID in Firebase for cross-device listing
        await fbFetch(`${FIREBASE_URL}/patients/${currentUser.userId}/cases/${caseId}.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clinicCode, caseId, timestamp: nowIso })
        });

        // Reset media inputs
        document.getElementById('symptomOnset').value = '';
        document.getElementById('symptomsText').value = '';
        audioPreview.style.display = 'none';
        clearAudioBtn.style.display = 'none';
        imagePreviewContainer.style.display = 'none';
        reportImageInput.value = '';
        audioBase64 = null;
        imageBase64 = null;
        recordingStatus.textContent = "Idle";

        statusMessage.className = "status-banner status-success";
        statusMessage.innerHTML = `
            <strong>✅ Case Submitted Successfully!</strong><br>
            Case ID: <span class="code-pill">${caseId}</span> | Clinic: <strong>${clinicCode}</strong><br>
            ${triagedResult.aiFallback ? '<span style="color:#b45309;">⚠️ AI analysis failed (' + escapeHtml(triagedResult.uncertaintyNotes[0]) + ')</span><br>' : ''}Sent to the <strong>${escapeHtml(triagedResult.suggestedDepartment || 'General Medicine')}</strong> team for review by a qualified healthcare professional.<br><small>If your symptoms get worse, call <strong>112</strong> or go to the nearest hospital.</small>
        `;
        statusMessage.style.display = 'block';

        await loadPatientCasesByClinic();
    } catch (err) {
        statusMessage.className = "status-banner status-error";
        statusMessage.textContent = "Submission Error: " + err.message;
        statusMessage.style.display = 'block';
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit for Clinical Triage Review";
    }
});

// Load All Cases for the Logged-in Patient, Grouped & Sorted by Clinic
async function loadPatientCasesByClinic(silent = false) {
    if (!silent) myCasesByClinicContainer.innerHTML = '<p class="text-muted">Syncing your cases across clinics...</p>';

    try {
        // Merge cookie knownCases + Firebase /patients/{userId}/cases
        const caseMap = new Map();
        (currentUser.knownCases || []).forEach(item => {
            if (item && item.clinicCode && item.caseId) {
                caseMap.set(`${item.clinicCode}__${item.caseId}`, item);
            }
        });

        try {
            const idxRes = await fbFetch(`${FIREBASE_URL}/patients/${currentUser.userId}/cases.json`);
            const idxData = await idxRes.json();
            if (idxData) {
                Object.values(idxData).forEach(item => {
                    if (item && item.clinicCode && item.caseId) {
                        caseMap.set(`${item.clinicCode}__${item.caseId}`, item);
                    }
                });
            }
        } catch (e) {}

        const refs = Array.from(caseMap.values());
        if (refs.length === 0) {
            myCasesByClinicContainer.innerHTML = `
                <div class="empty-state">
                    <p>No cases submitted under your profile yet.</p>
                    <small>Submit a new symptom intake on the left or look up an existing Case ID below.</small>
                </div>
            `;
            return;
        }

        // Fetch live details for each case
        const fetchedCases = await Promise.all(refs.map(async ({ clinicCode, caseId }) => {
            try {
                const r = await fbFetch(`${FIREBASE_URL}/clinics/${clinicCode}/cases/${caseId}.json`);
                const data = await r.json();
                return data || null;
            } catch (e) {
                return null;
            }
        }));

        const validCases = fetchedCases.filter(Boolean);
        if (validCases.length === 0) {
            myCasesByClinicContainer.innerHTML = `<div class="empty-state"><p>No active records found in cloud storage (they may have been purged or withdrawn).</p></div>`;
            return;
        }

        // Group cases by clinicCode (sorted alphabetically by clinic code, and newest first inside each clinic)
        const groupedByClinic = {};
        validCases.forEach(c => {
            const cl = c.clinicCode || 'UNKNOWN';
            if (!groupedByClinic[cl]) groupedByClinic[cl] = [];
            groupedByClinic[cl].push(c);
        });

        const sortedClinicNames = Object.keys(groupedByClinic).sort();
        myCasesByClinicContainer.innerHTML = '';

        sortedClinicNames.forEach(clinicName => {
            const clinicCases = groupedByClinic[clinicName].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            const clinicGroupEl = document.createElement('div');
            clinicGroupEl.className = 'clinic-group-block';
            clinicGroupEl.innerHTML = `
                <div class="clinic-group-header">
                    <span>🏥 Clinic: <strong>${escapeHtml(clinicName)}</strong></span>
                    <span class="badge">${clinicCases.length} Case${clinicCases.length > 1 ? 's' : ''}</span>
                </div>
            `;

            clinicCases.forEach(caseData => {
                clinicGroupEl.appendChild(renderPatientCaseCard(caseData));
            });

            myCasesByClinicContainer.appendChild(clinicGroupEl);
        });
    } catch (err) {
        myCasesByClinicContainer.innerHTML = `<p style="color:#ef4444;">Error loading cases: ${escapeHtml(err.message)}</p>`;
    }
}

// Render an Individual Patient Case Card with Doctor Updates, Closure Request Banner, & Live Chat
function renderPatientCaseCard(caseData) {
    const card = document.createElement('div');
    const isDissolved = caseData.status === 'DISSOLVED';
    const isClosureRequested = caseData.status === 'CLOSURE_REQUESTED';
    const isEmergency = caseData.status === 'EMERGENCY_DISPATCHED' || !!caseData.paramedicDispatch;

    card.className = `patient-case-card ${isDissolved ? 'case-dissolved' : ''}`;

    const messages = Array.isArray(caseData.messages) ? caseData.messages : [];
    const chatHtml = messages.map(m => `
        <div class="chat-bubble ${m.senderRole === 'doctor' ? 'chat-doctor' : (m.senderRole === 'system' ? 'chat-system' : 'chat-patient')}">
            <div class="chat-meta">
                <strong>${escapeHtml(m.senderName)}</strong>
                <span>${fmtDateTime(m.timestamp)}</span>
            </div>
            <div class="chat-text">${escapeHtml(m.text)}</div>
        </div>
    `).join('');

    card.innerHTML = `
        <div class="patient-case-top">
            <div>
                <strong>${escapeHtml(caseData.id)}</strong>
                <span class="dept-tag">${escapeHtml(caseData.triage?.suggestedDepartment || 'General Medicine')}</span>
            </div>
            <div style="display:flex; gap:6px; align-items:center;">
                <span class="status-pill status-${(caseData.status || 'PENDING_REVIEW').toLowerCase()}">${escapeHtml(caseData.status.replace(/_/g, ' '))}</span>
            </div>
        </div>

        ${isEmergency ? `
            <div class="emergency-banner">
                🚨 <strong>EMERGENCY PARAMEDIC DISPATCH ACTIVE:</strong> The attending doctor has forwarded your case and details to the hospital Paramedic Team (${escapeHtml(caseData.paramedicDispatch?.dispatchedAt || 'Just now')}).
            </div>
        ` : ''}

        <div class="case-summary-mini">
            <strong>AI Structured Summary:</strong> ${escapeHtml(caseData.triage?.clinicalSummary || caseData.symptomsText || 'Submitted for review')}
        </div>

        ${caseData.doctorNote ? `
            <div class="doctor-rx-box">
                <strong>🩺 Doctor's Official Triage / Referral Note:</strong>
                <p>${escapeHtml(caseData.doctorNote)}</p>
                <small>Reviewed by ${escapeHtml(caseData.reviewedBy || 'Clinician')} at ${escapeHtml(caseData.reviewedAt || '')}</small>
            </div>
        ` : ''}

        ${isClosureRequested ? `
            <div class="closure-request-box">
                <div>
                    <strong>✅ Doctor Requested Case Closure:</strong>
                    <p style="margin:4px 0 8px 0;">${escapeHtml(caseData.closureRequestedBy || 'Your doctor')} asked if you have recovered and would like to close/dissolve this case.</p>
                </div>
                <div style="display:flex; gap:8px;">
                    <button class="approve-btn sm-btn" onclick="respondToCaseClosure('${caseData.clinicCode}', '${caseData.id}', true)">Yes, I Recovered — Close Case</button>
                    <button class="override-btn sm-btn" onclick="respondToCaseClosure('${caseData.clinicCode}', '${caseData.id}', false)">Still Have Symptoms</button>
                </div>
            </div>
        ` : ''}

        <!-- Case-Scoped Chat Thread -->
        <div class="chat-section">
            <div class="chat-header-bar">
                <span>💬 Consultation Thread (${messages.length})</span>
                <small class="text-muted">Your replies are reviewed by AI and your care team</small>
            </div>
            <div class="chat-messages-box" id="chatBox_${caseData.id}">
                ${chatHtml || '<p class="text-muted">No messages yet.</p>'}
            </div>

            ${!isDissolved ? `
                <div class="chat-input-row">
                    <input type="text" id="chatInput_${caseData.id}" placeholder="Reply to doctor under this case (English / Hindi / Hinglish)...">
                    <button type="button" class="primary-btn sm-btn" id="sendChatBtn_${caseData.id}" onclick="sendPatientChatMessage('${caseData.clinicCode}', '${caseData.id}')">Send</button>
                </div>
            ` : `
                <div class="dissolved-notice">This case has been closed/dissolved. Submit a new intake if new symptoms arise.</div>
            `}
        </div>

        <div class="patient-case-footer">
            <small class="text-muted">Submitted: ${new Date(caseData.timestamp).toLocaleString()}</small>
            <div style="display:flex; gap:8px;">
                ${!isDissolved ? `<button type="button" class="override-btn sm-btn" onclick="respondToCaseClosure('${caseData.clinicCode}', '${caseData.id}', true)">Mark Recovered &amp; Close</button>` : ''}
                <button type="button" class="delete-btn sm-btn" onclick="withdrawPatientCase('${caseData.clinicCode}', '${caseData.id}')">🗑️ Withdraw &amp; Delete Data</button>
            </div>
        </div>
    `;

    return card;
}

// ---- Dynamic follow-up questions: shared helpers --------------------------------------------
// caseData.followUps = { active: [unasked suggestions], history: [{question,status,askedAt,answeredAt,answer}], updatedAt }
// Cases created before this feature fall back to the intake suggestions (triage.followUpQuestions).
function getFollowUpState(caseData) {
    const fu = caseData.followUps || null;
    const history = fu && Array.isArray(fu.history) ? fu.history : [];
    const active = fu
        ? (Array.isArray(fu.active) ? fu.active : [])
        : (Array.isArray(caseData.triage?.followUpQuestions) ? caseData.triage.followUpQuestions : []);
    return { active, history };
}

function sameQuestion(a, b) {
    const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    const x = norm(a), y = norm(b);
    return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

// Patient Sends a Chat Reply under a Specific Case (Triggers AI Summary & Dynamic Priority Shift)
window.sendPatientChatMessage = async function(clinicCode, caseId) {
    const inputEl = document.getElementById(`chatInput_${caseId}`);
    const sendBtn = document.getElementById(`sendChatBtn_${caseId}`);
    const text = inputEl.value.trim();
    if (!text) return;

    sendBtn.disabled = true;
    sendBtn.textContent = "AI Analysing...";

    try {
        const res = await fbFetch(`${FIREBASE_URL}/clinics/${clinicCode}/cases/${caseId}.json`);
        const caseData = await res.json();
        if (!caseData) throw new Error("Case record no longer exists.");

        const nowIso = new Date().toISOString();
        const messages = Array.isArray(caseData.messages) ? caseData.messages : [];
        messages.push({
            id: 'MSG-' + Date.now(),
            senderRole: 'patient',
            senderName: caseData.patientName || currentUser.name || 'Patient',
            text,
            timestamp: nowIso
        });

        const fuState = getFollowUpState(caseData);

        // Call AI backend in 'chat_update' mode to summarize follow-up & re-evaluate priority
        let chatAiResult = null;
        try {
            const aiRes = await fetch('/api/gemini', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mode: 'chat_update',
                    existingCase: {
                        patientName: caseData.patientName,
                        patientAge: caseData.patientAge,
                        currentPriority: caseData.triage?.priority || 'ROUTINE',
                        suggestedDepartment: caseData.triage?.suggestedDepartment || 'General Medicine',
                        clinicalSummary: caseData.triage?.clinicalSummary || caseData.symptomsText,
                        standardizedSymptoms: caseData.triage?.standardizedSymptoms || [],
                        askedQuestions: fuState.history.map(h => ({ question: h.question, status: h.status, answer: h.answer || '' })),
                        activeQuestions: fuState.active
                    },
                    messages,
                    latestPatientMessage: text
                })
            });
            if (aiRes.ok) {
                chatAiResult = await aiRes.json();
            }
        } catch (e) {
            console.warn("Local fallback for chat priority evaluation:", e.message);
        }

        // Fallback heuristic if serverless function isn't reachable
        if (!chatAiResult) {
            const lower = text.toLowerCase();
            let newPrio = caseData.triage?.priority || 'ROUTINE';
            let reason = 'Patient provided follow-up update.';
            if (/chest pain|breathless|saans|fainting|severe|blood|unbearable|badh gaya|worse/.test(lower)) {
                newPrio = 'CRITICAL';
                reason = 'Patient reported worsening or high-risk symptoms in chat.';
            } else if (/fever|bukhar|pain|vomit|not better|still/.test(lower) && newPrio === 'ROUTINE') {
                newPrio = 'URGENT';
                reason = 'Patient reported persistent/escalating moderate symptoms.';
            } else if (/better|recovered|fine now|theek|no pain|normal/.test(lower) && newPrio !== 'ROUTINE') {
                newPrio = 'ROUTINE';
                reason = 'Patient reported symptom improvement in chat.';
            }
            chatAiResult = {
                updatedPriority: newPrio,
                priorityShiftReason: reason,
                chatSummary: `Latest patient update: "${text}". (${reason})`,
                newSymptomsExtracted: []
            };
        }

        const oldPriority = caseData.triage?.priority || 'ROUTINE';
        let newPriority = chatAiResult.updatedPriority || oldPriority;
        const prioW = { CRITICAL: 3, URGENT: 2, ROUTINE: 1 };
        let deescalationNote = '';
        if ((prioW[newPriority] || 1) < (prioW[oldPriority] || 1)) {
            // Safety: AI can escalate on its own, but lowering priority needs a clinician's confirmation
            deescalationNote = ` AI suggests lowering priority to ${newPriority} - awaiting doctor confirmation.`;
            newPriority = oldPriority;
        }
        const priorityRankMap = { CRITICAL: 300, URGENT: 200, ROUTINE: 100 };

        const updatedTriage = {
            ...(caseData.triage || {}),
            priority: newPriority
        };

        // Add newly extracted symptoms with
        if (Array.isArray(chatAiResult.newSymptomsExtracted) && chatAiResult.newSymptomsExtracted.length > 0) {
            updatedTriage.standardizedSymptoms = [
                ...(updatedTriage.standardizedSymptoms || []),
                ...chatAiResult.newSymptomsExtracted
            ];
            updatedTriage.sourceLinks = [
                ...(updatedTriage.sourceLinks || []),
                ...chatAiResult.newSymptomsExtracted.map(s => ({
                    claim: s,
                    source: 'Patient Chat Follow-up',
                    confidence: 'High'
                }))
            ];
        }

        // --- Dynamic follow-up questions ---------------------------------------------------------
        // 1) Questions the doctor asked are now answered by this reply
        const newHistory = fuState.history.map(h => h.status === 'ASKED'
            ? { ...h, status: 'ANSWERED', answeredAt: nowIso, answer: text.slice(0, 200) }
            : h);
        const answeredNow = fuState.history.filter(h => h.status === 'ASKED').length;
        // 2) Replace the suggestions with the AI's fresh ones (or keep the unasked ones if the AI could not refresh)
        const aiRefreshed = Array.isArray(chatAiResult.followUpQuestions);
        const newActive = (aiRefreshed ? chatAiResult.followUpQuestions : fuState.active)
            .filter(q => typeof q === 'string' && q.trim() && !newHistory.some(h => sameQuestion(h.question, q)));
        const newFollowUps = {
            active: newActive,
            history: newHistory,
            updatedAt: aiRefreshed ? nowIso : ((caseData.followUps && caseData.followUps.updatedAt) || caseData.timestamp || nowIso)
        };

        const auditLog = Array.isArray(caseData.auditLog) ? caseData.auditLog : [];
        auditLog.push({
            timestamp: nowIso,
            actor: `Patient (${caseData.patientName})`,
            action: `Sent chat reply: "${text.substring(0, 80)}"`
        });
        if (aiRefreshed) {
            auditLog.push({
                timestamp: nowIso,
                actor: 'CareFlow AI Re-Triage',
                action: `Refreshed follow-up questions from the patient's reply (${newActive.length} suggested${answeredNow ? ', ' + answeredNow + ' asked question' + (answeredNow > 1 ? 's' : '') + ' answered' : ''}).`
            });
        }

        if (newPriority !== oldPriority) {
            auditLog.push({
                timestamp: nowIso,
                actor: 'CareFlow AI Re-Triage',
                action: `Priority automatically shifted from ${oldPriority} → ${newPriority} based on patient chat (${chatAiResult.priorityShiftReason || 'Clinical update'}).`
            });
        }

        if (deescalationNote) auditLog.push({ timestamp: nowIso, actor: 'CareFlow AI Re-Triage', action: deescalationNote.trim() });
        const newQueueScore = (priorityRankMap[newPriority] || 100) + (caseData.manualOrderOffset || 0);

        await fbFetch(`${FIREBASE_URL}/clinics/${clinicCode}/cases/${caseId}.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages,
                triage: updatedTriage,
                chatAiSummary: (chatAiResult.chatSummary || `Patient update: ${text}`) + deescalationNote,
                queueScore: newQueueScore,
                followUps: newFollowUps,
                auditLog
            })
        });

        inputEl.value = '';
        await loadPatientCasesByClinic();
    } catch (err) {
        alert("Failed to send message: " + err.message);
    } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = "Send";
    }
};

// Patient Confirms or Declines Case Closure / Recovery
window.respondToCaseClosure = async function(clinicCode, caseId, confirmClose) {
    try {
        const res = await fbFetch(`${FIREBASE_URL}/clinics/${clinicCode}/cases/${caseId}.json`);
        const caseData = await res.json();
        if (!caseData) return;

        const nowIso = new Date().toISOString();
        const messages = Array.isArray(caseData.messages) ? caseData.messages : [];
        const auditLog = Array.isArray(caseData.auditLog) ? caseData.auditLog : [];

        if (confirmClose) {
            messages.push({
                id: 'MSG-' + Date.now(),
                senderRole: 'system',
                senderName: 'CareFlow System',
                text: `Patient confirmed recovery and dissolved/closed Case #${caseId}.`,
                timestamp: nowIso
            });
            auditLog.push({
                timestamp: nowIso,
                actor: `Patient (${caseData.patientName})`,
                action: 'Confirmed recovery and closed/dissolved the case.'
            });
            await fbFetch(`${FIREBASE_URL}/clinics/${clinicCode}/cases/${caseId}.json`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    status: 'DISSOLVED',
                    messages,
                    auditLog
                })
            });
        } else {
            messages.push({
                id: 'MSG-' + Date.now(),
                senderRole: 'patient',
                senderName: caseData.patientName,
                text: 'I still have symptoms and would like to keep this case open for review.',
                timestamp: nowIso
            });
            auditLog.push({
                timestamp: nowIso,
                actor: `Patient (${caseData.patientName})`,
                action: 'Declined closure request; symptoms still present.'
            });
            await fbFetch(`${FIREBASE_URL}/clinics/${clinicCode}/cases/${caseId}.json`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    status: 'APPROVED',
                    messages,
                    auditLog
                })
            });
        }

        await loadPatientCasesByClinic();
    } catch (err) {
        alert("Failed to update case status: " + err.message);
    }
};

// Data Privacy: Patient Withdraws Consent & Deletes Own Record
window.withdrawPatientCase = async function(clinicCode, caseId) {
    if (!confirm(`DATA PRIVACY & CONSENT WITHDRAWAL:\nPermanently withdraw consent and delete Case ${caseId} from Clinic ${clinicCode}?`)) {
        return;
    }

    try {
        await fbFetch(`${FIREBASE_URL}/clinics/${clinicCode}/cases/${caseId}.json`, { method: 'DELETE' });
        await fbFetch(`${FIREBASE_URL}/clinics/${clinicCode}/media/${caseId}.json`, { method: 'DELETE' });
        await fbFetch(`${FIREBASE_URL}/patients/${currentUser.userId}/cases/${caseId}.json`, { method: 'DELETE' });

        currentUser.knownCases = (currentUser.knownCases || []).filter(c => !(c.caseId === caseId && c.clinicCode === clinicCode));
        setCookie('careflow_user', currentUser, 30);

        await loadPatientCasesByClinic();
    } catch (err) {
        alert("Failed to delete case: " + err.message);
    }
};

// Manual Lookup by Clinic + Case ID (also links it to patient's cookie dashboard)
document.getElementById('trackBtn').addEventListener('click', async () => {
    const clinic = cleanClinicCode(document.getElementById('trackClinicCode').value);
    const caseId = document.getElementById('trackCaseId').value.trim().toUpperCase();
    const resultBox = document.getElementById('trackingResult');

    if (!clinic || !caseId) {
        alert("Please enter both Clinic Code and Case ID.");
        return;
    }

    resultBox.style.display = 'block';
    resultBox.innerHTML = '<span class="text-muted">Searching hospital cloud...</span>';

    try {
        const res = await fbFetch(`${FIREBASE_URL}/clinics/${clinic}/cases/${caseId}.json`);
        const caseData = await res.json();

        if (!caseData) {
            resultBox.innerHTML = `<span style="color: #ef4444;">No case found with ID <strong>${escapeHtml(caseId)}</strong> under clinic <strong>${escapeHtml(clinic)}</strong>.</span>`;
            return;
        }

        // Link to current patient's cookie list so it appears in their main Clinic-sorted list
        if (!currentUser.knownCases.some(c => c.caseId === caseId && c.clinicCode === clinic)) {
            currentUser.knownCases.unshift({ clinicCode: clinic, caseId });
            setCookie('careflow_user', currentUser, 30);
        }

        resultBox.innerHTML = `<div class="status-banner status-success" style="margin-top:0;">Case <strong>${escapeHtml(caseId)}</strong> found and linked to your dashboard above!</div>`;
        await loadPatientCasesByClinic();
    } catch (err) {
        resultBox.innerHTML = `<span style="color: #ef4444;">Error retrieving record: ${escapeHtml(err.message)}</span>`;
    }
});

refreshMyCasesBtn.addEventListener('click', () => loadPatientCasesByClinic());

// Initialize on page load
initPatientSessionUI();
loadPatientCasesByClinic();

// Auto-refresh so doctor replies appear without clicking Refresh (skipped while the patient is typing)
setInterval(() => {
    const typing = Array.from(document.querySelectorAll('.chat-input-row input')).some(i => i.value || i === document.activeElement);
    if (!typing && !document.hidden) loadPatientCasesByClinic(true);
}, 15000);
