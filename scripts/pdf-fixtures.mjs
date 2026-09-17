import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

// Object syntax is ASCII; binary image streams are kept as bytes for xref offsets.
function pdf(objects) {
  const chunks = [Buffer.from('%PDF-1.4\n')], offsets = [0];
  let length = chunks[0].length;
  for (const [index,body] of objects.entries()) {
    offsets.push(length);
    const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`),Buffer.from(body),Buffer.from('\nendobj\n')]);
    chunks.push(object); length += object.length;
  }
  const xref = length;
  let data = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  data += offsets.slice(1).map(offset => `${String(offset).padStart(10,'0')} 00000 n \n`).join('');
  data += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = Buffer.concat([...chunks,Buffer.from(data)]);
  offsets.slice(1).forEach((offset,index) => assert(bytes.subarray(offset).toString().startsWith(`${index + 1} 0 obj\n`)));
  assert(bytes.subarray(xref,xref + 4).equals(Buffer.from('xref')));
  return bytes;
}
const stream = text => `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`;
export async function writePdfFixtures(out) {
  for (const sideways of [true,false]) {
    const width=96, height=160, pixels=Buffer.alloc(width*height,255);
    for (let y=8;y<height-8;y++) for (let x=8;x<width-8;x++) {
      if ((sideways ? x : y) % 12 < 4) pixels[y*width+x]=0;
    }
    await writeFile(path.join(out,sideways ? 'sideways-image.pdf' : 'upright-image.pdf'),pdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 6 0 R >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 6 0 R >>',
      Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`),pixels,Buffer.from('\nendstream')]),
      stream('q 595 0 0 842 0 0 cm /Im1 Do Q'),
    ]));
  }
  const sideways = page => Array.from({length:12},(_,i) =>
    `BT /F1 16 Tf 0 1 -1 0 ${70 + i * 40} 140 Tm (Page ${page} line ${i + 1}: needle) Tj ET`).join('\n');
  await writeFile(path.join(out,'sideways.pdf'),pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream(sideways(1)),stream(sideways(2)),
  ]));
  await writeFile(path.join(out,'report.pdf'),pdf([
    '<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream('BT /F1 24 Tf 72 700 Td (First page: needle) Tj ET'),
    stream('BT /F1 24 Tf 72 700 Td (Second page: needle) Tj ET'),
    '<< /Type /Outlines /First 9 0 R /Last 11 0 R /Count 3 >>',
    '<< /Title (First page) /Parent 8 0 R /Dest [3 0 R /Fit] /Next 10 0 R >>',
    '<< /Title (Same page, another heading) /Parent 8 0 R /Dest [3 0 R /Fit] /Prev 9 0 R /Next 11 0 R >>',
    '<< /Title (Second page) /Parent 8 0 R /Dest [4 0 R /Fit] /Prev 10 0 R >>',
  ]));
  await writeFile(path.join(out,'image-only.pdf'),pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',
    stream('q 468 0 0 648 72 72 cm /Im1 Do Q'),
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\n8899aa>\nendstream',
  ]));
}
