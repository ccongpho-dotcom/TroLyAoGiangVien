/* Đọc bộ câu hỏi từ tệp Word (.docx) theo mẫu của TroLyAoGiangVien.
   Mẫu:
     Câu 1: Nội dung câu hỏi
     A. Phương án A
     B. Phương án B
     ...
     Đáp án: B
   Mọi dòng trước "Câu 1:" (hướng dẫn, tiêu đề) được bỏ qua. */
(function (root) {
  "use strict";

  const LETTERS = "ABCDEF";

  function decodeXml(s) {
    return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&amp;/g, "&");
  }

  // Trả về danh sách đoạn văn: { text, numbered }
  function paragraphsFromXml(xml) {
    const out = [];
    const paraRe = /<w:p[\s>][\s\S]*?<\/w:p>|<w:p\/>/g;
    let m;
    while ((m = paraRe.exec(xml))) {
      const p = m[0];
      const numbered = /<w:numPr>/.test(p) || /<w:pStyle w:val="List(?:Number|Bullet)/i.test(p);
      let text = "";
      const tokRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br(?:\s[^>]*)?\/>|<w:cr\/>/g;
      let t;
      while ((t = tokRe.exec(p))) {
        if (t[1] !== undefined) text += decodeXml(t[1]);
        else if (t[0].startsWith("<w:tab")) text += " ";
        else text += "\n";
      }
      out.push({ text: text.normalize("NFC"), numbered });
    }
    return out;
  }

  function parseParagraphs(paragraphs) {
    const questions = [];
    const errors = [];
    let cur = null;

    const finish = () => {
      if (!cur) return;
      const label = `Câu ${cur.no}`;
      cur.text = cur.text.trim();
      cur.options = cur.options.map((o) => o.trim());
      const problems = [];
      if (!cur.text) problems.push("thiếu nội dung câu hỏi");
      if (cur.options.length < 2) problems.push("cần ít nhất 2 phương án (A., B., …)");
      if (cur.options.some((o) => !o)) problems.push("có phương án để trống");
      if (cur.answer == null) problems.push("thiếu dòng “Đáp án: …”");
      else if (cur.answer >= cur.options.length) problems.push(`đáp án ${LETTERS[cur.answer]} không có trong các phương án`);
      if (problems.length) errors.push(`${label}: ${problems.join("; ")}.`);
      questions.push({ no: cur.no, text: cur.text, options: cur.options, answer: cur.answer, ok: !problems.length });
      cur = null;
    };

    for (const para of paragraphs) {
      const lines = para.text.split("\n");
      for (let raw of lines) {
        const line = raw.replace(/ /g, " ").replace(/\s+/g, " ").trim();
        if (!line) continue;
        const q = /^Câu(?:\s*hỏi)?\s*(\d+)\s*[:.)\-–]\s*(.*)$/i.exec(line);
        if (q) { finish(); cur = { no: +q[1], text: q[2], options: [], answer: null }; continue; }
        if (!cur) continue;
        const a = /^(?:Đáp\s*án(?:\s*đúng)?|ĐA)\s*[:.\-–]?\s*([A-F])\s*\.?$/i.exec(line);
        if (a) { cur.answer = LETTERS.indexOf(a[1].toUpperCase()); continue; }
        const expected = LETTERS[cur.options.length];
        const o = /^(\*)?\s*([A-F])\s*[.):]\s*(.*)$/i.exec(line);
        if (o && expected && o[2].toUpperCase() === expected) {
          if (o[1]) cur.answer = cur.options.length;
          cur.options.push(o[3]);
          continue;
        }
        if (para.numbered && expected && (cur.text || cur.options.length)) {
          // Phương án dùng đánh số tự động của Word (A, B, C… không nằm trong chữ).
          const star = line.startsWith("*");
          if (star) cur.answer = cur.options.length;
          cur.options.push(star ? line.slice(1).trim() : line);
          continue;
        }
        if (cur.options.length) cur.options[cur.options.length - 1] += " " + line;
        else cur.text += (cur.text ? "\n" : "") + line;
      }
    }
    finish();
    if (!questions.length) errors.push("Không tìm thấy câu hỏi nào. Mỗi câu phải bắt đầu bằng “Câu 1:”, “Câu 2:”…");
    return { questions, errors };
  }

  async function parseDocx(arrayBuffer, JSZipLib) {
    const Zip = JSZipLib || root.JSZip;
    let zip;
    try { zip = await Zip.loadAsync(arrayBuffer); } catch (_) { throw new Error("Không đọc được tệp. Hãy chọn tệp Word dạng .docx."); }
    const file = zip.file("word/document.xml");
    if (!file) throw new Error("Tệp không phải văn bản Word (.docx) hợp lệ.");
    const xml = await file.async("string");
    return parseParagraphs(paragraphsFromXml(xml));
  }

  const api = { parseDocx, parseParagraphs, paragraphsFromXml };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KiemTraDocx = api;
})(typeof window !== "undefined" ? window : globalThis);
