// State variables for recording and media
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

// 1. Microphone Voice Recorder (MediaRecorder API)
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

            // Convert to Base64 for the API payload
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
        alert("Microphone permission denied or not supported.");
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

// 2. Image to Base64 Converter
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

// 3. Form Submission to Backend & Local multi-tenant storage
patientForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const submitBtn = document.getElementById('submitBtn');
    submitBtn.disabled = true;
    submitBtn.textContent = "Analyzing & Triaging Case...";

    const payload = {
        clinicCode: document.getElementById('clinicCode').value.trim().toUpperCase(),
        patientName: document.getElementById('patientName').value.trim(),
        patientAge: document.getElementById('patientAge').value,
        patientGender: document.getElementById('patientGender').value,
        symptomsText: document.getElementById('symptomsText').value.trim(),
        audioBase64: audioBase64,
        imageBase64: imageBase64,
        timestamp: new Date().toISOString()
    };

    try {
        const response = await fetch('/api/gemini', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) throw new Error("Server error processing triage.");

        const triagedResult = await response.json();

        // Save into local Multi-Tenant queue (accessible by Doctor Dashboard)
        const storageKey = `cases_${payload.clinicCode}`;
        const existingCases = JSON.parse(localStorage.getItem(storageKey) || "[]");
        
        const fullCaseRecord = {
            id: 'CASE-' + Date.now().toString().slice(-5),
            ...payload,
            triage: triagedResult,
            status: 'PENDING_REVIEW', // Initial status before doctor sign-off
            auditTrail: [
                {
                    timestamp: new Date().toLocaleTimeString(),
                    action: `Case created and triaged as ${triagedResult.priority || 'ROUTINE'} by AI[cite: 4]`
                }
            ]
        };

        existingCases.unshift(fullCaseRecord);
        localStorage.setItem(storageKey, JSON.stringify(existingCases));

        // Display Success Screen
        patientForm.reset();
        audioPreview.style.display = 'none';
        imagePreviewContainer.style.display = 'none';
        audioBase64 = null;
        imageBase64 = null;
        recordingStatus.textContent = "Idle";

        statusMessage.className = "status-banner status-success";
        statusMessage.innerHTML = `
            <strong>Submission Successful!</strong><br>
            Your case <strong>#${fullCaseRecord.id}</strong> has been forwarded to <strong>${payload.clinicCode}</strong>.
            Assigned Department: <strong>${triagedResult.suggestedDepartment || 'General Medicine'}</strong>.<br>
            <small>A doctor will review your structured summary shortly.</small>
        `;
        statusMessage.style.display = 'block';

    } catch (err) {
        statusMessage.className = "status-banner status-error";
        statusMessage.textContent = "Error: " + err.message + ". Please verify Vercel backend deployment.";
        statusMessage.style.display = 'block';
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit for Triage Review";
    }
});