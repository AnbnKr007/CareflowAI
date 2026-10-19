// =============================================================================
// CareFlow AI - Clinician Sign-In & Clinic Association Gate
//
// Doctors signing in to be associated with any clinic MUST provide:
//   1. Doctor's Full Name (& Primary Department)
//   2. Registered Clinic Code
//   3. The Clinic's 4-Digit Passcode
//
// Upon verification against Firebase (/clinics/{clinicCode}/info.json), the
// doctor is registered in /clinics/{clinicCode}/doctors/{docId}.json and
// granted access to that clinic's patient case database.
// =============================================================================

(function () {
    const FIREBASE_URL = "https://careflowai-2bd8b-default-rtdb.firebaseio.com";
    const SESSION_KEY = 'careflow_doctor_session';
    const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours
    let memorySession = null;

    function cleanClinicCode(v) {
        return String(v || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    }

    function normalizeDoctorName(name) {
        return String(name || '').toLowerCase().replace(/\./g, ' ').replace(/\s+/g, ' ').trim().replace(/^dr\s+/, '');
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

    // ---------- Session Management ----------
    function getSession() {
        let s = null;
        try {
            const raw = sessionStorage.getItem(SESSION_KEY);
            if (raw) s = JSON.parse(raw);
        } catch (e) {}
        if (!s) s = memorySession;
        if (!s || !s.name || !s.clinicCode || !s.unlockedClinics || !s.unlockedClinics[s.clinicCode] || !s.loginAt) {
            return null;
        }
        if (Date.now() - s.loginAt > SESSION_MAX_AGE_MS) return null;
        return s;
    }

    function setSession(s) {
        memorySession = s;
        try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {}
    }

    function clearSession() {
        memorySession = null;
        try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
    }

    // ---------- Verify Clinic Code + 4-Digit Pass & Associate Doctor ----------
    async function verifyClinicAndAssociateDoctor(name, clinicCodeRaw, pin, department = 'All') {
        const normName = normalizeDoctorName(name);
        if (!normName) {
            return { ok: false, reason: 'Please enter your full name.' };
        }
        const clinicCode = cleanClinicCode(clinicCodeRaw);
        if (!clinicCode) {
            return { ok: false, reason: 'Please enter a valid Clinic Code.' };
        }
        if (!/^\d{4}$/.test(String(pin))) {
            return { ok: false, reason: 'Clinic Pass must be进而 exactly 4 digits.' };
        }

        // 1. Fetch registered clinic credentials from Firebase
        let clinicInfo = null;
        try {
            const res = await fetch(`${FIREBASE_URL}/clinics/${clinicCode}/info.json`);
            if (!res.ok) {
                return { ok: false, reason: `Could not reach clinic database (${res.status}).` };
            }
            clinicInfo = await res.json();
        } catch (err) {
            return { ok: false, reason: 'Network error verifying clinic credentials: ' + err.message };
        }

        if (!clinicInfo || (!clinicInfo.passHash && !clinicInfo.passcode)) {
            return {
                ok: false,
                reason: `Clinic "${clinicCode}" is not registered yet. Please register the clinic and set its 4-digit pass on the Clinic Portal first.`
            };
        }

        // 2. Verify 4-digit Clinic Passcode
        const enteredHash = await hashClinicPass(clinicCode, pin);
        const passMatched =
            (clinicInfo.passHash && clinicInfo.passHash === enteredHash) ||
            (clinicInfo.passcode && String(clinicInfo.passcode) === String(pin));

        if (!passMatched) {
            return {
                ok: false,
                reason: `Incorrect 4-digit pass for clinic "${clinicCode}". Access to clinic cases denied.`
            };
        }

        // 3. Register / Update this Doctor under the Clinic's Doctor Roster in Firebase
        const doctorId = buildDoctorId(name);
        const displayName = formatDoctorDisplayName(name);
        const nowIso = new Date().toISOString();

        try {
            const existingDocRes = await fetch(`${FIREBASE_URL}/clinics/${clinicCode}/doctors/${doctorId}.json`);
            const existingDoc = existingDocRes.ok ? await existingDocRes.json() : null;

            const docRecord = {
                id: doctorId,
                name: displayName,
                department: department || (existingDoc && existingDoc.department) || 'All',
                clinicCode,
                joinedAt: (existingDoc && existingDoc.joinedAt) ? existingDoc.joinedAt : nowIso,
                lastActiveAt: nowIso
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
            clinicName: clinicInfo.clinicName || clinicCode,
            department: department || 'All'
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
            return !!(s && s.unlockedClinics && s.unlockedClinics[code]);
        },
        getUnlockedClinics: () => {
            const s = getSession();
            return (s && s.unlockedClinics) ? Object.keys(s.unlockedClinics) : [];
        },
        markClinicUnlocked: (clinicCode, clinicName, doctorName, department, doctorId) => {
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
            if (department) s.department = department;
            if (doctorId) s.doctorId = doctorId;
            setSession(s);
        },
        _reload: () => window.location.reload(),
        signOut() {
            clearSession();
            api._reload();
        }
    };
    window.CareFlowDoctorAuth = api;

    // Already authenticated with a verified clinic pass in this session -> unlock
    if (getSession()) {
        unlock();
        return;
    }

    // ---------- Sign-In Form Wiring ----------
    const form = document.getElementById('doctorLoginForm');
    const nameInput = document.getElementById('doctorLoginName');
    const deptSelect = document.getElementById('doctorLoginDept');
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
        if (savedProfile.department && deptSelect) deptSelect.value = savedProfile.department;
    }

    noteBox.textContent = 'Access is restricted: only doctors with a registered Clinic Code and its 4-digit pass can access clinic cases.';

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
        const dept = deptSelect ? deptSelect.value : 'All';
        const clinicCode = cleanClinicCode(clinicInput.value);
        const pin = pinInput.value.trim();

        submitBtn.disabled = true;
        submitBtn.textContent = 'Verifying Clinic Pass...';

        const result = await verifyClinicAndAssociateDoctor(name, clinicCode, pin, dept);

        submitBtn.disabled = false;
        submitBtn.textContent = 'Verify Clinic Pass & Sign In →';

        if (!result.ok) {
            showError(result.reason);
            pinInput.value = '';
            pinInput.focus();
            return;
        }

        const sessionObj = {
            name: result.displayName,
            doctorId: result.doctorId,
            department: result.department,
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
        window.dispatchEvent(new CustomEvent('careflow-doctor-login', { detail: sessionObj }));
    });
})();
