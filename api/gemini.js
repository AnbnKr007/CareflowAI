export default async function handler(req, res) {
    // 1. Set CORS Headers (Allows your browser frontend to talk to this Vercel backend)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight OPTIONS request
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Reject non-POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // Retrieve the API Key from Vercel Environment Variables
    const API_KEY = process.env.GEMINI_API_KEY;
    if (!API_KEY) {
        return res.status(500).json({ error: "Missing GEMINI_API_KEY in Vercel settings." });
    }

    try {
        // 2. Extract Data from Frontend Request
        const { 
            clinicCode, 
            patientName, 
            patientAge, 
            patientGender, 
            symptomsText, 
            audioBase64, 
            imageBase64 
        } = req.body;

        // 3. Define the Strict System Instructions for the AI
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
- ROUTINE: Common cold, chronic mild joint ache, rash without systemic symptoms.`;

        // 4. Assemble the Multimodal Content Array
        const patientContext = `
Patient Record:
- Clinic: ${clinicCode || 'Unassigned'}
- Name: ${patientName || 'Anonymous'}
- Age: ${patientAge || 'Unknown'}
- Gender: ${patientGender || 'Unknown'}
- Stated Symptoms: "${symptomsText || 'No text entered.'}"
`;
        
        // Start with the text inputs
        const parts = [{ text: patientContext }];

        // Add Audio (Voice Note) if the frontend sent it
        if (audioBase64) {
            parts.push({
                inline_data: {
                    mime_type: "audio/webm",
                    data: audioBase64
                }
            });
        }

        // Add Image (Lab Report) if the frontend sent it
        if (imageBase64) {
            parts.push({
                inline_data: {
                    mime_type: "image/jpeg",
                    data: imageBase64
                }
            });
        }

        // 5. Construct the final Payload using pure Native fetch formatting
        const payload = {
            system_instruction: {
                parts: [{ text: systemInstruction }]
            },
            contents: [{
                parts: parts
            }],
            generationConfig: {
                response_mime_type: "application/json", // Forces JSON output
                temperature: 0.1 // Keeps the AI deterministic and clinical
            }
        };

        // 6. Make the Native fetch call directly to Google's REST API (No SDK required)
        const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${API_KEY}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        // 7. Handle API Errors gracefully
        if (!geminiResponse.ok) {
            const errorText = await geminiResponse.text();
            throw new Error(`Google API Error: ${errorText}`);
        }

        // 8. Parse the JSON response and return it to the frontend
        const geminiData = await geminiResponse.json();
        
        // The AI output is guaranteed to be JSON because of response_mime_type
        const rawJsonString = geminiData.candidates[0].content.parts[0].text;
        const triagedData = JSON.parse(rawJsonString);

        return res.status(200).json(triagedData);

    } catch (error) {
        console.error("Triage Execution Error:", error);
        return res.status(500).json({ 
            error: "Server error processing triage.", 
            details: error.message 
        });
    }
}
