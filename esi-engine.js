/*
 * CareFlow AI — Emergency Severity Index (ESI) v4 triage engine
 * -------------------------------------------------------------
 * Reference: "Emergency Severity Index (ESI): A Triage Tool for Emergency Department Care,
 * Version 4, Implementation Handbook" (AHRQ Publication No. 12-0014, 2012 Edition).
 *
 * DESIGN
 *  - The AI (Gemini) never picks the triage level. It only reads the patient's input (typed text,
 *    voice, report OCR, in ANY language incl. Hinglish) and answers the structured ESI questions
 *    (decision points A, B, C, D) as facts + evidence quotes.
 *  - THIS file applies the ESI algorithm deterministically to those answers and produces the level.
 *  - A multilingual keyword safety net can only RAISE acuity, never lower it.
 *
 * ESI level -> CareFlow tier (used by every dashboard / queue / filter):
 *     ESI 1, ESI 2  -> CRITICAL
 *     ESI 3         -> URGENT
 *     ESI 4, ESI 5  -> ROUTINE
 *
 * Works in the browser (window.CareflowESI) and in Node/Vercel (import / require).
 * Decision support only: a qualified clinician makes every final decision.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.CareflowESI = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var STANDARD = 'ESI v4 (AHRQ 2012)';

    var LEVELS = {
        1: { label: 'Resuscitation', tier: 'CRITICAL', meaning: 'Requires immediate life-saving intervention' },
        2: { label: 'Emergent', tier: 'CRITICAL', meaning: 'High-risk situation, confused/lethargic/disoriented, or severe pain/distress' },
        3: { label: 'Urgent', tier: 'URGENT', meaning: 'Stable, expected to need two or more resources' },
        4: { label: 'Less Urgent', tier: 'ROUTINE', meaning: 'Expected to need one resource' },
        5: { label: 'Non-Urgent', tier: 'ROUTINE', meaning: 'Expected to need no resources' }
    };

    function clampLevel(n) {
        n = Math.round(Number(n));
        if (!isFinite(n)) return null;
        return Math.min(5, Math.max(1, n));
    }

    function tierForLevel(level) {
        var l = clampLevel(level);
        return l ? LEVELS[l].tier : 'ROUTINE';
    }

    // Legacy cases (saved before ESI) only have a tier. Map to a representative level for display/sorting.
    function levelForTier(tier) {
        if (tier === 'CRITICAL') return 2;
        if (tier === 'URGENT') return 3;
        return 5;
    }

    // Level of a stored case. Uses triage.esiLevel when present, else derives from the legacy tier.
    function levelOfCase(triage) {
        var t = triage || {};
        var l = clampLevel(t.esiLevel);
        if (l) return l;
        return levelForTier(t.priority || 'ROUTINE');
    }

    // Queue score: ESI 1 highest. Manual doctor reorder offsets (+/- small integers) are added on top.
    function scoreForLevel(level) {
        var l = clampLevel(level) || 5;
        return (6 - l) * 100;
    }

    function levelDisplay(level) {
        var l = clampLevel(level);
        return l ? ('ESI ' + l + ' · ' + LEVELS[l].label) : '';
    }

    // ------------------------------------------------------------------------------------------
    // Decision point C — resources (handbook Table 2-? / Figure 2-1a)
    //   Resources: labs (blood, urine) | ECG | X-rays | CT-MRI-ultrasound-angiography |
    //              IV fluids (hydration) | IV, IM or nebulized medications | specialty consultation |
    //              simple procedure (=1) | complex procedure (=2)
    //   NOT resources: history & physical, point-of-care testing, saline/heplock, PO medications,
    //              tetanus, prescription refills, phone call to PCP, simple wound care,
    //              crutches/splints/slings.
    //   Count the number of DIFFERENT TYPES, not individual tests (CBC + electrolytes = 1).
    // ------------------------------------------------------------------------------------------
    var RESOURCE_WEIGHT = {
        labs: 1,
        ecg: 1,
        xray: 1,
        ct_mri_us: 1,
        iv_fluids: 1,
        iv_im_neb_meds: 1,
        specialty_consult: 1,
        simple_procedure: 1,
        complex_procedure: 2
    };

    var RESOURCE_LABEL = {
        labs: 'Labs (blood/urine)',
        ecg: 'ECG',
        xray: 'X-ray',
        ct_mri_us: 'CT / MRI / Ultrasound / Angiography',
        iv_fluids: 'IV fluids',
        iv_im_neb_meds: 'IV / IM / nebulized medication',
        specialty_consult: 'Specialty consultation',
        simple_procedure: 'Simple procedure (e.g. laceration repair, Foley)',
        complex_procedure: 'Complex procedure (e.g. conscious sedation)'
    };

    function normalizeResourceKey(raw) {
        var s = String(raw || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        if (RESOURCE_WEIGHT.hasOwnProperty(s)) return s;
        if (/lab|blood|urine|cbc|culture|electrolyte|coag|troponin|urinalysis/.test(s)) return 'labs';
        if (/ecg|ekg|electrocardio/.test(s)) return 'ecg';
        if (/ct|mri|ultrasound|usg|sonograph|angiograph|doppler|echo/.test(s)) return 'ct_mri_us';
        if (/x_?ray|radiograph|xray|plain_film|chest_film/.test(s)) return 'xray';
        if (/iv_?fluid|hydration|saline_bolus|fluid_resus/.test(s)) return 'iv_fluids';
        if (/iv|im_|intramuscular|intravenous|nebul|injection/.test(s)) return 'iv_im_neb_meds';
        if (/consult|specialist|referral_to/.test(s)) return 'specialty_consult';
        if (/complex|sedation/.test(s)) return 'complex_procedure';
        if (/procedure|suture|lac|foley|catheter|splint_reduction|incision/.test(s)) return 'simple_procedure';
        return null;
    }

    // Returns { count, categories:[{category,label,reason,weight}] }. Duplicate categories count once.
    function countResources(list) {
        var seen = {};
        var cats = [];
        (Array.isArray(list) ? list : []).forEach(function (item) {
            var key = normalizeResourceKey(item && typeof item === 'object' ? (item.category || item.type || item.name) : item);
            if (!key || seen[key]) return;
            seen[key] = true;
            cats.push({
                category: key,
                label: RESOURCE_LABEL[key],
                reason: (item && typeof item === 'object' && item.reason) ? String(item.reason).slice(0, 200) : '',
                weight: RESOURCE_WEIGHT[key]
            });
        });
        var count = cats.reduce(function (n, c) { return n + c.weight; }, 0);
        return { count: count, categories: cats };
    }

    // ------------------------------------------------------------------------------------------
    // Decision point D — danger-zone vital signs (handbook Figure 5-1 / 5-2)
    //   <3 months: HR>180 RR>50 | 3 mo-3 y: HR>160 RR>40 | 3-8 y: HR>140 RR>30 | >8 y: HR>100 RR>20
    //   SaO2 < 92% at any age.
    //   Pediatric fever: 1-28 days >38.0C => at least ESI 2; 1-3 months >38.0C => consider ESI 2;
    //   3-36 months >39.0C => consider ESI 3.
    //   Only evaluated for patients who would otherwise be ESI 3 (two or more resources).
    // ------------------------------------------------------------------------------------------
    function num(v) {
        if (v === null || v === undefined || v === '') return null;
        var n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
        return isFinite(n) ? n : null;
    }

    function ageInMonths(ctx) {
        var m = num(ctx && ctx.ageMonths);
        if (m !== null) return m;
        var y = num(ctx && ctx.ageYears);
        return y === null ? null : y * 12;
    }

    function dangerZoneCheck(vitals, ctx) {
        var v = vitals || {};
        var months = ageInMonths(ctx);
        var hr = num(v.heartRate), rr = num(v.respiratoryRate), spo2 = num(v.spo2), tempC = num(v.temperatureC);
        var details = [];
        var hrLimit = 100, rrLimit = 20;
        if (months !== null) {
            if (months < 3) { hrLimit = 180; rrLimit = 50; }
            else if (months < 36) { hrLimit = 160; rrLimit = 40; }
            else if (months < 96) { hrLimit = 140; rrLimit = 30; }
        }
        if (hr !== null && hr > hrLimit) details.push('Heart rate ' + hr + ' > ' + hrLimit);
        if (rr !== null && rr > rrLimit) details.push('Respiratory rate ' + rr + ' > ' + rrLimit);
        if (spo2 !== null && spo2 < 92) details.push('SpO2 ' + spo2 + '% < 92%');

        var feverLevel = null;
        if (tempC !== null && months !== null) {
            if (months < 1 && tempC > 38.0) {
                feverLevel = 2;
                details.push('Neonate (<=28 days) with temperature ' + tempC + 'C > 38.0C (ESI: at least level 2)');
            } else if (months < 3 && tempC > 38.0) {
                feverLevel = 2;
                details.push('Infant 1-3 months with temperature ' + tempC + 'C > 38.0C (ESI: consider level 2)');
            } else if (months < 36 && tempC > 39.0) {
                feverLevel = 3;
                details.push('Child 3-36 months with temperature ' + tempC + 'C > 39.0C (ESI: consider level 3)');
            }
        }
        return {
            exceeded: details.length > 0,
            details: details,
            vitalSignExceeded: details.some(function (d) { return !/temperature/.test(d); }),
            feverLevel: feverLevel
        };
    }

    // ------------------------------------------------------------------------------------------
    // Vital-sign parsing from free text (English / Hinglish numerals) — used only as a backup when
    // the AI did not return numeric vitals, and by the offline fallback.
    // ------------------------------------------------------------------------------------------
    function parseVitalsFromText(text) {
        var t = String(text || '').toLowerCase();
        var out = { heartRate: null, respiratoryRate: null, spo2: null, temperatureC: null };
        var m;
        m = t.match(/(?:spo2|sp02|spo₂|saturation|o2 sat|oxygen(?: level| saturation)?|ऑक्सीजन)\D{0,8}(\d{2,3})/);
        if (m) out.spo2 = Number(m[1]);
        m = t.match(/(?:heart ?rate|pulse|dhadkan|heart ?beat|धड़कन|नाड़ी|नब्ज़)\D{0,8}(\d{2,3})/);
        if (m) out.heartRate = Number(m[1]);
        m = t.match(/(?:respiratory rate|resp(?:iration)? rate|breathing rate|\brr\b)\D{0,6}(\d{1,2})/);
        if (m) out.respiratoryRate = Number(m[1]);
        m = t.match(/(\d{2,3}(?:\.\d)?)\s*(?:°|º|˚|degrees?|deg)?\s*(f|c|fahrenheit|celsius)\b/);
        if (m) {
            var val = Number(m[1]);
            var unit = m[2].charAt(0);
            if (unit === 'f' && val >= 90 && val <= 110) out.temperatureC = Math.round(((val - 32) * 5 / 9) * 10) / 10;
            else if (unit === 'c' && val >= 34 && val <= 43) out.temperatureC = val;
        }
        return out;
    }

    // ------------------------------------------------------------------------------------------
    // Multilingual keyword SAFETY NET (English, Hindi in Devanagari, Hinglish / Roman Hindi).
    // Can only RAISE acuity. Deliberately not negation-aware (errs toward over-triage); the
    // clinician can always override. This list is a starter set and must be clinically reviewed.
    // ------------------------------------------------------------------------------------------
    var FLOOR_RULES = [
        // ---- ESI 1: A. immediate life-saving intervention / unresponsive / apneic / pulseless ----
        { level: 1, reason: 'Unresponsive / unconscious (ESI decision point A)',
          re: /unresponsive|unconscious|not responding|won'?t wake|not waking|passed out and (?:not|won)|behosh|behosh|besudh|hosh (?:nahi|nhi|me nahi)|बेहोश|बेसुध|होश नहीं|होश में नहीं/ },
        { level: 1, reason: 'Not breathing / apnea / choking (ESI decision point A)',
          re: /not breathing|stopped breathing|no pulse|pulseless|cardiac arrest|choking|saans (?:band|nahi chal|ruk)|saans nahi le|सांस (?:बंद|रुक)|सांस नहीं ले|साँस (?:बंद|रुक)|दम घुट|dam ghut/ },
        { level: 1, reason: 'Severe respiratory distress (ESI decision point A)',
          re: /severe (?:breathing|respiratory)|gasping|cannot breathe|can'?t breathe|unable to breathe|turning blue|blue lips|saans nahi aa rahi|सांस नहीं आ रही|साँस नहीं आ रही/ },

        // ---- ESI 2: B. high-risk situation / confused-lethargic / severe distress ----
        { level: 2, reason: 'Chest pain / pressure (high-risk situation, ESI decision point B)',
          re: /chest (?:pain|tightness|pressure|heaviness)|pain in (?:my )?chest|seene? (?:me|mein|mai) (?:dard|bharipan|bhaaripan|jakdan|jalan)|sine (?:me|mein) (?:dard|bharipan)|chest (?:me|mein) (?:dard|bharipan|bhaaripan|jakdan)|dil (?:me|mein) dard|सीने (?:में|मे) (?:दर्द|भारीपन|जकड़न|जलन)|छाती (?:में|मे) (?:दर्द|भारीपन|जकड़न)/ },
        { level: 2, reason: 'Difficulty breathing / breathlessness (high-risk situation, ESI decision point B)',
          re: /breathless|short(?:ness)? of breath|difficulty (?:in )?breathing|trouble breathing|wheez|saans (?:phool|lene|ki takleef|me takleef|mein takleef|mein dikkat|me dikkat|lene me)|सांस (?:फूल|लेने)|साँस (?:फूल|लेने)|सांस की तकलीफ|साँस की तकलीफ/ },
        { level: 2, reason: 'Stroke warning signs (high-risk situation, ESI decision point B)',
          re: /stroke|slurred|slurring|facial droop|face (?:is )?droop|face drooping|paraly|one[- ]sided weakness|weakness on one side|sudden (?:numbness|weakness)|mooh tedha|munh tedha|muh tedha|lakwa|lakva|zubaan (?:lad|ladkhada)|bol nahi pa|bolne me dikkat|ek taraf (?:se )?kamzor|लकवा|मुंह टेढ़ा|मुँह टेढ़ा|ज़ुबान लड़खड़|जुबान लड़खड़|बोल नहीं पा/ },
        { level: 2, reason: 'Seizure / convulsion (high-risk situation, ESI decision point B)',
          re: /seizure|convuls|fits\b|daura|dora aaya|mirgi|jhatke|दौरा|मिर्गी|झटके/ },
        { level: 2, reason: 'Severe bleeding / vomiting or coughing blood (high-risk situation, ESI decision point B)',
          re: /heavy bleeding|severe bleeding|bleeding (?:a lot|heavily|won'?t stop|not stopping)|vomiting blood|vomit(?:ing)? (?:of )?blood|coughing (?:up )?blood|blood in (?:vomit|stool)|khoon (?:ki ulti|ki ulti|aa raha|nahi ruk)|ulti (?:me|mein) khoon|खून की उल्टी|उल्टी में खून|खून नहीं रुक|खून बह रहा/ },
        { level: 2, reason: 'Suicidal thoughts / self-harm (high-risk situation, ESI decision point B)',
          re: /suicid|kill (?:my|him|her)self|want to die|end my life|jaan (?:de|dena)|marna chah|khud ko (?:khatam|maar)|aatmahatya|aatm ?hatya|आत्महत्या|जान दे|मरना चाह|खुद को (?:खत्म|मार)/ },
        { level: 2, reason: 'Overdose / poisoning (high-risk situation, ESI decision point B)',
          re: /overdose|poison|zeher|jahar|ingested|swallowed (?:pills|tablets|chemical|kerosene|phenyl)|ज़हर|जहर|ओवरडोज़|ओवरडोज/ },
        { level: 2, reason: 'Severe allergic reaction / anaphylaxis (high-risk situation, ESI decision point B)',
          re: /anaphyla|throat (?:swelling|closing)|swelling of (?:face|tongue|lips)|face swelling|tongue swelling/ },
        { level: 2, reason: 'Fainting / collapse (high-risk situation, ESI decision point B)',
          re: /fainted|fainting|syncope|collapsed|blacked out|chakkar aa(?:kar|ke) gir|चक्कर आकर|गिर पड़/ },
        { level: 2, reason: 'Confusion / altered mental status (ESI decision point B)',
          re: /disoriented|lethargic|not making sense|hallucinat|behaving strangely|ulta seedha bol|behki behki|भ्रमित/ },

        // ---- Conservative safety net (NOT an ESI rule): high fever alone is held at least at ESI 3 ----
        { level: 3, reason: 'High fever reported (conservative safety net; workup usually needs 2+ resources)',
          re: /high fever|tez bukhar|bahut (?:tez )?bukhar|तेज़ बुखार|तेज बुखार|बहुत बुखार/ }
    ];

    function keywordFloor(text, vitals, ctx) {
        var corpus = String(text || '').toLowerCase();
        var best = null;
        var reasons = [];
        FLOOR_RULES.forEach(function (rule) {
            if (rule.re.test(corpus)) {
                reasons.push(rule.reason);
                if (best === null || rule.level < best) best = rule.level;
            }
        });
        var v = vitals || parseVitalsFromText(corpus);
        var spo2 = num(v.spo2);
        if (spo2 !== null && spo2 < 90) {
            reasons.push('SpO2 ' + spo2 + '% < 90% (ESI decision point A)');
            best = 1;
        }
        var tempC = num(v.temperatureC);
        if (tempC !== null && tempC >= 38.9 && (best === null || best > 3)) {
            reasons.push('Temperature ' + tempC + 'C >= 38.9C (conservative safety net; ESI 3 minimum)');
            best = 3;
        }
        // Pediatric fever rules (ESI Table 5-1) also work as floors when the age is known.
        var d = dangerZoneCheck({ temperatureC: tempC }, ctx);
        if (d.feverLevel !== null && (best === null || d.feverLevel < best)) {
            reasons.push(d.details.filter(function (x) { return /temperature/.test(x); }).join('; '));
            best = d.feverLevel;
        }
        return { level: best, reasons: reasons };
    }

    // ------------------------------------------------------------------------------------------
    // The ESI algorithm itself.
    //   assessment = {
    //     pointA: { needsImmediateLifeSavingIntervention, criteriaMet[], evidence },
    //     pointB: { highRiskSituation, confusedLethargicDisoriented, severePainOrDistress, painScore,
    //               criteriaMet[], evidence },
    //     pointC: { resources: [ { category, reason } ] },
    //     pointD: { heartRate, respiratoryRate, spo2, temperatureC, ageMonths }
    //   }
    //   ctx = { ageYears, ageMonths, text }   (text = all patient-originated text, for the safety net)
    // ------------------------------------------------------------------------------------------
    function truthy(v) { return v === true || v === 'true' || v === 'yes' || v === 'Yes'; }

    function evaluate(assessment, ctx) {
        ctx = ctx || {};
        var a = assessment && typeof assessment === 'object' ? assessment : null;
        // No structured answers from the AI -> never default to a low level; use the cautious fallback.
        if (!a) return fallbackTriage(ctx);
        var pA = (a && a.pointA) || {};
        var pB = (a && a.pointB) || {};
        var pC = (a && a.pointC) || {};
        var pD = (a && a.pointD) || {};

        var rationale = [];
        var level = null;
        var decisionPoint = null;

        var painScore = num(pB.painScore);

        // A
        if (truthy(pA.needsImmediateLifeSavingIntervention)) {
            level = 1; decisionPoint = 'A';
            rationale.push('A: Immediate life-saving intervention / ESI-1 condition' +
                (Array.isArray(pA.criteriaMet) && pA.criteriaMet.length ? ' — ' + pA.criteriaMet.join('; ') : ''));
        }
        // B
        var bReasons = [];
        if (level === null) {
            if (truthy(pB.highRiskSituation)) bReasons.push('High-risk situation');
            if (truthy(pB.confusedLethargicDisoriented)) bReasons.push('Confused / lethargic / disoriented');
            if (truthy(pB.severePainOrDistress) || (painScore !== null && painScore >= 7)) {
                bReasons.push('Severe pain / distress' + (painScore !== null ? ' (' + painScore + '/10)' : ''));
            }
            if (bReasons.length) {
                level = 2; decisionPoint = 'B';
                rationale.push('B: ' + bReasons.join(', ') +
                    (Array.isArray(pB.criteriaMet) && pB.criteriaMet.length ? ' — ' + pB.criteriaMet.join('; ') : ''));
            }
        }

        // C
        var res = countResources(pC.resources);
        var dz = { exceeded: false, details: [], vitalSignExceeded: false, feverLevel: null };
        var vitals = {
            heartRate: num(pD.heartRate), respiratoryRate: num(pD.respiratoryRate),
            spo2: num(pD.spo2), temperatureC: num(pD.temperatureC)
        };
        var parsed = parseVitalsFromText(ctx.text);
        ['heartRate', 'respiratoryRate', 'spo2', 'temperatureC'].forEach(function (k) {
            if (vitals[k] === null && parsed[k] !== null) vitals[k] = parsed[k];
        });
        var dzCtx = { ageYears: ctx.ageYears, ageMonths: num(pD.ageMonths) !== null ? num(pD.ageMonths) : ctx.ageMonths };

        if (level === null) {
            if (res.count >= 2) {
                level = 3; decisionPoint = 'C';
                rationale.push('C: Expected to need ' + res.count + ' resources (' +
                    res.categories.map(function (c) { return c.label; }).join(', ') + ') → ESI 3');
                // D — only for ESI 3 candidates
                dz = dangerZoneCheck(vitals, dzCtx);
                if (dz.exceeded) {
                    level = 2; decisionPoint = 'D';
                    rationale.push('D: Danger-zone vital signs → up-triaged to ESI 2 — ' + dz.details.join('; ') +
                        ' (clinician to confirm)');
                }
            } else if (res.count === 1) {
                level = 4; decisionPoint = 'C';
                rationale.push('C: Expected to need 1 resource (' +
                    (res.categories[0] ? res.categories[0].label : 'unspecified') + ') → ESI 4');
            } else {
                level = 5; decisionPoint = 'C';
                rationale.push('C: No resources expected (history, exam, oral medication, advice only) → ESI 5');
            }
        }

        // Pediatric fever rules are always checked (they can lift ESI 4/5 as well; see Table 5-1)
        if (level >= 3) {
            var fz = dangerZoneCheck({ temperatureC: vitals.temperatureC }, dzCtx);
            if (fz.feverLevel !== null && fz.feverLevel < level) {
                level = fz.feverLevel; decisionPoint = 'D';
                rationale.push('D: Pediatric fever rule → ESI ' + fz.feverLevel + ' — ' + fz.details.join('; '));
                dz = { exceeded: true, details: (dz.details || []).concat(fz.details), vitalSignExceeded: dz.vitalSignExceeded, feverLevel: fz.feverLevel };
            }
        }

        // Safety net: can only raise acuity
        var floor = keywordFloor(ctx.text, vitals, dzCtx);
        var floorApplied = false;
        if (floor.level !== null && floor.level < level) {
            rationale.push('Safety net raised ESI ' + level + ' → ESI ' + floor.level + ': ' + floor.reasons.join('; '));
            level = floor.level;
            decisionPoint = decisionPoint + '*';
            floorApplied = true;
        }

        return {
            standard: STANDARD,
            level: level,
            tier: tierForLevel(level),
            label: LEVELS[level].label,
            decisionPoint: decisionPoint,
            rationale: rationale,
            resources: res,
            vitalsUsed: vitals,
            dangerZone: dz,
            safetyNet: { applied: floorApplied, reasons: floor.reasons },
            assessmentMissing: !a
        };
    }

    // ------------------------------------------------------------------------------------------
    // Offline / AI-unavailable fallback. No LLM -> resources cannot be predicted reliably, so the
    // keyword safety net decides ESI 1-3, and everything else is held at ESI 4 with a review flag.
    // ------------------------------------------------------------------------------------------
    var LIKELY_WORKUP_RE = /fever|bukhar|बुखार|vomit|ulti|उल्टी|fracture|infection|pain|dard|दर्द|dizz|chakkar|चक्कर|diarrh|loose motion|dast|दस्त|swelling|sujan|सूजन|rash|cough|khansi|खांसी|खाँसी/;

    function fallbackTriage(ctx) {
        ctx = ctx || {};
        var text = String(ctx.text || '');
        var t = text.toLowerCase();
        var floor = keywordFloor(t, null, ctx);
        var level, dp, why;
        if (floor.level !== null) {
            level = floor.level; dp = 'safety-net';
            why = 'Rule-based ESI safety net (AI unavailable): ' + floor.reasons.join('; ');
        } else if (LIKELY_WORKUP_RE.test(t)) {
            level = 3; dp = 'C(est.)';
            why = 'AI unavailable: complaint likely needs a workup (2+ resources) — held at ESI 3 pending clinician review';
        } else {
            level = 4; dp = 'C(est.)';
            why = 'AI unavailable: resources could not be predicted — held at ESI 4 pending clinician review';
        }
        if (ctx.hasMedia && level > 3) {
            level = 3; dp = 'media-unanalysed';
            why = 'AI unavailable and a voice note / report image was attached but NOT analysed — held at ESI 3 until a clinician reviews it';
        }
        return {
            standard: STANDARD,
            level: level,
            tier: tierForLevel(level),
            label: LEVELS[level].label,
            decisionPoint: dp,
            rationale: [why],
            resources: { count: 0, categories: [] },
            vitalsUsed: parseVitalsFromText(t),
            dangerZone: { exceeded: false, details: [], vitalSignExceeded: false, feverLevel: null },
            safetyNet: { applied: floor.level !== null, reasons: floor.reasons },
            assessmentMissing: true,
            fallback: true
        };
    }

    // Used by chat re-triage when the AI is unreachable: new patient text can only raise acuity.
    function chatFallback(currentLevel, text, ctx) {
        var floor = keywordFloor(text, null, ctx);
        var cur = clampLevel(currentLevel) || 5;
        var level = cur;
        var reason = 'Patient provided follow-up update.';
        if (floor.level !== null && floor.level < cur) {
            level = floor.level;
            reason = 'Rule-based ESI safety net on patient chat: ' + floor.reasons.join('; ');
        }
        return { level: level, tier: tierForLevel(level), reason: reason, reasons: floor.reasons };
    }

    return {
        STANDARD: STANDARD,
        LEVELS: LEVELS,
        RESOURCE_LABEL: RESOURCE_LABEL,
        tierForLevel: tierForLevel,
        levelForTier: levelForTier,
        levelOfCase: levelOfCase,
        scoreForLevel: scoreForLevel,
        levelDisplay: levelDisplay,
        clampLevel: clampLevel,
        countResources: countResources,
        dangerZoneCheck: dangerZoneCheck,
        parseVitalsFromText: parseVitalsFromText,
        keywordFloor: keywordFloor,
        evaluate: evaluate,
        fallbackTriage: fallbackTriage,
        chatFallback: chatFallback
    };
}));
