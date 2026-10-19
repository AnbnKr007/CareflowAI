// =============================================================================
// CareFlow AI - Clinician sign-in (4-digit PIN gate)
//
// DEMO MODE (current): any name + ANY 4-digit PIN is accepted, so judges and
// teammates can walk straight in.
//
// REGISTRY MODE: set DEMO_ACCEPT_ANY_PIN = false and only doctors listed in
// REGISTERED_DOCTORS (name + their own PIN) can sign in; everyone else is
// denied. That is the behaviour a real hospital deployment would use, with the
// list coming from the hospital's staff directory instead of this file.
//
// IMPORTANT: this is a front-end demo gate, not real security. The check runs in
// the browser, so a production system must verify credentials on a server
// (e.g. Firebase Authentication / the hospital's identity provider).
// =============================================================================

const DEMO_ACCEPT_ANY_PIN = true;

// Synthetic sample doctors for registry mode. PINs are stored only as a hash:
//   pinHash = SHA-256 of "<normalised name>:<PIN>"
// To add a doctor, run this in the browser console on the doctor page:
//   await CareFlowDoctorAuth.hashDoctorPin('Dr. Full Name', '1234')
// and paste the result below. (Demo PINs: Sharma 1234, Mehta 4321, Nair 2468)
const REGISTERED_DOCTORS = [
    { name: 'Dr. Ananya Sharma', pinHash: '8071e9abea92d718973de4e672ae88fc57f6848c199cb8bfff0e82f96c58d14d' },
    { name: 'Dr. Rohan Mehta',   pinHash: '48247da49aca6a3c604cfdddd48385062752a11d97728d3dc4fb79de43408ae5' },
    { name: 'Dr. Priya Nair',    pinHash: 'a9d0fd47fd5fa7ee48be8bfc1cf605e7d119eda40dd91ff656db1c472968d24f' }
];

(function () {
    const SESSION_KEY = 'careflow_doctor_session';
    const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours
    let memorySession = null; // fallback if sessionStorage is blocked

    // ---------- session (cleared automatically when the browser tab is closed) ----------
    function getSession() {
        let s = null;
        try {
            const raw = sessionStorage.getItem(SESSION_KEY);
            if (raw) s = JSON.parse(raw);
        } catch (e) { /* storage blocked */ }
        if (!s) s = memorySession;
        if (!s || !s.name || !s.loginAt) return null;
        if (Date.now() - s.loginAt > SESSION_MAX_AGE_MS) return null;
        return s;
    }

    function setSession(s) {
        memorySession = s;
        try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
    }

    function clearSession() {
        memorySession = null;
        try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
    }

    // ---------- credentials ----------
    // "Dr. Ananya  Sharma", "dr ananya sharma" and "Ananya Sharma" all count as the same person
    function normalizeDoctorName(name) {
        return String(name || '').toLowerCase().replace(/\./g, ' ').replace(/\s+/g, ' ').trim().replace(/^dr\s+/, '');
    }

    async function hashDoctorPin(name, pin) {
        const data = new TextEncoder().encode(`${normalizeDoctorName(name)}:${pin}`);
        const digest = await crypto.subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    async function verifyDoctorLogin(name, pin) {
        if (!normalizeDoctorName(name)) return { ok: false, reason: 'Please enter your full name.' };
        if (!/^\d{4}$/.test(String(pin))) return { ok: false, reason: 'PIN must be exactly 4 digits.' };

        if (DEMO_ACCEPT_ANY_PIN) return { ok: true, mode: 'demo' };

        // Registry mode: must be a registered doctor with the matching PIN
        try {
            const hash = await hashDoctorPin(name, pin);
            const wanted = normalizeDoctorName(name);
            const match = REGISTERED_DOCTORS.find(d => normalizeDoctorName(d.name) === wanted && d.pinHash === hash);
            return match
                ? { ok: true, mode: 'registry', registeredName: match.name }
                : { ok: false, reason: 'Not a registered doctor, or the PIN is incorrect.' };
        } catch (e) {
            return { ok: false, reason: 'Secure sign-in is unavailable in this browser (needs HTTPS).' };
        }
    }

    // Pre-fill the name from a previously saved doctor profile (read before doctor.js runs)
    function readSavedDoctorName() {
        try {
            let raw = null;
            const m = document.cookie.split(';').map(c => c.trim()).find(c => c.indexOf('careflow_user=') === 0);
            if (m) raw = decodeURIComponent(m.substring('careflow_user='.length));
            if (!raw) { try { raw = localStorage.getItem('careflow_user'); } catch (e) { /* ignore */ } }
            const p = raw ? JSON.parse(raw) : null;
            return (p && p.role === 'doctor' && p.name) ? p.name : '';
        } catch (e) { return ''; }
    }

    // ---------- screen lock ----------
    function unlock() {
        document.body.classList.remove('doctor-locked');
    }

    const api = {
        getSession,
        hashDoctorPin,
        verifyDoctorLogin,
        isAuthenticated: () => !!getSession(),
        _reload: () => window.location.reload(),
        signOut() {
            clearSession();
            api._reload(); // reload so nothing from the previous session stays on screen or keeps refreshing
        }
    };
    window.CareFlowDoctorAuth = api;

    // Already signed in during this browser session -> straight to the dashboard
    if (getSession()) {
        unlock();
        return;
    }

    // ---------- sign-in form ----------
    const form = document.getElementById('doctorLoginForm');
    const nameInput = document.getElementById('doctorLoginName');
    const pinInput = document.getElementById('doctorLoginPin');
    const errorBox = document.getElementById('doctorLoginError');
    const noteBox = document.getElementById('doctorLoginNote');
    if (!form || !nameInput || !pinInput) return; // gate markup missing: dashboard stays locked

    nameInput.value = readSavedDoctorName();
    noteBox.textContent = DEMO_ACCEPT_ANY_PIN
        ? 'Demo mode: any 4-digit PIN is accepted. A live deployment checks this against the hospital\u2019s registered-doctor list.'
        : 'Only registered doctors can sign in.';

    function showError(msg) {
        errorBox.textContent = msg;
        errorBox.style.display = 'block';
    }

    // Digits only, max 4
    pinInput.addEventListener('input', () => {
        pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 4);
        errorBox.style.display = 'none';
    });
    nameInput.addEventListener('input', () => { errorBox.style.display = 'none'; });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = nameInput.value.trim();
        const pin = pinInput.value;

        const result = await verifyDoctorLogin(name, pin);
        if (!result.ok) {
            showError(result.reason);
            pinInput.value = '';
            pinInput.focus();
            return;
        }

        const displayName = result.registeredName || name;
        setSession({ name: displayName, loginAt: Date.now(), mode: result.mode });
        pinInput.value = ''; // never keep the PIN around
        unlock();
        window.dispatchEvent(new CustomEvent('careflow-doctor-login', { detail: { name: displayName } }));
    });
})();
