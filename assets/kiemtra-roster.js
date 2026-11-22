/* Đọc danh sách lớp từ tệp Excel (.xlsx), Word (.docx) hoặc văn bản (.csv, .txt).
   Nhận ra: dòng "Tên lớp: …", cột "Họ và tên" (hoặc hai cột "Họ đệm" + "Tên"), cột "Ghi chú"/"Năm sinh".
   Bỏ qua dòng ví dụ (có chữ "ví dụ"). */
(function (root) {
  "use strict";

  const fold = (s) => String(s || "").normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/gi, "d").toLowerCase().replace(/\s+/g, " ").trim();
  const clean = (s) => String(s || "").normalize("NFC").replace(/ /g, " ").replace(/\s+/g, " ").trim();
  const decodeXml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, "&");
  const textOf = (xml) => { let out = ""; const re = /<(?:w:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:w:)?t>/g; let m; while ((m = re.exec(xml))) out += decodeXml(m[1]); return out; };

  /* ---------- Excel ---------- */
  function colIndex(ref) { const letters = /^[A-Z]+/.exec(ref)[0]; let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }

  async function gridFromXlsx(zip) {
    const wb = await zip.file("xl/workbook.xml")?.async("string");
    if (!wb) throw new Error("Tệp Excel không hợp lệ.");
    const firstSheet = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb);
    let path = "xl/worksheets/sheet1.xml";
    const rels = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
    if (firstSheet && rels) {
      const re = new RegExp(`<Relationship\\b[^>]*\\bId="${firstSheet[1]}"[^>]*>`);
      const rel = re.exec(rels);
      const target = rel && /\bTarget="([^"]+)"/.exec(rel[0]);
      if (target) path = target[1].startsWith("/") ? target[1].slice(1) : "xl/" + target[1].replace(/^\.\//, "");
    }
    const sheet = await zip.file(path)?.async("string");
    if (!sheet) throw new Error("Không tìm thấy trang tính trong tệp Excel.");
    const shared = [];
    const ss = await zip.file("xl/sharedStrings.xml")?.async("string");
    if (ss) { const re = /<si>([\s\S]*?)<\/si>/g; let m; while ((m = re.exec(ss))) shared.push(textOf(m[1])); }
    const grid = [];
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let r;
    while ((r = rowRe.exec(sheet))) {
      const row = [];
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let c;
      while ((c = cellRe.exec(r[1]))) {
        const attrs = c[1], body = c[2] || "";
        const ref = /\br="([A-Z]+\d+)"/.exec(attrs);
        const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1];
        let val = "";
        if (type === "s") { const v = /<v>([\s\S]*?)<\/v>/.exec(body); val = v ? shared[+v[1]] || "" : ""; }
        else if (type === "inlineStr") val = textOf(body);
        else { const v = /<v>([\s\S]*?)<\/v>/.exec(body); val = v ? decodeXml(v[1]) : ""; }
        row[ref ? colIndex(ref[1]) : row.length] = clean(val);
      }
      grid.push(Array.from(row, (v) => v || ""));
    }
    return { grid, extraLines: [] };
  }

  /* ---------- Word ---------- */
  async function gridFromDocx(zip) {
    const xml = await zip.file("word/document.xml")?.async("string");
    if (!xml) throw new Error("Tệp Word không hợp lệ.");
    const grid = [];
    const tblRe = /<w:tbl>[\s\S]*?<\/w:tbl>/g;
    let t;
    while ((t = tblRe.exec(xml))) {
      const trRe = /<w:tr[\s>][\s\S]*?<\/w:tr>/g;
      let tr;
      while ((tr = trRe.exec(t[0]))) {
        const cells = [];
        const tcRe = /<w:tc[\s>][\s\S]*?<\/w:tc>/g;
        let tc;
        while ((tc = tcRe.exec(tr[0]))) cells.push(clean(textOf(tc[0])));
        grid.push(cells);
      }
    }
    // Đoạn văn ngoài bảng (dòng "Tên lớp", hoặc danh sách gõ mỗi dòng một tên).
    const outside = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, "");
    const extraLines = [];
    const pRe = /<w:p[\s>][\s\S]*?<\/w:p>/g;
    let p;
    while ((p = pRe.exec(outside))) { const line = clean(textOf(p[0])); if (line) extraLines.push(line); }
    return { grid, extraLines };
  }

  /* ---------- Văn bản ---------- */
  function gridFromText(text) {
    const lines = String(text).replace(/^﻿/, "").split(/\r?\n/);
    const sep = lines.some((l) => l.includes("\t")) ? "\t" : lines.filter((l) => l.includes(";")).length > lines.filter((l) => l.includes(",")).length ? ";" : ",";
    return { grid: lines.map((l) => l.split(sep).map((c) => clean(c.replace(/^"|"$/g, "")))), extraLines: [] };
  }

  /* ---------- Phân tích bảng ---------- */
  const isNameLike = (s) => /\p{L}+\s+\p{L}+/u.test(s) && !/\d{3,}/.test(s) && s.length <= 80;
  const isExample = (cells) => cells.some((c) => /\bvi du\b/.test(fold(c)));

  function analyse({ grid, extraLines }) {
    const warnings = [];
    let className = "";
    const nameFrom = (s) => { const m = /^t[eê]n l[oớ]p\s*[:：]\s*(.+)$/i.exec(clean(s)); return m ? clean(m[1]) : ""; };
    for (const row of grid) {
      row.forEach((c, i) => {
        if (className) return;
        className = nameFrom(c);
        if (!className && /^t[eê]n l[oớ]p\s*[:：]?$/i.test(c)) className = row.slice(i + 1).find(Boolean) || "";
      });
    }
    if (!className) for (const l of extraLines) { className = nameFrom(l); if (className) break; }

    // Tìm dòng tiêu đề.
    let header = -1, nameCol = -1, lastCol = -1, firstCol = -1, noteCol = -1;
    for (let r = 0; r < grid.length && header < 0; r++) {
      const cells = grid[r].map((c) => (c.length <= 40 ? fold(c) : ""));
      const full = cells.findIndex((c) => /^(ho (va )?ten|ho ten|ho va ten hoc vien|ten hoc vien|hoc vien)$/.test(c));
      const fam = cells.findIndex((c) => /^(ho( va)?( ten)? ?dem|ho dem|ho)$/.test(c));
      const giv = cells.findIndex((c) => c === "ten");
      if (full >= 0 || (fam >= 0 && giv >= 0)) {
        header = r;
        if (full >= 0) nameCol = full; else { firstCol = fam; lastCol = giv; }
        noteCol = cells.findIndex((c) => /^(ghi chu|nam sinh|ngay sinh|don vi|lop)$/.test(c));
      }
    }
    if (header < 0) {
      // Không có tiêu đề: chọn cột có nhiều ô giống họ tên nhất.
      const counts = [];
      grid.forEach((row) => row.forEach((c, i) => { if (isNameLike(c) && !nameFrom(c)) counts[i] = (counts[i] || 0) + 1; }));
      nameCol = counts.reduce((best, n, i) => (n > (counts[best] || 0) ? i : best), -1);
    }

    const entries = [];
    const rows = header >= 0 ? grid.slice(header + 1) : grid;
    for (const row of rows) {
      if (isExample(row)) continue;
      let name = nameCol >= 0 ? row[nameCol] || "" : `${row[firstCol] || ""} ${row[lastCol] || ""}`;
      name = clean(name).replace(/^\d+\s*[.)\-–]?\s+/, "");
      if (!name || !/\p{L}/u.test(name) || nameFrom(name) || /^t[eê]n l[oớ]p/i.test(name)) continue;
      if (header < 0 && !isNameLike(name)) continue;
      entries.push({ name, note: noteCol >= 0 ? clean(row[noteCol] || "") : "" });
    }
    if (!entries.length && extraLines.length) {
      for (const l of extraLines) {
        const n = l.replace(/^\d+\s*[.)\-–]?\s+/, "");
        if (isNameLike(n) && !nameFrom(n) && !/^(danh sach|huong dan|trolyaogiangvien)/.test(fold(n))) entries.push({ name: n, note: "" });
      }
    }

    // Phân biệt người trùng tên bằng ghi chú.
    const byKey = new Map();
    entries.forEach((e) => { const k = fold(e.name); byKey.set(k, (byKey.get(k) || 0) + 1); });
    const students = entries.map((e) => (byKey.get(fold(e.name)) > 1 && e.note ? `${e.name} (${e.note})` : e.name));
    const seen = new Set(), dups = new Set();
    students.forEach((s) => { const k = fold(s); if (seen.has(k)) dups.add(s); seen.add(k); });
    if (dups.size) warnings.push(`Còn tên trùng: ${[...dups].join(", ")}. Hãy thêm năm sinh hoặc đơn vị vào cột Ghi chú rồi nhập lại, hoặc sửa trực tiếp trong ô danh sách.`);
    return { className, students, warnings };
  }

  async function parseFile(file, JSZipLib) {
    const name = (file.name || "").toLowerCase();
    const Zip = JSZipLib || root.JSZip;
    if (/\.(xls|doc)$/.test(name)) throw new Error("Tệp .xls/.doc kiểu cũ chưa đọc được. Hãy mở bằng Excel/Word rồi “Lưu thành” .xlsx/.docx.");
    if (/\.(csv|txt)$/.test(name)) return analyse(gridFromText(await file.text()));
    if (!/\.(xlsx|docx)$/.test(name)) throw new Error("Chỉ nhận tệp Excel (.xlsx), Word (.docx), .csv hoặc .txt.");
    let zip;
    try { zip = await Zip.loadAsync(await file.arrayBuffer()); } catch (_) { throw new Error("Không mở được tệp. Tệp có thể bị hỏng hoặc đang đặt mật khẩu."); }
    return analyse(name.endsWith(".xlsx") ? await gridFromXlsx(zip) : await gridFromDocx(zip));
  }

  const api = { parseFile, analyse, gridFromText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KiemTraRoster = api;
})(typeof window !== "undefined" ? window : globalThis);
