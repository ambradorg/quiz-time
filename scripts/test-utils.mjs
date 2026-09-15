/**
 * Shared fixtures for the failover test suites.
 */

/**
 * Builds a minimal, valid single-page PDF with one line of Helvetica text.
 * Small enough to craft by hand (correct xref offsets included) — no PDF
 * library needed — but complete enough for pdf.js to parse and extract.
 */
export function buildPdfBuffer(text) {
  const header = "%PDF-1.4\n";
  const objects = [];
  objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  objects.push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  const esc = text.replace(/([\\()])/g, "\\$1");
  objects.push(
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n"
  );
  const stream = `BT /F1 12 Tf 72 720 Td (${esc}) Tj ET`;
  objects.push(`4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  objects.push("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");

  let pdf = header;
  const offsets = [0];
  for (const o of objects) {
    offsets.push(pdf.length);
    pdf += o;
  }
  const xrefPos = pdf.length;
  pdf += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

/** A 1×1 red PNG — the smallest valid JPEG-alike the upload path accepts. */
export const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export function base64ToBuffer(b64) {
  return Buffer.from(b64, "base64");
}
