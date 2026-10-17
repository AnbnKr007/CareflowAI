const loginSection = document.getElementById('loginSection');
const dashboardSection = document.getElementById('dashboardSection');
const doctorLoginForm = document.getElementById('doctorLoginForm');
const triageQueue = document.getElementById('triageQueue');
const dashboardTitle = document.getElementById('dashboardTitle');
const logoutBtn = document.getElementById('logoutBtn');

let currentClinic = '';
let currentDepartment = '';

// 1. Handle Doctor Login & Routing
doctorLoginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    currentClinic = document.getElementById('docClinicCode').value.trim().toUpperCase();
    currentDepartment = document.getElementById('docDepartment').value;

    loginSection.style.display = 'none';
    dashboardSection.style.display = 'block';
    dashboardTitle.textContent = `Active Cases: ${currentClinic} (${currentDepartment})`;
    
    renderQueue();
});

// 2. Render the Triage Cards
function renderQueue() {
    const storageKey = `cases_${currentClinic}`;
    const allCases = JSON.parse(localStorage.getItem(storageKey) || "[]");
    
    // Filter cases based on department and pending status
    const filteredCases = allCases.filter(c => {
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
        
        // Build Lists safely
        const symptomsHtml = t.standardizedSymptoms ? t.standardizedSymptoms.map(s => `<li>${s}</li>`).join('') : '<li>No structured symptoms extracted</li>';
        const questionsHtml = t.followUpQuestions ? t.followUpQuestions.map(q => `<li>${q}</li>`).join('') : '<li>None suggested</li>';
        
        // Uncertainty / Missing Info Flag
        let alertHtml = '';
        if (t.confidenceFlag === false || (t.missingInformation && t.missingInformation.length > 0)) {
            const missing = t.missingInformation ? t.missingInformation.join(', ') : 'AI detected conflicting or unclear input.';
            alertHtml = `<div class="alert-box">⚠️ <strong>Flag:</strong> ${missing}</div>`;
        }

        const card = document.createElement('div');
        card.className = `triage-card ${priorityClass}`;
        card.innerHTML = `
            <div class="card-header">
                <div class="card-actions">
                <button class="approve-btn" onclick="signOffCase('${caseData.id}')">Approve & Sign Off</button>
                <button class="override-btn" onclick="overridePriority('${caseData.id}')">Override Priority</button>
                <button class="delete-btn" onclick="purgeRecord('${caseData.id}')">🗑️ Purge Record</button>
            </div>
                <div class="priority-badge">${t.priority || 'ROUTINE'}</div>
            </div>
            
            <div class="card-body">
                <div class="section-title">Standardized Symptoms</div>
                <ul>${symptomsHtml}</ul>

                <div class="section-title">Suggested Doctor Follow-ups</div>
                <ul>${questionsHtml}</ul>

                ${alertHtml}
            </div>

            <div class="card-actions">
                <button class="approve-btn" onclick="signOffCase('${caseData.id}')">Approve & Sign Off</button>
                <button class="override-btn" onclick="overridePriority('${caseData.id}')">Override Priority</button>
            </div>
        `;
        triageQueue.appendChild(card);
    });
}

// 3. Human-in-the-loop: Approve Case
window.signOffCase = function(caseId) {
    const storageKey = `cases_${currentClinic}`;
    let allCases = JSON.parse(localStorage.getItem(storageKey) || "[]");
    
    // Find case and update status
    const caseIndex = allCases.findIndex(c => c.id === caseId);
    if (caseIndex > -1) {
        allCases[caseIndex].status = 'APPROVED';
        allCases[caseIndex].auditTrail.push({
            timestamp: new Date().toLocaleTimeString(),
            action: `Doctor signed off on AI triage.`
        });
        localStorage.setItem(storageKey, JSON.stringify(allCases));
        renderQueue(); // Refresh dashboard
    }
};

// 4. Human-in-the-loop: Override Priority
window.overridePriority = function(caseId) {
    const storageKey = `cases_${currentClinic}`;
    let allCases = JSON.parse(localStorage.getItem(storageKey) || "[]");
    
    const caseIndex = allCases.findIndex(c => c.id === caseId);
    if (caseIndex > -1) {
        const newPriority = prompt("Enter new priority (CRITICAL, URGENT, ROUTINE):").toUpperCase();
        if (['CRITICAL', 'URGENT', 'ROUTINE'].includes(newPriority)) {
            allCases[caseIndex].triage.priority = newPriority;
            allCases[caseIndex].auditTrail.push({
                timestamp: new Date().toLocaleTimeString(),
                action: `Doctor overrode AI priority to ${newPriority}.`
            });
            localStorage.setItem(storageKey, JSON.stringify(allCases));
            renderQueue();
        } else {
            alert("Invalid priority entered.");
        }
    }
};

// 5. Logout
logoutBtn.addEventListener('click', () => {
    loginSection.style.display = 'block';
    dashboardSection.style.display = 'none';
    currentClinic = '';
    currentDepartment = '';
    document.getElementById('docClinicCode').value = '';
});
// 6. Data Privacy: Purge Record (Hackathon Constraint)
window.purgeRecord = function(caseId) {
    const confirmPurge = confirm("PRIVACY WARNING: Are you sure you want to permanently delete this patient's data? This action cannot be undone.");
    
    if (confirmPurge) {
        const storageKey = `cases_${currentClinic}`;
        let allCases = JSON.parse(localStorage.getItem(storageKey) || "[]");
        
        // Filter out the deleted case to simulate a database wipe
        allCases = allCases.filter(c => c.id !== caseId);
        
        // Save the scrubbed array back to local storage
        localStorage.setItem(storageKey, JSON.stringify(allCases));
        
        // Refresh the dashboard UI
        renderQueue(); 
        
        alert(`Patient record ${caseId} has been permanently purged from the system in compliance with data privacy guidelines.`);
    }
};