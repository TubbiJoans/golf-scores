// World Handicap System (WHS, 2024 revision) maths for the Golf Scores handicap tracker.
// Pure functions, no Firebase, so they can be tested on their own (tests/test_handicap_calc.py).
//
// Follows the published Rules of Handicapping:
//  - Score Differential = (113 / Slope) × (Adjusted Gross Score − Course Rating − PCC), to one decimal.
//  - Adjusted Gross Score: each hole capped at net double bogey (par + 2 + strokes received, never more than par + 5
//    when a player gets 4+ strokes on a hole); par + 5 before a Handicap Index exists. Holes not played count as net par.
//  - Handicap Index = average of the lowest 8 of the most recent 20 differentials; fewer than 20 use the Rule 5.2a table.
//  - Exceptional score reduction (−1 at 7.0–9.9 better than the Index, −2 at 10.0+), applied to the most recent 20.
//  - Soft cap (half of any rise above 3.0 over the Low Handicap Index) and hard cap (5.0), once there are 20 scores.
//  - Maximum Handicap Index 54.0. Course Handicap = Index × Slope/113 + (Course Rating − Par); half the Index for 9 holes.
//  - 9-hole scores (2024): the 9-hole differential plus an expected 9-hole differential for the holes not played.
//  - Scores are taken in date-played order, so a round posted late slots into the right place.
// Approximations (the published rules don't give a number to use):
//  - The expected 9-hole Score Differential: 0.52 × Index + 1.2. The USGA doesn't publish its table; this matches its
//    worked example (Index 14.0 → 8.5). Before a player has an Index, 9-hole scores are paired two at a time instead.
//  - A course with no 9-hole ratings: half the 18-hole Course Rating and the 18-hole Slope for each nine.
// Not done: the Playing Conditions Calculation (PCC is always 0; it needs every score posted at the course that day).

export const MAX_HI = 54;
export const STD_SLOPE = 113;

/** round to the nearest tenth, halves away from zero */
export const r1 = x => (Math.sign(x) * Math.round(Math.abs(x) * 10 + 1e-9) / 10) || 0;
/** round to a whole number, halves away from zero */
export const r0 = x => (Math.sign(x) * Math.round(Math.abs(x) + 1e-9)) || 0;

/** "+2.3" for a plus handicap (a negative number), "12.4" otherwise */
export const fmtHI = hi => hi == null ? '–' : hi < 0 ? '+' + (-hi).toFixed(1) : hi.toFixed(1);
export const fmtCH = ch => ch == null ? '–' : ch < 0 ? '+' + (-ch) : String(ch);

/** Rule 5.2a: how many of the lowest differentials to average, and the adjustment, for a record of n (3–20) */
export function indexRule(n) {
  if (n < 3) return null;
  if (n === 3) return { use: 1, adj: -2 };
  if (n === 4) return { use: 1, adj: -1 };
  if (n === 5) return { use: 1, adj: 0 };
  if (n === 6) return { use: 2, adj: -1 };
  if (n <= 8) return { use: 2, adj: 0 };
  if (n <= 11) return { use: 3, adj: 0 };
  if (n <= 14) return { use: 4, adj: 0 };
  if (n <= 16) return { use: 5, adj: 0 };
  if (n <= 18) return { use: 6, adj: 0 };
  if (n === 19) return { use: 7, adj: 0 };
  return { use: 8, adj: 0 };
}

/** Which holes a round covers, and the rating/slope/par to use for them.
 *  course: { holes:9|18, par:[…], si:[…], tees:[{ id, name, cr, slope, front:{cr,slope}?, back:{cr,slope}? }] }
 *  play: '18' (all 18 of an 18-hole course), 'front' / 'back' (9 of an 18-hole course), '9' (a 9-hole course),
 *        '9x2' (18 holes on a 9-hole course: round twice). Returns { holes, idx:[hole numbers 1-based], par, si, tee:{cr,slope,par}, approx }. */
export function roundSpec(course, teeId, play) {
  const tee = course.tees.find(t => t.id === teeId) || course.tees[0];
  if (!tee) return null;
  const n = course.holes, P = course.par.map(Number), SI = course.si.map(Number);
  const sum = a => a.reduce((x, y) => x + y, 0);
  if (n === 9 && play === '9x2') {
    const idx = [...Array(18)].map((_, i) => (i % 9) + 1);
    // rank the nine by stroke index (1–9), then odd numbers the first time round and even the second: a full 1–18 order
    const rk = new Array(9); SI.map((s, i) => [s, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).forEach(([, i], r) => { rk[i] = r + 1 });
    const si = idx.map((h, i) => rk[h - 1] * 2 - (i < 9 ? 1 : 0));
    return { holes: 18, idx, par: idx.map(h => P[h - 1]), si, tee: { cr: tee.cr * 2, slope: tee.slope, par: sum(P) * 2 }, approx: false };
  }
  if (n === 9) return { holes: 9, idx: P.map((_, i) => i + 1), par: P, si: SI, tee: { cr: tee.cr, slope: tee.slope, par: sum(P) } };
  if (play === 'front' || play === 'back') {
    const off = play === 'front' ? 0 : 9, idx = [...Array(9)].map((_, i) => off + i + 1), part = tee[play];
    const par = idx.map(h => P[h - 1]), has = part && part.cr != null && part.slope;
    return { holes: 9, idx, par, si: idx.map(h => SI[h - 1]),
             tee: has ? { cr: +part.cr, slope: +part.slope, par: sum(par) } : { cr: tee.cr / 2, slope: tee.slope, par: sum(par) }, approx: !has };
  }
  return { holes: 18, idx: P.map((_, i) => i + 1), par: P, si: SI, tee: { cr: tee.cr, slope: tee.slope, par: sum(P) } };
}

/** Course Handicap for the holes being played (unrounded and rounded). The tee's rating, slope and par are for those holes. */
export function courseHandicap(hi, tee, holes) {
  if (hi == null || !tee || tee.cr == null || !tee.slope) return null;
  const base = holes === 9 ? hi / 2 : hi;
  const raw = base * (tee.slope / STD_SLOPE) + (tee.cr - tee.par);
  return { raw, ch: r0(raw) };
}

/** Handicap strokes on each hole for a Course Handicap ch, given the holes' stroke index (lower = harder).
 *  A plus handicap (ch < 0) gives strokes back, starting on the easiest holes. */
export function strokesPerHole(ch, si) {
  const n = si.length;
  const order = si.map((s, i) => [Number(s) || 99, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const rank = new Array(n); order.forEach(([, i], r) => { rank[i] = r + 1 });   // 1 = hardest of the holes played
  if (ch >= 0) { const all = Math.floor(ch / n), extra = ch % n; return rank.map(r => all + (r <= extra ? 1 : 0)) }
  const back = Math.min(-ch, n);
  return rank.map(r => (r > n - back ? -1 : 0));
}

/** Adjusted Gross Score. gross per hole: a number, 0 = picked up (counts as the maximum), null = not played (counts as net par).
 *  Returns per-hole adjusted scores, the maximum per hole, and how many holes were actually played. */
export function adjustScore(gross, par, si, hi, tee) {
  const holes = gross.length;
  let strokes = new Array(holes).fill(0), ch = null;
  if (hi != null) { const c = courseHandicap(hi, tee, holes); ch = c ? c.ch : 0; strokes = strokesPerHole(ch, si) }
  // Rule 3.1: net double bogey = par + 2 + strokes received. "Where a Course Handicap is calculated at more than 54 and a
  // player receives 4 or more strokes on a hole, the maximum hole score is par + 5." (4 strokes on a hole only happens
  // above 54 for 18 holes, or above 27 for 9.) Before an Index exists: par + 5.
  const cap = par.map((p, i) => hi == null ? p + 5 : strokes[i] >= 4 ? p + 5 : p + 2 + strokes[i]);
  const netPar = par.map((p, i) => p + strokes[i]);
  const adj = gross.map((g, i) => g == null ? netPar[i] : g <= 0 ? cap[i] : Math.min(g, cap[i]));
  return { adj, cap, netPar, ch, ags: adj.reduce((a, x) => a + x, 0), played: gross.filter(g => g != null).length,
           gross: gross.reduce((a, g) => a + (g > 0 ? g : 0), 0), changed: adj.map((a, i) => gross[i] == null ? 'np' : a !== gross[i] ? 'cap' : '') };
}

/** fewest holes that must be played for a 9- or 18-hole score; and a player without an Index must finish every hole */
export const minHoles = (holes, hasIndex) => !hasIndex ? holes : holes === 9 ? 7 : 14;

/** Score Differential for the holes played (not yet converted to 18 holes), unrounded. pcc is the 18-hole PCC value. */
export function rawDifferential(ags, tee, holes, pcc = 0) {
  return (STD_SLOPE / tee.slope) * (ags - tee.cr - (holes === 9 ? pcc / 2 : pcc));
}

/** expected 9-hole Score Differential for a Handicap Index (approximation, see the header) */
export const expected9 = hi => 0.52 * hi + 1.2;

/** A score read back from the database, made safe: numbers are numbers, arrays are the right length, or null if unusable
 *  (so a malformed record can't break the page or the maths). */
export function cleanScore(x) {
  if (!x || typeof x !== 'object') return null;
  const holes = x.holes === 9 || x.holes === 18 ? x.holes : null, num = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
  if (!holes || !/^\d{4}-\d{2}-\d{2}$/.test(String(x.date || ''))) return null;
  const arr = (a, f) => Array.isArray(a) && a.length === holes ? a.map(f) : null;
  const par = arr(x.par, v => Number.isInteger(v) && v >= 3 && v <= 6 ? v : null), si = arr(x.si, v => num(v));
  const tee = x.tee && typeof x.tee === 'object' ? { cr: num(x.tee.cr), slope: num(x.tee.slope), par: num(x.tee.par) } : null;
  if (!par || par.includes(null) || !si || si.includes(null) || !tee || tee.cr == null || !(tee.slope >= 55 && tee.slope <= 155) || tee.par == null) return null;
  const out = { ...x, holes, par, si, tee, date: String(x.date), created: num(x.created) || 0 };
  out.idx = arr(x.idx, v => Number.isInteger(v) && v >= 1 && v <= 18 ? v : null) || par.map((_, i) => i + 1);
  if (out.idx.includes(null)) out.idx = par.map((_, i) => i + 1);
  if (x.total != null) { const t = num(x.total); if (t == null || !Number.isInteger(t) || t < holes || t > 20 * holes) return null; out.total = t; delete out.gross }
  else { const g = arr(x.gross, v => v == null ? null : Number.isInteger(v) && v >= 0 && v <= 20 ? v : NaN); if (!g || g.some(Number.isNaN)) return null; out.gross = g; delete out.total }
  return out;
}

/** Check one score before posting. Returns a list of problems (empty = fine). */
export function checkScore(s, hiBefore) {
  const out = [];
  if (!s.tee || s.tee.cr == null || !(s.tee.slope >= 55 && s.tee.slope <= 155)) out.push('This tee has no Course Rating and Slope yet (Slope must be 55–155).');
  if (s.total != null) {
    const caps = s.tee && s.tee.slope && Array.isArray(s.par) && s.par.length ? adjustScore(s.par.map(() => 0), s.par, s.si, hiBefore, s.tee).ags : Infinity;
    if (!(s.total > 0) || !Number.isInteger(s.total)) out.push('Enter the total.');
    else if (s.total < s.holes) out.push(`A ${s.holes}-hole total can't be under ${s.holes}.`);
    else if (s.total > caps) out.push(`That's more than your maximum for these holes (${caps}). Bring each hole down to its maximum before adding up.`);
  } else {
    const played = s.gross.filter(g => g != null).length, need = minHoles(s.holes, hiBefore != null);
    if (played < need) out.push(hiBefore == null
      ? `Enter a score for every hole (until you have a Handicap Index, every hole must be played).`
      : `Play at least ${need} of the ${s.holes} holes to post a ${s.holes}-hole score.`);
    if (s.gross.some(g => g != null && (g < 0 || g > 20 || !Number.isInteger(g)))) out.push('Hole scores must be whole numbers from 1 to 20 (or P for a pick-up).');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date || '')) out.push('Pick the date played.');
  return out;
}

/** The whole scoring record, worked through in date-played order. Each score:
 *    { id, date:'YYYY-MM-DD', holes:9|18, gross:[…] | total:number (already adjusted), par:[…], si:[…], tee:{cr,slope,par}, created? }
 *  opts.startHI: a starting Index (e.g. from an official handicap) used until the player's own scores give one.
 *  Returns the current Handicap Index and the record (each row's differential, whether it counts, and the Index after it). */
export function computeRecord(scores, opts = {}) {
  // a round dated after today (opts.today) doesn't count yet: it would otherwise move the 12-month window for the caps
  const list = [...scores].filter(s => !opts.today || s.date <= opts.today).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.created || 0) - (b.created || 0));
  const start = opts.startHI != null && opts.startHI !== '' ? Math.min(+opts.startHI, MAX_HI) : null;
  const diffs = [];      // 18-hole Score Differentials: { ids:[…], date, diff (rounded), raw, esr (reductions applied) }
  const rows = [];       // one per score posted
  const history = [];    // { date, hi, n } after each new differential
  let own = null, wait9 = null;
  const cur = () => own != null ? own : start;

  const lowIndex = date => {      // Low Handicap Index: lowest Index of the 365 days up to this score, once 20 differentials exist
    const from = new Date(new Date(date + 'T00:00:00Z').getTime() - 365 * 864e5).toISOString().slice(0, 10);
    const xs = history.filter(h => h.n >= 20 && h.date >= from && h.date <= date).map(h => h.hi);
    return xs.length ? Math.min(...xs) : null;
  };
  const indexNow = date => {
    const recent = diffs.slice(-20), rule = indexRule(recent.length);
    if (!rule) return { hi: null, used: [] };
    const sorted = recent.map(d => ({ d, v: r1(d.diff + d.esr) })).sort((a, b) => a.v - b.v).slice(0, rule.use);
    let v = r1(sorted.reduce((a, x) => a + x.v, 0) / rule.use + rule.adj), capped = null;
    if (recent.length >= 20) {
      const low = lowIndex(date);
      if (low != null && v - low > 3) {
        const soft = low + 3 + (v - low - 3) / 2, nv = r1(Math.min(soft, low + 5));
        if (nv < v) { capped = { from: v, low, kind: soft <= low + 5 ? 'soft' : 'hard' }; v = nv }
      }
    }
    return { hi: Math.min(v, MAX_HI), used: sorted.map(x => x.d), capped };
  };

  for (const s of list) {
    const hiB = cur(), row = { id: s.id, date: s.date, holes: s.holes, hiBefore: hiB, total: s.total ?? null };
    let ags;
    if (s.total != null) { ags = +s.total; row.gross = ags; row.ags = ags }
    else {
      const a = adjustScore(s.gross, s.par, s.si, hiB, s.tee);
      ags = a.ags; Object.assign(row, { gross: a.gross, ags, adj: a.adj, changed: a.changed, played: a.played });
    }
    row.ch = courseHandicap(hiB, s.tee, s.holes);
    const raw = rawDifferential(ags, s.tee, s.holes);
    row.diffHoles = r1(raw);
    let d = null;
    if (s.holes === 18) d = { ids: [s.id], date: s.date, raw, diff: r1(raw), esr: 0, kind: '18' };
    else if (hiB != null) {                                     // 2024 method: this 9 + the expected score for the other 9
      // as in the USGA's worked example: the 9-hole differential (to a tenth) + the expected 9-hole differential (to a tenth)
      const e = r1(expected9(hiB)), v = r1(raw) + e;
      d = { ids: [s.id], date: s.date, raw: v, diff: r1(v), esr: 0, kind: '9+expected', expected: e };
    } else if (wait9) {                                         // no Index yet: two 9-hole scores make one 18-hole differential
      const v = wait9.raw + raw;
      d = { ids: [wait9.id, s.id], date: s.date, raw: v, diff: r1(v), esr: 0, kind: '9+9' };
      wait9.row.pairedWith = s.id; wait9.row.waiting = false; wait9.row.kind = '9+9'; row.pairedWith = wait9.id; wait9 = null;
    } else { wait9 = { id: s.id, raw, row }; row.waiting = true }
    if (d) {
      diffs.push(d); Object.assign(row, { diff: d.diff, kind: d.kind, expected: d.expected });
      if (own != null) {   // exceptional score (Rule 5.9): "based on the difference between the Score Differential (unrounded) and the player's Handicap Index"
        const better = own - d.raw, cut = better >= 10 ? -2 : better >= 7 ? -1 : 0;
        if (cut) { diffs.slice(-20).forEach(x => { x.esr += cut }); row.esr = cut }
      }
      const had = own != null, now = indexNow(s.date);
      if (now.hi != null) { own = now.hi; history.push({ date: s.date, hi: own, n: diffs.length }) }
      row.hiAfter = cur(); row.capped = now.capped || null;
      if (!had && own != null && wait9) {   // first Index just arrived: a 9 still waiting for a partner now counts with the expected score
        const e = r1(expected9(own)), v = r1(wait9.raw) + e, w = wait9.row;
        diffs.push({ ids: [wait9.id], date: s.date, raw: v, diff: r1(v), esr: 0, kind: '9+expected', expected: e });
        Object.assign(w, { waiting: false, diff: r1(v), kind: '9+expected', expected: e }); wait9 = null;
        const n2 = indexNow(s.date); if (n2.hi != null) { own = n2.hi; history.push({ date: s.date, hi: own, n: diffs.length }) } row.hiAfter = own;
      }
    }
    rows.push(row);
  }
  const last = list.length ? list[list.length - 1].date : '9999-12-31';
  const fin = indexNow(last);
  const usedIds = new Set(fin.used.flatMap(d => d.ids)), inWindow = new Set(diffs.slice(-20).flatMap(d => d.ids));
  rows.forEach(r => { r.counts = usedIds.has(r.id); r.recent = inWindow.has(r.id) });
  return {
    hi: own,                                   // the player's own Handicap Index (null until 3 differentials)
    working: cur(),                            // what's used today: own Index, else the starting one
    rows: rows.reverse(), diffs, history, capped: fin.capped || null,
    low: list.length ? lowIndex(last) : null,
    needed: own == null ? Math.max(0, 3 - diffs.length) : 0,
    waiting9: !!wait9,
  };
}
