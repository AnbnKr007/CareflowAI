// =============================================================================
// CareFlow AI - Clinic Registration & Sign-In Verification
// =============================================================================

const FIREBASE_URL = "https://careflowai-2bd8b-default-rtdb.firebaseio.com";

(function () {
    const SESSION_KEY = 'careflow_clinic_session';
    
    function getSession() {
        try {
            const raw = sessionStorage.getItem(SESSION_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }

    function setSession(s) {
        try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {}
    }

    function clearSession() {
        try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
    }

    const api = {
        getSession,
        isAuthenticated: () => !!getSession(),
        signOut() {
            clearSession();
            window.location.reload();
        }
    };
    window.CareFlowClinicAuth = api;

    // Check existing session
    if (getSession()) {
        document.body.classList.remove('clinic-locked');
        return;
    }

    // Auth UI logic
    const form = document.getElementById('clinicLoginForm');
    const authModes = document.getElementsByName('authMode');
    const nameGroup = document.getElementById('clinicNameGroup');
    const nameInput = document.getElementById('clinicNameInput');
    const codeInput = document.getElementById('clinicCodeInput');
    const passInput = document.getElementById('clinicPassInput');
    const errorBox = document.getElementById('clinicLoginError');
    const submitBtn = document.getElementById('clinicAuthBtn');

    if (!form) return;

    let isRegisterMode = false;

    authModes.forEach(radio => {
        radio.addEventListener('change', (e) => {
            isRegisterMode = e.target.value === 'register';
            nameGroup.style.display = isRegisterMode ? 'block' : 'none';
            nameInput.required = isRegisterMode;
            submitBtn.textContent = isRegisterMode ? "Register Clinic →" : "Sign In →";
            errorBox.style.display = 'none';
        });
    });

    passInput.addEventListener('input', () => {
        passInput.value = passInput.value.replace(/\D/g, '').slice(0, 4);
        errorBox.style.display = 'none';
    });
    codeInput.addEventListener('input', () => errorBox.style.display = 'none');

    function showError(msg) {
        errorBox.textContent = msg;
        errorBox.style.display = 'block';
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        submitBtn.disabled = true;
        submitBtn.textContent = "Processing...";

        const code = codeInput.value.trim().toUpperCase();
        const pass = passInput.value;
        const name = nameInput.value.trim();

        if (!code || pass.length !== 4) {
            showError("Provide a valid Clinic Code and 4-Digit Pass.");
            submitBtn.disabled = false;
            submitBtn.textContent = isRegisterMode ? "Register Clinic →" : "Sign In →";
            return;
        }

        try {
            const res = await fetch(`${FIREBASE_URL}/registered_clinics/${code}.json`);
            const existingClinic = await res.json();

            if (isRegisterMode) {
                if (existingClinic) {
                    showError(`Clinic Code '${code}' is already registered.`);
                } else {
                    // Register the clinic
                    await fetch(`${FIREBASE_URL}/registered_clinics/${code}.json`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: name || code, pass: pass, createdAt: new Date().toISOString() })
                    });
                    finalizeLogin(code, name || code);
                }
            } else {
                if (!existingClinic) {
                    showError(`Clinic Code '${code}' not found. Please register first.`);
                } else if (existingClinic.pass !== pass) {
                    showError(`Incorrect Pass for clinic '${code}'.`);
                } else {
                    finalizeLogin(code, existingClinic.name);
                }
            }
        } catch (err) {
            showError("Network error connecting to database.");
        } finally {
            submitBtn.disabled = false;
            if (!document.body.classList.contains('clinic-locked')) return;
            submitBtn.textContent = isRegisterMode ? "Register Clinic →" : "Sign In →";
        }
    });

    function finalizeLogin(code, name) {
        setSession({ clinicCode: code, clinicName: name, loginAt: Date.now() });
        passInput.value = '';
        document.body.classList.remove('clinic-locked');
        window.dispatchEvent(new CustomEvent('careflow-clinic-login', { detail: { code, name } }));
    }
})();
