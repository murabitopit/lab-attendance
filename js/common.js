// 画面共通のユーティリティ
// absent(帰宅/不在)は初期値で、毎朝4:00にも全員この状態へ戻る
const STATUS_LABEL = { present: "出席", away: "離席", absent: "帰宅/不在", leave: "休暇" };
const STATUS_ICON = { present: "🟢", away: "🟡", absent: "⚪", leave: "⚫" };
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

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * アプリのパスワード。入力値から研究室データの保存場所(labId)を計算する。
 * 正しいパスワードかどうかは Firestore のルールが判定する(コード内に正解は置いていない)。
 * 一度通ればこの端末に labId を記憶し、次回から入力を省略する。
 */
const AppLock = {
  KEY: "labAccessKey",
  saved() { try { return localStorage.getItem(this.KEY) || ""; } catch (_) { return ""; } },
  save(v) { try { localStorage.setItem(this.KEY, v); } catch (_) { /* 記憶できなくても今回は使える */ } },
  forget() { try { localStorage.removeItem(this.KEY); } catch (_) { /* noop */ } },
  derive: pw => sha256Hex("lab-attendance:v1:" + pw),
};

function showFatal(msg) {
  document.body.classList.remove("locked");
  document.querySelector(".wrap").prepend(el("div", { class: "card", style: "background:var(--warn-bg)" }, msg));
}

/** パスワード入力画面を出し、正しく開けたら resolve */
function askAppPassword() {
  return new Promise(resolve => {
    const input = el("input", { type: "password", inputmode: "numeric", autocomplete: "current-password",
                                placeholder: "パスワード", style: "width:100%" });
    const err = el("div", { class: "live", style: "min-height:1.5em; color:var(--danger)" });
    const btn = el("button", { class: "primary", style: "width:100%" }, "開く");
    const submit = async () => {
      const pw = input.value.trim();
      if (!pw) return;
      btn.disabled = true; err.textContent = "確認中…";
      try {
        const key = await AppLock.derive(pw);
        await Store.openLab(key);
        AppLock.save(key);
        box.remove();
        resolve();
      } catch (e) {
        err.textContent = e.message === "WRONG_KEY" ? "パスワードが違います" : "接続できませんでした。通信状況を確認してください";
        input.select();
      } finally { btn.disabled = false; }
    };
    btn.addEventListener("click", submit);
    input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing) submit(); });
    const box = el("div", { class: "app-lock" },
      el("div", { class: "app-lock-card" },
        el("h1", {}, "研究室 出席管理"),
        el("p", { class: "live" }, "研究室メンバー用のページです。パスワードを入力してください(この端末では次回から省略されます)。"),
        input, err, btn));
    document.body.append(box);
    input.focus();
  });
}

/** Firebase に接続し、パスワード確認を経てからページ本体を始める */
async function boot(main) {
  document.body.classList.add("locked");
  try {
    await Store.init();
  } catch (e) {
    console.error(e);
    showFatal(e.message === "NOT_CONFIGURED"
      ? "Firebase がまだ設定されていません。js/firebase-config.js に設定を書き込んでください(README.md 参照)。"
      : "サーバーに接続できませんでした。通信状況を確認して再読み込みしてください。");
    return;
  }
  let opened = false;
  const saved = AppLock.saved();
  if (saved) {
    try { await Store.openLab(saved); opened = true; }
    catch (e) {
      if (e.message !== "WRONG_KEY") { console.error(e); showFatal("サーバーに接続できませんでした。通信状況を確認して再読み込みしてください。"); return; }
      AppLock.forget();   // パスワードが変更された等
    }
  }
  if (!opened) await askAppPassword();
  document.body.classList.remove("locked");
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
  function unlocked() { try { return sessionStorage.getItem(KEY) === HASH; } catch (_) { return false; } }
  /** container の中にパスワード入力欄を出し、正しければ onUnlock を呼ぶ(解除済みなら即呼ぶ) */
  function gate(container, onUnlock, autofocus = false) {
    if (unlocked()) { onUnlock(); return; }
    const input = el("input", { type: "password", inputmode: "numeric", autocomplete: "current-password",
                                placeholder: "管理者パスワード", style: "width:12em" });
    const submit = async () => {
      if (await sha256Hex(input.value.trim()) !== HASH) { toast("パスワードが違います"); input.select(); return; }
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
