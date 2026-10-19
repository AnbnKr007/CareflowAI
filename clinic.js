const FIREBASE_URL = "https://careflowai-2bd8b-default-rtdb.firebaseio.com";

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const clinicGreetingHeader = document.getElementById('clinicGreetingHeader');
const countDoctors = document.getElementById('countDoctors');
const countTotalCases = document.getElementById('countTotalCases');
const doctorsListContainer = document.getElementById('doctorsListContainer');
const clinicCasesContainer = document.getElementById('clinicCasesContainer');
const refreshAdminBtn = document.getElementById('refreshAdminBtn');

let currentSession = null;

function renderClinicProfile() {
    clinicGreetingHeader.innerHTML = `
        <span class="user-chip">
            🏥 Admin: <strong>${escapeHtml(currentSession.clinicName)}</strong>
            <small>(Code: ${escapeHtml(currentSession.clinicCode)})</small>
        </span>
        <button type="button" class="ghost-btn sm-btn" onclick="CareFlowClinicAuth.signOut()">Sign Out</button>
    `;
}

async function fetchAdminData() {
    if (!currentSession) return;
    const code = currentSession.clinicCode;
    
    try {
        const [casesRes, docsRes] = await Promise.all([
            fetch(`${FIREBASE_URL}/clinics/${code}/cases.json`),
            fetch(`${FIREBASE_URL}/clinics/${code}/doctors.json`)
        ]);

        const casesData = await casesRes.json() || {};
        const docsData = await docsRes.json() || {};

        const casesArray = Object.values(casesData).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        const docsArray = Object.values(docsData).sort((a, b) => new Date(b.lastActive) - new Date(a.lastActive));

        countDoctors.textContent = docsArray.length;
        countTotalCases.textContent = casesArray.length;

        // Render Doctors
        if (docsArray.length === 0) {
            doctorsListContainer.innerHTML = `<div class="empty-state" style="padding:15px;"><small>No doctors active yet.</small></div>`;
        } else {
            doctorsListContainer.innerHTML = docsArray.map(doc => {
                const activeTime = new Date(doc.lastActive).toLocaleString([], {hour: '2-digit', minute:'2-digit', day: 'numeric', month: 'short'});
                return `
                <div class="clinic-item-row">
                    <div>
                        <strong>${escapeHtml(doc.name)}</strong>
                        <div style="font-size:0.75rem; color:#64748b;">${escapeHtml(doc.department)}</div>
                    </div>
                    <small style="color:#10b981;">Active: ${activeTime}</small>
                </div>`;
            }).join('');
        }

        // Render Cases
        if (casesArray.length === 0) {
            clinicCasesContainer.innerHTML = `<div class="empty-state"><p>No patient cases registered to this clinic.</p></div>`;
        } else {
            clinicCasesContainer.innerHTML = casesArray.map(c => {
                const isCritical = c.triage?.priority === 'CRITICAL';
                return `
                <div class="clinic-item-row" style="border-left: 4px solid ${isCritical ? '#dc2626' : '#cbd5e1'};">
                    <div style="flex:1;">
                        <strong style="font-size: 0.95rem;">#${escapeHtml(c.id)} - ${escapeHtml(c.patientName)}</strong>
                        <span class="status-pill status-${(c.status || 'PENDING_REVIEW').toLowerCase()}" style="margin-left:8px;">${escapeHtml(c.status.replace(/_/g, ' '))}</span>
                        
                        <div style="margin-top:4px; font-size:0.82rem; color:#475569;">
                            Priority: <strong style="color: ${isCritical ? '#b91c1c' : 'inherit'}">${escapeHtml(c.triage?.priority || 'ROUTINE')}</strong> 
                            | Dept: ${escapeHtml(c.triage?.suggestedDepartment || 'General Medicine')}
                        </div>
                    </div>
                    <div style="text-align:right; min-width: 120px;">
                        <small style="color:#64748b;">${new Date(c.timestamp).toLocaleString([], {day: '2-digit', month: 'short', hour: '2-digit', minute:'2-digit'})}</small>
                    </div>
                </div>`;
            }).join('');
        }
    } catch (e) {
        console.error(e);
        clinicCasesContainer.innerHTML = `<span style="color:#ef4444;">Error fetching clinic data.</span>`;
    }
}

refreshAdminBtn.addEventListener('click', fetchAdminData);

function startDashboard(session) {
    currentSession = session;
    renderClinicProfile();
    fetchAdminData();
    // Auto refresh every 20 seconds
    setInterval(() => fetchAdminData(), 20000);
}

if (window.CareFlowClinicAuth && window.CareFlowClinicAuth.isAuthenticated()) {
    startDashboard(window.CareFlowClinicAuth.getSession());
} else {
    window.addEventListener('careflow-clinic-login', (e) => startDashboard({
        clinicCode: e.detail.code,
        clinicName: e.detail.name
    }), { once: true });
}
