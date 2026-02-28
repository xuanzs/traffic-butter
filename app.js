/**
 * TrafficAI v6 — app.js
 * ═══════════════════════════════════════════════════════════════
 *
 * ARCHITECTURE
 * ─────────────
 *  TrafficMaster  — seeded-LCG deterministic spawner.
 *                   Produces IDENTICAL event streams for both sims.
 *
 *  TrafficLight   — 4-phase protected signal controller.
 *                   green → yellow → all-red → next phase.
 *                   AI mode: calls Vertex AI at each phase-end.
 *
 *  Simulation     — independent physics per canvas.
 *
 *  SimManager     — orchestrates both sims, RAF loop, UI.
 *
 * SIGNAL PHASES  (mathematically conflict-free)
 * ───────────────────────────────────────────────
 *  Phase NS_SR : North+South Straight & Right  GREEN
 *  Phase NS_L  : North+South Left (protected)  GREEN
 *  Phase EW_SR : East+West  Straight & Right   GREEN
 *  Phase EW_L  : East+West  Left  (protected)  GREEN
 *
 *  Conflict proof:
 *   NS phases → EW always red (perpendicular blocked)
 *   SR phase  → left always red (oncoming left cross-traffic blocked)
 *   Right turns never conflict with same-axis straights (merge, no cross)
 *
 * LANE GEOMETRY  (strict, immutable at spawn)
 * ────────────────────────────────────────────
 *  Lane 0 (inner)  = LEFT  TURN ONLY
 *  Lane 1 (middle) = STRAIGHT ONLY
 *  Lane 2 (outer)  = RIGHT TURN ONLY
 *
 *  North arm x ∈ [MID-RH, MID]   (left side of vertical road)
 *  South arm x ∈ [MID,    MID+RH](right side)
 *  East  arm y ∈ [MID-RH, MID]   (top of horizontal road)
 *  West  arm y ∈ [MID,    MID+RH](bottom)
 *
 *  lane index 0 = innermost (closest to centre line)
 *
 * EXIT LANE CONVENTION
 * ─────────────────────
 *  right-turner → exits into exit-arm lane 0 (inner — tight turn)
 *  straight     → exits into exit-arm lane 1 (middle)
 *  left-turner  → exits into exit-arm lane 2 (outer — wide swing)
 *
 * VERTEX AI INTEGRATION
 * ──────────────────────
 *  Polled via Firebase Cloud Function at each phase end.
 *  Payload: 12 per-lane queue counts + context.
 *  Response: { next_phase, phase1..4 durations, reason }
 *  Falls back to silent proportional heuristic if unavailable.
 *
 * JAM DETECTION
 * ─────────────
 *  Any approach vehicle whose tail reaches within JAM_THRESHOLD px
 *  of the canvas edge triggers a jammed state for that arm.
 *  Jammed arms glow red on canvas; badge flashes in UI.
 * ═══════════════════════════════════════════════════════════════
 */
'use strict';

/* ═══════════════════════════════════════════════════════════════
   CONFIGURATION — all tunable values in one place
═══════════════════════════════════════════════════════════════ */
const CONFIG = {
  /* Canvas ──────────────────────────────────────────────────── */
  CANVAS_W:       520,   // px  (square canvas)

  /* Road geometry ───────────────────────────────────────────── */
  LANE_W:          20,   // px per lane
  N_LANES:          3,   // lanes per arm
  BOX_HALF:        56,   // intersection box half-size (px)

  /* Vehicles ─────────────────────────────────────────────────  */
  CAR_L:           17,   // car length along travel axis
  CAR_W:           10,   // car width
  CAR_GAP:          5,   // min bumper-to-bumper gap
  CAR_SPD:          1.6, // px/frame at 1× speed

  /* Signal timing (baseline) ────────────────────────────────── */
  FIXED_GREEN:     15,   // ← SWAP THIS to change baseline (seconds)
  YELLOW_DUR:       3,   // yellow clearance (seconds — 3 s safety buffer per spec)
  ALL_RED_DUR:      1,   // all-red between phases (seconds)

  /* Spawning ─────────────────────────────────────────────────  */
  AI_DECISION_INTERVAL: 10, // seconds between AI decisions (Right sim only)

  SPAWN_RATE:    0.004,  // prob per dir per lane per frame
  LCG_SEED:      1337,   // deterministic seed — same for both sims

  /* Jam detection ────────────────────────────────────────────  */
  JAM_THRESHOLD:   40,   // px from edge = jammed

  /* Vertex AI Cloud Function URL ─────────────────────────────  */
  CLOUD_FN_URL: 'https://getaitraffictiming-viz6ebtkda-as.a.run.app',
};

/* Derived */
const W   = CONFIG.CANVAS_W;
const MID = W / 2;                             // 260
const RH  = CONFIG.N_LANES * CONFIG.LANE_W;   // 60 — road half-width

/* Direction maps */
const OPP_D  = { north:'south', south:'north', east:'west',  west:'east'  };
const LEFT_D = { north:'west',  west:'south',  south:'east', east:'north' };
const RIGHT_D= { north:'east',  east:'south',  south:'west', west:'north' };

/* Lane → move (immutable) */
const LANE_MOVE = ['left', 'straight', 'right'];

/* ═══════════════════════════════════════════════════════════════
   PHASE SYSTEM — TWO STRATEGIES, ONE TRUTH TABLE
   ───────────────────────────────────────────────────────────────
   FIXED TIMING  (Baseline) — 4 phases, clockwise one-arm-at-a-time:
     Phase N : NORTH  Left + Straight + Right   GREEN   (all others RED)
     Phase E : EAST   Left + Straight + Right   GREEN   (all others RED)
     Phase S : SOUTH  Left + Straight + Right   GREEN   (all others RED)
     Phase W : WEST   Left + Straight + Right   GREEN   (all others RED)
   ─ Safe: only one arm moves. Simple, predictable, slow.

   AI TIMING (Vertex AI) — 10-phase toolkit (IDs 1-10):
     Single-arm (1-4): same as fixed, used when one arm is overloaded
       1=N  2=E  3=S  4=W
     Paired conflict-free (5-10): serve TWO arms simultaneously
       5=N+S Straight   6=N+S Left (protected)   7=N+S Right (protected)
       8=E+W Straight   9=E+W Left (protected)   10=E+W Right (protected)
   ─ Safe: paired phases are mathematically conflict-free (parallel axes).
   ─ Smart: paired phases clear ~2× more vehicles per green window.

   Conflict proof for paired phases:
     NS phases → EW always red   (perpendicular blocked)
     EW phases → NS always red   (perpendicular blocked)
     Straight lanes are parallel, never cross.
     Opposing protected lefts swing away from each other.
     Opposing protected rights merge into the same exit lane.

   Yellow buffer: 3 s between ALL phase transitions (spec requirement).
═══════════════════════════════════════════════════════════════ */
const PH = {
  /* ── Fixed-timing single-arm phases ── */
  N:    'n',      // North all (L+S+R)
  E:    'e',      // East  all (L+S+R)
  S:    's',      // South all (L+S+R)
  W:    'w',      // West  all (L+S+R)
  /* ── AI paired conflict-free phases ── */
  NS_S: 'ns_s',  // N+S Straight
  NS_L: 'ns_l',  // N+S Protected Left
  NS_R: 'ns_r',  // N+S Protected Right
  EW_S: 'ew_s',  // E+W Straight
  EW_L: 'ew_l',  // E+W Protected Left
  EW_R: 'ew_r',  // E+W Protected Right
};

/** Fixed timing: clockwise one-arm rotation N→E→S→W */
const FIXED_PHASE_SEQ = [ PH.N, PH.E, PH.S, PH.W ];

/** AI default sequence (overridden each cycle by Vertex AI) */
const AI_PHASE_SEQ = [ PH.NS_S, PH.NS_L, PH.NS_R, PH.EW_S, PH.EW_L, PH.EW_R ];

/** All valid phase keys (used for greenDur init + validation) */
const ALL_PHASES = [ PH.N, PH.E, PH.S, PH.W, PH.NS_S, PH.NS_L, PH.NS_R, PH.EW_S, PH.EW_L, PH.EW_R ];

const PHASE_LABEL = {
  [PH.N]:    '↑ North — All Lanes',
  [PH.E]:    '→ East — All Lanes',
  [PH.S]:    '↓ South — All Lanes',
  [PH.W]:    '← West — All Lanes',
  [PH.NS_S]: 'N+S Straight',
  [PH.NS_L]: 'N+S Protected Left',
  [PH.NS_R]: 'N+S Protected Right',
  [PH.EW_S]: 'E+W Straight',
  [PH.EW_L]: 'E+W Protected Left',
  [PH.EW_R]: 'E+W Protected Right',
};

/**
 * Numeric API IDs for Vertex AI (1-10):
 *   1-4  = single-arm phases  (N, E, S, W)
 *   5-10 = paired phases (parallel axes, serve 2 arms at once)
 */
const PHASE_NUM_MAP = {
  1: PH.N,   2: PH.E,   3: PH.S,   4: PH.W,
  5: PH.NS_S, 6: PH.NS_L, 7: PH.NS_R,
  8: PH.EW_S, 9: PH.EW_L, 10: PH.EW_R,
};

/**
 * phaseAllows(ph, dir, move) → true if the movement is GREEN.
 *
 * Single-arm phases: the entire named arm goes (all 3 lanes).
 * Paired phases: both arms on that axis share the same movement type.
 * All rules are mathematically conflict-free by construction.
 */
function phaseAllows(ph, dir, move) {
  // ── Single-arm: main arm ALL lanes green + ALL OTHER LEFT lanes green ─────
  // This matches the requested logic:
  //   Example: when North (L+S+R) is green, East-L, South-L, West-L are also green.
  if (ph === PH.N) return (dir === 'north') || (move === 'left' && dir !== 'north');
  if (ph === PH.E) return (dir === 'east')  || (move === 'left' && dir !== 'east');
  if (ph === PH.S) return (dir === 'south') || (move === 'left' && dir !== 'south');
  if (ph === PH.W) return (dir === 'west')  || (move === 'left' && dir !== 'west');

  // ── Paired: per-movement on one axis ───────────────────────
  const ns = dir === 'north' || dir === 'south';
  const ew = dir === 'east'  || dir === 'west';

  if (ph === PH.NS_S) return ns && move === 'straight';
  if (ph === PH.NS_L) return ns && move === 'left';
  if (ph === PH.NS_R) return ns && move === 'right';
  if (ph === PH.EW_S) return ew && move === 'straight';
  if (ph === PH.EW_L) return ew && move === 'left';
  if (ph === PH.EW_R) return ew && move === 'right';

  return false;
}

/* ═══════════════════════════════════════════════════════════════
   GEOMETRY — right-hand traffic rebuilt from first principles
   ───────────────────────────────────────────────────────────────
   */
function laneX(dir, lane) {
  if (dir === 'north') {
    // West side: lane0(L) outermost west, lane2(R) innermost (nearest MID)
    // off increases with lane: lane0→largest off→westmost; lane2→smallest off
    const off = (CONFIG.N_LANES - lane - 0.5) * CONFIG.LANE_W;
    return MID - off;  // all x < MID
  } else {
    // South: East side: lane0(L) outermost east, lane2(R) innermost (nearest MID)
    const off = (CONFIG.N_LANES - lane - 0.5) * CONFIG.LANE_W;
    return MID + off;  // all x > MID
  }
}

/** Approach lane Y for east/west arms. lane0=L=nearest centre, lane2=R=outermost */
// REPLACE your existing laneY with this (puts E/W traffic on the OPPOSITE half of the road)
function laneY(dir, lane) {
  const off = (CONFIG.N_LANES - lane - 0.5) * CONFIG.LANE_W;

  if (dir === 'east') {
    // Eastbound (→): use TOP half (y < MID)
    return MID - off;
  } else {
    // Westbound (←): use BOTTOM half (y > MID)
    return MID + off;
  }
}

function exitLaneX(dir, lane) {
  // IMPORTANT: normalize "global" exit lane (3..5) into local index (0..2)
  const i = lane >= CONFIG.N_LANES ? (lane - CONFIG.N_LANES) : lane; // 3→0,4→1,5→2
  const off = (i + 0.5) * CONFIG.LANE_W;

  // North exit is on EAST half (x > MID), South exit is on WEST half (x < MID)
  return dir === 'north' ? MID + off : MID - off;
}

function exitLaneY(dir, lane) {
  // normalize 3..5 -> 0..2
  const i = lane >= CONFIG.N_LANES ? (lane - CONFIG.N_LANES) : lane;
  const off = (i + 0.5) * CONFIG.LANE_W;

  // East exit is on NORTH half (y < MID), West exit is on SOUTH half (y > MID)
  return dir === 'east' ? MID - off : MID + off;
}

function spawnPos(dir, lane) {
  const far = W + 30;

  if (dir === 'north') return { x: laneX('north', lane), y: far };
  if (dir === 'south') return { x: laneX('south', lane), y: -30 };
  if (dir === 'east')  return { x: -30, y: laneY('east', lane) };
  return                      { x: far, y: laneY('west', lane) };
}

function stopCoord(dir) {
  const m = CONFIG.BOX_HALF + CONFIG.CAR_L * 0.5 + 3;
  if (dir === 'north') return { axis:'y', val: MID + m };
  if (dir === 'south') return { axis:'y', val: MID - m };
  if (dir === 'east')  return { axis:'x', val: MID - m };
  return                      { axis:'x', val: MID + m };
}

function pastStop(v) {
  // Use the FRONT bumper relative to movement direction, so cars never
  // creep into the intersection on red.
  const s = stopCoord(v.dir);
  const half = CONFIG.CAR_L * 0.5;

  if (v.dir === 'north') return (v.y - half) <= s.val;
  if (v.dir === 'south') return (v.y + half) >= s.val;
  if (v.dir === 'east')  return (v.x + half) >= s.val;
  return                        (v.x - half) <= s.val; // west
}
/* ═══════════════════════════════════════════════════════════════
   BÉZIER TURN PATHS
═══════════════════════════════════════════════════════════════ */
// Rule you want: if the car is in the L lane (turn-left), it should exit into the NEAREST lane
// on the exit road. In your numbering, that “nearest” exit lane is the 6th lane (i.e. exit-lane index 2).
function exitLaneFor(move) {
  if (move === 'left')     return 5;  // nearest exit lane (your “6th lane”)
  if (move === 'straight') return 3;  // middle exit lane (your “5th lane”)
  return 4;                            // remaining exit lane (your “4th lane”)
}

// REPLACE your buildPath(v) with this version (cars follow the drawn white arrows)
// Assumes: v.dir in {'north','south','east','west'}
//          v.lane: 0=L, 1=S, 2=R
// REPLACE your current buildPath(v) with this one.
// (Fixes “cars not moving” because it returns a BEZIER {p0,p1,p2,p3} like bezAt/bezLen expect.)
function buildPath(v) {
  const box = CONFIG.BOX_HALF;
  const move = v.move;

  const lane = v.lane;

  // lane -> exitDir mapping (clockwise rotation)
  const exitDirMap = {
    north: ['west',  'north', 'east' ],
    east:  ['north', 'east',  'south'],
    south: ['east',  'south', 'west' ],
    west:  ['south', 'west',  'north'],
  };

  // lane -> exitLane mapping (your 3/4/5)
  const exitLaneMap = {
    north: [2, -2, 3],
    east:  [-3, 4, -1],
    south: [2, -2, 3],
    west:  [-3, 4, -1],
  };

  const exitDir  = exitDirMap[v.dir][lane];
  const exitLane = exitLaneMap[v.dir][lane];

  // store for _exit() and exit-lane snap
  v.exitDir  = exitDir;
  v.exitLane = exitLane;

  // start point = where the vehicle is when it enters turning state
  const p0 = { x: v.x, y: v.y };

  // end point = just outside the intersection box on the exit arm
  const edge = box + 1;
  let p3;
  if (exitDir === 'north') p3 = { x: exitLaneX('north', exitLane), y: MID - edge };
  else if (exitDir === 'south') p3 = { x: exitLaneX('south', exitLane), y: MID + edge };
  else if (exitDir === 'east')  p3 = { x: MID + edge, y: exitLaneY('east',  exitLane) };
  else                          p3 = { x: MID - edge, y: exitLaneY('west',  exitLane) };

  // control points
  // straight: keep it nearly straight (smooth)
  if (move === 'straight') {
    // push controls along the travel axis
    if (v.dir === 'north' || v.dir === 'south') {
      const dy = (p3.y - p0.y);
      return { p0, p1: { x: p0.x, y: p0.y + dy * 0.33 }, p2: { x: p3.x, y: p0.y + dy * 0.66 }, p3 };
    } else {
      const dx = (p3.x - p0.x);
      return { p0, p1: { x: p0.x + dx * 0.33, y: p0.y }, p2: { x: p0.x + dx * 0.66, y: p3.y }, p3 };
    }
  }

  // turns: use a corner “pivot” near the quadrant corner to follow your drawn white arrows
  const r = box * 0.75; // turning smoothness (smaller = tighter, bigger = wider)
  let cx = MID, cy = MID;

  // pick quadrant corner based on (from dir → to exitDir)
  // (This aligns with your white arrow flow around the center.)
  if (v.dir === 'north' && exitDir === 'west') { cx = MID - r; cy = MID + r; } // north right
  if (v.dir === 'north' && exitDir === 'east') { cx = MID + r; cy = MID + r; } // north left

  if (v.dir === 'south' && exitDir === 'east') { cx = MID + r; cy = MID - r; } // south right
  if (v.dir === 'south' && exitDir === 'west') { cx = MID - r; cy = MID - r; } // south left

  if (v.dir === 'east'  && exitDir === 'south'){ cx = MID - r; cy = MID + r; } // east right
  if (v.dir === 'east'  && exitDir === 'north'){ cx = MID - r; cy = MID - r; } // east left

  if (v.dir === 'west'  && exitDir === 'north'){ cx = MID + r; cy = MID - r; } // west right
  if (v.dir === 'west'  && exitDir === 'south'){ cx = MID + r; cy = MID + r; } // west left

  // cubic controls pull the curve toward the pivot corner
  const p1 = { x: p0.x + (cx - p0.x) * 0.60, y: p0.y + (cy - p0.y) * 0.60 };
  const p2 = { x: p3.x + (cx - p3.x) * 0.60, y: p3.y + (cy - p3.y) * 0.60 };

  return { p0, p1, p2, p3 };
}

function bezAt(path, t) {
  const { p0, p1, p2, p3 } = path;
  const m = 1 - t;
  return {
    x: m*m*m*p0.x + 3*m*m*t*p1.x + 3*m*t*t*p2.x + t*t*t*p3.x,
    y: m*m*m*p0.y + 3*m*m*t*p1.y + 3*m*t*t*p2.y + t*t*t*p3.y,
  };
}

function bezLen(path, steps = 24) {
  let len = 0, prev = bezAt(path, 0);
  for (let i = 1; i <= steps; i++) {
    const p = bezAt(path, i / steps);
    const dx = p.x - prev.x, dy = p.y - prev.y;
    len += Math.sqrt(dx * dx + dy * dy);
    prev = p;
  }
  return Math.max(len, 1);
}

/* ═══════════════════════════════════════════════════════════════
   VEHICLE
═══════════════════════════════════════════════════════════════ */
class Vehicle {
  constructor(dir, lane) {
    this.id    = ++Vehicle._uid;
    this.dir   = dir;
    this.lane  = lane;
    this.move  = LANE_MOVE[lane];
    this.color = Vehicle._PAL[this.id % Vehicle._PAL.length];
    const pos  = spawnPos(dir, lane);
    this.x     = pos.x;
    this.y     = pos.y;
    this.phase    = 'approach'; // approach → turning → exit
    this.stopped  = false;
    this.waiting  = false;
    this.waitSec  = 0;
    this.done     = false;
    this.turnT    = 0;
    this.turnPath = null;
    this._pLen    = 1;
    this.exitDir  = null;
    this.exitLane = null;
  }
  static _uid = 0;
  static _PAL = [
    '#4FC3F7','#EF5350','#66BB6A','#FFA726','#AB47BC',
    '#26C6DA','#D4E157','#FF7043','#42A5F5','#EC407A',
    '#80DEEA','#FFAB40','#A5D6A7','#F48FB1','#CE93D8',
  ];
}

/* ═══════════════════════════════════════════════════════════════
   TRAFFIC MASTER — deterministic seeded spawner
   Both sims share ONE instance; identical events, identical order.
═══════════════════════════════════════════════════════════════ */
class TrafficMaster {
  constructor() {
    this._seed  = CONFIG.LCG_SEED;
    this._queue = [];   // [{time, dir, lane}] sorted ascending
    this._t     = 0;
  }

  _rng() {
    // Knuth LCG — integer overflow handled with imul + unsigned shift
    this._seed = (Math.imul(this._seed, 1664525) + 1013904223) >>> 0;
    return this._seed / 0x100000000;
  }

  tick(dt) {
    this._t += dt;
    const events = [];

    // Drain scheduled queue
    while (this._queue.length && this._queue[0].time <= this._t) {
      const e = this._queue.shift();
      events.push({ dir: e.dir, lane: e.lane });
    }

    // Background random spawns (all dirs × all lanes, deterministic)
    for (const dir of ['north', 'south', 'east', 'west']) {
      for (let lane = 0; lane < CONFIG.N_LANES; lane++) {
        if (this._rng() < CONFIG.SPAWN_RATE) {
          events.push({ dir, lane });
        }
      }
    }

    return events;
  }

  /** Inject one vehicle per lane for dir, staggered 0.4s each */
  injectDir(dir) {
    for (let lane = 0; lane < CONFIG.N_LANES; lane++) {
      this._queue.push({ time: this._t + lane * 0.4 + 0.05, dir, lane });
    }
    this._sort();
  }

  /** Bulk: n vehicles per lane per direction */
  bulkAdd(dir, n) {
    const dirs = dir === 'all' ? ['north','south','east','west'] : [dir];
    for (const d of dirs) {
      for (let i = 0; i < n; i++) {
        for (let lane = 0; lane < CONFIG.N_LANES; lane++) {
          this._queue.push({ time: this._t + i * 0.5 + lane * 0.15, dir: d, lane });
        }
      }
    }
    this._sort();
  }

  _sort() { this._queue.sort((a, b) => a.time - b.time); }

  reset() {
    this._seed  = CONFIG.LCG_SEED;
    this._queue = [];
    this._t     = 0;
  }
}

/* ═══════════════════════════════════════════════════════════════
   TRAFFIC LIGHT
   mode='baseline' → cycles FIXED_PHASE_SEQ (N→E→S→W clockwise)
   mode='ai'       → AI overrides each phase; falls back to AI_PHASE_SEQ
═══════════════════════════════════════════════════════════════ */
class TrafficLight {
  constructor(mode = 'baseline') {
    this.mode      = mode;
    this.subPhase  = 'green';   // 'green' | 'yellow' | 'allred'
    this.timer     = 0;

    // Choose the sequential fallback based on mode
    this._seq      = FIXED_PHASE_SEQ; // baseline & ai share the same clockwise phase order
    this._seqIdx   = 0;
    this._phaseKey = this._seq[0]; // active phase key (string)

    // Per-phase green durations for ALL known phases
    this.greenDur  = {};
    for (const ph of ALL_PHASES) this.greenDur[ph] = CONFIG.FIXED_GREEN;

    this._nextOverride = null;   // set by AI: next phase key to jump to
    this.onPhaseEnd    = null;   // callback: fired at yellow→allred
  }

  /** Currently active phase key (e.g. 'n', 'ns_s', 'ew_l') */
  get currentPhase() { return this._phaseKey; }

  canGo(dir, move) {
    return this.subPhase === 'green' && phaseAllows(this._phaseKey, dir, move);
  }

  stateFor(dir, move) {
    if (!phaseAllows(this._phaseKey, dir, move)) return 'red';
    if (this.subPhase === 'allred') return 'red';
    return this.subPhase; // 'green' or 'yellow'
  }

  remaining() {
    const dur = this.subPhase === 'green'  ? this.greenDur[this._phaseKey]
              : this.subPhase === 'yellow' ? CONFIG.YELLOW_DUR
              : CONFIG.ALL_RED_DUR;
    return Math.max(0, dur - this.timer);
  }

  tick(dt) {
    this.timer += dt;
    const dur = this.subPhase === 'green'  ? this.greenDur[this._phaseKey]
              : this.subPhase === 'yellow' ? CONFIG.YELLOW_DUR
              : CONFIG.ALL_RED_DUR;
    if (this.timer < dur) return;
    this.timer = 0;

    if (this.subPhase === 'green') {
      this.subPhase = 'yellow';
    } else if (this.subPhase === 'yellow') {
      this.subPhase = 'allred';
      if (this.onPhaseEnd) this.onPhaseEnd(this._phaseKey);
    } else {
      // allred → advance to next phase
      if (this._nextOverride !== null) {
        // AI-chosen phase key (can be ANY of the 10 phase keys)
        this._phaseKey = this._nextOverride;
        // Keep _seqIdx in sync if the override is in our default sequence
        const idx = this._seq.indexOf(this._phaseKey);
        if (idx !== -1) this._seqIdx = idx;
        this._nextOverride = null;
      } else {
        // Sequential fallback: clockwise for fixed, default rotation for AI
        this._seqIdx   = (this._seqIdx + 1) % this._seq.length;
        this._phaseKey = this._seq[this._seqIdx];
      }
      this.subPhase = 'green';
    }
  }

  /**
   * Set the NEXT phase (by numeric ID 1-10 or string key) and its duration.
   * Called by _callAI when Vertex AI responds.
   */
  setNextPhase(phaseId, duration) {
    const phKey = (typeof phaseId === 'number')
      ? PHASE_NUM_MAP[phaseId]
      : (ALL_PHASES.includes(phaseId) ? phaseId : null);
    if (!phKey) return;
    const d = Math.max(5, Math.min(60, Math.round(Number(duration) || CONFIG.FIXED_GREEN)));
    this.greenDur[phKey] = d;
    this._nextOverride = phKey;
  }
}

/* ═══════════════════════════════════════════════════════════════
   SIMULATION ENGINE
═══════════════════════════════════════════════════════════════ */
class Simulation {
  constructor(canvas, mode) {
    this.canvas   = canvas;
    this.ctx      = canvas.getContext('2d');
    this.mode     = mode;
    this.light    = new TrafficLight(mode);
    this.vehicles = [];
    this.simTime  = 0;

    this.totalPassed  = 0;
    this.totalWaitSec = 0;
    this.passedCount  = 0;

    this.jammed    = { north: false, south: false, east: false, west: false };
    this.aiPending = false;
    this.aiReason  = 'Awaiting first AI cycle…';

    this._aiTimer = 0;   // sim-seconds counter; AI polled every 10 s (spec)
    if (mode === 'ai') {
      // AI fires on phase-end AND on 10-second periodic tick
      this.light.onPhaseEnd = (ph) => this._callAI(ph);
    }
  }

  spawn(dir, lane) {
    this.vehicles.push(new Vehicle(dir, lane));
  }

  laneQueues() {
    const q = {};
    for (const dir of ['north','south','east','west']) {
      for (const move of LANE_MOVE) q[`${dir}_${move}`] = 0;
    }
    for (const v of this.vehicles) {
      if (v.phase === 'approach') {
        const k = `${v.dir}_${v.move}`;
        if (k in q) q[k]++;
      }
    }
    return q;
  }

  dirQueues() {
    const q = { north:0, south:0, east:0, west:0 };
    for (const v of this.vehicles) {
      if (v.phase === 'approach') q[v.dir]++;
    }
    return q;
  }

  avgWait() {
    return this.passedCount ? this.totalWaitSec / this.passedCount : 0;
  }

  /* ── TICK ──────────────────────────────────────────────────── */
  tick(dt) {
    this.simTime += dt;
    this.light.tick(dt);
    for (const v of this.vehicles) {
      if (!v.done) this._move(v, dt);
    }
    this.vehicles = this.vehicles.filter(v => !v.done);
    // this._detectJams(); // Jam UI removed

    // Vertex AI timing is applied on phase-end only (same logic as baseline).
  }

  /* ── MOVEMENT ─────────────────────────────────────────────── */
  _move(v, dt) {
    if      (v.phase === 'exit')    this._exit(v);
    else if (v.phase === 'turning') this._turn(v);
    else                             this._approach(v, dt);
  }

  _approach(v, dt) {
    const green = this.light.canGo(v.dir, v.move);
    const atStop = pastStop(v);
    // If stopped at stop line and not allowed, wait
    if (atStop && !green) {
      v.stopped = true; v.waiting = true; v.waitSec += dt; return;
    }
  
    // gap check (same lane queue safety)
    const gap = this._gap(v);
    if (gap < CONFIG.CAR_GAP) { v.stopped = true; v.waiting = false; return; }
  
    v.stopped = false; v.waiting = false;
  
    // move forward
    switch (v.dir) {
      case 'north': v.y -= CONFIG.CAR_SPD; break;
      case 'south': v.y += CONFIG.CAR_SPD; break;
      case 'east':  v.x += CONFIG.CAR_SPD; break;
      default:      v.x -= CONFIG.CAR_SPD; break;
    }
  
    // enter turning if allowed (green OR right-on-red)
    if (pastStop(v) && (green)) {
      const path = buildPath(v);
      if (!path) return;
      v.phase    = 'turning';
      v.turnPath = path;
      v._pLen    = bezLen(v.turnPath);
      v.turnT    = 0;
      const p    = bezAt(v.turnPath, 0);
      v.x = p.x; v.y = p.y;
    }
  }

  _turn(v) {
    v.turnT = Math.min(1, v.turnT + CONFIG.CAR_SPD / v._pLen);
    const p = bezAt(v.turnPath, v.turnT);
    v.x = p.x; v.y = p.y;

    if (v.turnT >= 1) {
      v.phase = 'exit';
      // Snap to exit lane position (exit lanes are on opposite side of road from approach)
      if (v.exitDir === 'north' || v.exitDir === 'south') v.x = exitLaneX(v.exitDir, v.exitLane);
      else                                                  v.y = exitLaneY(v.exitDir, v.exitLane);
    }
  }

  _exit(v) {
    switch (v.exitDir) {
      case 'north': v.y -= CONFIG.CAR_SPD; break;
      case 'south': v.y += CONFIG.CAR_SPD; break;
      case 'east':  v.x += CONFIG.CAR_SPD; break;
      default:      v.x -= CONFIG.CAR_SPD; break;
    }
    if (v.x < -50 || v.x > W + 50 || v.y < -50 || v.y > W + 50) {
      v.done = true;
      this.totalPassed++;
      this.totalWaitSec += v.waitSec;
      this.passedCount++;
    }
  }

  _gap(v) {
    let min = Infinity;
    for (const o of this.vehicles) {
      if (o === v || o.dir !== v.dir || o.lane !== v.lane || o.phase !== 'approach') continue;
      let gap;
      switch (v.dir) {
        case 'north': gap = v.y - o.y - CONFIG.CAR_L; break;
        case 'south': gap = o.y - v.y - CONFIG.CAR_L; break;
        case 'east':  gap = o.x - v.x - CONFIG.CAR_L; break;
        default:      gap = v.x - o.x - CONFIG.CAR_L; break;
      }
      if (gap !== undefined && gap >= 0 && gap < min) min = gap;
    }
    return min;
  }

  _detectJams() {
    const T = CONFIG.JAM_THRESHOLD;
    const J = { north:false, south:false, east:false, west:false };
    for (const v of this.vehicles) {
      if (v.phase !== 'approach') continue;
      const hl = CONFIG.CAR_L / 2;
      if (v.dir === 'north' && v.y + hl >= W - T) J.north = true;
      if (v.dir === 'south' && v.y - hl <= T)     J.south = true;
      if (v.dir === 'east'  && v.x - hl <= T)     J.east  = true;
      if (v.dir === 'west'  && v.x + hl >= W - T) J.west  = true;
    }
    this.jammed = J;
  }

  _isIntersectionClearForRightTurn(v) {
    const box = CONFIG.BOX_HALF + 6; // small buffer
    // If ANY vehicle is inside/near the intersection box, be conservative and wait.
    for (const o of this.vehicles) {
      if (o === v) continue;
      if (o.phase !== 'turning' && o.phase !== 'exit') continue;
  
      if (Math.abs(o.x - MID) <= box && Math.abs(o.y - MID) <= box) {
        return false;
      }
    }
    return true;
  }

  /* ── VERTEX AI ────────────────────────────────────────────── */
  async _callAI(contextPhase) {
    if (this.aiPending) return;
    this.aiPending = true;

    const q = this.laneQueues();

    /* ── demand aggregation (shared traffic logic with baseline) ─────────────
       NEW RULE: when a main arm is green (L+S+R), ALL OTHER LEFT lanes are also green.
       Practical effect: LEFT turns are almost always moving, so phase choice + duration
       should focus more on STRAIGHT+RIGHT backlogs (to reduce wasted green).
    */
    const demand = {
      // Main-arm phases (1-4): prioritize straight+right; left is given a smaller weight
      1:  q.north_straight + q.north_right + 0.25 * q.north_left,
      2:  q.east_straight  + q.east_right  + 0.25 * q.east_left,
      3:  q.south_straight + q.south_right + 0.25 * q.south_left,
      4:  q.west_straight  + q.west_right  + 0.25 * q.west_left,
      // Keep 5-10 defined (legacy / debugging), but AI should mainly use 1-4 now
      5:  0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0,
    };

    /* Numeric ID of the phase that just ended (used to block repeats) */
    const curId = Object.entries(PHASE_NUM_MAP).find(([,v]) => v === contextPhase)?.[0] | 0;

    // Same phase order as fixed: always use the next clockwise phase (1→2→3→4→1)
    const cw = [1, 2, 3, 4];
    const cur = cw.includes(+curId) ? +curId : 1;
    const fixedNextId = cw[(cw.indexOf(cur) + 1) % 4];

    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
    const fixedDur = CONFIG.FIXED_GREEN;

    // Heuristic target duration for the NEXT fixed phase (focus on straight+right; left is always flowing)
    const loadNext = Number(demand[fixedNextId] || 0);
    const targetDur = clamp(Math.round(8 + loadNext * 1.8), 5, 45);

    /* ── heuristic fallback ─────────────────────────────────── */
    const heuristic = (reason) => {
      // Keep the same phase order as FIXED, but use smarter timing (targetDur) to reduce wasted green.
      this.light.setNextPhase(fixedNextId, targetDur);
      this.aiReason = (reason || `Smart timing → next=${fixedNextId} dur=${targetDur}s load=${loadNext.toFixed(1)} (fixed=${fixedDur}s)`)
        .slice(0, 250);
    };

    const urlReady = CONFIG.CLOUD_FN_URL &&
                     !CONFIG.CLOUD_FN_URL.includes('YOUR_') &&
                     !CONFIG.CLOUD_FN_URL.includes('your_');
    if (!urlReady) {
      heuristic('Local heuristic (Vertex AI not configured)');
      this.aiPending = false;
      return;
    }

    try {
      const ctrl    = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 9000);

      const res = await fetch(CONFIG.CLOUD_FN_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          /* ── 12 per-lane queue counts (keys match index.js) ── */
          north_left:     q.north_left,   north_straight: q.north_straight, north_right: q.north_right,
          south_left:     q.south_left,   south_straight: q.south_straight, south_right: q.south_right,
          east_left:      q.east_left,    east_straight:  q.east_straight,  east_right:  q.east_right,
          west_left:      q.west_left,    west_straight:  q.west_straight,  west_right:  q.west_right,
          /* ── Pre-aggregated demand per phase ID 1-10 ── */
          demand,
          /* ── Context ── */
          current_phase_id: +curId,
          fixed_next_phase_id: fixedNextId,
          fixed_green: fixedDur,
          target_duration: targetDur,
          sim_time: Math.round(this.simTime),
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      /* Expected response: { next_phase: 1-4, duration: seconds, reason: string, improved_over_fixed?: boolean } */
      const aiDurRaw = Number(data.duration);
      const aiDur    = clamp(Math.round(aiDurRaw || fixedDur), 5, 45);

      // Enforce SAME phase order as fixed (clockwise). Ignore any model-proposed next_phase.
      const modelImproved = (data && typeof data.improved_over_fixed === 'boolean')
        ? !!data.improved_over_fixed
        : (Math.abs(aiDur - targetDur) < Math.abs(fixedDur - targetDur)); // fallback check

      if (Number.isFinite(aiDurRaw) && modelImproved) {
        // ✅ AI timing beats fixed for THIS next phase → apply "new command"
        this.light.setNextPhase(fixedNextId, aiDur);
        this.aiReason = String(data.reason || `AI timing accepted → next=${fixedNextId} dur=${aiDur}s (target=${targetDur}s)`).slice(0, 250);
      } else if (Number.isFinite(aiDurRaw)) {
        // AI responded but not better than fixed → keep fixed duration
        this.light.setNextPhase(fixedNextId, fixedDur);
        this.aiReason = `AI timing rejected (not better than fixed). Using fixed ${fixedDur}s for next=${fixedNextId}.`.slice(0, 250);
      } else {
        // Bad response → use smart local timing
        heuristic(`Bad AI response (duration=${data.duration}) — smart timing used`);
      }
    } catch (err) {
      heuristic(`Vertex AI error: ${String(err.message || err).slice(0, 120)} — heuristic`);
    }
    this.aiPending = false;
  }

  /* ═══════════════════════════════════════════════════════════
     RENDER
  ═══════════════════════════════════════════════════════════ */
  render(accentColor) {
    const ctx = this.ctx;

    // ── Road surfaces ────────────────────────────────────────
    ctx.fillStyle = '#07111a'; ctx.fillRect(0, 0, W, W);

    // City blocks
    ctx.fillStyle = '#0c1820';
    ctx.fillRect(0,      0,      MID-RH, MID-RH);
    ctx.fillRect(MID+RH, 0,      W,      MID-RH);
    ctx.fillRect(0,      MID+RH, MID-RH, W);
    ctx.fillRect(MID+RH, MID+RH, W,      W);

    // Road surface
    ctx.fillStyle = '#16243a';
    ctx.fillRect(MID-RH, 0,      RH*2, W);
    ctx.fillRect(0,      MID-RH, W,    RH*2);

    // Intersection box (slightly lighter)
    ctx.fillStyle = '#1a2c42';
    ctx.fillRect(MID-RH, MID-RH, RH*2, RH*2);

    // ── Lane markings ────────────────────────────────────────
    // Kerb edges
    ctx.strokeStyle = '#040c14'; ctx.lineWidth = 3; ctx.setLineDash([]);
    for (const [x1,y1,x2,y2] of [
      [MID-RH,0,     MID-RH,MID-RH], [MID-RH,MID+RH,MID-RH,W],
      [MID+RH,0,     MID+RH,MID-RH], [MID+RH,MID+RH,MID+RH,W],
      [0,MID-RH,     MID-RH,MID-RH], [MID+RH,MID-RH,W,MID-RH],
      [0,MID+RH,     MID-RH,MID+RH], [MID+RH,MID+RH,W,MID+RH],
    ]) { ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke(); }

    // Lane dividers (dashed white)
    ctx.strokeStyle = '#ffffff12'; ctx.lineWidth = 1; ctx.setLineDash([6,9]);
    for (let i = 1; i < CONFIG.N_LANES * 2; i++) {
      const x = MID - RH + i * CONFIG.LANE_W;
      ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,MID-RH); ctx.moveTo(x,MID+RH); ctx.lineTo(x,W); ctx.stroke();
      const y = MID - RH + i * CONFIG.LANE_W;
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(MID-RH,y); ctx.moveTo(MID+RH,y); ctx.lineTo(W,y); ctx.stroke();
    }
    ctx.setLineDash([]);

    // Centre divider (yellow)
    ctx.strokeStyle = '#e8a84445'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(MID,0);        ctx.lineTo(MID,MID-RH);
    ctx.moveTo(MID,MID+RH);   ctx.lineTo(MID,W);
    ctx.moveTo(0,MID);        ctx.lineTo(MID-RH,MID);
    ctx.moveTo(MID+RH,MID);   ctx.lineTo(W,MID);
    ctx.stroke();

    // ── Canvas features ──────────────────────────────────────
    this._drawArrows(ctx);
    this._drawStopLines(ctx);

    for (const v of this.vehicles) this._drawCar(ctx, v);

    // Panel glow border
    ctx.strokeStyle = accentColor + '55';
    ctx.lineWidth = 3; ctx.setLineDash([]);
    ctx.strokeRect(1.5, 1.5, W-3, W-3);
  }

  /* ── Lane directional arrows ─────────────────────────────── */
  _drawArrows(ctx) {
    ctx.save();
    ctx.setLineDash([]);

    /*
     * Arrow shapes are drawn in LOCAL space, then transformed.
     *
     * LOCAL convention (same for every arm):
     *   +Y = forward  (toward intersection / the direction car travels)
     *   +X = driver's RIGHT
     *   -X = driver's LEFT
     *
     * Shapes:
     *   straight : tail(0,+s) → tip(0,-s)  [tip points forward = -Y]
     *   left     : tail offset right, curves to -X (driver-left)
     *   right    : tail offset left,  curves to +X (driver-right)
     *
     * Transform per arm: translate → rotate(angle) → scale(sx, 1)
     *   Maps local -Y  →  screen travel direction
     *   Maps local +X  →  driver's-right on screen
     *
     *   Dir    travel(screen)  angle    sx
     *   north  (0,-1) up       0        +1   local-Y=up ✓  local+X=east=driver-right ✓
     *   south  (0,+1) down     π        -1   local-Y=down ✓ local+X→west after π+flip ✓
     *   east   (+1,0) right   -π/2      -1   local-Y=right ✓ local+X→north after -90+flip ✓
     *   west   (-1,0) left    +π/2      +1   local-Y=left ✓  local+X=north=driver-right ✓
     *
     * Verification — local +X after scale(sx,1) then rotate(angle):
     *   screen-x = sx·cos(a),  screen-y = sx·sin(a)
     *   north(a=0,  sx=+1): (+1,0)=east  = driver-right of northbound ✓
     *   south(a=π,  sx=-1): (+1,0)=east→after-scale(-1,0)→rotate(π)=(+1,0)=east... 
     *     Actually: scale first → local(+1,0)→(-1,0), then rotate(π)→(+1,0)=east.
     *     South driver-right=west. WRONG. Try sx=+1:
     *     scale(+1)→(+1,0), rotate(π)→(-1,0)=west = south driver-right ✓  so sx=+1 for south too.
     *   Re-derive south(a=π, sx=+1): local+X→rotate(π)→(-1,0)=west=south driver-right ✓
     *   east(a=-π/2, sx=+1): local+X→rotate(-π/2)→(0,+1)=south=east driver-right ✓
     *   west(a=+π/2, sx=+1): local+X→rotate(+π/2)→(0,-1)=north=west driver-right ✓
     *
     * All arms: sx=+1. Only need the angle.
     * Re-derive: rotate(a) maps (x,y)→(x·cosA-y·sinA, x·sinA+y·cosA)
     * Need local tip (0,-s) → screen travel direction:
     *   result = (s·sinA, -s·cosA) = screen travel
     *   north (0,-1): sinA=0,cosA=1 → A=0 ✓
     *   south (0,+1): s·sinA=0, -s·cosA=+s → cosA=-1 → A=π ✓
     *   east  (+1,0): s·sinA=+s → sinA=1 → A=+π/2
     *   west  (-1,0): s·sinA=-s → sinA=-1 → A=-π/2
     * Driver-right check with sx=+1, local(+s,0)→(s·cosA, s·sinA):
     *   north(A=0):   (+s,0)=east  = north driver-right ✓
     *   south(A=π):   (-s,0)=west  = south driver-right ✓
     *   east(A=+π/2): (0,+s)=south = east  driver-right ✓
     *   west(A=-π/2): (0,-s)=north = west  driver-right ✓
     * All verified. sx=+1 for all arms.
     *   north: 0    south: π    east: +π/2    west: -π/2
     */
    const ANGLE = { north: 0, south: Math.PI, east: Math.PI/2, west: -Math.PI/2 };

    const drawArrow = (cx, cy, dir, move, alpha) => {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ANGLE[dir]);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth   = 1.5;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';

      const s = 7;
      // tail=+s (behind car), tip=-s (toward intersection / forward)

      if (move === 'straight') {
        ctx.beginPath();
        ctx.moveTo(0,  s);   // tail
        ctx.lineTo(0, -s);   // tip
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-s*0.4, -s*0.5);
        ctx.lineTo(0, -s);
        ctx.lineTo( s*0.4, -s*0.5);
        ctx.stroke();

      } else if (move === 'left') {
        // shaft from slightly-right tail, hooks to driver-left (-X)
        ctx.beginPath();
        ctx.moveTo( s*0.3,  s);     // tail (offset right = driver-right side)
        ctx.lineTo( s*0.3,  0);
        ctx.quadraticCurveTo( s*0.3, -s,  -s*0.45, -s);  // hook to -X
        ctx.stroke();
        // arrowhead pointing −X
        ctx.beginPath();
        ctx.moveTo(-s*0.45, -s + s*0.45);
        ctx.lineTo(-s*0.45, -s);
        ctx.lineTo(-s*0.45 + s*0.5, -s);
        ctx.stroke();

      } else { // right
        // shaft from slightly-left tail, hooks to driver-right (+X)
        ctx.beginPath();
        ctx.moveTo(-s*0.3,  s);     // tail (offset left = driver-left side)
        ctx.lineTo(-s*0.3,  0);
        ctx.quadraticCurveTo(-s*0.3, -s,   s*0.45, -s);  // hook to +X
        ctx.stroke();
        // arrowhead pointing +X
        ctx.beginPath();
        ctx.moveTo( s*0.45, -s + s*0.45);
        ctx.lineTo( s*0.45, -s);
        ctx.lineTo( s*0.45 - s*0.5, -s);
        ctx.stroke();
      }

      ctx.restore();
    };

    const BOX = CONFIG.BOX_HALF;
    const d1  = BOX + 28;
    const d2  = BOX + 56;

    for (let lane = 0; lane < CONFIG.N_LANES; lane++) {
      const move = LANE_MOVE[lane];  // lane0=left, lane1=straight, lane2=right

      // North arm (cars travel ↑, approach from y > MID+BOX)
      drawArrow(laneX('north', lane), MID + d1, 'north', move, 0.75);
      drawArrow(laneX('north', lane), MID + d2, 'north', move, 0.30);

      // South arm (cars travel ↓, approach from y < MID-BOX)
      drawArrow(laneX('south', lane), MID - d1, 'south', move, 0.75);
      drawArrow(laneX('south', lane), MID - d2, 'south', move, 0.30);

      // East arm (cars travel →, approach from x < MID-BOX)
      drawArrow(MID - d1, laneY('east', lane), 'east', move, 0.75);
      drawArrow(MID - d2, laneY('east', lane), 'east', move, 0.30);

      // West arm (cars travel ←, approach from x > MID+BOX)
      drawArrow(MID + d1, laneY('west', lane), 'west', move, 0.75);
      drawArrow(MID + d2, laneY('west', lane), 'west', move, 0.30);
    }

    // Lane labels (L / S / R) — drawn at each lane's physical position
    // Result on screen:
    //   North (bottom): L(lane0) S(lane1) R(lane2) left→right ✓
    //   South (top):    R(lane2) S(lane1) L(lane0) left→right ✓  (lane0 is rightmost)
    //   East  (right):  L(lane0) S(lane1) R(lane2) top→bottom ✓  (lane0 is topmost/innermost)
    //   West  (left):   R(lane2) S(lane1) L(lane0) top→bottom ✓  (lane2 is topmost/outermost)
    ctx.font = 'bold 8px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const LCOL = { left:'#CE93D8', straight:'#81C784', right:'#FFB74D' };

    for (let lane = 0; lane < CONFIG.N_LANES; lane++) {
      const move = LANE_MOVE[lane];
      ctx.fillStyle = LCOL[move] + 'f0';
      const lbl = move[0].toUpperCase();  // 'L', 'S', 'R'

      ctx.fillText(lbl, laneX('north', lane), MID + BOX + 13);  // North: below stop line
      ctx.fillText(lbl, laneX('south', lane), MID - BOX - 13);  // South: above stop line
      ctx.fillText(lbl, MID - BOX - 13, laneY('east', lane));   // East: left of stop line
      ctx.fillText(lbl, MID + BOX + 13, laneY('west', lane));   // West: right of stop line
    }

    ctx.restore();
  }


  /* ── Stop lines coloured per lane light state ────────────── */
  _drawStopLines(ctx) {
    const box = CONFIG.BOX_HALF;
    const LW  = CONFIG.LANE_W;
    ctx.lineWidth = 3; ctx.setLineDash([]);

    const col = (dir, move) => {
      const s = this.light.stateFor(dir, move);
      return s === 'green' ? '#30d080' : s === 'yellow' ? '#f0c830' : '#ff4040';
    };

    // Draw each lane's stop-line segment centred on laneX/laneY
    for (let lane = 0; lane < 3; lane++) {
      const move = LANE_MOVE[lane];
      const half = LW / 2;

      // North: horizontal segment at y=MID+box, centred on laneX
      ctx.strokeStyle = col('north', move);
      const nx = laneX('north', lane);
      ctx.beginPath(); ctx.moveTo(nx - half, MID + box); ctx.lineTo(nx + half, MID + box); ctx.stroke();

      // South: horizontal segment at y=MID-box, centred on laneX
      ctx.strokeStyle = col('south', move);
      const sx = laneX('south', lane);
      ctx.beginPath(); ctx.moveTo(sx - half, MID - box); ctx.lineTo(sx + half, MID - box); ctx.stroke();

      // East: vertical segment at x=MID-box, centred on laneY
      ctx.strokeStyle = col('east', move);
      const ey = laneY('east', lane);
      ctx.beginPath(); ctx.moveTo(MID - box, ey - half); ctx.lineTo(MID - box, ey + half); ctx.stroke();

      // West: vertical segment at x=MID+box, centred on laneY
      ctx.strokeStyle = col('west', move);
      const wy = laneY('west', lane);
      ctx.beginPath(); ctx.moveTo(MID + box, wy - half); ctx.lineTo(MID + box, wy + half); ctx.stroke();
    }
  }

  /* ── Traffic light poles (approach side only) ────────────── */
  _drawLights(ctx) {
    const box = CONFIG.BOX_HALF;

    const armState = (dir) => {
      for (const move of LANE_MOVE) { if (this.light.stateFor(dir, move) === 'green')  return 'green'; }
      for (const move of LANE_MOVE) { if (this.light.stateFor(dir, move) === 'yellow') return 'yellow'; }
      return 'red';
    };

    // Pole positions: left kerb of each approach, at the stop line
    const poles = [
      { x: MID-RH-9, y: MID+box,   dir:'north', stemOff:+12 },
      { x: MID+RH+9, y: MID-box,   dir:'south', stemOff:-12 },
      { x: MID-box,  y: MID-RH-9,  dir:'east',  stemOff:+12 },
      { x: MID+box,  y: MID+RH+9,  dir:'west',  stemOff:-12 },
    ];

    ctx.setLineDash([]);
    for (const p of poles) {
      const st = armState(p.dir);

      // Stem
      ctx.strokeStyle = '#334455'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(p.x, p.y + (p.stemOff > 0 ? 2 : -2)); ctx.lineTo(p.x, p.y + p.stemOff); ctx.stroke();

      // Housing
      ctx.fillStyle = '#0e1820'; ctx.strokeStyle = '#1e3040'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(p.x-5, p.y-16, 10, 18, 2); ctx.fill(); ctx.stroke();

      // Three lamps
      const lamps = [
        { dy:-11, when:'red',    on:'#ff4040', off:'#3a1010' },
        { dy: -6, when:'yellow', on:'#f0c830', off:'#3a3010' },
        { dy: -1, when:'green',  on:'#30d080', off:'#103a20' },
      ];
      for (const L of lamps) {
        const lit = st === L.when;
        ctx.beginPath(); ctx.arc(p.x, p.y + L.dy, 3, 0, Math.PI*2);
        ctx.fillStyle = lit ? L.on : L.off; ctx.fill();
        if (lit) {
          ctx.beginPath(); ctx.arc(p.x, p.y + L.dy, 6.5, 0, Math.PI*2);
          ctx.fillStyle = L.on + '44'; ctx.fill();
        }
      }
    }
  }

  /* ── Vehicle rendering ───────────────────────────────────── */
  _drawCar(ctx, v) {
    ctx.save();
    let angle = 0;
    if (v.phase === 'approach') {
      angle = { north:-Math.PI/2, south:Math.PI/2, east:0, west:Math.PI }[v.dir];
    } else if (v.phase === 'exit') {
      angle = { north:-Math.PI/2, south:Math.PI/2, east:0, west:Math.PI }[v.exitDir];
    } else if (v.turnPath) {
      const t2 = Math.min(1, v.turnT + 0.04);
      const pa = bezAt(v.turnPath, v.turnT);
      const pb = bezAt(v.turnPath, t2);
      angle = Math.atan2(pb.y - pa.y, pb.x - pa.x);
    }
    ctx.translate(v.x, v.y); ctx.rotate(angle);
    const L = CONFIG.CAR_L, CW = CONFIG.CAR_W;

    // Body
    ctx.fillStyle = v.color;
    ctx.beginPath(); ctx.roundRect(-L/2, -CW/2, L, CW, 2); ctx.fill();

    // Windscreen (front = +x)
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.fillRect(L/2-6, -CW/2+2, 5, CW-4);

    // Brake lights (rear = -x)
    ctx.fillStyle = v.waiting ? '#ff2222dd' : '#55000044';
    ctx.fillRect(-L/2, -CW/2+1, 3, 3);
    ctx.fillRect(-L/2, CW/2-4,  3, 3);

    ctx.restore();
  }
}

/* ═══════════════════════════════════════════════════════════════
   SIMULATION MANAGER
═══════════════════════════════════════════════════════════════ */
class SimManager {
  constructor() {
    this.cbEl = document.getElementById('canvas-baseline');
    this.caEl = document.getElementById('canvas-ai');

    this.master  = new TrafficMaster();
    this.simBase = new Simulation(this.cbEl, 'baseline');
    this.simAI   = new Simulation(this.caEl, 'ai');

    this.running  = false;
    this.paused   = false;
    this.globalT  = 0;
    this.speed    = 2;
    this.lastTs   = null;
    this.rafId    = null;

    this.csvSchedule = [];
    this.csvIdx      = 0;

    // Show FIXED_GREEN in panel title
    const lbl = document.getElementById('fixed-green-label');
    if (lbl) lbl.textContent = CONFIG.FIXED_GREEN;

    this._bindUI();
  }

  _bindUI() {
    document.getElementById('btn-start').addEventListener('click', () => this.start());
    document.getElementById('btn-pause').addEventListener('click', () => this.togglePause());
    document.getElementById('btn-reset').addEventListener('click', () => this.reset());
    document.getElementById('sim-speed').addEventListener('change', e => { this.speed = +e.target.value; });

    document.querySelectorAll('.inject-btn').forEach(btn => {
      btn.addEventListener('click', () => this.master.injectDir(btn.dataset.dir));
    });

    document.getElementById('btn-bulk-add').addEventListener('click', () => {
      const n   = parseInt(document.getElementById('bulk-count').value) || 5;
      const dir = document.getElementById('bulk-dir').value;
      this.master.bulkAdd(dir, n);
    });

    document.getElementById('csv-input').addEventListener('change', e => {
      const f = e.target.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = ev => this._parseCSV(ev.target.result);
      r.readAsText(f);
    });
  }

  _parseCSV(text) {
    // Supports two formats:
    //   Simple:   time,count       → `count` vehicles per direction at `time`
    //   Extended: time,north,south,east,west → individual counts per direction
    const lines = text.trim().split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
    this.csvSchedule = [];

    // Detect format from header or first data row
    const firstData = lines[0].toLowerCase().replace(/\s/g,'');
    const hasHeader = firstData.startsWith('time');
    const dataLines = hasHeader ? lines.slice(1) : lines;

    // Determine column count from first data line
    const sampleCols = dataLines[0] ? dataLines[0].split(',').length : 2;
    const isSimple   = sampleCols <= 2; // time,count or just count

    for (const line of dataLines) {
      const parts = line.split(',').map(s => parseFloat(s.trim()));
      if (parts.length === 0 || isNaN(parts[0])) continue;

      if (isSimple) {
        // time,count format: apply count to all 4 directions
        const [time, count = 1] = parts;
        if (!isNaN(time)) {
          this.csvSchedule.push({ time, north: count, south: count, east: count, west: count });
        }
      } else {
        // time,north,south,east,west format (original)
        const [time, north = 0, south = 0, east = 0, west = 0] = parts;
        if (!isNaN(time)) {
          this.csvSchedule.push({ time, north, south, east, west });
        }
      }
    }
    this.csvIdx = 0;
    console.log(`[CSV] Loaded ${this.csvSchedule.length} entries (${isSimple ? 'simple time,count' : 'extended time,N,S,E,W'} format)`);
  }

  start() {
    if (this.running) return;
    this.running = true;
    document.getElementById('btn-start').disabled = true;
    document.getElementById('btn-pause').disabled = false;
    this.lastTs = null;
    // Trigger first AI query immediately so it doesn't wait for first phase end
    this.simAI._callAI(null);
    this.rafId = requestAnimationFrame(ts => this._loop(ts));
  }

  togglePause() {
    this.paused = !this.paused;
    document.getElementById('btn-pause').textContent = this.paused ? '▶ RESUME' : '⏸ PAUSE';
    if (!this.paused) { this.lastTs = null; this.rafId = requestAnimationFrame(ts => this._loop(ts)); }
  }

  reset() {
    cancelAnimationFrame(this.rafId);
    this.running = this.paused = false;
    this.globalT = 0; this.csvIdx = 0; Vehicle._uid = 0;
    this.master.reset();
    this.simBase = new Simulation(this.cbEl, 'baseline');
    this.simAI   = new Simulation(this.caEl, 'ai');
    document.getElementById('btn-start').disabled = false;
    document.getElementById('btn-pause').disabled = true;
    document.getElementById('btn-pause').textContent = '⏸ PAUSE';
    this._render(); this._updateUI();
  }

  _loop(ts) {
    if (this.paused || !this.running) return;
    const dtReal = this.lastTs ? ts - this.lastTs : 16.67;
    this.lastTs  = ts;
    const dt     = Math.min((dtReal / 1000) * this.speed, 0.10);
    this.globalT += dt;

    // CSV injection via TrafficMaster
    while (this.csvIdx < this.csvSchedule.length && this.csvSchedule[this.csvIdx].time <= this.globalT) {
      const e = this.csvSchedule[this.csvIdx++];
      for (const dir of ['north','south','east','west']) {
        this.master.bulkAdd(dir, Math.round(e[dir] || 0));
      }
    }

    // Single tick → same events to both sims
    const events = this.master.tick(dt);
    for (const ev of events) {
      this.simBase.spawn(ev.dir, ev.lane);
      this.simAI.spawn(ev.dir, ev.lane);
    }

    // Sync time
    this.simBase.simTime = this.globalT;
    this.simAI.simTime   = this.globalT;

    this.simBase.tick(dt);
    this.simAI.tick(dt);

    this._render();
    this._updateUI();

    this.rafId = requestAnimationFrame(ts2 => this._loop(ts2));
  }

  _render() {
    this.simBase.render('#f07030');
    this.simAI.render('#00ccff');
  }

  _updateUI() {
    // ── Clock ──────────────────────────────────────────────────
    const t = Math.floor(this.globalT);
    document.getElementById('global-clock').textContent =
      `${String(Math.floor(t/3600)).padStart(2,'0')}:` +
      `${String(Math.floor((t%3600)/60)).padStart(2,'0')}:` +
      `${String(t%60).padStart(2,'0')}`;

    const bL = this.simBase.light;
    const aL = this.simAI.light;

    // ── Phase bars ─────────────────────────────────────────────
    const subCol  = sp => sp === 'green' ? 'var(--green)' : sp === 'yellow' ? 'var(--yellow)' : 'var(--red)';
    const subLbl  = sp => sp === 'green' ? 'GREEN' : sp === 'yellow' ? 'YELLOW' : 'ALL RED';

    document.getElementById('base-phase-name').textContent = PHASE_LABEL[bL.currentPhase];
    document.getElementById('base-phase-sub').textContent  = subLbl(bL.subPhase);
    const bCD = document.getElementById('base-countdown');
    bCD.textContent   = Math.ceil(bL.remaining());
    bCD.style.color   = subCol(bL.subPhase);

    document.getElementById('ai-phase-name').textContent = PHASE_LABEL[aL.currentPhase];
    document.getElementById('ai-phase-sub').textContent  = subLbl(aL.subPhase);
    const aCD = document.getElementById('ai-countdown');
    aCD.textContent   = Math.ceil(aL.remaining());
    aCD.style.color   = subCol(aL.subPhase);

    // ── Phase signal dots ──────────────────────────────────────
    // Base uses FIXED_PHASE_SEQ (n, e, s, w); AI uses ALL_PHASES
    for (const [pfx, lt, seq] of [['base',bL,FIXED_PHASE_SEQ],['ai',aL,ALL_PHASES]]) {
      for (const ph of seq) {
        const el = document.getElementById(`${pfx}-dot-${ph.replace('_','-')}`);
        if (!el) continue;
        if (lt.currentPhase === ph) {
          el.className = `ph-dot ${lt.subPhase === 'allred' ? 'red' : lt.subPhase}`;
        } else {
          el.className = 'ph-dot red';
        }
      }
    }

    // ── Stats ──────────────────────────────────────────────────
    const qB = this.simBase.dirQueues(), qA = this.simAI.dirQueues();
    const bPass = this.simBase.totalPassed, aPass = this.simAI.totalPassed;
    const bWait = this.simBase.avgWait().toFixed(1);
    const aWait = this.simAI.avgWait().toFixed(1);
    const bQTot = Object.values(qB).reduce((a,b)=>a+b,0);
    const aQTot = Object.values(qA).reduce((a,b)=>a+b,0);

    document.getElementById('base-passed').textContent = bPass;
    document.getElementById('ai-passed').textContent   = aPass;
    document.getElementById('base-wait').textContent   = bWait + 's';
    document.getElementById('ai-wait').textContent     = aWait + 's';
    document.getElementById('base-queue').textContent  = bQTot;
    document.getElementById('ai-queue').textContent    = aQTot;

    // AI advantage badge
    const dPass = bPass > 0 ? (((aPass-bPass)/bPass)*100).toFixed(0) : 0;
    const dWait = parseFloat(bWait) > 0 ? (((parseFloat(bWait)-parseFloat(aWait))/parseFloat(bWait))*100).toFixed(0) : 0;
    document.getElementById('adv-passed').textContent = dPass >= 0 ? `+${dPass}%` : `${dPass}%`;
    document.getElementById('adv-wait').textContent   = dWait >= 0 ? `−${dWait}%` : `+${Math.abs(dWait)}%`;

    // ── AI phase duration chips ─────────────────────────────────
    // Shows current duration for each of the 6 paired AI phases
    const chipMap = [
      [PH.NS_S, 'chip-ns-s', 'chip-dur-ns-s'],
      [PH.NS_L, 'chip-ns-l', 'chip-dur-ns-l'],
      [PH.NS_R, 'chip-ns-r', 'chip-dur-ns-r'],
      [PH.EW_S, 'chip-ew-s', 'chip-dur-ew-s'],
      [PH.EW_L, 'chip-ew-l', 'chip-dur-ew-l'],
      [PH.EW_R, 'chip-ew-r', 'chip-dur-ew-r'],
      // Fallback: also try old HTML IDs if new ones absent
      [PH.NS_S, 'chip-ns-sr', 'chip-dur-ns-sr'],
      [PH.EW_S, 'chip-ew-sr', 'chip-dur-ew-sr'],
    ];
    for (const [ph, chipId, durId] of chipMap) {
      const chip = document.getElementById(chipId);
      const dur  = document.getElementById(durId);
      if (chip && dur) {
        dur.textContent = aL.greenDur[ph] + 's';
        chip.className  = 'ai-dur-chip' + (aL.currentPhase === ph ? ' active' : '');
      }
    }

    // ── AI log ─────────────────────────────────────────────────
    document.getElementById('ai-log-txt').textContent =
      this.simAI.aiPending ? '⟳ Consulting Gemini Pro…' : this.simAI.aiReason;

    // ── Queue bars ──────────────────────────────────────────────
    const MAX = 20;
    for (const [dir, a] of [['north','n'],['south','s'],['east','e'],['west','w']]) {
      const vB = qB[dir], vA = qA[dir];
      document.getElementById(`qbar-base-${a}`).style.width = Math.min(100,(vB/MAX)*100) + '%';
      document.getElementById(`qbar-ai-${a}`).style.width   = Math.min(100,(vA/MAX)*100) + '%';
      document.getElementById(`qlbl-${a}`).textContent = `${vB}/${vA}`;
    }

    // Inject queue badges
    const qBall = this.simBase.dirQueues();
    document.getElementById('q-north').textContent = qBall.north;
    document.getElementById('q-south').textContent = qBall.south;
    document.getElementById('q-east').textContent  = qBall.east;
    document.getElementById('q-west').textContent  = qBall.west;
    // Jam alerts UI removed
  }
}

/* ── BOOT ──────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  const mgr = new SimManager();
  mgr._render();
  mgr._updateUI();
  window._sim = mgr;
  console.log('%c✦ TrafficAI v6', 'color:#00ccff;font-size:14px;font-weight:bold');
  console.log('%cwindow._sim — inspect/control from console', 'color:#4a5f75');
  console.log('%cCONFIG.FIXED_GREEN =', 'color:#f07030', CONFIG.FIXED_GREEN, '— swap in CONFIG to change baseline');
});