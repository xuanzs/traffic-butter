/**
 * TrafficAI v6 — Firebase Cloud Function (Hardened JSON)
 *
 * Key fixes vs original:
 *  - Prompt is strict JSON and no contradictory "reason without quotes".
 *  - Robust JSON extraction (handles extra text) + one retry if incomplete (e.g. rawText = "{").
 *  - Extra logs for finishReason to debug partial generations.
 */

const { onRequest } = require('firebase-functions/v2/https');
const { VertexAI }  = require('@google-cloud/vertexai');

const FN_CONFIG = {
  REGION:        'asia-southeast1',
  VERTEX_REGION: 'us-central1',
  MODEL:         'gemini-2.5-flash',
  TIMEOUT_S:     30,
  MEMORY:        '256MiB',
  MIN_GREEN:      5,
  MAX_GREEN:     15,
  BASE_GREEN:    15,
};

const PHASE_INFO = {
  1: { label: 'North main (L+S+R) + other LEFT lanes', arms: 1, axis: 'ns' },
  2: { label: 'East  main (L+S+R) + other LEFT lanes', arms: 1, axis: 'ew' },
  3: { label: 'South main (L+S+R) + other LEFT lanes', arms: 1, axis: 'ns' },
  4: { label: 'West  main (L+S+R) + other LEFT lanes', arms: 1, axis: 'ew' },
};

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function extractJsonObject(text) {
  if (!text) return null;
  const first = text.indexOf('{');
  const last  = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  const candidate = text.slice(first, last + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    // Try the original regex as a fallback
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
}

function buildPrompt({ phaseRows, currentPhaseId, simTime, fixedNextId, fixedGreen, minG, maxG }) {
  return `
  Return ONLY valid JSON:
  {"next_phase":1-4,"duration":5-15,"reason":"short"}
  No extra text.
  `;
}

exports.getAITrafficTiming = onRequest(
  { region: FN_CONFIG.REGION, timeoutSeconds: FN_CONFIG.TIMEOUT_S, memory: FN_CONFIG.MEMORY, cors: true },
  async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

    const b = req.body || {};

    // Accept both key formats: north_left (v6) and N_Left (legacy)
    const rv = (a, z) => +(b[a] ?? b[z] ?? 0);
    const q = {
      nL: rv('north_left',   'N_Left'),   nS: rv('north_straight', 'N_Straight'), nR: rv('north_right',  'N_Right'),
      sL: rv('south_left',   'S_Left'),   sS: rv('south_straight', 'S_Straight'), sR: rv('south_right',  'S_Right'),
      eL: rv('east_left',    'E_Left'),   eS: rv('east_straight',  'E_Straight'), eR: rv('east_right',   'E_Right'),
      wL: rv('west_left',    'W_Left'),   wS: rv('west_straight',  'W_Straight'), wR: rv('west_right',   'W_Right'),
    };

    const currentPhaseId = Number(b.current_phase_id || b.current_phase || b.ended_phase || 0);
    const simTime        = +b.sim_time || 0;

    // Fixed logic reference: next clockwise phase (1→2→3→4→1)
    const cw = [1, 2, 3, 4];
    const cur = cw.includes(currentPhaseId) ? currentPhaseId : 1;
    const fixedNextId = cw[(cw.indexOf(cur) + 1) % 4];

    const fixedGreen = clamp(
      Math.round(Number(b.fixed_green ?? FN_CONFIG.BASE_GREEN) || FN_CONFIG.BASE_GREEN),
      FN_CONFIG.MIN_GREEN,
      FN_CONFIG.MAX_GREEN
    );

    // Use pre-aggregated demand if provided, else compute
    const d = b.demand || {};
    const demand = {
      1: +(d[1] ?? (q.nS + q.nR + 0.25 * q.nL)),
      2: +(d[2] ?? (q.eS + q.eR + 0.25 * q.eL)),
      3: +(d[3] ?? (q.sS + q.sR + 0.25 * q.sL)),
      4: +(d[4] ?? (q.wS + q.wR + 0.25 * q.wL)),
      5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0,
    };

    console.log(`[TrafficAI] demand N=${demand[1]} E=${demand[2]} S=${demand[3]} W=${demand[4]} | cur=${currentPhaseId}`);

    const fallback = (reason = 'Heuristic') => {
      const load = Number(demand[fixedNextId] || 0);
      const targetDur = clamp(Math.round(8 + load * 1.8), FN_CONFIG.MIN_GREEN, FN_CONFIG.MAX_GREEN);
      return {
        next_phase: fixedNextId,
        duration: targetDur,
        improved_over_fixed: targetDur !== fixedGreen,
        reason: String(reason).slice(0, 300),
      };
    };

    const rankedPhases = [1, 2, 3, 4]
      .filter(id => id !== currentPhaseId)
      .sort((a, bb) => demand[bb] - demand[a]);

    const phaseRows = rankedPhases.map(id => {
      const info = PHASE_INFO[id];
      return `- Phase ${id}: demand=${demand[id]} | ${info?.label || ''}`;
    }).join('\n');

    const prompt = buildPrompt({
      phaseRows,
      currentPhaseId,
      simTime,
      fixedNextId,
      fixedGreen,
      minG: FN_CONFIG.MIN_GREEN,
      maxG: FN_CONFIG.MAX_GREEN,
    });

    const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;

    async function callGemini(textPrompt) {
      const vertex = new VertexAI({ project: projectId, location: FN_CONFIG.VERTEX_REGION });
      const model  = vertex.getGenerativeModel({
        model: FN_CONFIG.MODEL,
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 256,
          // responseMimeType: 'application/json',
        },
      });

      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: textPrompt }] }],
      });

      const cand = result?.response?.candidates?.[0];
      const finishReason = cand?.finishReason;
      const rawText = cand?.content?.parts?.map(p => p.text || '').join('').trim() || '';

      console.log('[TrafficAI] finishReason:', finishReason);
      console.log('[TrafficAI] rawText:', rawText);

      return { rawText, finishReason };
    }

    try {
      // 1) First attempt
      let { rawText } = await callGemini(prompt);
      let data = extractJsonObject(rawText);

      // 2) Retry once if incomplete/invalid JSON (e.g. rawText = "{")
      if (!data) {
        const retryPrompt =
        'Return ONLY this JSON object, no extra text:\n' +
        '{"next_phase":1,"duration":15,"reason":"short"}\n' +
        'Now output JSON only using the correct values.';
        const retry = await callGemini(retryPrompt);
        data = extractJsonObject(retry.rawText);
      }

      if (!data) {
        throw new Error('No valid JSON from model');
      }

      const durRaw = Number(data.duration);
      const durNum = clamp(Math.round(durRaw || fixedGreen), FN_CONFIG.MIN_GREEN, FN_CONFIG.MAX_GREEN);

      // Enforce clockwise next phase (fixed logic)
      const nextId = fixedNextId;

      const response = {
        next_phase: nextId,
        duration:   durNum,
        reason:     String(data.reason || `Gemini duration=${durNum}s`).replace(/[\r\n]+/g, ' ').slice(0, 300),
      };

      console.log(`[TrafficAI] ✓ Phase${nextId}(${PHASE_INFO[nextId]?.label || 'n/a'}) ${durNum}s`);
      return res.status(200).json(response);

    } catch (err) {
      console.error('[TrafficAI] Error:', err.message, '| project:', projectId);
      return res.status(200).json(fallback(`Gemini error: ${String(err.message).slice(0, 120)}`));
    }
  }
);
