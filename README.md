# CareFlow AI — Human-in-the-Loop Healthcare Triage Assistant

CareFlow AI is a multilingual, multimodal clinical triage web application designed to help hospitals and clinics capture unstructured patient inputs (text, voice recordings, and medical report images) and convert them into prioritized, source-linked summaries for healthcare professionals.

## Key Features
- **Multimodal & Multilingual Intake**: Accepts English, Hindi, Hinglish, and regional Indian languages via typed descriptions, WebRTC voice recordings, and uploaded medical reports (OCR).
- **ESI v4 Triage (Emergency Severity Index)**: Triage levels follow the AHRQ ESI v4 algorithm, applied deterministically by `esi-engine.js` (shared by the server and the browser). The AI never picks the level: Stage 1 reads typed text, voice and report images in any language (English, Hindi, Hinglish, regional, badly written or spoken), and Stage 2 answers the structured ESI questions (A: life-saving intervention, B: high-risk / confused / severe pain, C: expected resources, D: danger-zone vitals). The engine then maps **ESI 1-2 → CRITICAL, ESI 3 → URGENT, ESI 4-5 → ROUTINE**. Each case stores `triage.esiLevel`, `triage.priority` (tier) and `triage.esi` (decision point + rationale) for audit. Same logic is used at intake and when the patient replies in the doctor chat (re-triage).
- **Safety-First Non-Diagnostic AI Triage**: Uses a two-stage Gemini pipeline (`/api/gemini`) with an automatic client-side safety fallback. Identifies red-flag warning signs, missing clinical context, conflicting data across sources, and transcription/OCR uncertainty without diagnosing diseases.
- **Source Attribution Links**: Every extracted symptom, vital sign, or lab finding is linked back to its source (Patient Text, Voice Recording, or Medical Report OCR).
- **Browser Cookie Sessions & Personalized Dashboards**:
  - **Patients**: Greeted by name, with all submitted cases automatically synced and grouped by **Clinic Code**.
  - **Doctors**: Greeted by name, with instant clinic switching and filtering across **14 hospital departments**.
- **Case-Scoped Doctor–Patient Chat with Dynamic AI Re-Triage**:
  - Doctors can update patients, suggest medicines, or insert AI-suggested follow-up questions with one click.
  - Patients reply under that specific case thread. Each patient reply is analyzed by AI to update the clinical chat summary and dynamically escalate or de-escalate the case priority.
- **Reddit-Style Queue Ordering (`▲` / `▼`) with Downgrade Confirmation**:
  - Doctors can move cases higher or lower in priority order using upvote/downvote arrows.
  - Attempting to move a `CRITICAL` case below an `URGENT` or `ROUTINE` case triggers a mandatory confirmation modal before reclassifying its priority tier.
- **Full Case Lifecycle & Paramedic Dispatch**:
  - **Close / Dissolve**: Doctors can request the patient to confirm recovery and close the case, or dissolve it directly.
  - **Purge**: Both patients (consent withdrawal) and doctors can permanently purge records from Firebase.
  - **Emergency Paramedic Dispatch**: Doctors can mark critical cases (such as chest pain with breathlessness) as an **Emergency**, forwarding a structured clinical packet to the hospital Paramedic Team.
- **Audit Trail**: Every AI action and human clinician override is logged with timestamps on each case.

## Deployment Instructions (GitHub + Vercel)
1. Push all files to your GitHub repository (ensuring `gemini.js` is inside the `api/` directory: `api/gemini.js`).
2. Import the repository into **Vercel**.
3. In Vercel Project Settings → **Environment Variables**, add:
   - `GEMINI_API_KEY` = `your_google_gemini_api_key`
4. Deploy!

## Assumptions & Limitations
- **Decision support only.** CareFlow AI never diagnoses; a qualified clinician makes every final decision.
- **Demo data.** Use synthetic or anonymised data only. This prototype is not certified for real patient records.
- **Red-flag keywords are a starter set** (English, Hindi, Hinglish) and must be reviewed by a clinician before real use. They act as an ESI safety net that can only RAISE the ESI level. Matching is deliberately not negation-aware ("no chest pain" still flags), so it errs toward over-triage; doctors can override.
- **ESI level changes**: the AI can raise the ESI level automatically; lowering it (via patient chat) needs doctor confirmation. Doctors can set any ESI level 1-5 from the card; lowering a CRITICAL case asks for confirmation.
- **ESI v4 is a nurse-assessed tool.** CareFlow applies it to patient-reported information only (no measured vitals unless the patient/report states them). Danger-zone vitals automatically up-triage ESI 3 → ESI 2 (the handbook says "consider"); the clinician confirms. Read the ESI copyright notice in the AHRQ handbook before any real deployment.
- **Language accuracy** for Hindi, Hinglish and regional languages depends on the Gemini models and has not been benchmarked; uncertain transcription/translation is flagged for the doctor.
- **Emergency numbers** shown on the intake form are for India (112 national, 108 ambulance).
- **Voice notes** auto-stop at 120 seconds.
- **Voice notes** are stored in a separate database node so the doctor can play them back; they are deleted when a case is withdrawn or purged.
- **Patients never see the AI priority label.** It is shown to clinicians only.
- **Translation uncertainty** is flagged only when the AI reports it is genuinely unsure about a transcription or translation; the doctor can then check the original input beside the AI's reading.
- **Clinician sign-in** uses a 4-digit PIN. In this demo any 4-digit PIN is accepted. A registered-doctors check is built in (`doctor-auth.js`, set `DEMO_ACCEPT_ANY_PIN = false`): unregistered doctors or wrong PINs are then denied. This is a front-end demo gate, not real security; a live deployment must verify credentials on a server against the hospital's staff directory.
- **Follow-up questions are dynamic.** A suggested question the doctor uses moves to "awaiting reply"; when the patient answers, the AI proposes new questions from the reply (never repeating ones already asked) and the answered ones are kept in a history. Suggestions are for the clinician only; the clinician decides what to ask.
