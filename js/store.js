// Firestore とのやり取り(読み書き・リアルタイム購読)をまとめたもの。
//
// データ構成(すべて labs/{LAB_ID} 以下):
//   (doc)       settings: coreWeekdays / coreStart / coreEnd / toleranceMin, lastReset
//   members/    name, grade, seatId(null=席なし), status, statusSince, active
//   events/     memberId, status, at   … ステータス変更のログ(コアタイム集計に使う)
//   schedules/  memberId, date("YYYY-MM-DD"), note   … 休暇。ID は `${memberId}_${date}`
//   messages/   memberId, text, createdAt, expiresAt … ひとこと掲示板
//   noCoreDays/ note   … コアタイムなしの日。ID は日付
const Store = (() => {
  let db = null, lab = null, FV = null, TS = null;
  const SNAP = { serverTimestamps: "estimate" };

  function configured() {
    const c = window.FIREBASE_CONFIG;
    return !!(c && c.apiKey && c.apiKey !== "YOUR_API_KEY");
  }

  async function init() {
    const emu = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && new URLSearchParams(location.search).has("emu");
    if (!configured() && !emu) throw new Error("NOT_CONFIGURED");
    const app = firebase.initializeApp(configured() ? window.FIREBASE_CONFIG : { apiKey: "demo", projectId: "demo-lab" });
    db = app.firestore();
    if (emu) {
      db.useEmulator("127.0.0.1", 8080);
      app.auth().useEmulator("http://127.0.0.1:9099");
    }
    FV = firebase.firestore.FieldValue;
    TS = firebase.firestore.Timestamp;
    lab = db.collection("labs").doc(window.LAB_ID || "main");
    await app.auth().signInAnonymously();
  }

  const toDate = v => (v && v.toDate ? v.toDate() : v instanceof Date ? v : null);
  const docs = snap => snap.docs.map(d => ({ id: d.id, ...d.data(SNAP) }));
  // 一時期あった「帰宅(home)」は「帰宅/不在(absent)」として扱う
  const member = d => ({ ...d, status: d.status === "home" ? "absent" : d.status, statusSince: toDate(d.statusSince) });

  // ───── 購読(リアルタイム) ─────
  function onSettings(cb) {
    return lab.onSnapshot(s => cb(normSettings(s.exists ? s.data(SNAP) : {})));
  }
  function onMembers(cb, onMeta) {
    return lab.collection("members").where("active", "==", true)
      .onSnapshot({ includeMetadataChanges: true }, snap => {
        onMeta?.(snap.metadata);
        cb(sortMembers(docs(snap).map(member)));
      }, err => onMeta?.({ error: err }));
  }
  function onMessages(cb) {
    return lab.collection("messages").onSnapshot(snap =>
      cb(docs(snap).map(m => ({ ...m, createdAt: toDate(m.createdAt), expiresAt: toDate(m.expiresAt) }))
        .sort((a, b) => b.createdAt - a.createdAt)));
  }
  function onNoCore(cb) {
    return lab.collection("noCoreDays").onSnapshot(snap =>
      cb(Object.fromEntries(snap.docs.map(d => [d.id, d.data().note || ""]))));
  }
  function onSchedulesFrom(ymd, cb) {
    return lab.collection("schedules").where("date", ">=", ymd).onSnapshot(snap => cb(docs(snap)));
  }
  function onEventsSince(date, cb) {
    return lab.collection("events").where("at", ">=", TS.fromDate(date))
      .onSnapshot(snap => cb(docs(snap).map(e => ({ ...e, at: toDate(e.at) })).filter(e => e.at)));
  }

  // ───── 1回だけ取得 ─────
  async function getSchedules(d0, d1) {
    return docs(await lab.collection("schedules").where("date", ">=", d0).where("date", "<=", d1).get());
  }
  async function getEvents(from, to) {
    const snap = await lab.collection("events").where("at", ">=", TS.fromDate(from)).where("at", "<", TS.fromDate(to)).get();
    return docs(snap).map(e => ({ ...e, at: toDate(e.at) }));
  }
  async function getMembers() {
    return sortMembers(docs(await lab.collection("members").where("active", "==", true).get()).map(member));
  }
  async function getSettings() {
    const s = await lab.get();
    return normSettings(s.exists ? s.data() : {});
  }
  async function getNoCore() {
    return Object.fromEntries((await lab.collection("noCoreDays").get()).docs.map(d => [d.id, d.data().note || ""]));
  }

  // ───── 書き込み ─────
  async function setStatus(memberId, status) {
    const b = db.batch();
    b.update(lab.collection("members").doc(memberId), { status, statusSince: FV.serverTimestamp() });
    b.set(lab.collection("events").doc(), { memberId, status, at: FV.serverTimestamp() });
    await b.commit();
  }

  async function postMessage(memberId, text, minutes) {
    const now = new Date();
    await lab.collection("messages").add({
      memberId, text: text.slice(0, 80),
      createdAt: TS.fromDate(now), expiresAt: TS.fromDate(new Date(now.getTime() + minutes * 60000)),
    });
  }
  const deleteMessage = id => lab.collection("messages").doc(id).delete();

  /** 新規 or 更新。使用中の座席を選んだ場合、元の人は「席なし」にする。戻り値は通知文 */
  async function saveMember({ id, name, grade, seatId }, current) {
    const b = db.batch();
    let notice = null;
    const other = seatId && current.find(m => m.seatId === seatId && m.id !== id);
    if (other) {
      b.update(lab.collection("members").doc(other.id), { seatId: null });
      notice = `席${seatId} にいた ${other.name} さんは「席なし」になりました`;
    }
    if (id) b.update(lab.collection("members").doc(id), { name, grade, seatId: seatId || null });
    else b.set(lab.collection("members").doc(), { name, grade, seatId: seatId || null, status: "absent",
                                                  statusSince: FV.serverTimestamp(), active: true });
    await b.commit();
    return notice;
  }
  /** 過去の記録を残すため論理削除 */
  const deleteMember = id => lab.collection("members").doc(id).update({ active: false, seatId: null });

  async function seedMembers(list) {
    const b = db.batch();
    for (const [grade, name, seatId] of list) {
      b.set(lab.collection("members").doc(), { name, grade, seatId, status: "absent",
                                              statusSince: FV.serverTimestamp(), active: true });
    }
    await b.commit();
  }

  async function addSchedules(memberId, from, to, note) {
    if (to < from) [from, to] = [to, from];
    const b = db.batch();
    let n = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (++n > 62) throw new Error("一度に登録できるのは2か月までです");
      b.set(lab.collection("schedules").doc(`${memberId}_${d}`), { memberId, date: d, note });
    }
    await b.commit();
  }
  const deleteSchedule = id => lab.collection("schedules").doc(id).delete();

  const saveSettings = s => lab.set(s, { merge: true });
  const addNoCore = (date, note) => lab.collection("noCoreDays").doc(date).set({ note });
  const deleteNoCore = date => lab.collection("noCoreDays").doc(date).delete();

  /**
   * 毎朝のリセット。サーバーが無いので、リセット時刻以降に最初に画面を開いた端末が実行する。
   * トランザクションで lastReset を確認するので、複数端末が同時に開いても1回だけ行われる。
   * リセット時刻より後にステータスを変えた人は対象外(押した直後に上書きしないため)。
   */
  async function maybeReset(members) {
    const R = latestReset(new Date());
    const ref = lab;
    await db.runTransaction(async tx => {
      const s = await tx.get(ref);
      const last = s.exists ? toDate(s.data().lastReset) : null;
      if (last && last >= R) return;
      const refs = members.filter(m => m.status !== "absent").map(m => lab.collection("members").doc(m.id));
      const snaps = await Promise.all(refs.map(r => tx.get(r)));
      tx.set(ref, { lastReset: TS.fromDate(R) }, { merge: true });
      snaps.forEach((ms, i) => {
        const d = ms.data();
        if (!d || d.status === "absent" || (toDate(d.statusSince) && toDate(d.statusSince) >= R)) return;
        tx.update(refs[i], { status: "absent", statusSince: TS.fromDate(R) });
        tx.set(lab.collection("events").doc(), { memberId: ms.id, status: "absent", at: TS.fromDate(R) });
      });
    });
  }

  return { configured, init, onSettings, onMembers, onMessages, onNoCore, onSchedulesFrom, onEventsSince,
           getSchedules, getEvents, getMembers, getSettings, getNoCore,
           setStatus, postMessage, deleteMessage, saveMember, deleteMember, seedMembers,
           addSchedules, deleteSchedule, saveSettings, addNoCore, deleteNoCore, maybeReset };
})();

function sortMembers(list) {
  const key = m => (m.seatId == null ? "2" : m.seatId.startsWith("T") ? "1" : "0") + (m.seatId || "") + m.name;
  return list.sort((a, b) => key(a).localeCompare(key(b)));
}
