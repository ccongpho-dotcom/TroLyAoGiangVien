/* Trang giáo viên — Kiểm tra theo lớp. */
(function () {
  "use strict";

  const config = window.BMTH_CONFIG || {};
  const API = String(config.kiemtraApiUrl || "").replace(/\/+$/, "");
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = "tlagv_gv_token";
  const LETTERS = "ABCDEF";

  const session = (() => {
    try { sessionStorage.setItem("__t", "1"); sessionStorage.removeItem("__t"); return sessionStorage; }
    catch (_) { const m = {}; return { getItem: (k) => m[k] ?? null, setItem: (k, v) => { m[k] = v; }, removeItem: (k) => { delete m[k]; } }; }
  })();

  const state = { user: null, sets: [], exams: [], detail: null, detailId: null, refreshTimer: null, parsed: null };

  /* ---------- Tiện ích ---------- */

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) node.append(c.nodeType ? c : document.createTextNode(String(c)));
    return node;
  }

  function notify(message, kind = "") {
    const box = $("alert");
    if (!message) { box.hidden = true; return; }
    box.className = "kt-alert" + (kind ? " " + kind : "");
    box.textContent = message;
    box.hidden = false;
    box.scrollIntoView({ block: "nearest" });
    clearTimeout(notify.t);
    if (kind !== "error") notify.t = setTimeout(() => { box.hidden = true; }, 6000);
  }

  async function api(method, path, body) {
    if (!API) throw new Error("Chưa cấu hình máy chủ kiểm tra (kiemtraApiUrl trong config.js).");
    const headers = { "Content-Type": "application/json" };
    const token = session.getItem(TOKEN_KEY);
    if (token) headers.Authorization = "Bearer " + token;
    let res;
    try { res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch (_) { throw new Error("Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại."); }
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (res.status === 401 && data.code === "AUTH") { logout(true); }
    if (!res.ok) throw Object.assign(new Error(data.error || "Có lỗi xảy ra."), { status: res.status });
    return data;
  }

  const pad = (n) => String(n).padStart(2, "0");
  const fmt = (ms) => { if (!ms) return "—"; const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; };
  const fmtShort = (ms) => { if (!ms) return "—"; const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`; };
  const toLocalInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const fromLocalInput = (s) => { const t = new Date(s).getTime(); return Number.isFinite(t) ? t : NaN; };
  const ten = (score, total) => total ? Math.round((score / total) * 100) / 10 : 0;
  const stateLabel = { open: "Đang mở", upcoming: "Chưa mở", closed: "Đã đóng" };

  function views(name) {
    ["view-setup", "view-login", "view-app", "view-password"].forEach((v) => { $(v).hidden = v !== name; });
    $("top-actions").hidden = !(name === "view-app" || name === "view-password");
  }

  function examLink(code) {
    const base = location.href.replace(/[#?].*$/, "").replace(/[^/]*$/, "");
    return `${base}kiemtra.html?ma=${encodeURIComponent(code)}`;
  }

  function qrSvg(text) {
    const qr = window.qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }

  /* ---------- Đăng nhập ---------- */

  async function boot() {
    try {
      const s = await api("GET", "/api/auth/setup-status");
      if (s.needsSetup) { views("view-setup"); return; }
    } catch (err) { notify(err.message, "error"); }
    if (session.getItem(TOKEN_KEY)) {
      try { const me = await api("GET", "/api/me"); return enterApp(me.user); } catch (_) {}
    }
    views("view-login");
  }

  function formData(form) { return Object.fromEntries(new FormData(form).entries()); }

  $("setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    try {
      await api("POST", "/api/auth/setup", d);
      const res = await api("POST", "/api/auth/login", { username: d.username, password: d.password });
      session.setItem(TOKEN_KEY, res.token);
      notify("Đã tạo tài khoản quản trị.");
      enterApp(res.user);
    } catch (err) { notify(err.message, "error"); }
  });

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    try {
      const res = await api("POST", "/api/auth/login", d);
      session.setItem(TOKEN_KEY, res.token);
      e.target.reset();
      notify("");
      enterApp(res.user);
    } catch (err) { notify(err.message, "error"); }
  });

  function logout(expired) {
    session.removeItem(TOKEN_KEY);
    state.user = null;
    clearInterval(state.refreshTimer);
    views("view-login");
    if (expired) notify("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.", "warn");
  }
  $("btn-logout").addEventListener("click", () => logout(false));

  $("btn-password").addEventListener("click", () => { clearInterval(state.refreshTimer); views("view-password"); });
  $("btn-cancel-password").addEventListener("click", () => { views("view-app"); });
  $("password-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const res = await api("POST", "/api/me/password", formData(e.target));
      session.setItem(TOKEN_KEY, res.token);
      e.target.reset();
      views("view-app");
      notify("Đã đổi mật khẩu.");
    } catch (err) { notify(err.message, "error"); }
  });

  function enterApp(user) {
    state.user = user;
    $("top-user").textContent = user.displayName + (user.role === "admin" ? " · Quản trị" : "");
    $("tab-accounts").hidden = user.role !== "admin";
    views("view-app");
    selectTab("exams");
    loadSets();
    loadClasses();
  }

  /* ---------- Thẻ chức năng ---------- */

  function selectTab(name) {
    ["exams", "sets", "classes", "accounts"].forEach((t) => {
      $("tab-" + t).setAttribute("aria-selected", t === name ? "true" : "false");
      $("panel-" + t).hidden = t !== name;
    });
    clearInterval(state.refreshTimer);
    if (name === "exams") { showExamHome(); loadExams(); }
    if (name === "sets") { if ($("set-editor").hidden) loadSets(); }
    if (name === "classes") loadClasses();
    if (name === "accounts") loadTeachers();
  }
  ["exams", "sets", "classes", "accounts"].forEach((t) => $("tab-" + t).addEventListener("click", () => selectTab(t)));

  /* ---------- Bộ câu hỏi ---------- */

  const editor = { id: null, questions: [], dirty: false };

  async function loadSets() {
    try {
      const res = await api("GET", "/api/sets");
      state.sets = res.sets;
      renderSets();
      fillSetSelect();
    } catch (err) { notify(err.message, "error"); }
  }

  function renderSets() {
    const list = $("set-list");
    list.textContent = "";
    if (!state.sets.length) { list.append(el("div", { class: "kt-empty", text: "Chưa có bộ câu hỏi nào. Tải tệp Word theo mẫu hoặc soạn trên web để bắt đầu." })); return; }
    for (const s of state.sets) {
      list.append(el("div", { class: "kt-item" },
        el("div", {}, el("h3", { text: s.title }), el("p", { text: `${s.count} câu · Tạo lúc ${fmt(s.createdAt)}` })),
        el("div", { class: "kt-row" },
          el("button", { class: "kt-btn kt-btn-ghost kt-btn-sm", type: "button", onclick: () => editSet(s.id) }, "Xem / Sửa"),
          el("button", { class: "kt-btn kt-btn-primary kt-btn-sm", type: "button", onclick: () => { selectTab("exams"); openExamForm(s.id); } }, "Tạo đợt kiểm tra"),
          el("button", { class: "kt-btn kt-btn-danger kt-btn-sm", type: "button", onclick: () => deleteSet(s) }, "Xóa"))));
    }
  }

  async function deleteSet(s) {
    if (!confirm(`Xóa bộ câu hỏi “${s.title}”? Các đợt kiểm tra đã tạo từ bộ này vẫn giữ nguyên.`)) return;
    try { await api("DELETE", "/api/sets/" + s.id); notify("Đã xóa bộ câu hỏi."); loadSets(); }
    catch (err) { notify(err.message, "error"); }
  }

  const imageUrl = (id) => `${API}/api/img/${encodeURIComponent(id)}`;

  function openEditor({ id = null, title = "", questions = [], mode = "", issues = [], warnings = [] }) {
    editor.id = id;
    editor.questions = questions.map((q) => ({
      text: q.text || "", options: q.options && q.options.length ? [...q.options] : ["", ""],
      answer: Number.isInteger(q.answer) ? q.answer : null, image: q.image || null,
      local: q.imageFile ? { blob: q.imageFile, url: URL.createObjectURL(q.imageFile) } : null,
    }));
    if (!editor.questions.length) editor.questions.push(blankQuestion());
    editor.dirty = false;
    $("ed-mode").textContent = mode;
    $("ed-title").value = title;
    $("ed-note").textContent = id ? "Sửa bộ câu hỏi không làm thay đổi các đợt kiểm tra đã tạo trước đó." : "";
    const iss = $("ed-issues");
    iss.textContent = "";
    if (issues.length) {
      iss.append(el("strong", { text: `Tệp Word có ${issues.length} lỗi. Có thể sửa ngay bên dưới (câu lỗi được tô đỏ) rồi lưu:` }), el("ul", {}, issues.slice(0, 30).map((m) => el("li", { text: m }))));
      iss.hidden = false;
    } else iss.hidden = true;
    const warn = $("ed-warnings");
    warn.textContent = "";
    if (warnings.length) { warn.append(el("ul", { style: "margin:0" }, warnings.slice(0, 30).map((m) => el("li", { text: m })))); warn.hidden = false; }
    else warn.hidden = true;
    $("sets-home").hidden = true;
    $("set-editor").hidden = false;
    renderEditor();
    window.scrollTo({ top: 0 });
  }

  function closeEditor() {
    editor.questions.forEach((q) => q.local && URL.revokeObjectURL(q.local.url));
    editor.questions = [];
    $("set-editor").hidden = true;
    $("sets-home").hidden = false;
  }

  function blankQuestion() { return { text: "", options: ["", "", "", ""], answer: null, image: null, local: null }; }

  function questionProblems(q) {
    const p = [];
    if (!q.text.trim()) p.push("thiếu nội dung");
    const filled = q.options.filter((o) => o.trim()).length;
    if (q.options.length < 2) p.push("cần ít nhất 2 phương án");
    else if (filled < q.options.length) p.push("có phương án để trống");
    if (q.answer == null || q.answer >= q.options.length) p.push("chưa chọn đáp án đúng");
    return p;
  }

  function renderEditor() {
    const wrap = $("ed-questions");
    wrap.textContent = "";
    editor.questions.forEach((q, qi) => wrap.append(questionCard(q, qi)));
    updateEditorCount();
  }

  function updateEditorCount() {
    const bad = editor.questions.filter((q) => questionProblems(q).length).length;
    $("ed-count").textContent = `${editor.questions.length} câu` + (bad ? ` · ${bad} câu chưa hoàn chỉnh` : "");
  }

  function markDirty() { editor.dirty = true; updateEditorCount(); }

  function questionCard(q, qi) {
    const problems = questionProblems(q);
    const card = el("div", { class: "kt-card kt-qedit" + (problems.length ? " bad" : "") });
    const status = el("span", { class: "kt-muted", style: "font-size:.84rem", text: problems.length ? "⚠ " + problems.join(", ") : "" });
    const refreshStatus = () => {
      const pr = questionProblems(q);
      card.classList.toggle("bad", pr.length > 0);
      status.textContent = pr.length ? "⚠ " + pr.join(", ") : "";
      markDirty();
    };
    const move = (d) => { const j = qi + d; if (j < 0 || j >= editor.questions.length) return; [editor.questions[qi], editor.questions[j]] = [editor.questions[j], editor.questions[qi]]; markDirty(); renderEditor(); };

    card.append(el("div", { class: "kt-row kt-between", style: "margin-bottom:10px" },
      el("div", {}, el("strong", { style: "color:var(--navy-800)", text: `Câu ${qi + 1}` }), " ", status),
      el("div", { class: "kt-row" },
        el("button", { class: "kt-btn kt-btn-ghost kt-btn-sm", type: "button", title: "Lên", "aria-label": `Đưa câu ${qi + 1} lên`, disabled: qi === 0, onclick: () => move(-1) }, "↑"),
        el("button", { class: "kt-btn kt-btn-ghost kt-btn-sm", type: "button", title: "Xuống", "aria-label": `Đưa câu ${qi + 1} xuống`, disabled: qi === editor.questions.length - 1, onclick: () => move(1) }, "↓"),
        el("button", { class: "kt-btn kt-btn-danger kt-btn-sm", type: "button", onclick: () => { if (q.text.trim() && !confirm(`Xóa câu ${qi + 1}?`)) return; editor.questions.splice(qi, 1); if (!editor.questions.length) editor.questions.push(blankQuestion()); markDirty(); renderEditor(); } }, "Xóa câu"))));

    const ta = el("textarea", { class: "kt-textarea", rows: 2, "aria-label": `Nội dung câu ${qi + 1}`, placeholder: "Nội dung câu hỏi" });
    ta.value = q.text;
    ta.addEventListener("input", () => { q.text = ta.value; refreshStatus(); });
    card.append(ta);

    // Hình ảnh
    const imgBox = el("div", { class: "kt-qimage-edit" });
    const fileIn = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", class: "sr-only" });
    fileIn.addEventListener("change", () => {
      const f = fileIn.files[0];
      fileIn.value = "";
      if (!f) return;
      if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) { notify("Chỉ dùng ảnh PNG, JPG, WEBP hoặc GIF.", "error"); return; }
      if (f.size > 15 * 1024 * 1024) { notify("Ảnh quá lớn (tối đa 15 MB trước khi nén).", "error"); return; }
      if (q.local) URL.revokeObjectURL(q.local.url);
      q.local = { blob: f, url: URL.createObjectURL(f) };
      q.image = null;
      markDirty();
      renderEditor();
    });
    const src = q.local ? q.local.url : q.image ? imageUrl(q.image) : null;
    if (src) {
      imgBox.append(el("img", { src, alt: `Hình câu ${qi + 1}`, class: "kt-qimage" }),
        el("div", { class: "kt-row" },
          el("button", { class: "kt-btn kt-btn-ghost kt-btn-sm", type: "button", onclick: () => fileIn.click() }, "Đổi hình"),
          el("button", { class: "kt-btn kt-btn-danger kt-btn-sm", type: "button", onclick: () => { if (q.local) URL.revokeObjectURL(q.local.url); q.local = null; q.image = null; markDirty(); renderEditor(); } }, "Bỏ hình")));
    } else {
      imgBox.append(el("button", { class: "kt-btn kt-btn-ghost kt-btn-sm", type: "button", onclick: () => fileIn.click() }, "+ Thêm hình"));
    }
    imgBox.append(fileIn);
    card.append(imgBox);

    // Phương án
    const opts = el("div", { class: "kt-optedit-list", role: "radiogroup", "aria-label": `Phương án câu ${qi + 1}` });
    q.options.forEach((o, oi) => {
      const radio = el("input", { type: "radio", name: `ans-${qi}`, "aria-label": `Đáp án đúng là ${LETTERS[oi]}`, title: "Đánh dấu là đáp án đúng" });
      radio.checked = q.answer === oi;
      radio.addEventListener("change", () => { q.answer = oi; refreshStatus(); });
      const input = el("input", { class: "kt-input", value: o, placeholder: `Phương án ${LETTERS[oi]}`, "aria-label": `Phương án ${LETTERS[oi]} câu ${qi + 1}` });
      input.addEventListener("input", () => { q.options[oi] = input.value; refreshStatus(); });
      opts.append(el("div", { class: "kt-optedit" + (q.answer === oi ? " right" : "") },
        el("label", { class: "kt-optedit-key" }, radio, el("span", { text: LETTERS[oi] })),
        input,
        el("button", { class: "kt-btn kt-btn-ghost kt-btn-sm", type: "button", "aria-label": `Xóa phương án ${LETTERS[oi]}`, disabled: q.options.length <= 2,
          onclick: () => { q.options.splice(oi, 1); if (q.answer === oi) q.answer = null; else if (q.answer > oi) q.answer--; markDirty(); renderEditor(); } }, "×")));
    });
    card.append(el("p", { class: "kt-muted", style: "margin:12px 0 6px;font-size:.84rem", text: "Bấm vào chữ cái để chọn đáp án đúng." }), opts);
    if (q.options.length < 6) card.append(el("button", { class: "kt-btn kt-btn-ghost kt-btn-sm", type: "button", style: "margin-top:8px", onclick: () => { q.options.push(""); markDirty(); renderEditor(); } }, "+ Thêm phương án"));
    return card;
  }

  // Nén ảnh trước khi tải lên: tối đa 1400px, JPEG.
  async function compressImage(blob) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error("Không đọc được ảnh.")); i.src = url; });
      let scale = Math.min(1, 1400 / Math.max(img.naturalWidth, img.naturalHeight));
      for (let attempt = 0; attempt < 5; attempt++) {
        const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const out = await new Promise((r) => c.toBlob(r, "image/jpeg", attempt < 2 ? 0.85 : 0.72));
        if (out && out.size <= 650 * 1024) return out;
        scale *= 0.75;
      }
      throw new Error("Ảnh quá lớn, không nén được.");
    } finally { URL.revokeObjectURL(url); }
  }

  async function uploadImage(blob) {
    const small = await compressImage(blob);
    const headers = { "Content-Type": "image/jpeg", Authorization: "Bearer " + session.getItem(TOKEN_KEY) };
    const res = await fetch(API + "/api/images", { method: "POST", headers, body: small });
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error(data.error || "Không tải được ảnh lên.");
    return data.id;
  }

  async function saveEditor() {
    const title = $("ed-title").value.trim();
    if (!title) { notify("Nhập tên bộ câu hỏi.", "error"); $("ed-title").focus(); return; }
    const bad = editor.questions.findIndex((q) => questionProblems(q).length);
    if (bad >= 0) {
      notify(`Câu ${bad + 1} chưa hoàn chỉnh: ${questionProblems(editor.questions[bad]).join(", ")}.`, "error");
      $("ed-questions").children[bad]?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    const btn = $("ed-save");
    btn.disabled = true;
    try {
      const pending = editor.questions.filter((q) => q.local);
      let done = 0;
      for (const q of pending) {
        btn.textContent = `Đang tải hình ${++done}/${pending.length}…`;
        q.image = await uploadImage(q.local.blob);
        URL.revokeObjectURL(q.local.url);
        q.local = null;
      }
      btn.textContent = "Đang lưu…";
      const payload = { title, questions: editor.questions.map((q) => ({ text: q.text.trim(), options: q.options.map((o) => o.trim()), answer: q.answer, image: q.image || undefined })) };
      const res = editor.id ? await api("PUT", "/api/sets/" + editor.id, payload) : await api("POST", "/api/sets", payload);
      notify(`Đã lưu bộ câu hỏi “${title}” (${res.count} câu).`);
      editor.dirty = false;
      closeEditor();
      loadSets();
    } catch (err) { notify(err.message, "error"); }
    finally { btn.disabled = false; btn.textContent = "Lưu bộ câu hỏi"; }
  }

  async function editSet(id) {
    try {
      const set = await api("GET", "/api/sets/" + id);
      openEditor({ id: set.id, title: set.title, questions: set.questions, mode: "Sửa bộ câu hỏi" });
    } catch (err) { notify(err.message, "error"); }
  }

  $("btn-new-set").addEventListener("click", () => openEditor({ title: "", questions: [], mode: "Soạn bộ câu hỏi mới" }));
  $("ed-add").addEventListener("click", () => {
    editor.questions.push(blankQuestion());
    markDirty();
    renderEditor();
    const last = $("ed-questions").lastElementChild;
    last.scrollIntoView({ block: "center", behavior: "smooth" });
    last.querySelector("textarea").focus({ preventScroll: true });
  });
  $("ed-save").addEventListener("click", saveEditor);
  $("ed-cancel").addEventListener("click", () => { if (editor.dirty && !confirm("Bỏ các thay đổi chưa lưu?")) return; closeEditor(); });
  window.addEventListener("beforeunload", (e) => { if (editor.dirty && !$("set-editor").hidden) { e.preventDefault(); e.returnValue = ""; } });

  $("docx-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (!/\.docx$/i.test(file.name)) { notify("Hãy chọn tệp Word dạng .docx (Word 2007 trở lên). Tệp .doc cũ cần mở bằng Word rồi “Lưu thành” .docx.", "error"); return; }
    if (file.size > 30 * 1024 * 1024) { notify("Tệp quá lớn (tối đa 30 MB).", "error"); return; }
    try {
      const result = await window.KiemTraDocx.parseDocx(await file.arrayBuffer());
      if (!result.questions.length) { notify(result.errors[0] || "Không tìm thấy câu hỏi nào trong tệp.", "error"); return; }
      openEditor({
        title: file.name.replace(/\.docx$/i, "").replace(/[_-]+/g, " ").trim(),
        questions: result.questions, issues: result.errors, warnings: result.warnings,
        mode: `Đọc được ${result.questions.length} câu từ tệp “${file.name}” — kiểm tra rồi bấm Lưu`,
      });
    } catch (err) { notify(err.message || "Không đọc được tệp Word.", "error"); }
  });

  /* ---------- Lớp học ---------- */

  const classState = { list: [], editing: null };

  function parseRoster(text) {
    return String(text || "").split(/\r?\n/).map((line) => {
      let cells = line.split("\t").map((c) => c.trim()).filter(Boolean);
      if (cells.length > 1) cells = [cells.find((c) => /\p{L}\s+\p{L}/u.test(c) && !/\d{3,}/.test(c)) || cells.join(" ")];
      return (cells[0] || "").replace(/^\s*\d+\s*[.)\-–]?\s+/, "").replace(/\s+/g, " ").trim();
    }).filter((n) => n && /\p{L}/u.test(n));
  }

  async function loadClasses() {
    try {
      const res = await api("GET", "/api/classes");
      classState.list = res.classes;
      renderClasses();
      fillClassSelect();
    } catch (err) { notify(err.message, "error"); }
  }

  function renderClasses() {
    const list = $("class-list");
    list.textContent = "";
    if (!classState.list.length) { list.append(el("div", { class: "kt-empty", text: "Chưa có lớp nào." })); return; }
    for (const c of classState.list) {
      const names = el("ol", { class: "kt-roster-list", hidden: true }, c.students.map((n) => el("li", { text: n })));
      list.append(el("div", { class: "kt-item" },
        el("div", {}, el("h3", { text: c.name }), el("p", { text: `${c.students.length} học viên · Cập nhật ${fmt(c.updatedAt)}` }), names),
        el("div", { class: "kt-row" },
          el("button", { class: "kt-btn kt-btn-ghost kt-btn-sm", type: "button", onclick: () => { names.hidden = !names.hidden; } }, "Xem"),
          el("button", { class: "kt-btn kt-btn-ghost kt-btn-sm", type: "button", onclick: () => editClass(c) }, "Sửa"),
          el("button", { class: "kt-btn kt-btn-danger kt-btn-sm", type: "button", onclick: () => deleteClass(c) }, "Xóa"))));
    }
  }

  function editClass(c) {
    const f = $("class-form");
    classState.editing = c.id;
    f.name.value = c.name;
    f.students.value = c.students.join("\n");
    $("class-form-title").textContent = "Sửa lớp";
    $("class-cancel").hidden = false;
    updateClassCount();
    f.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  function resetClassForm() {
    const f = $("class-form");
    f.reset();
    classState.editing = null;
    $("class-form-title").textContent = "Thêm lớp";
    $("class-cancel").hidden = true;
    updateClassCount();
  }

  function updateClassCount() { $("class-count").textContent = `${parseRoster($("class-form").students.value).length} học viên`; }
  $("class-form").students.addEventListener("input", updateClassCount);
  $("class-cancel").addEventListener("click", resetClassForm);

  $("class-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const students = parseRoster(f.students.value);
    try {
      if (classState.editing) await api("PUT", "/api/classes/" + classState.editing, { name: f.name.value, students });
      else await api("POST", "/api/classes", { name: f.name.value, students });
      notify(`Đã lưu lớp “${f.name.value.trim()}” (${students.length} học viên).`);
      resetClassForm();
      loadClasses();
    } catch (err) { notify(err.message, "error"); }
  });

  async function deleteClass(c) {
    if (!confirm(`Xóa lớp “${c.name}”? Các đợt kiểm tra đã tạo cho lớp này vẫn giữ danh sách cũ.`)) return;
    try { await api("DELETE", "/api/classes/" + c.id); notify("Đã xóa lớp."); loadClasses(); }
    catch (err) { notify(err.message, "error"); }
  }

  /* ---------- Đợt kiểm tra ---------- */

  function fillSetSelect(selected) {
    const sel = document.querySelector("#exam-form [name=setId]");
    const keep = selected || sel.value;
    sel.textContent = "";
    if (!state.sets.length) sel.append(el("option", { value: "", text: "— Chưa có bộ câu hỏi, hãy tải lên ở thẻ “Bộ câu hỏi” —" }));
    for (const s of state.sets) sel.append(el("option", { value: s.id, text: `${s.title} (${s.count} câu)` }));
    if (keep) sel.value = String(keep);
    updateCountNote();
  }

  function updateCountNote() {
    const sel = document.querySelector("#exam-form [name=setId]");
    const input = document.querySelector("#exam-form [name=questionCount]");
    const total = state.reopen ? state.reopen.totalInSet : (state.sets.find((s) => String(s.id) === sel.value) || {}).count;
    if (total) { input.max = total; $("exam-count-note").textContent = `Có ${total} câu. Để trống = lấy tất cả.`; }
  }

  function fillClassSelect() {
    const sel = document.querySelector("#exam-form [name=classId]");
    const keep = sel.value;
    sel.textContent = "";
    sel.append(el("option", { value: "", text: "— Không dùng danh sách lớp (học viên tự gõ họ tên) —" }));
    for (const c of classState.list) sel.append(el("option", { value: c.id, text: `${c.name} (${c.students.length} học viên)` }));
    if (keep && classState.list.some((c) => String(c.id) === keep)) sel.value = keep;
  }
  document.querySelector("#exam-form [name=setId]").addEventListener("change", updateCountNote);

  function openExamForm(setId, reopen) {
    const f = $("exam-form");
    state.reopen = reopen || null;
    $("set-field").hidden = !!reopen;
    const note = $("reopen-note");
    if (reopen) {
      note.textContent = `Dùng lại toàn bộ câu hỏi và thiết lập của đợt “${reopen.title}”. Đợt mới có mã đề và bảng điểm riêng.`;
      note.hidden = false;
      const m = /^(.*)\(lần (\d+)\)\s*$/.exec(reopen.title);
      f.title.value = m ? `${m[1].trim()} (lần ${+m[2] + 1})` : `${reopen.title} (lần 2)`;
      f.durationMin.value = reopen.durationMin;
      f.questionCount.value = reopen.count < reopen.totalInSet ? reopen.count : "";
      f.shuffle.checked = reopen.shuffle;
      f.oneAttempt.checked = reopen.oneAttempt;
      f.showScore.checked = false;
    } else {
      note.hidden = true;
      fillSetSelect(setId);
    }
    fillClassSelect();
    loadClasses();
    updateCountNote();
    const now = Date.now();
    f.opensAt.value = toLocalInput(now);
    f.closesAt.value = toLocalInput(now + 2 * 60 * 60 * 1000);
    f.hidden = false;
    f.scrollIntoView({ block: "start", behavior: "smooth" });
    f.title.focus();
  }
  $("btn-new-exam").addEventListener("click", () => { $("exam-form").reset(); openExamForm(); });
  $("btn-cancel-exam").addEventListener("click", () => { $("exam-form").hidden = true; state.reopen = null; });
  $("btn-reopen").addEventListener("click", () => {
    const x = state.detail && state.detail.exam;
    if (!x) return;
    showExamHome();
    loadExams();
    $("exam-form").reset();
    openExamForm(null, x);
  });

  $("exam-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const opensAt = fromLocalInput(f.opensAt.value);
    const closesAt = fromLocalInput(f.closesAt.value);
    if (!state.reopen && !f.setId.value) { notify("Chưa có bộ câu hỏi. Hãy tải bộ câu hỏi ở thẻ “Bộ câu hỏi”.", "error"); return; }
    if (!(closesAt > opensAt)) { notify("Giờ đóng phải sau giờ mở.", "error"); return; }
    try {
      const res = await api("POST", "/api/exams", {
        ...(state.reopen ? { sourceExamId: state.reopen.id } : { setId: Number(f.setId.value) }),
        classId: f.classId.value ? Number(f.classId.value) : undefined,
        title: f.title.value.trim(), durationMin: Number(f.durationMin.value),
        questionCount: f.questionCount.value ? Number(f.questionCount.value) : undefined,
        opensAt, closesAt, shuffle: f.shuffle.checked, oneAttempt: f.oneAttempt.checked, showScore: f.showScore.checked,
      });
      f.reset();
      f.hidden = true;
      state.reopen = null;
      notify(`Đã tạo đợt kiểm tra. Mã đề: ${res.code}`);
      openExam(res.id);
    } catch (err) { notify(err.message, "error"); }
  });

  async function loadExams() {
    try {
      const res = await api("GET", "/api/exams");
      state.exams = res.exams;
      renderExams();
    } catch (err) { notify(err.message, "error"); }
  }

  function renderExams() {
    const list = $("exam-list");
    list.textContent = "";
    if (!state.exams.length) { list.append(el("div", { class: "kt-empty", text: "Chưa có đợt kiểm tra nào. Bấm “Tạo đợt kiểm tra” để bắt đầu." })); return; }
    for (const x of state.exams) {
      list.append(el("div", { class: "kt-item" },
        el("div", {},
          el("h3", {}, x.title, " ", el("span", { class: "kt-badge " + x.state, text: stateLabel[x.state] })),
          el("p", {}, "Mã ", el("span", { class: "kt-code", text: x.code }), ` · ${x.className ? "Lớp " + x.className + " · " : ""}${x.count} câu · ${x.durationMin} phút · Đã nộp ${x.submitted}/${x.started}`),
          el("p", { text: `Mở ${fmt(x.opensAt)} → đóng ${fmt(x.closesAt)}` })),
        el("div", { class: "kt-row" }, el("button", { class: "kt-btn kt-btn-primary kt-btn-sm", type: "button", onclick: () => openExam(x.id) }, "Mở"))));
    }
  }

  function showExamHome() {
    $("exam-detail").hidden = true;
    $("exams-home").hidden = false;
    state.detailId = null;
    clearInterval(state.refreshTimer);
  }
  $("btn-back-exams").addEventListener("click", () => { showExamHome(); loadExams(); });

  async function openExam(id) {
    state.detailId = id;
    $("exams-home").hidden = true;
    $("exam-detail").hidden = false;
    await refreshDetail(true);
    clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(() => { if (document.visibilityState === "visible" && state.detailId === id) refreshDetail(false); }, 15000);
    window.scrollTo({ top: 0 });
  }

  async function refreshDetail(full) {
    if (!state.detailId) return;
    try {
      const d = await api("GET", "/api/exams/" + state.detailId);
      state.detail = d;
      renderDetail(d, full);
    } catch (err) {
      notify(err.message, "error");
      if (err.status === 404) { showExamHome(); loadExams(); }
    }
  }
  $("btn-refresh").addEventListener("click", () => refreshDetail(false));

  function renderDetail(d, full) {
    const x = d.exam;
    $("d-title").textContent = x.title;
    $("d-meta").textContent = `${x.className ? "Lớp " + x.className + " (" + x.rosterSize + " học viên) · " : ""}${x.count}${x.count < x.totalInSet ? "/" + x.totalInSet : ""} câu · ${x.durationMin} phút · Mở ${fmt(x.opensAt)} → đóng ${fmt(x.closesAt)}` +
      `${x.shuffle ? " · Trộn câu" : ""}${x.oneAttempt ? " · Mỗi người 1 lần" : ""}`;
    const badge = $("d-state");
    badge.className = "kt-badge " + x.state;
    badge.textContent = stateLabel[x.state];
    if (full) {
      const link = examLink(x.code);
      $("d-code").textContent = x.code;
      $("d-link").textContent = link;
      $("d-link").href = link;
      $("d-qr").innerHTML = qrSvg(link);
    }
    $("d-show-score").checked = x.showScore;
    if (document.activeElement !== $("d-closes")) $("d-closes").value = toLocalInput(x.closesAt);
    $("btn-close-now").disabled = x.state === "closed";

    const submitted = d.attempts.filter((a) => a.status === "submitted");
    const avg = submitted.length ? submitted.reduce((s, a) => s + ten(a.score, a.total), 0) / submitted.length : 0;
    const best = submitted.length ? Math.max(...submitted.map((a) => ten(a.score, a.total))) : 0;
    const sum = $("d-summary");
    sum.textContent = "";
    [[x.className ? `${d.attempts.length}/${x.rosterSize}` : d.attempts.length, "đã vào làm"], [submitted.length, "đã nộp"], [submitted.length ? avg.toLocaleString("vi-VN", { maximumFractionDigits: 1 }) : "—", "điểm trung bình"], [submitted.length ? best.toLocaleString("vi-VN") : "—", "điểm cao nhất"]]
      .forEach(([v, l]) => sum.append(el("div", { class: "kt-fact" }, el("b", { text: String(v) }), el("span", { text: l }))));

    const body = $("d-attempts");
    body.textContent = "";
    if (!d.attempts.length && !d.absent.length) body.append(el("tr", {}, el("td", { colspan: 7, class: "kt-muted", text: "Chưa có học viên nào vào làm bài." })));
    d.attempts.forEach((a, i) => {
      const done = a.status === "submitted";
      body.append(el("tr", {},
        el("td", { class: "num", text: i + 1 }),
        el("td", {}, a.name, a.duplicateName ? el("span", { class: "kt-badge warn", title: "Trùng tên với người khác", style: "margin-left:6px", text: "⚠ trùng tên" }) : null),
        el("td", { class: "num", text: fmtShort(a.startedAt) }),
        el("td", { class: "num" }, done ? fmtShort(a.submittedAt) : el("span", { class: "kt-badge open", text: "Đang làm" }), done && a.finishReason === "timeout" ? el("span", { class: "kt-muted", text: " (hết giờ)" }) : null),
        el("td", { class: "num", text: done ? `${a.score}/${a.total}` : "—" }),
        el("td", { class: "num", text: done ? ten(a.score, a.total).toLocaleString("vi-VN") : "—" }),
        el("td", {}, el("button", { class: "kt-btn kt-btn-danger kt-btn-sm", type: "button", onclick: () => deleteAttempt(a) }, "Xóa"))));
    });
    d.absent.forEach((name, i) => {
      body.append(el("tr", { class: "kt-absent" },
        el("td", { class: "num", text: d.attempts.length + i + 1 }),
        el("td", { text: name }),
        el("td", { colspan: 5 }, el("span", { class: "kt-badge closed", text: "Chưa làm" }))));
    });

    const stats = $("d-stats");
    stats.textContent = "";
    d.questionStats.forEach((q) => {
      const pct = q.shown ? Math.round((q.correct / q.shown) * 100) : null;
      stats.append(el("tr", {},
        el("td", { class: "num", text: q.index }),
        el("td", { text: q.text.length > 140 ? q.text.slice(0, 140) + "…" : q.text }),
        el("td", { class: "num", text: q.shown ? `${q.correct}/${q.shown}` : "—" }),
        el("td", {}, pct == null ? "—" : el("div", { class: "kt-row", style: "flex-wrap:nowrap" }, el("div", { class: "kt-bar", style: "flex:1" }, el("i", { style: `width:${pct}%` })), el("span", { class: "num", text: pct + "%" })))));
    });
  }

  async function deleteAttempt(a) {
    if (!confirm(`Xóa lượt làm bài của “${a.name}”? Học viên này sẽ làm lại được từ đầu.`)) return;
    try { await api("DELETE", `/api/exams/${state.detailId}/attempts/${a.id}`); notify("Đã xóa lượt làm bài."); refreshDetail(false); }
    catch (err) { notify(err.message, "error"); }
  }

  $("d-show-score").addEventListener("change", async (e) => {
    try {
      await api("PATCH", "/api/exams/" + state.detailId, { showScore: e.target.checked });
      notify(e.target.checked ? "Đã công bố điểm cho học viên." : "Đã ẩn điểm với học viên.");
    } catch (err) { e.target.checked = !e.target.checked; notify(err.message, "error"); }
  });
  $("btn-save-close").addEventListener("click", async () => {
    const t = fromLocalInput($("d-closes").value);
    if (!Number.isFinite(t)) return;
    try { await api("PATCH", "/api/exams/" + state.detailId, { closesAt: t }); notify("Đã lưu giờ đóng."); refreshDetail(false); }
    catch (err) { notify(err.message, "error"); }
  });
  $("btn-close-now").addEventListener("click", async () => {
    if (!confirm("Đóng đợt kiểm tra ngay? Học viên chưa vào sẽ không vào được nữa; người đang làm vẫn được làm hết giờ.")) return;
    try { await api("PATCH", "/api/exams/" + state.detailId, { closeNow: true }); notify("Đã đóng đợt kiểm tra."); refreshDetail(false); }
    catch (err) { notify(err.message, "error"); }
  });
  $("btn-delete-exam").addEventListener("click", async () => {
    const x = state.detail && state.detail.exam;
    if (!x || !confirm(`Xóa đợt “${x.title}” và toàn bộ bài làm, bảng điểm? Không thể khôi phục.`)) return;
    try { await api("DELETE", "/api/exams/" + x.id); notify("Đã xóa đợt kiểm tra."); showExamHome(); loadExams(); }
    catch (err) { notify(err.message, "error"); }
  });

  $("btn-copy-link").addEventListener("click", async () => {
    const link = $("d-link").href;
    try { await navigator.clipboard.writeText(link); notify("Đã sao chép liên kết."); }
    catch (_) { prompt("Sao chép liên kết:", link); }
  });

  function present(open) {
    const p = $("present");
    if (!open) { p.hidden = true; document.body.style.overflow = ""; return; }
    const x = state.detail.exam;
    const link = examLink(x.code);
    $("p-title").textContent = x.title;
    $("p-qr").innerHTML = qrSvg(link);
    $("p-code").textContent = x.code;
    $("p-link").textContent = "Quét mã hoặc vào " + link.replace(/^https?:\/\//, "").replace(/\?.*$/, "") + " và nhập mã";
    p.hidden = false;
    document.body.style.overflow = "hidden";
    $("btn-close-present").focus();
    if (p.requestFullscreen) p.requestFullscreen().catch(() => {});
  }
  $("btn-present").addEventListener("click", () => present(true));
  $("btn-close-present").addEventListener("click", () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); present(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("present").hidden) present(false); });
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && !$("present").hidden) present(false); });

  /* Xuất Excel (.xlsx) không cần thư viện bảng tính: tạo tệp từ JSZip. */
  function xmlEsc(s) { return String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;" }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ""); }
  function colName(i) { let s = ""; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  async function buildXlsx(sheetName, rows, widths) {
    const zip = new window.JSZip();
    const sheetRows = rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((v, ci) => {
      const ref = colName(ci) + (ri + 1);
      const style = ri === 0 ? ' s="1"' : "";
      if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEsc(v ?? "")}</t></is></c>`;
    }).join("") + "</row>").join("");
    const cols = widths ? "<cols>" + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("") + "</cols>" : "";
    zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>');
    zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
    zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`);
    zip.file("xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
    zip.file("xl/styles.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');
    zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${sheetRows}</sheetData></worksheet>`);
    return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  $("btn-export").addEventListener("click", async () => {
    const d = state.detail;
    if (!d) return;
    const rows = [["STT", "Họ và tên", "Bắt đầu", "Nộp bài", "Số câu đúng", "Tổng số câu", "Điểm (thang 10)", "Ghi chú"]];
    d.attempts.forEach((a, i) => {
      const done = a.status === "submitted";
      const notes = [done ? (a.finishReason === "timeout" ? "Tự nộp khi hết giờ" : "") : "Chưa nộp", a.duplicateName ? "Trùng tên" : ""].filter(Boolean).join("; ");
      rows.push([i + 1, a.name, fmtShort(a.startedAt), done ? fmtShort(a.submittedAt) : "", done ? a.score : "", done ? a.total : "", done ? ten(a.score, a.total) : "", notes]);
    });
    d.absent.forEach((name, i) => rows.push([d.attempts.length + i + 1, name, "", "", "", "", "", "Chưa làm"]));
    try {
      const blob = await buildXlsx("Bang diem", rows, [6, 30, 18, 18, 12, 12, 15, 24]);
      const safe = d.exam.title.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "bang-diem";
      const a = el("a", { href: URL.createObjectURL(blob), download: `bang-diem-${safe}-${d.exam.code}.xlsx` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (err) { notify("Không tạo được tệp Excel: " + err.message, "error"); }
  });

  /* ---------- Tài khoản (quản trị) ---------- */

  async function loadTeachers() {
    try {
      const res = await api("GET", "/api/admin/teachers");
      const list = $("teacher-list");
      list.textContent = "";
      for (const t of res.teachers) {
        const reset = el("form", { class: "kt-row", hidden: true, style: "margin-top:10px", novalidate: true },
          el("input", { class: "kt-input", name: "password", type: "text", autocomplete: "off", minlength: 8, placeholder: "Mật khẩu mới (≥ 8 ký tự)", style: "flex:1 1 200px" }),
          el("button", { class: "kt-btn kt-btn-primary kt-btn-sm", type: "submit" }, "Lưu"));
        reset.addEventListener("submit", async (e) => {
          e.preventDefault();
          try { await api("PATCH", "/api/admin/teachers/" + t.id, { password: reset.password.value }); notify(`Đã đặt lại mật khẩu cho ${t.displayName}.`); reset.hidden = true; reset.reset(); }
          catch (err) { notify(err.message, "error"); }
        });
        const me = state.user && t.id === state.user.id;
        list.append(el("div", { class: "kt-item" },
          el("div", {},
            el("h3", {}, t.displayName, " ", t.role === "admin" ? el("span", { class: "kt-badge upcoming", text: "Quản trị" }) : null, t.active ? null : el("span", { class: "kt-badge closed", text: "Đã khóa" })),
            el("p", { text: `${t.username} · ${t.sets} bộ câu hỏi · ${t.exams} đợt · Đăng nhập gần nhất: ${fmt(t.lastLogin)}` }),
            reset),
          el("div", { class: "kt-row" },
            el("button", { class: "kt-btn kt-btn-ghost kt-btn-sm", type: "button", onclick: () => { reset.hidden = !reset.hidden; if (!reset.hidden) reset.password.focus(); } }, "Đặt lại mật khẩu"),
            me ? null : el("button", { class: "kt-btn " + (t.active ? "kt-btn-danger" : "kt-btn-ghost") + " kt-btn-sm", type: "button", onclick: () => toggleTeacher(t) }, t.active ? "Khóa" : "Mở khóa"))));
      }
    } catch (err) { notify(err.message, "error"); }
  }

  async function toggleTeacher(t) {
    if (t.active && !confirm(`Khóa tài khoản ${t.displayName}? Giáo viên này sẽ không đăng nhập được; dữ liệu vẫn giữ nguyên.`)) return;
    try { await api("PATCH", "/api/admin/teachers/" + t.id, { active: !t.active }); loadTeachers(); }
    catch (err) { notify(err.message, "error"); }
  }

  $("teacher-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const d = formData(e.target);
      await api("POST", "/api/admin/teachers", d);
      notify(`Đã tạo tài khoản ${d.username}.`);
      e.target.reset();
      loadTeachers();
    } catch (err) { notify(err.message, "error"); }
  });

  boot();
})();
