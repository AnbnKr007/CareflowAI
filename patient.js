// REPLACE THIS WITH YOUR FIREBASE URL (Keep the trailing slash removed)
const FIREBASE_URL = "https://careflowai-2bd8b-default-rtdb.firebaseio.com/";

let mediaRecorder;
let audioChunks = [];
let audioBase64 = null;
let imageBase64 = null;

const recordBtn = document.getElementById('recordBtn');
const stopRecordBtn = document.getElementById('stopRecordBtn');
const recordingStatus = document.getElementById('recordingStatus');
const audioPreview = document.getElementById('audioPreview');
const reportImageInput = document.getElementById('reportImage');
const imagePreview = document.getElementById('imagePreview');
const imagePreviewContainer = document.getElementById('imagePreviewContainer');
const patientForm = document.getElementById('patientForm');
const statusMessage = document.getElementById('statusMessage');

// Audio Recorder
recordBtn.addEventListener('click', async () => {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];

        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) audioChunks.push(event.data);
        };

        mediaRecorder.onstop = () => {
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            audioPreview.src = URL.createObjectURL(audioBlob);
            audioPreview.style.display = 'block';

            const reader = new FileReader();
            reader.readAsDataURL(audioBlob);
            reader.onloadend = () => {
                audioBase64 = reader.result.split(',')[1];
            };
        };

        mediaRecorder.start();
        recordBtn.disabled = true;
        stopRecordBtn.disabled = false;
        recordingStatus.textContent = "● Recording... speak now";
        recordingStatus.style.color = "#ef4444";
    } catch (err) {
        alert("Microphone access denied or unavailable.");
    }
});

stopRecordBtn.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
        recordBtn.disabled = false;
        stopRecordBtn.disabled = true;
        recordingStatus.textContent = "Recording attached ✓";
        recordingStatus.style.color = "#16a34a";
    }
});

// Image Converter
reportImageInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onloadend = () => {
            imageBase64 = reader.result.split(',')[1];
            imagePreview.src = reader.result;
            imagePreviewContainer.style.display = 'block';
        };
        reader.readAsDataURL(file);
    }
});

// Form Submission (Saves to Cloud Firebase)
patientForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const submitBtn = document.getElementById('submitBtn');
    submitBtn.disabled = true;
    submitBtn.textContent = "AI Triaging in Progress...";

    const clinicCode = document.getElementById('clinicCode').value.trim().toUpperCase();
    const caseId = 'PAT-' + Math.floor(1000 + Math.random() * 9000);

    const payload = {
        clinicCode: clinicCode,
        patientName: document.getElementById('patientName').value.trim(),
        patientAge: document.getElementById('patientAge').value,
        patientGender: document.getElementById('patientGender').value,
        symptomsText: document.getElementById('symptomsText').value.trim(),
        audioBase64: audioBase64,
        imageBase64: imageBase64,
        timestamp: new Date().toISOString()
    };

    try {
        // 1. Process via Vercel AI Backend
        const aiResponse = await fetch('/api/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!aiResponse.ok) throw new Error("Failed to process triage with AI backend.");
        const triagedResult = await aiResponse.json();

        // 2. Assemble Cloud Record
        const fullCaseRecord = {
            id: caseId,
            clinicCode: clinicCode,
            patientName: payload.patientName,
            patientAge: payload.patientAge,
            patientGender: payload.patientGender,
            symptomsText: payload.symptomsText,
            timestamp: payload.timestamp,
            triage: triagedResult,
            status: 'PENDING_REVIEW',
            doctorNote: null,
            reviewedBy: null,
            reviewedAt: null
        };

        // 3. Save directly to Firebase Cloud (Available to doctors instantly)
        await fetch(`${FIREBASE_URL}/clinics/${clinicCode}/cases/${caseId}.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fullCaseRecord)
        });

        // 4. Update UI
        patientForm.reset();
        audioPreview.style.display = 'none';
        imagePreviewContainer.style.display = 'none';
        audioBase64 = null;
        imageBase64 = null;
        recordingStatus.textContent = "Idle";

        statusMessage.className = "status-banner status-success";
        statusMessage.innerHTML = `
            <strong>Submission Successful!</strong><br>
            Your Unique Case ID: <span style="font-size: 1.2rem; font-weight: bold; color: #1e40af;">${caseId}</span><br>
            Routed to Department: <strong>${triagedResult.suggestedDepartment || 'General Medicine'}</strong><br>
            <small>Save this Case ID to check your doctor's instructions anytime.</small>
        `;
        statusMessage.style.display = 'block';

    } catch (err) {
        statusMessage.className = "status-banner status-error";
        statusMessage.textContent = "Error: " + err.message;
        statusMessage.style.display = 'block';
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit for Triage Review";
    }
});

// Live Cloud Tracking by Case ID
document.getElementById('trackBtn').addEventListener('click', async () => {
    const clinic = document.getElementById('trackClinicCode').value.trim().toUpperCase();
    const caseId = document.getElementById('trackCaseId').value.trim().toUpperCase();
    const resultBox = document.getElementById('trackingResult');

    if (!clinic || !caseId) {
        alert("Please enter both Clinic Code and Case ID.");
        return;
    }

    resultBox.style.display = 'block';
    resultBox.innerHTML = 'Fetching updates from hospital cloud...';

    try {
        const res = await fetch(`${FIREBASE_URL}/clinics/${clinic}/cases/${caseId}.json`);
        const caseData = await res.json();

        if (!caseData) {
            resultBox.innerHTML = '<span style="color: #ef4444;">No case found with this ID under clinic ' + clinic + '.</span>';
            return;
        }

        const isReviewed = caseData.status === 'APPROVED';
        resultBox.innerHTML = `
            <div style="border-bottom: 1px solid #cbd5e1; padding-bottom: 8px; margin-bottom: 8px;">
                <strong>Case ${caseData.id}</strong> | Status: 
                <span class="badge" style="background: ${isReviewed ? '#dcfce7; color: #15803d' : '#fef9c3; color: #a16207'}">
                    ${isReviewed ? 'Doctor Reviewed & Approved' : 'Pending Review'}
                </span>
            </div>
            <div><strong>Assigned Department:</strong> ${caseData.triage.suggestedDepartment || 'General Medicine'}</div>
            <div><strong>Triage Urgency:</strong> ${caseData.triage.priority || 'ROUTINE'}</div>
            
            ${isReviewed ? `
                <div style="margin-top: 12px; padding: 10px; background: #ecfdf5; border-radius: 6px; border-left: 4px solid #10b981;">
                    <strong>Doctor's Prescription & Action Plan:</strong><br>
                    <p style="margin: 5px 0 0 0; color: #065f46;">${caseData.doctorNote || 'No custom notes provided.'}</p>
                    <small style="color: #64748b;">Signed off by: ${caseData.reviewedBy} at${caseData.reviewedAt}</small>
                </div>
            ` : `
                <div style="margin-top: 10px; color: #64748b; font-size: 0.9rem;">
                    Your case is currently waiting in the clinical review queue. Please check back shortly.
                </div>
            `}
        `;
    } catch (err) {
        resultBox.innerHTML = '<span style="color: #ef4444;">Failed to retrieve record: ' + err.message + '</span>';
    }
});
