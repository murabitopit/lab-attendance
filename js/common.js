// 画面共通のユーティリティ
// absent(不在)は初期値で、毎朝4:00にも全員この状態へ戻る
const STATUS_LABEL = { present: "出席", away: "離席", home: "帰宅", absent: "不在", leave: "休暇" };
const STATUS_ICON = { present: "🟢", away: "🟡", home: "🔴", absent: "⚪", leave: "⚫" };
const NOT_IN_ROOM = ["home", "absent"];
const SEAT_IDS = [..."ABCD"].flatMap(r => [1, 2, 3, 4].map(c => r + c)).concat(["T1", "T2"]);
const GRADES = ["B4", "M1", "M2", "D", "先生", "その他"];
const $ = id => document.getElementById(id);

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "style") e.style.cssText = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}
function fmtRemain(sec) {
  if (sec <= 0) return "まもなく消えます";
  const m = Math.ceil(sec / 60);
  if (m < 60) return `あと${m}分`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `あと${h}時間${r}分` : `あと${h}時間`;
}

let toastTimer;
function toast(msg) {
  let t = document.querySelector(".toast");
  if (!t) { t = el("div", { class: "toast" }); document.body.append(t); }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

/** 書き込み処理を包み、失敗時はトーストで知らせる */
async function attempt(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) { console.error(e); toast(e.message && !/^\w+\/[\w-]+/.test(e.message) ? e.message : "保存に失敗しました(通信状況を確認してください)"); throw e; }
}

const myId = {
  get() { try { return localStorage.getItem("labMemberId") || ""; } catch (_) { return ""; } },
  set(v) { try { localStorage.setItem("labMemberId", v); } catch (_) { /* プライベートモード等 */ } },
};

function memberLabel(m) { return `${m.grade} ${m.name}` + (m.seatId ? ` (席${m.seatId})` : ""); }

function fillMemberSelect(select, members, placeholder = "名前を選択") {
  const cur = select.value || myId.get();
  select.replaceChildren(el("option", { value: "" }, placeholder),
    ...members.map(m => el("option", { value: m.id }, memberLabel(m))));
  if (members.some(m => m.id === cur)) select.value = cur;
}

/** Firebase に接続してからページ本体を始める。未設定・失敗時は案内を表示 */
async function boot(main) {
  try {
    await Store.init();
  } catch (e) {
    console.error(e);
    const msg = e.message === "NOT_CONFIGURED"
      ? "Firebase がまだ設定されていません。js/firebase-config.js に設定を書き込んでください(README.md 参照)。"
      : "サーバーに接続できませんでした。通信状況を確認して再読み込みしてください。";
    document.querySelector(".wrap").prepend(el("div", { class: "card", style: "background:var(--warn-bg)" }, msg));
    return;
  }
  main();
}

/**
 * 管理者ロック(コアタイム集計・コアタイム設定)。
 * サーバーが無いためブラウザ側での簡易ロック。パスワードそのものではなく SHA-256 ハッシュだけを置いている。
 * 一度解除するとタブを閉じるまで有効(sessionStorage)。
 */
const Admin = (() => {
  const HASH = "84689d1299af4da7678a848ccd0d58e6b8fcfb6398312badd709d6fff6d6c4aa";
  const KEY = "labAdminUnlocked";
  async function sha256(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  function unlocked() { try { return sessionStorage.getItem(KEY) === HASH; } catch (_) { return false; } }
  /** container の中にパスワード入力欄を出し、正しければ onUnlock を呼ぶ(解除済みなら即呼ぶ) */
  function gate(container, onUnlock, autofocus = false) {
    if (unlocked()) { onUnlock(); return; }
    const input = el("input", { type: "password", inputmode: "numeric", autocomplete: "current-password",
                                placeholder: "管理者パスワード", style: "width:12em" });
    const submit = async () => {
      if (await sha256(input.value.trim()) !== HASH) { toast("パスワードが違います"); input.select(); return; }
      try { sessionStorage.setItem(KEY, HASH); } catch (_) { /* 保存できなくてもこのページでは解除 */ }
      box.remove();
      onUnlock();
    };
    input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing) submit(); });
    const box = el("div", { class: "lock-box" },
      el("div", { style: "font-weight:700" }, "🔒 管理者のみ"),
      el("div", { class: "row" }, input, el("button", { class: "primary", onclick: submit }, "解除")));
    container.append(box);
    if (autofocus) input.focus();
  }
  return { gate, unlocked };
})();
