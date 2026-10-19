// =============================================================================
// CareFlow AI - Clinician Auth (Clinic Code & Pass Verification)
// =============================================================================

const FIREBASE_URL = "https://careflowai-2bd8b-default-rtdb.firebaseio.com";

(function () {
    const SESSION_KEY = 'careflow_doctor_session';
    const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000; 
    let memorySession = null;

    function getSession() {
        let s = null;
        try {
            const raw = sessionStorage.getItem(SESSION_KEY);
            if (raw) s = JSON.parse(raw);
        } catch (e) {}
        if (!s) s = memorySession;
        if (!s || !s.name || !s.loginAt) return null;
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

    // Verify credentials directly against registered clinics in Firebase
    async function verifyDoctorLogin(name, code, pass) {
        const cleanName = String(name || '').trim();
        const cleanCode = String(code || '').trim().toUpperCase();
        
        if (!cleanName) return { ok: false, reason: 'Please enter your full name.' };
        if (!cleanCode) return { ok: false, reason: 'Please enter the Clinic Code.' };
        if (!/^\d{4}$/.test(String(pass))) return { ok: false, reason: 'Clinic Pass must be exactly 4 digits.' };

        try {
            const res = await fetch(`${FIREBASE_URL}/registered_clinics/${cleanCode}.json`);
            if (!res.ok) throw new Error('Network response not ok');
            
            const clinic = await res.json();
            if (!clinic) return { ok: false, reason: `Clinic Code '${cleanCode}' not found. The clinic must register first.` };
            if (clinic.pass !== pass) return { ok: false, reason: 'Incorrect 4-digit Clinic Pass.' };

            return { ok: true, clinicCode: cleanCode, clinicName: clinic.name };
        } catch (e) {
            return { ok: false, reason: 'Network error checking credentials. Please check connection.' };
        }
    }

    function readSavedDoctorName() {
        try {
            let raw = null;
            const m = document.cookie.split(';').map(c => c.trim()).find(c => c.indexOf('careflow_user=') === 0);
            if (m) raw = decodeURIComponent(m.substring('careflow_user='.length));
            if (!raw) { try { raw = localStorage.getItem('careflow_user'); } catch (e) {} }
            const p = raw ? JSON.parse(raw) : null;
            return (p && p.role === 'doctor' && p.name) ? p.name : '';
        } catch (e) { return ''; }
    }

    function unlock() {
        document.body.classList.remove('doctor-locked');
    }

    const api = {
        getSession,
        verifyDoctorLogin,
        isAuthenticated: () => !!getSession(),
        _reload: () => window.location.reload(),
        signOut() {
            clearSession();
            api._reload();
        }
    };
    window.CareFlowDoctorAuth = api;

    // Check existing session
    const activeSession = getSession();
    if (activeSession) {
        unlock();
        return;
    }

    // Gate UI
    const form = document.getElementById('doctorLoginForm');
    const nameInput = document.getElementById('doctorLoginName');
    const codeInput = document.getElementById('doctorClinicCode');
    const pinInput = document.getElementById('doctorClinicPass');
    const errorBox = document.getElementById('doctorLoginError');
    if (!form) return; 

    nameInput.value = readSavedDoctorName();

    function showError(msg) {
        errorBox.textContent = msg;
        errorBox.style.display = 'block';
    }

    pinInput.addEventListener('input', () => {
        pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 4);
        errorBox.style.display = 'none';
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        submitBtn.textContent = "Verifying...";

        const result = await verifyDoctorLogin(nameInput.value, codeInput.value, pinInput.value);
        
        submitBtn.disabled = false;
        submitBtn.textContent = "Verify & Sign in →";

        if (!result.ok) {
            showError(result.reason);
            pinInput.value = '';
            pinInput.focus();
            return;
        }

        setSession({ 
            name: nameInput.value.trim(), 
            clinicCode: result.clinicCode, 
            loginAt: Date.now() 
        });
        pinInput.value = ''; 
        unlock();
        
        window.dispatchEvent(new CustomEvent('careflow-doctor-login', { 
            detail: { name: nameInput.value.trim(), clinicCode: result.clinicCode } 
        }));
    });
})();
