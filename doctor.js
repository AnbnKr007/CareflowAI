// REPLACE THIS WITH YOUR FIREBASE URL (Keep the trailing slash removed)
const FIREBASE_URL = "https://careflowai-2bd8b-default-rtdb.firebaseio.com/";

const loginSection = document.getElementById('loginSection');
const dashboardSection = document.getElementById('dashboardSection');
const doctorLoginForm = document.getElementById('doctorLoginForm');
const triageQueue = document.getElementById('triageQueue');
const dashboardTitle = document.getElementById('dashboardTitle');
const logoutBtn = document.getElementById('logoutBtn');

let currentClinic = '';
let currentDepartment = '';

doctorLoginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    currentClinic = document.getElementById('docClinicCode').value.trim().toUpperCase();
    currentDepartment = document.getElementById('docDepartment').value;

    loginSection.style.display = 'none';
    dashboardSection.style.display = 'block';
    dashboardTitle.textContent = `Active Cloud Queue: ${currentClinic} (${currentDepartment})`;
    
    fetchCloudQueue();
});

// Fetch all cases live from Firebase
async function fetchCloudQueue() {
    triageQueue.innerHTML = '<p style="text-align:center; color:#64748b;">Syncing with cloud database...</p>';

    try {
        const response = await fetch(`${FIREBASE_URL}/clinics/${currentClinic}/cases.json`);
        const data = await response.json();

        if (!data) {
            triageQueue.innerHTML = '<p style="text-align:center; color:#64748b;">No active cases found for clinic ' + currentClinic + '.</p>';
            return;
        }

        const casesArray = Object.values(data);

        // Filter for matching department and pending status
        const filteredCases = casesArray.filter(c => {
            const matchDept = currentDepartment === 'All' || (c.triage.suggestedDepartment && c.triage.suggestedDepartment.includes(currentDepartment));
            const matchStatus = c.status === 'PENDING_REVIEW';
            return matchDept && matchStatus;
        });

        triageQueue.innerHTML = '';

        if (filteredCases.length === 0) {
            triageQueue.innerHTML = '<p style="text-align:center; color:#64748b;">No pending cases for this department.</p>';
            return;
        }

        filteredCases.forEach(caseData => {
            const t = caseData.triage;
            const priorityClass = t.priority ? `priority-${t.priority.toLowerCase()}` : 'priority-routine';
            
            const symptomsHtml = t.standardizedSymptoms ? t.standardizedSymptoms.map(s => `<li>${s}</li>`).join('') : '<li>None</li>';
            const questionsHtml = t.followUpQuestions ? t.followUpQuestions.map(q => `<li>${q}</li>`).join('') : '<li>None</li>';
            
            let alertHtml = '';
            if (t.confidenceFlag === false || (t.missingInformation && t.missingInformation.length > 0)) {
                const missing = t.missingInformation ? t.missingInformation.join(', ') : 'Unclear or conflicting data detected.';
                alertHtml = `<div class="alert-box">⚠️ <strong>Flag:</strong> ${missing}</div>`;
            }

            const card = document.createElement('div');
            card.className = `triage-card ${priorityClass}`;
            card.innerHTML = `
                <div class="card-header">
                    <div class="patient-info">
                        <h3>${caseData.patientName} (Age: ${caseData.patientAge}, ${caseData.patientGender})</h3>
                        <div class="patient-meta">Case #${caseData.id} | Submitted: ${new Date(caseData.timestamp).toLocaleTimeString()} | Dept: ${t.suggestedDepartment}</div>
                    </div>
                    <div class="priority-badge">${t.priority || 'ROUTINE'}</div>
                </div>
                
                <div class="card-body">
                    <div class="section-title">Standardized Symptoms</div>
                    <ul>${symptomsHtml}</ul>

                    <div class="section-title">AI Suggested Follow-ups</div>
                    <ul>${questionsHtml}</ul>

                    ${alertHtml}

                    <div style="margin-top: 15px;">
                        <label style="font-weight: 600; font-size: 0.85rem;">Doctor's Response & Instructions for Patient:</label>
                        <textarea id="doctorNote_${caseData.id}" rows="2" style="width: 100%; box-sizing: border-box; margin-top: 5px; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px;" placeholder="e.g. Prescribed Paracetamol 650mg. Advised OPD Room 4 visit..."></textarea>
                    </div>
                </div>

                <div class="card-actions" style="margin-top: 15px;">
                    <button class="approve-btn" onclick="approveAndSend('${caseData.id}')">Approve & Send to Patient</button>
                    <button class="override-btn" onclick="overridePriority('${caseData.id}')">Override Priority</button>
                    <button class="delete-btn" onclick="purgeRecord('${caseData.id}')">🗑️ Purge Record</button>
                </div>
            `;
            triageQueue.appendChild(card);
        });

    } catch (err) {
        triageQueue.innerHTML = '<p style="color: #ef4444; text-align: center;">Error loading cloud queue: ' + err.message + '</p>';
    }
}

// Approve and send instructions back to patient phone
window.approveAndSend = async function(caseId) {
    const note = document.getElementById(`doctorNote_${caseId}`).value.trim();
    const docId = prompt("Enter your Doctor ID / Name for the audit signature:", "Dr. Sharma");
    
    if (!docId) return;

    try {
        await fetch(`${FIREBASE_URL}/clinics/${currentClinic}/cases/${caseId}.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                status: 'APPROVED',
                doctorNote: note || "Triage validated. Proceed to clinic desk.",
                reviewedBy: docId,
                reviewedAt: new Date().toLocaleTimeString()
            })
        });

        alert(`Case #${caseId} approved and synced. Patient can now view this update.`);
        fetchCloudQueue();
    } catch (err) {
        alert("Failed to update cloud: " + err.message);
    }
};

// Override Priority
window.overridePriority = async function(caseId) {
    const newPriority = prompt("Enter new priority (CRITICAL, URGENT, ROUTINE):").toUpperCase();
    if (!['CRITICAL', 'URGENT', 'ROUTINE'].includes(newPriority)) {
        alert("Invalid priority.");
        return;
    }

    try {
        await fetch(`${FIREBASE_URL}/clinics/${currentClinic}/cases/${caseId}/triage.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ priority: newPriority })
        });
        fetchCloudQueue();
    } catch (err) {
        alert("Failed to update priority: " + err.message);
    }
};

// Data Privacy: Purge Record
window.purgeRecord = async function(caseId) {
    if (confirm("PRIVACY WARNING: Permanently delete this record from cloud storage?")) {
        try {
            await fetch(`${FIREBASE_URL}/clinics/${currentClinic}/cases/${caseId}.json`, {
                method: 'DELETE'
            });
            alert(`Record ${caseId} permanently deleted.`);
            fetchCloudQueue();
        } catch (err) {
            alert("Failed to delete record: " + err.message);
        }
    }
};

logoutBtn.addEventListener('click', () => {
    loginSection.style.display = 'block';
    dashboardSection.style.display = 'none';
    currentClinic = '';
    currentDepartment = '';
    document.getElementById('docClinicCode').value = '';
});
