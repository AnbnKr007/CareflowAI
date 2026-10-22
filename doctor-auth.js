// =============================================================================
// CareFlow AI - Clinician Sign-In & Clinic Association Gate
//
// Doctors sign in with:
//   1. Doctor Full Name
//   2. Registered Clinic Code
//   3. Clinic's 4-Digit Passcode
//
// Verifies against /clinics/{clinicCode}/info.json in Firebase, registers the
// doctor under /clinics/{clinicCode}/doctors/{doctorId}.json, and unlocks all
// cases across all departments for that clinic.
// =============================================================================

(function () {
    const FIREBASE_URL = "https://careflowai-2bd8b-default-rtdb.firebaseio.com";
    const SESSION_KEY = 'careflow_doctor_session_v2';
    const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours
    let memorySession = null;

    function cleanClinicCode(v) {
        return String(v || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    }

    function normalizeDoctorName(name) {
        return String(name || '')
            .toLowerCase()
            .replace(/\./g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/^dr\s+/, '');
    }

    function buildDoctorId(name) {
        const norm = normalizeDoctorName(name);
        return 'DOC_' + (norm.replace(/[^a-z0-9]+/g, '_').toUpperCase() || 'CLINICIAN');
    }

    function formatDoctorDisplayName(name) {
        const trimmed = String(name || '').trim();
        if (!trimmed) return 'Dr. Clinician';
        return trimmed.toLowerCase().startsWith('dr') ? trimmed : `Dr. ${trimmed}`;
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

    function saveDoctorCookieProfile(sessionObj) {
        const profile = {
            role: 'doctor',
            name: sessionObj.name,
            userId: sessionObj.doctorId,
            clinicCode: sessionObj.clinicCode,
            department: 'All',
            savedClinics: Object.keys(sessionObj.unlockedClinics || { [sessionObj.clinicCode]: true })
        };
        const d = new Date();
        d.setTime(d.getTime() + (30 * 24 * 60 * 60 * 1000));
        document.cookie = `careflow_user=${encodeURIComponent(JSON.stringify(profile))};expires=${d.toUTCString()};path=/;SameSite=Lax`;
        try { localStorage.setItem('careflow_user', JSON.stringify(profile)); } catch (e) {}
    }

    function getSession() {
        let s = null;
        try {
            const raw = sessionStorage.getItem(SESSION_KEY);
            if (raw) s = JSON.parse(raw);
        } catch (e) {}
        if (!s) s = memorySession;
        if (!s || !s.name || !s.clinicCode || !s.loginAt) return null;
        if (Date.now() - s.loginAt > SESSION_MAX_AGE_MS) return null;
        return s;
    }

    function setSession(s) {
        memorySession = s;
        try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {}
        saveDoctorCookieProfile(s);
    }

    function clearSession() {
        memorySession = null;
        try {
            sessionStorage.removeItem(SESSION_KEY);
            sessionStorage.removeItem('careflow_doctor_session');
        } catch (e) {}
    }

    async function verifyClinicAndAssociateDoctor(name, clinicCodeRaw, pin) {
        const normName = normalizeDoctorName(name);
        if (!normName) {
            return { ok: false, reason: 'Please enter your full name.' };
        }
        const clinicCode = cleanClinicCode(clinicCodeRaw);
        if (!clinicCode) {
            return { ok: false, reason: 'Please enter a valid Clinic Code.' };
        }
        const cleanPin = String(pin || '').trim();
        if (!/^\d{4}$/.test(cleanPin)) {
            return { ok: false, reason: 'Clinic Pass must be exactly 4 digits.' };
        }

        let clinicInfo = null;
        try {
            const res = await fetch(`${FIREBASE_URL}/clinics/${clinicCode}/info.json`);
            if (!res.ok) {
                return { ok: false, reason: `Could not reach Firebase (${res.status}).` };
            }
            clinicInfo = await res.json();
        } catch (err) {
            return { ok: false, reason: 'Network error verifying clinic: ' + err.message };
        }

        if (!clinicInfo || (!clinicInfo.passcode && !clinicInfo.passHash)) {
            return {
                ok: false,
                reason: `Clinic "${clinicCode}" is not registered yet. Please register "${clinicCode}" on the Clinic Portal first.`
            };
        }

        const enteredHash = await hashClinicPass(clinicCode, cleanPin);
        const directMatch = clinicInfo.passcode && String(clinicInfo.passcode).trim() === cleanPin;
        const hashMatch = clinicInfo.passHash && clinicInfo.passHash === enteredHash;

        if (!directMatch && !hashMatch) {
            return {
                ok: false,
                reason: `Incorrect 4-digit pass for clinic "${clinicCode}".`
            };
        }

        const doctorId = buildDoctorId(name);
        const displayName = formatDoctorDisplayName(name);
        const nowIso = new Date().toISOString();

        try {
            const existingDocRes = await fetch(`${FIREBASE_URL}/clinics/${clinicCode}/doctors/${doctorId}.json`);
            const existingDoc = existingDocRes.ok ? await existingDocRes.json() : null;

            const docRecord = {
                id: doctorId,
                name: displayName,
                department: 'All Departments',
                clinicCode,
                joinedAt: (existingDoc && existingDoc.joinedAt) ? existingDoc.joinedAt : nowIso,
                lastActiveAt: nowIso,
                lastAction: (existingDoc && existingDoc.lastAction) ? existingDoc.lastAction : 'Signed in to clinic console'
            };

            await fetch(`${FIREBASE_URL}/clinics/${clinicCode}/doctors/${doctorId}.json`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(docRecord)
            });
        } catch (e) {
            console.warn('Could not update clinic doctor roster:', e.message);
        }

        return {
            ok: true,
            doctorId,
            displayName,
            clinicCode,
            clinicName: clinicInfo.clinicName || clinicCode
        };
    }

    function readSavedDoctorProfile() {
        try {
            let raw = null;
            const m = document.cookie.split(';').map(c => c.trim()).find(c => c.indexOf('careflow_user=') === 0);
            if (m) raw = decodeURIComponent(m.substring('careflow_user='.length));
            if (!raw) { try { raw = localStorage.getItem('careflow_user'); } catch (e) {} }
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }

    function unlock() {
        document.body.classList.remove('doctor-locked');
    }

    const api = {
        getSession,
        buildDoctorId,
        formatDoctorDisplayName,
        verifyClinicAndAssociateDoctor,
        isAuthenticated: () => !!getSession(),
        isClinicUnlocked: (clinicCode) => {
            const s = getSession();
            const code = cleanClinicCode(clinicCode);
            if (!s) return false;
            if (cleanClinicCode(s.clinicCode) === code) return true;
            return !!(s.unlockedClinics && s.unlockedClinics[code]);
        },
        getUnlockedClinics: () => {
            const s = getSession();
            if (!s) return [];
            const map = { ...(s.unlockedClinics || {}), [s.clinicCode]: true };
            return Object.keys(map).filter(Boolean);
        },
        markClinicUnlocked: (clinicCode, clinicName, doctorName, doctorId) => {
            const s = getSession() || { unlockedClinics: {}, loginAt: Date.now() };
            const code = cleanClinicCode(clinicCode);
            if (!s.unlockedClinics) s.unlockedClinics = {};
            s.unlockedClinics[code] = {
                clinicCode: code,
                clinicName: clinicName || code,
                unlockedAt: Date.now()
            };
            s.clinicCode = code;
            s.clinicName = clinicName || code;
            if (doctorName) s.name = doctorName;
            if (doctorId) s.doctorId = doctorId;
            setSession(s);
        },
        signOut() {
            clearSession();
            window.location.reload();
        }
    };
    window.CareFlowDoctorAuth = api;

    if (getSession()) {
        unlock();
        return;
    }

    const form = document.getElementById('doctorLoginForm');
    const nameInput = document.getElementById('doctorLoginName');
    const clinicInput = document.getElementById('doctorLoginClinicCode');
    const pinInput = document.getElementById('doctorLoginPin');
    const submitBtn = document.getElementById('doctorLoginSubmitBtn');
    const errorBox = document.getElementById('doctorLoginError');
    const noteBox = document.getElementById('doctorLoginNote');
    if (!form || !nameInput || !clinicInput || !pinInput) return;

    const savedProfile = readSavedDoctorProfile();
    if (savedProfile) {
        if (savedProfile.role === 'doctor' && savedProfile.name) nameInput.value = savedProfile.name;
        if (savedProfile.clinicCode) clinicInput.value = savedProfile.clinicCode;
    }

    if (noteBox) {
        noteBox.textContent = 'Doctors associated with a clinic can view and attend to all cases across all departments in that clinic.';
    }

    function showError(msg) {
        errorBox.textContent = msg;
        errorBox.style.display = 'block';
    }

    pinInput.addEventListener('input', () => {
        pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 4);
        errorBox.style.display = 'none';
    });
    nameInput.addEventListener('input', () => { errorBox.style.display = 'none'; });
    clinicInput.addEventListener('input', () => { errorBox.style.display = 'none'; });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorBox.style.display = 'none';

        const name = nameInput.value.trim();
        const clinicCode = cleanClinicCode(clinicInput.value);
        const pin = pinInput.value.trim();

        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Verifying Clinic Pass...';
        }

        const result = await verifyClinicAndAssociateDoctor(name, clinicCode, pin);

        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Verify Clinic Pass & Sign In →';
        }

        if (!result.ok) {
            showError(result.reason);
            pinInput.value = '';
            pinInput.focus();
            return;
        }

        const sessionObj = {
            name: result.displayName,
            doctorId: result.doctorId,
            clinicCode: result.clinicCode,
            clinicName: result.clinicName,
            unlockedClinics: {
                [result.clinicCode]: {
                    clinicCode: result.clinicCode,
                    clinicName: result.clinicName,
                    unlockedAt: Date.now()
                }
            },
            loginAt: Date.now()
        };

        setSession(sessionObj);
        pinInput.value = '';
        unlock();

        if (typeof window.startDoctorDashboard === 'function') {
            window.startDoctorDashboard(sessionObj);
        } else {
            window.dispatchEvent(new CustomEvent('careflow-doctor-login', { detail: sessionObj }));
        }
    });
})();
