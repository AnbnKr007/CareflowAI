export default async function handler(req, res) {
    // 1. CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const API_KEY = process.env.GEMINI_API_KEY;
    if (!API_KEY) {
        return res.status(500).json({ error: "Missing GEMINI_API_KEY in Vercel." });
    }

    try {
        const { 
            clinicCode, 
            patientName, 
            patientAge, 
            patientGender, 
            symptomsText, 
            audioBase64, 
            imageBase64 
        } = req.body;

        // =========================================================================
        // STAGE 1: SLM (gemini-3.5-flash-lite)
        // Role: Speech-to-Text, Medical Image OCR, and Hinglish Translation
        // =========================================================================
        const slmParts = [
            {
                text: `You are a sensory extraction agent (SLM). 
Your ONLY task:
1. Transcribe the audio recording if provided.
2. Read and extract all text, numbers, and test values from the medical report image if provided.
3. Translate all Hindi or Hinglish text into clear English.
4. Synthesize all patient statements into a coherent clinical summary paragraph.
DO NOT diagnose or assign triage categories. Output clean clinical text only.`
            },
            {
                text: `Patient Info: Name: ${patientName}, Age: ${patientAge}, Gender: ${patientGender}.
Raw Input Text: "${symptomsText || 'None provided'}"`
            }
        ];

        if (audioBase64) {
            slmParts.push({
                inline_data: { mime_type: "audio/webm", data: audioBase64 }
            });
        }

        if (imageBase64) {
            slmParts.push({
                inline_data: { mime_type: "image/jpeg", data: imageBase64 }
            });
        }

        const slmResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: slmParts }] })
        });

        if (!slmResponse.ok) {
            const err = await slmResponse.text();
            throw new Error(`SLM Stage 1 failed: ${err}`);
        }

        const slmData = await slmResponse.json();
        const extractedClinicalNotes = slmData.candidates[0].content.parts[0].text;

        // =========================================================================
        // STAGE 2: LLM (gemini-3-flash)
        // Role: High-Level Clinical Reasoning, Department Routing, and JSON Output
        // =========================================================================
        const llmSystemInstruction = `
You are a senior hospital triage assistant.
Analyze the structured clinical summary provided by the extraction layer:
"${extractedClinicalNotes}"

Core Tasks:
1. Categorize priority into CRITICAL, URGENT, or ROUTINE.
2. Assign the relevant medical department.
3. Flag any conflicting data (e.g., patient claims no fever, but lab report indicates high temperature).
4. Identify missing critical clinical context.
5. Provide 2-3 focused follow-up questions for the attending physician.
6. MANDATORY GUARDRAIL: Do not provide a diagnosis or treatment plan.

Output STRICTLY valid JSON conforming to this schema (no markdown formatting):
{
    "priority": "CRITICAL" | "URGENT" | "ROUTINE",
    "suggestedDepartment": "Cardiology" | "Pulmonology" | "Orthopedics" | "General Medicine" | "Emergency",
    "standardizedSymptoms": ["Symptom 1", "Symptom 2"],
    "extractedVitals": {
        "temperature": "string or null",
        "heart_rate": "string or null",
        "blood_pressure": "string or null",
        "spo2": "string or null"
    },
    "missingInformation": ["Context physician must clarify"],
    "followUpQuestions": ["Doctor follow-up question 1", "Doctor follow-up question 2"],
    "confidenceFlag": true
}`;

        const llmResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                system_instruction: {
                    parts: [{ text: llmSystemInstruction }]
                },
                contents: [{
                    parts: [{ text: `Process triage for patient: ${patientName}, Age: ${patientAge}, Clinic: ${clinicCode}` }]
                }],
                generationConfig: {
                    response_mime_type: "application/json",
                    temperature: 0.1
                }
            })
        });

        if (!llmResponse.ok) {
            const err = await llmResponse.text();
            throw new Error(`LLM Stage 2 failed: ${err}`);
        }

        const llmData = await llmResponse.json();
        const rawJson = llmData.candidates[0].content.parts[0].text;
        const triagedData = JSON.parse(rawJson);

        return res.status(200).json(triagedData);

    } catch (error) {
        console.error("Triage Pipeline Error:", error);
        return res.status(500).json({ 
            error: "Server error processing triage pipeline.", 
            details: error.message 
        });
    }
}
