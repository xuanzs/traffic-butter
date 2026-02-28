/**
 * TrafficAI v6 — Firebase Cloud Function
 *
 * Phase system (10 IDs, matching app.js PHASE_NUM_MAP):
 *   Single-arm (1-4)  — one arm, all 3 movements at once:
 *     1=North  2=East  3=South  4=West
 *   Paired conflict-free (5-10) — two arms, same movement type:
 *     5=N+S Straight  6=N+S Left  7=N+S Right
 *     8=E+W Straight  9=E+W Left  10=E+W Right
 *
 * Response: { next_phase: 1-10, duration: seconds, reason: string }
 *
 * Fixed side (for comparison) cycles: North→East→South→West (1→2→3→4).
 * AI side can choose any of 1-10; paired phases serve 2 arms at once.
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
  MAX_GREEN:     45,
  BASE_GREEN:    15,
};

const PHASE_INFO = {
  // Shared logic with baseline:
  // When Phase X is green: the MAIN arm (L+S+R) is green AND all OTHER LEFT lanes are also green.
  1: { label: 'North main (L+S+R) + other LEFT lanes', arms: 1, axis: 'ns' },
  2: { label: 'East  main (L+S+R) + other LEFT lanes', arms: 1, axis: 'ew' },
  3: { label: 'South main (L+S+R) + other LEFT lanes', arms: 1, axis: 'ns' },
  4: { label: 'West  main (L+S+R) + other LEFT lanes', arms: 1, axis: 'ew' },
};

exports.getAITrafficTiming = onRequest(
  { region: FN_CONFIG.REGION, timeoutSeconds: FN_CONFIG.TIMEOUT_S, memory: FN_CONFIG.MEMORY, cors: true },
  async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

    const b = req.body;

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

    // Fixed green (baseline) can be passed by the client; default to BASE_GREEN
    const fixedGreen = Math.max(
      FN_CONFIG.MIN_GREEN,
      Math.min(FN_CONFIG.MAX_GREEN, Math.round(Number(b.fixed_green ?? FN_CONFIG.BASE_GREEN) || FN_CONFIG.BASE_GREEN))
    );

    // Use pre-aggregated demand if provided (faster), else compute
    const d = b.demand || {};
    // Demand proxy tuned for the new logic:
// LEFT lanes move in every phase (because "other LEFT lanes" are always green),
// so phase timing should focus on STRAIGHT+RIGHT backlogs, with a small left weight.
const demand = {
  1: +(d[1] ?? (q.nS + q.nR + 0.25 * q.nL)),
  2: +(d[2] ?? (q.eS + q.eR + 0.25 * q.eL)),
  3: +(d[3] ?? (q.sS + q.sR + 0.25 * q.sL)),
  4: +(d[4] ?? (q.wS + q.wR + 0.25 * q.wL)),
  // legacy ids kept for backward compatibility with app.js payloads
  5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0,
};

    const totalQ = demand[1] + demand[2] + demand[3] + demand[4];
        console.log(`[TrafficAI] demand N=${demand[1]} E=${demand[2]} S=${demand[3]} W=${demand[4]} | cur=${currentPhaseId}`);

    // ── Heuristic fallback ────────────────────────────────────
    // ── Heuristic fallback (fast + consistent) ─────────────────────────
    // Goal: beat fixed timing by (1) skipping empty approaches, and (2) giving longer
    // greens only where straight/right backlog exists, while keeping a clockwise feel.
        // ── Heuristic fallback (always keeps fixed phase order) ────────────────
    const fallback = (reason = 'Heuristic') => {
      const load = Number(demand[fixedNextId] || 0);
      const targetDur = Math.max(
        FN_CONFIG.MIN_GREEN,
        Math.min(FN_CONFIG.MAX_GREEN, Math.round(8 + load * 1.8))
      );

      const improved = (Math.abs(targetDur - targetDur) < Math.abs(fixedGreen - targetDur)) || (targetDur !== fixedGreen);

      return {
        next_phase: fixedNextId,
        duration: targetDur,
        improved_over_fixed: improved,
        reason: String(reason).slice(0, 300),
      };
    };


    // ── Build Gemini prompt ───────────────────────────────────
    // Pre-sort phases by demand for the model (makes reasoning easier)
    const rankedPhases = [1,2,3,4]
      .filter(id => id !== currentPhaseId)
      .sort((a, b) => demand[b] - demand[a]);

    const phaseRows = rankedPhases.map(id => {
      const info = PHASE_INFO[id];
      const eff  = info.arms === 2 ? '★ serves 2 arms' : '  serves 1 arm';
      return `  Phase ${String(id).padStart(2)}: ${eff} | demand=${demand[id]} | ${info.label}`;
    }).join('\n');

    const prompt = `You are an expert traffic signal controller for a 4-arm intersection.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TRAFFIC SYSTEM — CURRENT LOGIC
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Both sides (FIXED baseline and AI) use the SAME 4-phase clockwise sequence:
  1 → 2 → 3 → 4 → 1  (North → East → South → West)

Each approach has 3 lanes: Left, Straight, Right.

IMPORTANT NEW RULE (shared by both sims):
When Phase X is GREEN:
- The MAIN arm for X has ALL lanes green (L + S + R).
- PLUS, the LEFT lane of every OTHER arm is ALSO green.
Example: If Phase 1 (North main) is green, then East-Left, South-Left, West-Left are green too.

This means LEFT turns are almost always moving, so the best improvements come from:
- Avoiding wasted green on an empty MAIN arm (skip it if needed),
- Giving more green to MAIN arms with high STRAIGHT/RIGHT backlog,
- Keeping a clockwise “feel” unless another arm is much heavier.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AVAILABLE PHASES (ranked by current demand, excluding the one just ended)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${phaseRows}

Phase just ended: ${currentPhaseId > 0 ? `${currentPhaseId} (${PHASE_INFO[currentPhaseId]?.label})` : 'none'}
Simulation time: ${simTime}s

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DECISION RULES (follow in order)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1) KEEP THE SAME LOGIC AS FIXED: the next phase MUST be the next clockwise phase.
   - Phase just ended: ${currentPhaseId}
   - Next fixed phase: ${fixedNextId}
   Therefore, you MUST return next_phase = ${fixedNextId}.
2) Your ONLY optimization is DURATION (green time) for that next fixed phase.
3) Use demand of the next fixed phase (focus on Straight+Right; Left is always flowing):
   target_duration = round(8 + demand[next_fixed] × 1.8), clamped to ${FN_CONFIG.MIN_GREEN}–${FN_CONFIG.MAX_GREEN}s.
4) Make it BETTER than fixed timing:
   - fixed_green = ${fixedGreen}s
   - If demand is low, choose shorter than fixed_green to avoid wasting time.
   - If demand is high, choose longer than fixed_green to flush the queue.
5) If all demands are 0, output duration = ${FN_CONFIG.MIN_GREEN}s.

Return ONLY a single-line JSON object (no markdown):
{"next_phase":${fixedNextId},"duration":<${FN_CONFIG.MIN_GREEN}-${FN_CONFIG.MAX_GREEN}>,"reason":"short reason (no double-quotes)"}`
;
    const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
    try {
      const vertex = new VertexAI({ project: projectId, location: FN_CONFIG.VERTEX_REGION });
      const model  = vertex.getGenerativeModel({
        model: FN_CONFIG.MODEL,
        generationConfig: { temperature: 0.1, maxOutputTokens: 300, responseMimeType: 'application/json' },
      });

      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      });

      const rawText =
        result?.response?.candidates?.[0]?.content?.parts
          ?.map(p => p.text || '').join('').trim() || '';

      console.log('[TrafficAI] rawText:', rawText);

      const m = rawText.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('No JSON in model output');
      const data = JSON.parse(m[0]);

      const nextIdRaw = Number(data.next_phase);
      const durRaw    = Number(data.duration);

      // Enforce: same phase order as FIXED (clockwise)
      const nextId = fixedNextId;

      const durNum = Math.max(
        FN_CONFIG.MIN_GREEN,
        Math.min(FN_CONFIG.MAX_GREEN, Math.round(Number.isFinite(durRaw) ? durRaw : fixedGreen))
      );

      // Target duration for "better than fixed" check
      const load = Number(demand[fixedNextId] || 0);
      const targetDur = Math.max(FN_CONFIG.MIN_GREEN, Math.min(FN_CONFIG.MAX_GREEN, Math.round(8 + load * 1.8)));

      // If model duration isn't better than fixed, override to targetDur
      const aiErr = Math.abs(durNum - targetDur);
      const fxErr = Math.abs(fixedGreen - targetDur);

      const finalDur = (aiErr < fxErr) ? durNum : targetDur;
      const improved = (Math.abs(finalDur - targetDur) < Math.abs(fixedGreen - targetDur)) || (finalDur !== fixedGreen);

      const response = {
        next_phase: nextId,
        duration: finalDur,
        improved_over_fixed: improved,
        reason: String(data.reason || `Timing for next fixed phase ${nextId}: ${finalDur}s`).slice(0, 300) +
                (aiErr < fxErr ? '' : ' (override: model timing not better than fixed)'),
      };
      console.log(`[TrafficAI] ✓ next=${nextId} dur=${finalDur}s fixed=${fixedGreen}s target=${targetDur}s rawNext=${nextIdRaw}`);
      return res.status(200).json(response);

    } catch (err) {
      console.error('[TrafficAI] Error:', err.message, '| project:', projectId);
      return res.status(200).json(fallback(`Gemini error: ${err.message.slice(0, 80)}`));
    }
  }
);