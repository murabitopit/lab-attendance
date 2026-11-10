// 座席表ページ。Firestore の変更を購読し、変更があれば即座に描画し直す。
const S = {
  settings: normSettings({}), members: [], messages: [], noCore: {}, schedules: [], events: [],
  loaded: false,
};
let today = null;
let unsubDaily = [];
let calendar = null;
let durMin = 60;
let lastMemberKey = "";
let renderQueued = false;

// ───── 購読 ─────
function subscribeDaily() {
  unsubDaily.forEach(u => u());
  today = ymdOf(new Date());
  unsubDaily = [
    Store.onSchedulesFrom(today, v => { S.schedules = v; queueRender(); calendar?.refetchEvents(); }),
    Store.onEventsSince(dayStart(today), v => { S.events = v; queueRender(); }),
  ];
}

function start() {
  buildRoom();
  initCalendar();
  Store.onSettings(v => { S.settings = v; queueRender(); });
  Store.onNoCore(v => { S.noCore = v; queueRender(); calendar?.refetchEvents(); });
  Store.onMessages(v => { S.messages = v; queueRender(); });
  Store.onMembers(v => {
    const first = !S.loaded;
    S.members = v; S.loaded = true; queueRender();
    if (first) Store.maybeReset(v).catch(console.error);
  }, meta => {
    const live = $("live");
    const off = meta.error || meta.fromCache;
    live.classList.toggle("stale", !!off);
    $("live-text").textContent = meta.error ? "接続エラー(再読み込みしてください)"
      : off ? "オフライン(再接続を待っています)" : "リアルタイム同期中";
  });
  subscribeDaily();
  // 日付が変わった・朝4時を過ぎたときの処理
  setInterval(() => {
    if (ymdOf(new Date()) !== today) subscribeDaily();
    if (S.loaded) Store.maybeReset(S.members).catch(console.error);
  }, 60000);
  setInterval(tick, 1000);
  setInterval(queueRender, 20000);   // 在室時間バーを進める
}

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

// ───── 派生データ ─────
function vacationToday(m) { return S.schedules.some(s => s.memberId === m.id && s.date === today); }
function displayStatus(m) { return vacationToday(m) && NOT_IN_ROOM.includes(m.status) ? "leave" : m.status; }
function coreNow() { return coreInfo(new Date(), S.settings, S.noCore); }
function coreToday() {
  const now = new Date();
  const tls = buildTimelines(S.events, dayStart(today), new Date(Math.max(now, dayStart(today))));
  return Object.fromEntries(S.members.map(m => [m.id, dayResult(tls[m.id], today, S.settings, now, vacationToday(m))]));
}
function activeMessages() { const now = new Date(); return S.messages.filter(m => m.expiresAt > now); }

// ───── 描画 ─────
function buildRoom() {
  const seat = id => el("div", { class: "seat", id: "seat-" + id }, el("span", { class: "sid" }, id), el("span", { class: "nm" }));
  $("room").replaceChildren(
    el("div", { class: "desk" }, SEAT_IDS.slice(0, 8).map(seat)),
    el("div", { class: "desk" }, SEAT_IDS.slice(8, 16).map(seat)),
    el("div", { class: "desk teacher" }, SEAT_IDS.slice(16).map(seat)));
}

function render() {
  if (!S.loaded) return;
  const key = JSON.stringify(S.members.map(m => [m.id, m.name, m.grade, m.seatId]));
  if (key !== lastMemberKey) {
    fillMemberSelect($("me"), S.members);
    lastMemberKey = key;
    calendar?.refetchEvents();   // カレンダーの名前表示を更新
  }
  const core = coreNow();
  const ct = core.isCoreDay ? coreToday() : {};
  renderSeats(core);
  renderMine(ct);
  renderBoard();
  renderCore(core, ct);
  tick();
  cleanupExpired();
}

function isWarn(m, core) {
  return core.phase === "during" && !vacationToday(m) && NOT_IN_ROOM.includes(m.status) && m.grade !== "先生";
}

function renderSeats(core) {
  const me = $("me").value;
  const latest = {};
  for (const msg of activeMessages()) if (!(msg.memberId in latest)) latest[msg.memberId] = msg.text;
  document.querySelectorAll("#room .seat").forEach(s => {
    s.className = "seat";
    s.querySelector(".nm").textContent = "";
    s.querySelector(".cm")?.remove();
    s.removeAttribute("title");
  });
  const seatless = [];
  for (const m of S.members) {
    const seat = m.seatId && $("seat-" + m.seatId);
    if (!seat) { seatless.push(m); continue; }
    const st = displayStatus(m);
    seat.classList.add(st);
    if (isWarn(m, core)) seat.classList.add("warn");
    if (m.id === me) seat.classList.add("me");
    seat.querySelector(".nm").textContent = m.name;
    seat.title = `${m.grade} ${m.name}:${STATUS_LABEL[st]}`;
    if (latest[m.id]) seat.append(el("span", { class: "cm" }, "💬 " + latest[m.id]));
  }
  $("seatless").replaceChildren(...(seatless.length ? [
    el("span", { class: "live" }, "席なし: "),
    ...seatless.map(m => el("span", { class: "chip st-" + displayStatus(m), title: STATUS_LABEL[displayStatus(m)] }, m.name)),
  ] : []));
}

function renderMine(ct) {
  const m = S.members.find(x => x.id === $("me").value);
  document.querySelectorAll(".status-buttons button").forEach(b =>
    b.classList.toggle("on", !!m && b.dataset.status === m.status));
  if (!m) { $("mine-info").textContent = "名前を選ぶと、この端末に記憶されます。"; return; }
  const since = m.statusSince ? `${ymdOf(m.statusSince).slice(5).replace("-", "/")} ${hmOf(m.statusSince)}` : "";
  let txt = `現在:${STATUS_ICON[m.status]} ${STATUS_LABEL[m.status]}` + (since ? `(${since}〜)` : "");
  const c = ct[m.id];
  if (c && c.mark !== "休") txt += ` / 今日のコア在室 ${c.inMin}分・${c.fullMin}分中`;
  if (vacationToday(m)) txt += " / 今日は休暇登録あり";
  $("mine-info").textContent = txt;
}

function renderBoard() {
  const now = new Date();
  const nameOf = id => S.members.find(m => m.id === id)?.name ?? "(削除済み)";
  const items = activeMessages().map(msg => {
    const total = (msg.expiresAt - msg.createdAt) / 1000, left = (msg.expiresAt - now) / 1000;
    const pct = Math.max(0, Math.min(100, 100 * left / total));
    return el("li", {},
      el("div", {},
        el("div", { class: "who" }, nameOf(msg.memberId)),
        el("div", { class: "txt" }, msg.text),
        el("div", { class: "meta", "data-exp": msg.expiresAt.getTime(), "data-made": hmOf(msg.createdAt) }, ""),
        el("div", { class: "life" }, el("span", { "data-total": total, style: `width:${pct}%` }))),
      el("button", { class: "small", title: "消す", onclick: () => deleteMessage(msg.id) }, "✕"));
  });
  $("board").replaceChildren(...(items.length ? items : [el("li", { class: "empty" }, "いまは掲示がありません")]));
}

function cleanupExpired() {
  // サーバーが無いので、期限切れに気づいた端末が消しておく(失敗しても表示上は消えている)
  const now = new Date();
  for (const m of S.messages) if (m.expiresAt <= now) Store.deleteMessage(m.id).catch(() => {});
}

function coreTag(m, c, phase) {
  if (!c) return el("span");
  if (c.mark === "休") return el("span", { class: "tag none" }, "休暇");
  const inRoom = m.status === "present" || m.status === "away";
  if (phase === "before") {
    return inRoom ? el("span", { class: "tag ok" }, `来室済 ${c.arrival ?? ""}`) : el("span", { class: "tag none" }, "未来室");
  }
  if (phase === "during") {
    if (m.status === "present") return el("span", { class: "tag ok" }, c.late ? `在室(${c.arrival}来室)` : "在室");
    if (m.status === "away") return el("span", { class: "tag info" }, "離席中");
    if (c.inMin === 0) return el("span", { class: "tag warn" }, "未出席");
    return el("span", { class: "tag warn" }, `${STATUS_LABEL[m.status]}(${c.leftAt ?? ""}退室)`);
  }
  const t = { "◯": ["ok", "達成"], "△": ["warn", "一部在室"], "✕": ["warn", "不在"] }[c.mark] ?? ["none", c.mark];
  return el("span", { class: "tag " + t[0] }, t[1]);
}

function renderCore(core, ct) {
  $("core-card").hidden = !core.isCoreDay;
  if (!core.isCoreDay) return;
  const rows = S.members.filter(m => m.grade !== "先生").map(m => {
    const c = ct[m.id];
    return el("li", {},
      el("span", { style: "overflow:hidden; text-overflow:ellipsis; white-space:nowrap" }, `${m.grade} ${m.name}`),
      el("div", {},
        el("div", { class: "bar", title: `出席 ${c.presentMin}分 / 離席 ${c.awayMin}分` },
          el("span", { class: "p", style: `width:${100 * c.presentMin / c.fullMin}%` }),
          el("span", { class: "a", style: `width:${100 * c.awayMin / c.fullMin}%` })),
        el("div", { class: "live" }, `${c.inMin} / ${c.fullMin}分`)),
      coreTag(m, c, core.phase));
  });
  $("core-list").replaceChildren(...rows);
}

// 1秒ごと:時計・残り時間
let lastPhase = null;
function tick() {
  if (!S.loaded) return;
  const now = new Date();
  const core = coreNow();
  if (lastPhase !== null && core.phase !== lastPhase) queueRender();
  lastPhase = core.phase;
  const cfg = S.settings;
  const wd = cfg.coreWeekdays.map(i => WEEKDAY_JA[i]).join("");
  const span = `${cfg.coreStart}〜${cfg.coreEnd}`;
  $("banner").className = "banner " + core.phase;
  let title, sub, clock = "";
  if (core.phase === "during") {
    title = "🟢 コアタイム中"; sub = `本日 ${span} · 終了まで`; clock = fmtDuration((core.endAt - now) / 1000);
  } else if (core.phase === "before") {
    title = "⏳ 本日はコアタイムの日"; sub = `${span} · 開始まで`; clock = fmtDuration((core.startAt - now) / 1000);
  } else if (core.phase === "after") {
    title = "✅ 本日のコアタイムは終了しました"; sub = core.nextDay ? `次回:${core.nextDay} ${span}` : "";
  } else {
    title = core.excludedNote !== null ? `本日はコアタイムなし(${core.excludedNote || "休講日"})` : "本日はコアタイムなし";
    sub = `コアタイム:毎週${wd} ${span}` + (core.nextDay ? ` · 次回 ${core.nextDay}` : "");
  }
  $("banner-title").textContent = title;
  $("banner-sub").textContent = sub;
  $("banner-clock").textContent = clock;
  let expired = false;
  document.querySelectorAll("#board .meta[data-exp]").forEach(e => {
    const left = (Number(e.dataset.exp) - now) / 1000;
    if (left <= 0) expired = true;
    e.textContent = `${e.dataset.made} 投稿 · ${fmtRemain(left)}`;
    const bar = e.nextElementSibling.firstChild;
    bar.style.width = `${Math.max(0, Math.min(100, 100 * left / Number(bar.dataset.total)))}%`;
  });
  if (expired) queueRender();
}

// ───── 操作 ─────
$("me").addEventListener("change", e => { myId.set(e.target.value); queueRender(); });

document.querySelectorAll(".status-buttons button").forEach(btn => btn.addEventListener("click", async () => {
  const id = $("me").value;
  if (!id) { toast("先に自分の名前を選んでください"); return; }
  myId.set(id);
  await attempt(() => Store.setStatus(id, btn.dataset.status), `${STATUS_LABEL[btn.dataset.status]} にしました`).catch(() => {});
}));

document.querySelectorAll("#dur-buttons button").forEach(btn => btn.addEventListener("click", () => {
  document.querySelectorAll("#dur-buttons button").forEach(b => b.classList.remove("on"));
  btn.classList.add("on");
  durMin = btn.dataset.min === "today"
    ? Math.max(1, Math.round((jstDate(ymdOf(new Date()), "23:59") - new Date()) / 60000))
    : Number(btn.dataset.min);
  $("dur-h").value = Math.floor(durMin / 60);
  $("dur-m").value = durMin % 60;
}));
["dur-h", "dur-m"].forEach(id => $(id).addEventListener("input", () => {
  document.querySelectorAll("#dur-buttons button").forEach(b => b.classList.remove("on"));
  durMin = (Number($("dur-h").value) || 0) * 60 + (Number($("dur-m").value) || 0);
}));

async function postMessage() {
  const id = $("me").value;
  const text = $("msg-text").value.trim();
  if (!id) { toast("先に自分の名前を選んでください"); return; }
  if (!text) { toast("ひとことを入力してください"); return; }
  if (durMin <= 0) { toast("表示時間を1分以上にしてください"); return; }
  await attempt(() => Store.postMessage(id, text, Math.min(durMin, 72 * 60))).then(() => { $("msg-text").value = ""; }).catch(() => {});
}
$("msg-post").addEventListener("click", postMessage);
$("msg-text").addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing) postMessage(); });

async function deleteMessage(id) {
  if (!confirm("この掲示を消しますか?")) return;
  await attempt(() => Store.deleteMessage(id)).catch(() => {});
}

// ───── カレンダー(表示中の月の休暇だけ取得) ─────
function initCalendar() {
  if (!window.FullCalendar) return;
  const narrow = window.matchMedia("(max-width: 520px)").matches;
  calendar = new FullCalendar.Calendar($("calendar"), {
    initialView: narrow ? "listMonth" : "dayGridMonth",
    locale: "ja", height: "auto",
    headerToolbar: { left: "prev,next today", center: "title", right: "dayGridMonth,listMonth" },
    buttonText: { today: "今日", month: "月", list: "一覧" },
    noEventsText: "予定はありません", allDayText: "終日",
    events: async (info, ok, ng) => {
      try {
        const sch = await Store.getSchedules(info.startStr.slice(0, 10), info.endStr.slice(0, 10));
        const nameOf = id => S.members.find(m => m.id === id)?.name;
        ok([
          ...sch.filter(s => nameOf(s.memberId)).map(s => ({
            title: `${nameOf(s.memberId)}(休)${s.note ? " " + s.note : ""}`, start: s.date, allDay: true, color: "#374151" })),
          ...Object.entries(S.noCore).map(([d, note]) => ({ title: `コアなし ${note}`, start: d, allDay: true, color: "#9ca3af" })),
        ]);
      } catch (e) { ng(e); }
    },
  });
  calendar.render();
}

boot(start);
