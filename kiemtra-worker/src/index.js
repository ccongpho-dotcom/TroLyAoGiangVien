// TroLyAoGiangVien — Kiểm tra theo lớp.
// Máy chủ riêng, cơ sở dữ liệu riêng; không dùng chung gì với phần "Tự kiểm tra kiến thức".

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const SUBMIT_GRACE_MS = 90 * 1000;
const MAX_QUESTIONS = 200;
const MAX_TEXT = 2000;
const MAX_OPTION = 600;
const PBKDF2_ITERATIONS = 100000;

let schemaReady = null;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const cors = corsHeaders(origin, allowed);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (origin && !allowed.includes(origin)) return json({ error: "Nguồn truy cập không được phép." }, 403, cors);

    try {
      if (!env.DB) throw httpError(503, "Chưa cấu hình cơ sở dữ liệu.");
      await ensureSchema(env.DB);
      const url = new URL(request.url);
      const res = await route(request, env, url);
      return json(res.body, res.status || 200, cors);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error("kiemtra error", err && err.stack || err);
      return json({ error: status >= 500 ? "Máy chủ gặp lỗi. Vui lòng thử lại." : err.message, code: err.code }, status, cors);
    }
  },
};

/* ----------------------------- Routing ----------------------------- */

async function route(request, env, url) {
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const m = request.method;
  const db = env.DB;
  let mt;

  if (p === "/" || p === "/api/health") return ok({ status: "ok", service: "TroLyAoGiangVien kiemtra" });

  // ---- Thiết lập tài khoản quản trị lần đầu ----
  if (p === "/api/auth/setup-status" && m === "GET") {
    const admins = await countAdmins(db);
    return ok({ needsSetup: admins === 0 && env.SETUP_OPEN === "1" });
  }
  if (p === "/api/auth/setup" && m === "POST") return ok(await setupAdmin(request, env));
  if (p === "/api/auth/login" && m === "POST") return ok(await login(request, env));

  // ---- Học viên ----
  if ((mt = p.match(/^\/api\/exam\/([A-Za-z0-9]{4,10})$/)) && m === "GET") return ok(await examInfo(db, mt[1]));
  if ((mt = p.match(/^\/api\/exam\/([A-Za-z0-9]{4,10})\/start$/)) && m === "POST") return ok(await startAttempt(request, env, mt[1]));
  if (p === "/api/attempt/save" && m === "POST") return ok(await saveAttempt(request, db));
  if (p === "/api/attempt/submit" && m === "POST") return ok(await submitAttempt(request, db));
  if (p === "/api/attempt/status" && m === "POST") return ok(await attemptStatus(request, db));

  // ---- Giáo viên (cần đăng nhập) ----
  if (p.startsWith("/api/")) {
    const user = await requireUser(request, env);
    if (p === "/api/me" && m === "GET") return ok({ user: publicUser(user) });
    if (p === "/api/me/password" && m === "POST") return ok(await changePassword(request, db, user));

    if (p === "/api/sets" && m === "GET") return ok(await listSets(db, user));
    if (p === "/api/sets" && m === "POST") return ok(await createSet(request, db, user));
    if ((mt = p.match(/^\/api\/sets\/(\d+)$/))) {
      if (m === "GET") return ok(await getSet(db, user, +mt[1]));
      if (m === "DELETE") return ok(await deleteSet(db, user, +mt[1]));
    }

    if (p === "/api/exams" && m === "GET") return ok(await listExams(db, user));
    if (p === "/api/exams" && m === "POST") return ok(await createExam(request, db, user));
    if ((mt = p.match(/^\/api\/exams\/(\d+)$/))) {
      if (m === "GET") return ok(await examDetail(db, user, +mt[1]));
      if (m === "PATCH") return ok(await updateExam(request, db, user, +mt[1]));
      if (m === "DELETE") return ok(await deleteExam(db, user, +mt[1]));
    }
    if ((mt = p.match(/^\/api\/exams\/(\d+)\/attempts\/(\d+)$/)) && m === "DELETE") return ok(await deleteAttempt(db, user, +mt[1], +mt[2]));

    if (p.startsWith("/api/admin/")) {
      if (user.role !== "admin") throw httpError(403, "Chỉ tài khoản quản trị mới dùng được chức năng này.");
      if (p === "/api/admin/teachers" && m === "GET") return ok(await listTeachers(db));
      if (p === "/api/admin/teachers" && m === "POST") return ok(await createTeacher(request, db));
      if ((mt = p.match(/^\/api\/admin\/teachers\/(\d+)$/)) && m === "PATCH") return ok(await updateTeacher(request, db, user, +mt[1]));
    }
  }
  throw httpError(404, "Không tìm thấy chức năng.");
}

/* ----------------------------- Schema ----------------------------- */

function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db.batch([
      db.prepare("CREATE TABLE IF NOT EXISTS app_config (k TEXT PRIMARY KEY, v TEXT NOT NULL)"),
      db.prepare(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'teacher', pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL,
        pass_ver INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, last_login INTEGER)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS qsets (
        id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, title TEXT NOT NULL,
        questions TEXT NOT NULL, qcount INTEGER NOT NULL, created_at INTEGER NOT NULL)`),
      db.prepare("CREATE INDEX IF NOT EXISTS qsets_owner ON qsets(owner_id)"),
      db.prepare(`CREATE TABLE IF NOT EXISTS exams (
        id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, owner_id INTEGER NOT NULL,
        set_id INTEGER, title TEXT NOT NULL, questions TEXT NOT NULL, qcount INTEGER NOT NULL,
        duration_min INTEGER NOT NULL, shuffle INTEGER NOT NULL, one_attempt INTEGER NOT NULL,
        show_score INTEGER NOT NULL, opens_at INTEGER NOT NULL, closes_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL)`),
      db.prepare("CREATE INDEX IF NOT EXISTS exams_owner ON exams(owner_id)"),
      db.prepare(`CREATE TABLE IF NOT EXISTS attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, exam_id INTEGER NOT NULL, token TEXT NOT NULL UNIQUE,
        device_id TEXT NOT NULL, student_name TEXT NOT NULL, ip_key TEXT,
        started_at INTEGER NOT NULL, deadline INTEGER NOT NULL, layout TEXT NOT NULL,
        answers TEXT NOT NULL DEFAULT '{}', submitted_at INTEGER, score INTEGER, total INTEGER,
        finish_reason TEXT)`),
      db.prepare("CREATE INDEX IF NOT EXISTS attempts_exam ON attempts(exam_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS attempts_device ON attempts(exam_id, device_id)"),
      db.prepare(`CREATE TABLE IF NOT EXISTS rate_limits (
        k TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL)`),
    ]).catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

/* ----------------------------- Accounts ----------------------------- */

async function countAdmins(db) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").first();
  return row ? row.n : 0;
}

async function setupAdmin(request, env) {
  if (env.SETUP_OPEN !== "1") throw httpError(403, "Chức năng thiết lập đã tắt.");
  if ((await countAdmins(env.DB)) > 0) throw httpError(409, "Đã có tài khoản quản trị.");
  const body = await readJson(request);
  const username = cleanUsername(body.username);
  const displayName = cleanText(body.displayName, 80) || username;
  const password = checkPassword(body.password);
  const { hash, salt } = await hashPassword(password);
  await env.DB.prepare("INSERT INTO users (username, display_name, role, pass_hash, pass_salt, created_at) VALUES (?,?,?,?,?,?)")
    .bind(username, displayName, "admin", hash, salt, Date.now()).run();
  return { created: true };
}

async function login(request, env) {
  const db = env.DB;
  const ipKey = await ipKeyOf(request, env, "login");
  await rateLimit(db, ipKey, 10, 15 * 60 * 1000, "Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.", true);
  const body = await readJson(request);
  const username = String(body.username || "").trim().toLowerCase();
  const user = await db.prepare("SELECT * FROM users WHERE username=?").bind(username).first();
  const valid = user && user.active === 1 && await verifyPassword(String(body.password || ""), user.pass_hash, user.pass_salt);
  if (!valid) {
    await bumpRate(db, ipKey, 15 * 60 * 1000);
    throw httpError(401, user && user.active !== 1 ? "Tài khoản đã bị khóa." : "Sai tên đăng nhập hoặc mật khẩu.");
  }
  await db.prepare("UPDATE users SET last_login=? WHERE id=?").bind(Date.now(), user.id).run();
  const token = await signToken(db, { uid: user.id, pv: user.pass_ver, exp: Date.now() + TOKEN_TTL_MS });
  return { token, user: publicUser(user) };
}

async function requireUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const payload = token && await verifyToken(env.DB, token);
  if (!payload) throw httpError(401, "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.", "AUTH");
  const user = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(payload.uid).first();
  if (!user || user.active !== 1 || user.pass_ver !== payload.pv) throw httpError(401, "Phiên đăng nhập không còn hiệu lực.", "AUTH");
  return user;
}

async function changePassword(request, db, user) {
  const body = await readJson(request);
  if (!await verifyPassword(String(body.current || ""), user.pass_hash, user.pass_salt)) throw httpError(400, "Mật khẩu hiện tại không đúng.");
  const password = checkPassword(body.next);
  const { hash, salt } = await hashPassword(password);
  await db.prepare("UPDATE users SET pass_hash=?, pass_salt=?, pass_ver=pass_ver+1 WHERE id=?").bind(hash, salt, user.id).run();
  const fresh = await db.prepare("SELECT * FROM users WHERE id=?").bind(user.id).first();
  const token = await signToken(db, { uid: fresh.id, pv: fresh.pass_ver, exp: Date.now() + TOKEN_TTL_MS });
  return { changed: true, token };
}

async function listTeachers(db) {
  const rows = await db.prepare(`SELECT u.id, u.username, u.display_name, u.role, u.active, u.created_at, u.last_login,
      (SELECT COUNT(*) FROM qsets s WHERE s.owner_id=u.id) AS sets,
      (SELECT COUNT(*) FROM exams e WHERE e.owner_id=u.id) AS exams
    FROM users u ORDER BY u.role='admin' DESC, u.display_name`).all();
  return { teachers: rows.results.map((r) => ({
    id: r.id, username: r.username, displayName: r.display_name, role: r.role, active: r.active === 1,
    createdAt: r.created_at, lastLogin: r.last_login, sets: r.sets, exams: r.exams,
  })) };
}

async function createTeacher(request, db) {
  const body = await readJson(request);
  const username = cleanUsername(body.username);
  const displayName = cleanText(body.displayName, 80);
  if (!displayName) throw httpError(400, "Nhập họ tên giáo viên.");
  const password = checkPassword(body.password);
  const exists = await db.prepare("SELECT id FROM users WHERE username=?").bind(username).first();
  if (exists) throw httpError(409, "Tên đăng nhập này đã có người dùng.");
  const { hash, salt } = await hashPassword(password);
  await db.prepare("INSERT INTO users (username, display_name, role, pass_hash, pass_salt, created_at) VALUES (?,?,?,?,?,?)")
    .bind(username, displayName, "teacher", hash, salt, Date.now()).run();
  return { created: true };
}

async function updateTeacher(request, db, admin, id) {
  const body = await readJson(request);
  const target = await db.prepare("SELECT * FROM users WHERE id=?").bind(id).first();
  if (!target) throw httpError(404, "Không tìm thấy tài khoản.");
  if (typeof body.active === "boolean") {
    if (target.id === admin.id) throw httpError(400, "Không thể tự khóa tài khoản của mình.");
    await db.prepare("UPDATE users SET active=?, pass_ver=pass_ver+1 WHERE id=?").bind(body.active ? 1 : 0, id).run();
  }
  if (body.displayName !== undefined) {
    const name = cleanText(body.displayName, 80);
    if (!name) throw httpError(400, "Họ tên không được để trống.");
    await db.prepare("UPDATE users SET display_name=? WHERE id=?").bind(name, id).run();
  }
  if (body.password !== undefined) {
    const { hash, salt } = await hashPassword(checkPassword(body.password));
    await db.prepare("UPDATE users SET pass_hash=?, pass_salt=?, pass_ver=pass_ver+1 WHERE id=?").bind(hash, salt, id).run();
  }
  return { updated: true };
}

/* ----------------------------- Question sets ----------------------------- */

function validateQuestions(list) {
  if (!Array.isArray(list) || !list.length) throw httpError(400, "Bộ câu hỏi chưa có câu nào.");
  if (list.length > MAX_QUESTIONS) throw httpError(400, `Mỗi bộ tối đa ${MAX_QUESTIONS} câu.`);
  return list.map((q, i) => {
    const text = cleanText(q && q.text, MAX_TEXT, true);
    const options = Array.isArray(q && q.options) ? q.options.map((o) => cleanText(o, MAX_OPTION, true)) : [];
    const answer = Number(q && q.answer);
    if (!text) throw httpError(400, `Câu ${i + 1}: thiếu nội dung câu hỏi.`);
    if (options.length < 2 || options.length > 6 || options.some((o) => !o)) throw httpError(400, `Câu ${i + 1}: cần từ 2 đến 6 phương án, không để trống.`);
    if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) throw httpError(400, `Câu ${i + 1}: đáp án đúng không hợp lệ.`);
    return { text, options, answer };
  });
}

async function listSets(db, user) {
  const rows = await db.prepare("SELECT id, title, qcount, created_at FROM qsets WHERE owner_id=? ORDER BY created_at DESC").bind(user.id).all();
  return { sets: rows.results.map((r) => ({ id: r.id, title: r.title, count: r.qcount, createdAt: r.created_at })) };
}

async function createSet(request, db, user) {
  const body = await readJson(request, 1_500_000);
  const title = cleanText(body.title, 150);
  if (!title) throw httpError(400, "Nhập tên bộ câu hỏi.");
  const questions = validateQuestions(body.questions);
  const r = await db.prepare("INSERT INTO qsets (owner_id, title, questions, qcount, created_at) VALUES (?,?,?,?,?)")
    .bind(user.id, title, JSON.stringify(questions), questions.length, Date.now()).run();
  return { id: r.meta.last_row_id, count: questions.length };
}

async function getSet(db, user, id) {
  const row = await db.prepare("SELECT * FROM qsets WHERE id=? AND owner_id=?").bind(id, user.id).first();
  if (!row) throw httpError(404, "Không tìm thấy bộ câu hỏi.");
  return { id: row.id, title: row.title, createdAt: row.created_at, questions: JSON.parse(row.questions) };
}

async function deleteSet(db, user, id) {
  const r = await db.prepare("DELETE FROM qsets WHERE id=? AND owner_id=?").bind(id, user.id).run();
  if (!r.meta.changes) throw httpError(404, "Không tìm thấy bộ câu hỏi.");
  return { deleted: true };
}

/* ----------------------------- Exams (teacher) ----------------------------- */

function examState(exam, now = Date.now()) {
  if (now < exam.opens_at) return "upcoming";
  if (now >= exam.closes_at) return "closed";
  return "open";
}

async function newExamCode(db) {
  for (let i = 0; i < 12; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const code = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
    const hit = await db.prepare("SELECT 1 FROM exams WHERE code=?").bind(code).first();
    if (!hit) return code;
  }
  throw httpError(500, "Không tạo được mã đề.");
}

async function createExam(request, db, user) {
  const body = await readJson(request);
  const set = await db.prepare("SELECT * FROM qsets WHERE id=? AND owner_id=?").bind(Number(body.setId), user.id).first();
  if (!set) throw httpError(404, "Không tìm thấy bộ câu hỏi.");
  const title = cleanText(body.title, 150) || set.title;
  const duration = intIn(body.durationMin, 1, 300);
  if (!duration) throw httpError(400, "Thời gian làm bài từ 1 đến 300 phút.");
  const now = Date.now();
  const opensAt = Number.isFinite(Number(body.opensAt)) && Number(body.opensAt) > 0 ? Number(body.opensAt) : now;
  const closesAt = Number(body.closesAt);
  if (!Number.isFinite(closesAt) || closesAt <= opensAt) throw httpError(400, "Giờ đóng phải sau giờ mở.");
  if (closesAt - opensAt > 60 * 24 * 60 * 60 * 1000) throw httpError(400, "Một đợt kiểm tra mở tối đa 60 ngày.");
  let questions = JSON.parse(set.questions);
  const pick = intIn(body.questionCount, 1, questions.length);
  const code = await newExamCode(db);
  const r = await db.prepare(`INSERT INTO exams (code, owner_id, set_id, title, questions, qcount, duration_min, shuffle, one_attempt, show_score, opens_at, closes_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(code, user.id, set.id, title, JSON.stringify(questions), pick || questions.length, duration,
      body.shuffle ? 1 : 0, body.oneAttempt === false ? 0 : 1, body.showScore ? 1 : 0, opensAt, closesAt, now).run();
  return { id: r.meta.last_row_id, code };
}

async function listExams(db, user) {
  const rows = await db.prepare(`SELECT e.id, e.code, e.title, e.qcount, e.duration_min, e.opens_at, e.closes_at, e.show_score, e.created_at,
      (SELECT COUNT(*) FROM attempts a WHERE a.exam_id=e.id) AS started,
      (SELECT COUNT(*) FROM attempts a WHERE a.exam_id=e.id AND a.submitted_at IS NOT NULL) AS submitted
    FROM exams e WHERE e.owner_id=? ORDER BY e.created_at DESC`).bind(user.id).all();
  const now = Date.now();
  return { exams: rows.results.map((e) => ({
    id: e.id, code: e.code, title: e.title, count: e.qcount, durationMin: e.duration_min, opensAt: e.opens_at,
    closesAt: e.closes_at, showScore: e.show_score === 1, createdAt: e.created_at, state: examState(e, now),
    started: e.started, submitted: e.submitted,
  })) };
}

async function ownedExam(db, user, id) {
  const exam = await db.prepare("SELECT * FROM exams WHERE id=? AND owner_id=?").bind(id, user.id).first();
  if (!exam) throw httpError(404, "Không tìm thấy đợt kiểm tra.");
  return exam;
}

async function examDetail(db, user, id) {
  const exam = await ownedExam(db, user, id);
  await finalizeExpired(db, exam);
  const rows = await db.prepare("SELECT * FROM attempts WHERE exam_id=? ORDER BY student_name COLLATE NOCASE, started_at").bind(exam.id).all();
  const questions = JSON.parse(exam.questions);
  const stats = questions.map(() => ({ shown: 0, correct: 0 }));
  const nameCount = new Map();
  for (const a of rows.results) {
    const key = nameKey(a.student_name);
    nameCount.set(key, (nameCount.get(key) || 0) + 1);
    if (a.submitted_at == null) continue;
    const layout = JSON.parse(a.layout);
    const answers = JSON.parse(a.answers || "{}");
    for (const item of layout) {
      stats[item.q].shown++;
      if (Number(answers[item.q]) === questions[item.q].answer) stats[item.q].correct++;
    }
  }
  const now = Date.now();
  return {
    exam: {
      id: exam.id, code: exam.code, title: exam.title, count: exam.qcount, totalInSet: questions.length,
      durationMin: exam.duration_min, shuffle: exam.shuffle === 1, oneAttempt: exam.one_attempt === 1,
      showScore: exam.show_score === 1, opensAt: exam.opens_at, closesAt: exam.closes_at, state: examState(exam, now),
    },
    attempts: rows.results.map((a) => ({
      id: a.id, name: a.student_name, startedAt: a.started_at, submittedAt: a.submitted_at, deadline: a.deadline,
      score: a.score, total: a.total, finishReason: a.finish_reason,
      status: a.submitted_at != null ? "submitted" : "working",
      duplicateName: nameCount.get(nameKey(a.student_name)) > 1,
    })),
    questionStats: questions.map((q, i) => ({ index: i + 1, text: q.text, shown: stats[i].shown, correct: stats[i].correct })),
  };
}

async function updateExam(request, db, user, id) {
  const exam = await ownedExam(db, user, id);
  const body = await readJson(request);
  const now = Date.now();
  if (typeof body.showScore === "boolean") await db.prepare("UPDATE exams SET show_score=? WHERE id=?").bind(body.showScore ? 1 : 0, exam.id).run();
  if (body.closeNow === true) await db.prepare("UPDATE exams SET closes_at=? WHERE id=?").bind(Math.min(exam.closes_at, now), exam.id).run();
  if (body.closesAt !== undefined) {
    const closesAt = Number(body.closesAt);
    if (!Number.isFinite(closesAt) || closesAt <= exam.opens_at) throw httpError(400, "Giờ đóng phải sau giờ mở.");
    await db.prepare("UPDATE exams SET closes_at=? WHERE id=?").bind(closesAt, exam.id).run();
  }
  return { updated: true };
}

async function deleteExam(db, user, id) {
  const exam = await ownedExam(db, user, id);
  await db.batch([
    db.prepare("DELETE FROM attempts WHERE exam_id=?").bind(exam.id),
    db.prepare("DELETE FROM exams WHERE id=?").bind(exam.id),
  ]);
  return { deleted: true };
}

async function deleteAttempt(db, user, examId, attemptId) {
  const exam = await ownedExam(db, user, examId);
  const r = await db.prepare("DELETE FROM attempts WHERE id=? AND exam_id=?").bind(attemptId, exam.id).run();
  if (!r.meta.changes) throw httpError(404, "Không tìm thấy bài làm.");
  return { deleted: true };
}

/* ----------------------------- Student flow ----------------------------- */

async function examByCode(db, code) {
  const exam = await db.prepare("SELECT e.*, u.display_name AS teacher FROM exams e JOIN users u ON u.id=e.owner_id WHERE e.code=?")
    .bind(String(code).toUpperCase()).first();
  if (!exam) throw httpError(404, "Mã đề không đúng hoặc đợt kiểm tra đã bị xóa.", "NO_EXAM");
  return exam;
}

async function examInfo(db, code) {
  const exam = await examByCode(db, code);
  return {
    code: exam.code, title: exam.title, teacher: exam.teacher, count: exam.qcount, durationMin: exam.duration_min,
    opensAt: exam.opens_at, closesAt: exam.closes_at, state: examState(exam), oneAttempt: exam.one_attempt === 1,
    serverNow: Date.now(),
  };
}

function shuffled(n) {
  const arr = [...Array(n).keys()];
  const rnd = crypto.getRandomValues(new Uint32Array(n));
  for (let i = n - 1; i > 0; i--) { const j = rnd[i] % (i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

function buildLayout(exam, questions) {
  const order = exam.shuffle === 1 ? shuffled(questions.length) : [...questions.keys()];
  const picked = order.slice(0, exam.qcount);
  return picked.map((q) => ({ q, o: exam.shuffle === 1 ? shuffled(questions[q].options.length) : [...questions[q].options.keys()] }));
}

function studentQuestions(questions, layout) {
  return layout.map((item, i) => ({
    id: item.q, number: i + 1, text: questions[item.q].text,
    options: item.o.map((oi) => ({ id: oi, text: questions[item.q].options[oi] })),
  }));
}

function gradeAttempt(questions, layout, answers) {
  let score = 0;
  for (const item of layout) if (Number(answers[item.q]) === questions[item.q].answer) score++;
  return { score, total: layout.length };
}

function cleanAnswers(raw, layout) {
  const allowed = new Map(layout.map((it) => [String(it.q), new Set(it.o)]));
  const out = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      const opts = allowed.get(String(k));
      const n = Number(v);
      if (opts && Number.isInteger(n) && opts.has(n)) out[k] = n;
    }
  }
  return out;
}

function resultView(exam, attempt) {
  const showScore = exam.show_score === 1;
  return {
    submitted: true, name: attempt.student_name, submittedAt: attempt.submitted_at, showScore,
    score: showScore ? attempt.score : null, total: showScore ? attempt.total : null, title: exam.title,
  };
}

async function finalizeOne(db, exam, attempt, reason, answersOverride) {
  const questions = JSON.parse(exam.questions);
  const layout = JSON.parse(attempt.layout);
  const answers = answersOverride || JSON.parse(attempt.answers || "{}");
  const { score, total } = gradeAttempt(questions, layout, answers);
  const at = reason === "timeout" ? Math.min(Date.now(), attempt.deadline) : Date.now();
  await db.prepare("UPDATE attempts SET answers=?, submitted_at=?, score=?, total=?, finish_reason=? WHERE id=? AND submitted_at IS NULL")
    .bind(JSON.stringify(answers), at, score, total, reason, attempt.id).run();
  return { ...attempt, answers: JSON.stringify(answers), submitted_at: at, score, total, finish_reason: reason };
}

async function finalizeExpired(db, exam) {
  const limit = Date.now() - SUBMIT_GRACE_MS;
  const rows = await db.prepare("SELECT * FROM attempts WHERE exam_id=? AND submitted_at IS NULL AND deadline < ?").bind(exam.id, limit).all();
  for (const a of rows.results) await finalizeOne(db, exam, a, "timeout");
}

async function startAttempt(request, env, code) {
  const db = env.DB;
  const body = await readJson(request);
  const exam = await examByCode(db, code);
  const deviceId = String(body.deviceId || "");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(deviceId)) throw httpError(400, "Thiết bị không hợp lệ. Hãy tải lại trang.");
  const now = Date.now();
  const questions = JSON.parse(exam.questions);

  // Bài đang làm hoặc đã nộp trên cùng thiết bị.
  const existing = await db.prepare("SELECT * FROM attempts WHERE exam_id=? AND device_id=? ORDER BY started_at DESC LIMIT 1").bind(exam.id, deviceId).first();
  if (existing) {
    let att = existing;
    if (att.submitted_at == null && now > att.deadline + SUBMIT_GRACE_MS) att = await finalizeOne(db, exam, att, "timeout");
    if (att.submitted_at == null) {
      return {
        token: att.token, name: att.student_name, deadline: att.deadline, serverNow: now, title: exam.title,
        questions: studentQuestions(questions, JSON.parse(att.layout)), answers: JSON.parse(att.answers || "{}"),
      };
    }
    if (exam.one_attempt === 1) return { ...resultView(exam, att), token: att.token, alreadyDone: true };
  }

  const state = examState(exam, now);
  if (state === "upcoming") throw httpError(403, "Đợt kiểm tra chưa mở.", "NOT_OPEN");
  if (state === "closed") throw httpError(403, "Đợt kiểm tra đã đóng.", "CLOSED");
  const name = cleanText(body.name, 80);
  if (!name || name.length < 4 || !/\s/.test(name)) throw httpError(400, "Vui lòng nhập đầy đủ họ và tên.");

  const ipKey = await ipKeyOf(request, env, "start");
  await rateLimit(db, ipKey, 400, 10 * 60 * 1000, "Có quá nhiều lượt vào thi từ cùng một mạng. Vui lòng thử lại sau ít phút.");
  await bumpRate(db, ipKey, 10 * 60 * 1000);

  const layout = buildLayout(exam, questions);
  const deadline = Math.min(now + exam.duration_min * 60 * 1000, exam.closes_at);
  const token = randomToken(32);
  await db.prepare(`INSERT INTO attempts (exam_id, token, device_id, student_name, ip_key, started_at, deadline, layout)
      VALUES (?,?,?,?,?,?,?,?)`).bind(exam.id, token, deviceId, name, ipKey, now, deadline, JSON.stringify(layout)).run();
  return { token, name, deadline, serverNow: now, title: exam.title, questions: studentQuestions(questions, layout), answers: {} };
}

async function attemptByToken(db, token) {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(String(token || ""))) throw httpError(400, "Phiên làm bài không hợp lệ.");
  const att = await db.prepare("SELECT * FROM attempts WHERE token=?").bind(token).first();
  if (!att) throw httpError(404, "Không tìm thấy bài làm. Có thể giáo viên đã xóa.", "NO_ATTEMPT");
  const exam = await db.prepare("SELECT * FROM exams WHERE id=?").bind(att.exam_id).first();
  if (!exam) throw httpError(404, "Đợt kiểm tra đã bị xóa.", "NO_EXAM");
  return { att, exam };
}

async function saveAttempt(request, db) {
  const body = await readJson(request);
  const { att, exam } = await attemptByToken(db, body.token);
  if (att.submitted_at != null) return { saved: false, submitted: true };
  if (Date.now() > att.deadline + 5000) return { saved: false, expired: true };
  const answers = cleanAnswers(body.answers, JSON.parse(att.layout));
  await db.prepare("UPDATE attempts SET answers=? WHERE id=? AND submitted_at IS NULL").bind(JSON.stringify(answers), att.id).run();
  return { saved: true, examTitle: exam.title };
}

async function submitAttempt(request, db) {
  const body = await readJson(request);
  const { att, exam } = await attemptByToken(db, body.token);
  if (att.submitted_at != null) return resultView(exam, att);
  const layout = JSON.parse(att.layout);
  const late = Date.now() > att.deadline + SUBMIT_GRACE_MS;
  // Nộp trễ quá thời gian cho phép: chỉ chấm các câu đã lưu trước khi hết giờ.
  const answers = late ? JSON.parse(att.answers || "{}") : cleanAnswers(body.answers, layout);
  const done = await finalizeOne(db, exam, att, late ? "timeout" : (body.auto ? "auto" : "manual"), answers);
  return resultView(exam, done);
}

async function attemptStatus(request, db) {
  const body = await readJson(request);
  const { att, exam } = await attemptByToken(db, body.token);
  let current = att;
  if (current.submitted_at == null && Date.now() > current.deadline + SUBMIT_GRACE_MS) current = await finalizeOne(db, exam, current, "timeout");
  if (current.submitted_at == null) return { submitted: false, deadline: current.deadline, serverNow: Date.now() };
  return resultView(exam, current);
}

/* ----------------------------- Helpers ----------------------------- */

function ok(body) { return { body, status: 200 }; }

function httpError(status, message, code) { return Object.assign(new Error(message), { status, code }); }

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

function corsHeaders(origin, allowed) {
  const h = { "Vary": "Origin" };
  if (origin && allowed.includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET, POST, PATCH, DELETE, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    h["Access-Control-Max-Age"] = "600";
  }
  return h;
}

async function readJson(request, max = 64_000) {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > max) throw httpError(413, "Dữ liệu gửi lên quá lớn.");
  const text = await request.text();
  if (text.length > max) throw httpError(413, "Dữ liệu gửi lên quá lớn.");
  try { return text ? JSON.parse(text) : {}; } catch { throw httpError(400, "Dữ liệu không hợp lệ."); }
}

function cleanText(value, max, multiline = false) {
  let s = String(value ?? "").normalize("NFC").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  s = multiline ? s.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() : s.replace(/\s+/g, " ").trim();
  return s.slice(0, max);
}

function nameKey(name) {
  return String(name || "").normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/gi, "d").toLowerCase().replace(/\s+/g, " ").trim();
}

function cleanUsername(value) {
  const u = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(u)) throw httpError(400, "Tên đăng nhập 3–32 ký tự, chỉ gồm chữ không dấu, số, dấu chấm, gạch ngang.");
  return u;
}

function checkPassword(value) {
  const p = String(value || "");
  if (p.length < 8 || p.length > 128) throw httpError(400, "Mật khẩu cần từ 8 ký tự trở lên.");
  return p;
}

function intIn(value, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : 0;
}

function publicUser(u) { return { id: u.id, username: u.username, displayName: u.display_name, role: u.role }; }

const enc = new TextEncoder();

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function randomToken(n) { return b64url(crypto.getRandomValues(new Uint8Array(n))); }

async function hashPassword(password, saltB64) {
  const salt = saltB64 ? b64urlDecode(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, key, 256);
  return { hash: b64url(new Uint8Array(bits)), salt: b64url(salt) };
}

async function verifyPassword(password, hash, salt) {
  if (!password || !hash || !salt) return false;
  const { hash: h } = await hashPassword(password, salt);
  return timingSafeEqual(h, hash);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

let signingKey = null;
async function getSigningKey(db) {
  if (signingKey) return signingKey;
  let row = await db.prepare("SELECT v FROM app_config WHERE k='signing_key'").first();
  if (!row) {
    await db.prepare("INSERT OR IGNORE INTO app_config (k, v) VALUES ('signing_key', ?)").bind(randomToken(32)).run();
    row = await db.prepare("SELECT v FROM app_config WHERE k='signing_key'").first();
  }
  signingKey = await crypto.subtle.importKey("raw", b64urlDecode(row.v), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return signingKey;
}

async function signToken(db, payload) {
  const key = await getSigningKey(db);
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

async function verifyToken(db, token) {
  const [body, sig] = String(token).split(".");
  if (!body || !sig) return null;
  const key = await getSigningKey(db);
  let valid = false;
  try { valid = await crypto.subtle.verify("HMAC", key, b64urlDecode(sig), enc.encode(body)); } catch { return null; }
  if (!valid) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    return payload.exp > Date.now() ? payload : null;
  } catch { return null; }
}

async function ipKeyOf(request, env, scope) {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const key = await getSigningKey(env.DB);
  const day = Math.floor(Date.now() / 86400000);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${scope}|${day}|${ip}`)));
  return `${scope}:${b64url(sig).slice(0, 22)}`;
}

async function rateLimit(db, k, max, windowMs, message) {
  const row = await db.prepare("SELECT count, window_start FROM rate_limits WHERE k=?").bind(k).first();
  if (row && Date.now() - row.window_start < windowMs && row.count >= max) throw httpError(429, message, "RATE_LIMIT");
}

async function bumpRate(db, k, windowMs) {
  const now = Date.now();
  await db.prepare(`INSERT INTO rate_limits (k, count, window_start) VALUES (?, 1, ?)
      ON CONFLICT(k) DO UPDATE SET
        count = CASE WHEN ? - window_start >= ? THEN 1 ELSE count + 1 END,
        window_start = CASE WHEN ? - window_start >= ? THEN ? ELSE window_start END`)
    .bind(k, now, now, windowMs, now, windowMs, now).run();
}
