/* Trang học viên — Kiểm tra theo lớp. */
(function () {
  "use strict";

  const config = window.BMTH_CONFIG || {};
  const API = String(config.kiemtraApiUrl || "").replace(/\/+$/, "");
  const $ = (id) => document.getElementById(id);
  const steps = ["step-code", "step-info", "step-exam", "step-done"];
  const KEYS = "ABCDEF";

  const store = (() => {
    try { const k = "__kt"; localStorage.setItem(k, "1"); localStorage.removeItem(k); return localStorage; }
    catch (_) { const mem = {}; return { getItem: (k) => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } }; }
  })();

  function deviceId() {
    let id = store.getItem("tlagv_kt_device");
    if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
      const bytes = crypto.getRandomValues(new Uint8Array(18));
      id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      store.setItem("tlagv_kt_device", id);
    }
    return id;
  }

  const state = { code: "", info: null, token: "", name: "", questions: [], answers: {}, current: 0, deadline: 0, offset: 0, timer: null, saveTimer: null, dirty: false, submitting: false, inExam: false };

  function show(step) {
    steps.forEach((s) => { $(s).hidden = s !== step; });
    window.scrollTo({ top: 0 });
  }

  function alertBox(message, kind = "error") {
    const box = $("kt-alert");
    if (!message) { box.hidden = true; return; }
    box.className = "kt-alert" + (kind ? " " + kind : "");
    box.textContent = message;
    box.hidden = false;
  }

  async function api(path, body) {
    if (!API) throw new Error("Chức năng kiểm tra theo lớp chưa được cấu hình.");
    const res = await fetch(API + path, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw Object.assign(new Error(data.error || "Không kết nối được máy chủ."), { status: res.status, code: data.code });
    return data;
  }

  const pad2 = (n) => String(n).padStart(2, "0");
  const fmtTime = (ms) => {
    const d = new Date(ms), now = new Date();
    const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    return d.toDateString() === now.toDateString() ? `${hm} hôm nay` : `${hm} ngày ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
  };
  const tokenKey = () => "tlagv_kt_attempt_" + state.code;
  const answersKey = () => "tlagv_kt_answers_" + state.code;

  /* ---------- Bước 1 & 2 ---------- */

  async function openCode(code) {
    code = String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length < 4) { alertBox("Mã đề chưa đúng. Kiểm tra lại với giáo viên."); show("step-code"); return; }
    alertBox("");
    state.code = code;
    try {
      const info = await api("/api/exam/" + encodeURIComponent(code));
      state.info = info;
      const url = new URL(location.href);
      url.searchParams.set("ma", code);
      history.replaceState(null, "", url);
      if (store.getItem(tokenKey())) { await begin(store.getItem("tlagv_kt_name_" + code) || ""); return; }
      renderInfo(info);
    } catch (err) {
      alertBox(err.message);
      $("code-input").value = code;
      show("step-code");
    }
  }

  function renderInfo(info) {
    $("info-code").textContent = info.code;
    $("info-title").textContent = info.title;
    $("info-teacher").textContent = info.teacher;
    $("info-count").textContent = info.count;
    $("info-duration").textContent = info.durationMin;
    const labels = { open: "Đang mở", upcoming: "Chưa mở", closed: "Đã đóng" };
    $("info-state").textContent = labels[info.state] || "";
    $("info-state-note").textContent = info.state === "open" ? "đến " + fmtTime(info.closesAt) : "trạng thái";
    const sched = $("info-schedule");
    if (info.state === "upcoming") { sched.textContent = "Đợt kiểm tra mở lúc " + fmtTime(info.opensAt) + ". Hãy quay lại đúng giờ."; sched.hidden = false; }
    else if (info.state === "closed") { sched.textContent = "Đợt kiểm tra đã đóng lúc " + fmtTime(info.closesAt) + "."; sched.hidden = false; }
    else sched.hidden = true;
    $("start-btn").disabled = info.state !== "open";
    $("info-rules").textContent = `Thời gian làm bài ${info.durationMin} phút, tính từ lúc bấm “Bắt đầu”. ` +
      (info.oneAttempt ? "Mỗi máy chỉ làm được một lần. " : "") + "Hết giờ, bài tự nộp.";
    const saved = store.getItem("tlagv_kt_last_name");
    if (saved && !$("name-input").value) $("name-input").value = saved;
    show("step-info");
  }

  async function begin(name) {
    alertBox("");
    $("start-btn").disabled = true;
    try {
      const data = await api(`/api/exam/${encodeURIComponent(state.code)}/start`, { name, deviceId: deviceId() });
      if (data.submitted) {
        state.token = data.token || store.getItem(tokenKey()) || "";
        if (state.token) store.setItem(tokenKey(), state.token);
        showDone(data);
        return;
      }
      state.token = data.token;
      state.name = data.name;
      state.questions = data.questions;
      state.deadline = data.deadline;
      state.offset = data.serverNow - Date.now();
      let local = {};
      try { local = JSON.parse(store.getItem(answersKey()) || "{}"); } catch (_) {}
      state.answers = Object.assign({}, data.answers || {}, local.token === data.token ? local.answers : {});
      store.setItem(tokenKey(), data.token);
      store.setItem("tlagv_kt_name_" + state.code, data.name);
      store.setItem("tlagv_kt_last_name", data.name);
      startExam();
    } catch (err) {
      if (err.code === "NO_ATTEMPT" || err.code === "NO_EXAM") store.removeItem(tokenKey());
      alertBox(err.message);
      if (state.info) renderInfo(state.info); else show("step-code");
    } finally {
      $("start-btn").disabled = !state.info || state.info.state !== "open";
    }
  }

  /* ---------- Bước 3: làm bài ---------- */

  function startExam() {
    state.inExam = true;
    state.current = Math.min(state.current, state.questions.length - 1);
    show("step-exam");
    renderQuestion();
    tick();
    clearInterval(state.timer);
    state.timer = setInterval(tick, 250);
    if (Object.keys(state.answers).length) scheduleSave(200);
  }

  function remaining() { return state.deadline - (Date.now() + state.offset); }

  function tick() {
    const ms = Math.max(0, remaining());
    const total = Math.ceil(ms / 1000);
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    const el = $("timer");
    el.textContent = (h ? h + ":" + pad(m) : pad(m)) + ":" + pad(s);
    el.classList.toggle("low", total <= 60);
    if (ms <= 0 && state.inExam && !state.submitting) submit(true);
  }

  function renderQuestion() {
    const q = state.questions[state.current];
    const n = state.questions.length;
    $("q-number").textContent = `Câu ${state.current + 1}/${n}`;
    $("q-text").textContent = q.text;
    const wrap = $("q-options");
    wrap.textContent = "";
    q.options.forEach((opt, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "kt-option";
      btn.setAttribute("role", "radio");
      const checked = Number(state.answers[q.id]) === opt.id;
      btn.setAttribute("aria-checked", checked ? "true" : "false");
      btn.tabIndex = checked || (i === 0 && state.answers[q.id] === undefined) ? 0 : -1;
      const key = document.createElement("span");
      key.className = "key";
      key.textContent = KEYS[i];
      const text = document.createElement("span");
      text.textContent = opt.text;
      btn.append(key, text);
      btn.addEventListener("click", () => choose(q.id, opt.id));
      btn.addEventListener("keydown", (e) => {
        if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
        e.preventDefault();
        const dir = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
        const all = [...wrap.children];
        const next = all[(i + dir + all.length) % all.length];
        next.focus();
      });
      wrap.appendChild(btn);
    });
    $("prev-btn").disabled = state.current === 0;
    $("next-btn").disabled = state.current === n - 1;
    renderDots();
  }

  function renderDots() {
    const wrap = $("dots");
    wrap.textContent = "";
    let answered = 0;
    state.questions.forEach((q, i) => {
      const has = state.answers[q.id] !== undefined;
      if (has) answered++;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "kt-dot" + (has ? " answered" : "") + (i === state.current ? " current" : "");
      b.textContent = i + 1;
      b.setAttribute("aria-label", `Câu ${i + 1}${has ? ", đã trả lời" : ", chưa trả lời"}`);
      if (i === state.current) b.setAttribute("aria-current", "true");
      b.addEventListener("click", () => go(i));
      wrap.appendChild(b);
    });
    $("progress").textContent = `Đã làm ${answered}/${state.questions.length}`;
  }

  function go(i) {
    state.current = Math.max(0, Math.min(state.questions.length - 1, i));
    renderQuestion();
    $("q-text").focus({ preventScroll: true });
    $("q-number").scrollIntoView({ block: "nearest" });
  }

  function choose(qid, oid) {
    state.answers[qid] = oid;
    store.setItem(answersKey(), JSON.stringify({ token: state.token, answers: state.answers }));
    const keepFocus = document.activeElement && document.activeElement.closest(".kt-option");
    const idx = state.questions[state.current].options.findIndex((o) => o.id === oid);
    renderQuestion();
    if (keepFocus) $("q-options").children[idx]?.focus();
    $("submit-confirm").hidden = true;
    scheduleSave(1200);
  }

  function scheduleSave(delay) {
    state.dirty = true;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveNow, delay);
  }

  async function saveNow() {
    if (!state.dirty || state.submitting || !state.inExam) return;
    state.dirty = false;
    try {
      const res = await api("/api/attempt/save", { token: state.token, answers: state.answers });
      $("save-note").textContent = res.saved ? "Đã lưu bài làm lúc " + new Date().toLocaleTimeString("vi-VN") : "";
      if (res.submitted) await finishFromServer();
    } catch (_) {
      state.dirty = true;
      $("save-note").textContent = "Mất kết nối — bài làm vẫn được giữ trên máy, sẽ lưu lại khi có mạng.";
      clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(saveNow, 8000);
    }
  }

  function askSubmit() {
    const left = state.questions.filter((q) => state.answers[q.id] === undefined).length;
    $("submit-confirm-text").textContent = left
      ? `Còn ${left} câu chưa trả lời. Đồng chí chắc chắn muốn nộp bài?`
      : "Đồng chí đã trả lời tất cả các câu. Nộp bài ngay?";
    $("submit-confirm").hidden = false;
    $("submit-yes").focus();
  }

  async function submit(auto) {
    if (state.submitting) return;
    state.submitting = true;
    clearTimeout(state.saveTimer);
    $("submit-btn").disabled = true;
    $("submit-yes").disabled = true;
    $("save-note").textContent = auto ? "Hết giờ — đang nộp bài…" : "Đang nộp bài…";
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await api("/api/attempt/submit", { token: state.token, answers: state.answers, auto: !!auto });
        state.inExam = false;
        clearInterval(state.timer);
        store.removeItem(answersKey());
        showDone(res);
        return;
      } catch (err) {
        if (err.status && err.status < 500) { alertBox(err.message); break; }
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    state.submitting = false;
    $("submit-btn").disabled = false;
    $("submit-yes").disabled = false;
    $("save-note").textContent = "Chưa nộp được do mất kết nối. Bài làm vẫn còn trên máy — bấm “Nộp bài” lại khi có mạng.";
  }

  async function finishFromServer() {
    try { showDone(await api("/api/attempt/status", { token: state.token })); } catch (_) {}
  }

  /* ---------- Bước 4: kết quả ---------- */

  function showDone(data) {
    state.inExam = false;
    clearInterval(state.timer);
    $("done-title").textContent = data.title || (state.info && state.info.title) || "";
    $("done-name").textContent = data.name ? "Học viên: " + data.name : "";
    if (data.showScore && data.total) {
      $("done-score-value").textContent = data.score;
      $("done-score-total").textContent = "/" + data.total + " câu đúng";
      const ten = Math.round((data.score / data.total) * 100) / 10;
      $("done-score-ten").textContent = "Điểm: " + ten.toLocaleString("vi-VN") + "/10";
      $("done-score").hidden = false;
      $("done-pending").hidden = true;
    } else {
      $("done-score").hidden = true;
      $("done-pending").hidden = false;
    }
    if (data.alreadyDone) alertBox("Máy này đã nộp bài cho đợt kiểm tra này.", "");
    show("step-done");
  }

  /* ---------- Sự kiện ---------- */

  $("code-form").addEventListener("submit", (e) => { e.preventDefault(); openCode($("code-input").value); });
  $("name-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("name-input").value.replace(/\s+/g, " ").trim();
    if (name.length < 4 || !name.includes(" ")) { alertBox("Vui lòng nhập đầy đủ họ và tên."); $("name-input").focus(); return; }
    begin(name);
  });
  $("change-code").addEventListener("click", () => {
    const url = new URL(location.href); url.searchParams.delete("ma"); history.replaceState(null, "", url);
    $("code-input").value = ""; alertBox(""); show("step-code"); $("code-input").focus();
  });
  $("prev-btn").addEventListener("click", () => go(state.current - 1));
  $("next-btn").addEventListener("click", () => go(state.current + 1));
  $("submit-btn").addEventListener("click", askSubmit);
  $("submit-no").addEventListener("click", () => { $("submit-confirm").hidden = true; });
  $("submit-yes").addEventListener("click", () => submit(false));
  $("check-score").addEventListener("click", async () => {
    const token = state.token || store.getItem(tokenKey());
    if (!token) return;
    try {
      const data = await api("/api/attempt/status", { token });
      if (!data.showScore) alertBox("Giáo viên chưa công bố điểm. Đồng chí thử lại sau.", "");
      else alertBox("");
      showDone(data);
    } catch (err) { alertBox(err.message); }
  });
  window.addEventListener("beforeunload", (e) => { if (state.inExam && !state.submitting) { e.preventDefault(); e.returnValue = ""; } });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && state.dirty) saveNow(); else if (state.inExam) tick(); });

  const initial = new URLSearchParams(location.search).get("ma");
  if (initial) openCode(initial); else show("step-code");
})();
