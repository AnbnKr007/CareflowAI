import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
    // 1. CORS headers to permit requests from your frontend
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
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

        // 2. Initialize the SLM (Sub-20B tier for efficiency scoring)
        const model = genAI.getGenerativeModel({ 
            model: 'gemini-3.5-flash-lite',
            generationConfig: {
                responseMimeType: "application/json",
                temperature: 0.1 
            }
        });

        // 3. Assemble Multimodal Payload
        const promptParts = [];

        const systemInstruction = `
You are a medical triage assistant. 
Your core tasks:
1. Translate Hindi, Hinglish, and regional terms into standardized clinical English.
2. Transcribe voice audio recordings if provided.
3. Extract lab report findings and OCR values if an image is provided.
4. Categorize urgency and route to the appropriate department.
5. Highlight missing context or conflicting findings.
6. MANDATORY GUARDRAIL: Do not diagnose conditions or prescribe treatments.

Return strictly a valid JSON object matching this schema:
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
    "missingInformation": ["List key missing clinical parameters"],
    "followUpQuestions": ["Targeted question 1 for physician", "Targeted question 2 for physician"],
    "confidenceFlag": true
}

Priority Thresholds:
- CRITICAL: Chest pain, acute dyspnea, suspected stroke, unresponsiveness, severe hemorrhage.
- URGENT: High fever (>102°F), suspected fracture, severe localized pain.
- ROUTINE: Common cold, chronic mild joint ache, rash without systemic symptoms.
`;
        promptParts.push(systemInstruction);

        // Append text demographic and symptom context
        const patientContext = `
Patient Record:
- Clinic: ${clinicCode || 'Unassigned'}
- Name: ${patientName || 'Anonymous'}
- Age: ${patientAge || 'Unknown'}
- Gender: ${patientGender || 'Unknown'}
- Stated Symptoms: "${symptomsText || 'No text entered.'}"
`;
        promptParts.push(patientContext);

        // Append base64 audio if present
        if (audioBase64) {
            promptParts.push({
                inlineData: {
                    data: audioBase64,
                    mimeType: "audio/webm"
                }
            });
        }

        // Append base64 lab report/image if present
        if (imageBase64) {
            promptParts.push({
                inlineData: {
                    data: imageBase64,
                    mimeType: "image/jpeg"
                }
            });
        }

        // 4. Run Multimodal Inference
        const result = await model.generateContent(promptParts);
        const responseText = result.response.text();
        
        const triagedData = JSON.parse(responseText);

        return res.status(200).json(triagedData);

    } catch (error) {
        console.error("Triage Execution Error:", error);
        return res.status(500).json({ 
            error: "Server error processing triage.", 
            details: error.message 
        });
    }
}
