// 時刻(JST)とコアタイム判定の純粋関数。Firebase に依存しないので Node でもテストできる。
// 端末のタイムゾーン設定に関係なく、すべて日本時間で計算する(日本は夏時間なし)。

const JST_OFFSET_MS = 9 * 3600e3;
const RESET_HM = "04:00";   // この時刻に全員を「帰宅/不在」へ自動リセット(付けっぱなし対策)
const DEFAULT_SETTINGS = { coreWeekdays: [2, 3, 4], coreStart: "10:00", coreEnd: "15:00", toleranceMin: 10 };
const WEEKDAY_JA = "月火水木金土日";

const pad2 = n => String(n).padStart(2, "0");

/** Date → JST の "YYYY-MM-DD" */
function ymdOf(date) {
  const x = new Date(date.getTime() + JST_OFFSET_MS);
  return `${x.getUTCFullYear()}-${pad2(x.getUTCMonth() + 1)}-${pad2(x.getUTCDate())}`;
}
/** Date → JST の "HH:MM" */
function hmOf(date) {
  const x = new Date(date.getTime() + JST_OFFSET_MS);
  return `${pad2(x.getUTCHours())}:${pad2(x.getUTCMinutes())}`;
}
/** "YYYY-MM-DD" + "HH:MM"(JST) → Date */
function jstDate(ymd, hm = "00:00") { return new Date(`${ymd}T${hm}:00+09:00`); }
function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** 月=0 … 日=6 */
function weekdayOf(ymd) { return (new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7; }
function labelOf(ymd) { return `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}(${WEEKDAY_JA[weekdayOf(ymd)]})`; }

/** now 以前で最も新しいリセット時刻(JST 4:00) */
function latestReset(now) {
  const today = ymdOf(now);
  const r = jstDate(today, RESET_HM);
  return now < r ? jstDate(addDays(today, -1), RESET_HM) : r;
}
/** その日の集計開始時刻(=リセット時刻) */
function dayStart(ymd) { return jstDate(ymd, RESET_HM); }

function normSettings(s) { return { ...DEFAULT_SETTINGS, ...(s || {}) }; }
function isCoreDay(ymd, cfg, noCore) { return cfg.coreWeekdays.includes(weekdayOf(ymd)) && !(ymd in noCore); }
function coreWindow(ymd, cfg) { return [jstDate(ymd, cfg.coreStart), jstDate(ymd, cfg.coreEnd)]; }

/**
 * イベント列から、[from, to) の区間ごとのステータスを作る。
 * 毎朝のリセットにより from(4:00)時点の状態は「不在」とみなせる。
 * events: [{memberId, status, at: Date}] → { memberId: [[開始, 終了, status], ...] }
 */
function buildTimelines(events, from, to) {
  const sorted = events.filter(e => e.at >= from && e.at < to).sort((a, b) => a.at - b.at);
  const cur = {}, out = {};
  for (const e of sorted) {
    const [s, st] = cur[e.memberId] || [from, "absent"];
    if (e.at > s) (out[e.memberId] ||= []).push([s, e.at, st]);
    cur[e.memberId] = [e.at, e.status];
  }
  for (const [mid, [s, st]] of Object.entries(cur)) if (to > s) (out[mid] ||= []).push([s, to, st]);
  return out;
}

const overlapMin = (s, e, a, b) => Math.max(0, (Math.min(e, b) - Math.max(s, a)) / 60000);

/** 1人・1日分のコアタイム判定 */
function dayResult(tl, ymd, cfg, now, hasSchedule) {
  const [cs, ce] = coreWindow(ymd, cfg);
  const tol = cfg.toleranceMin * 60000;
  const full = (ce - cs) / 60000;
  const effEnd = new Date(Math.min(ce, now));
  let present = 0, away = 0, leave = 0, arrival = null, departure = null;
  for (const [s, e, st] of tl || []) {
    if (effEnd > cs) {
      const m = overlapMin(s, e, cs, effEnd);
      if (st === "present") present += m; else if (st === "away") away += m; else if (st === "leave") leave += m;
    }
    if ((st === "present" || st === "away") && e > s) { arrival ||= s; departure = e; }
  }
  const inMin = present + away;
  const started = now > cs, finished = now >= ce;
  const leftAt = departure && departure < Math.min(ce, now) && departure > cs ? departure : null;
  let mark;
  if (now < jstDate(ymd)) mark = "";
  else if (hasSchedule || (leave > 0 && inMin < full - cfg.toleranceMin)) mark = "休";
  else if (!started) mark = "";
  else if (inMin >= full - cfg.toleranceMin) mark = "◯";
  else if (inMin > 0) mark = finished ? "△" : "…";
  else mark = finished ? "✕" : "…";
  return {
    date: ymd, mark,
    inMin: Math.round(inMin), presentMin: Math.round(present), awayMin: Math.round(away), fullMin: Math.round(full),
    arrival: arrival && ymdOf(arrival) === ymd ? hmOf(arrival) : null,
    late: !!(arrival && arrival - cs > tol && inMin > 0),
    leftAt: leftAt ? hmOf(leftAt) : null,
    early: !!(leftAt && ce - leftAt > tol),
    vacation: !!hasSchedule,
  };
}

/** 期間 [d0, d1] のコアタイム日ごとの判定 */
function rangeReport(members, events, schedules, cfg, noCore, d0, d1, now) {
  const days = [];
  for (let d = d0; d <= d1; d = addDays(d, 1)) if (isCoreDay(d, cfg, noCore)) days.push(d);
  const sched = new Set(schedules.map(s => `${s.memberId}_${s.date}`));
  const report = Object.fromEntries(members.map(m => [m.id, []]));
  for (const d of days) {
    const from = dayStart(d), to = new Date(Math.min(dayStart(addDays(d, 1)), Math.max(now, from)));
    const tls = buildTimelines(events, from, to);
    for (const m of members) report[m.id].push(dayResult(tls[m.id], d, cfg, now, sched.has(`${m.id}_${d}`)));
  }
  return { days, report };
}

function summarize(results) {
  const done = results.filter(r => ["◯", "△", "✕"].includes(r.mark));
  const full = done.reduce((a, r) => a + r.fullMin, 0), inm = done.reduce((a, r) => a + r.inMin, 0);
  const cnt = f => done.filter(f).length;
  return {
    days: done.length, ok: cnt(r => r.mark === "◯"), partial: cnt(r => r.mark === "△"), ng: cnt(r => r.mark === "✕"),
    vacation: results.filter(r => r.mark === "休").length, late: cnt(r => r.late), early: cnt(r => r.early),
    rate: full ? Math.round(100 * inm / full) : null,
  };
}

/** 画面上部のバナー用:今日のコアタイムの状態 */
function coreInfo(now, cfg, noCore) {
  const today = ymdOf(now);
  const info = { today, isCoreDay: isCoreDay(today, cfg, noCore), excludedNote: noCore[today] ?? null, phase: "none" };
  if (info.isCoreDay) {
    const [cs, ce] = coreWindow(today, cfg);
    info.phase = now < cs ? "before" : now < ce ? "during" : "after";
    info.startAt = cs; info.endAt = ce;
  }
  for (let i = 1; i < 60; i++) {
    const d = addDays(today, i);
    if (isCoreDay(d, cfg, noCore)) { info.nextDay = labelOf(d); break; }
  }
  return info;
}

if (typeof module !== "undefined") {
  module.exports = { ymdOf, hmOf, jstDate, addDays, weekdayOf, labelOf, latestReset, dayStart, normSettings,
    isCoreDay, buildTimelines, dayResult, rangeReport, summarize, coreInfo, DEFAULT_SETTINGS };
}
