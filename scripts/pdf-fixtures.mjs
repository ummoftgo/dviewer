import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

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
const binary = (dict,bytes) => Buffer.concat([Buffer.from(`<< ${dict} /Length ${bytes.length} >>\nstream\n`),bytes,Buffer.from('\nendstream')]);

// Print To PDF of a font-less document: y-down pixel space, every glyph an outline path.
// Strokes are 0.7pt and fill about a fifth of a glyph cell, so a 256px probe sees grey, not ink.
// The sideways file is the landscape layout turned onto portrait paper; the upright one is portrait.
function vectorPdf(sideways) {
  let seed = 43;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const w = 0.7 / 0.75, n = value => +value.toFixed(2);
  // Reading frame: rx along the lines, ry down the page as the reader sees it.
  const RW = sideways ? 1122.56 : 794.56, RH = sideways ? 794.56 : 1122.56;
  const place = sideways ? (rx,ry) => [794.56 - ry,rx] : (rx,ry) => [rx,ry];
  const ops = [];
  // (u,v) is glyph space: u along the line, v up from the baseline.
  const shapes = {
    l:[['rect',2.5,0,w,10]], t:[['rect',2.5,0,w,9],['rect',0.5,6.2,5,w]],
    o:[['ring']], b:[['rect',-w,0,w,10],['ring']], n:[['rect',0,0,w,7],['rect',5,0,w,4.5],['rect',0,6.2,5.9,w]],
  };
  const letters = Object.keys(shapes);
  function glyph(rx,ry,size,letter) {
    const at = (u,v) => place(rx + u * size,ry - v * size);
    for (const [kind,...box] of shapes[letter]) {
      if (kind === 'rect') {
        const [u,v,du,dv] = box, [x1,y1] = at(u,v), [x2,y2] = at(u + du,v + dv);
        ops.push(`${n(Math.min(x1,x2))} ${n(Math.min(y1,y2))} ${n(Math.abs(x2 - x1))} ${n(Math.abs(y2 - y1))} re`);
        continue;
      }
      // Outer and inner ellipses wind oppositely, so a nonzero fill leaves the counter open.
      for (const [rx2,ry2,dir] of [[3,3.5,1],[3 - w,3.5 - w,-1]]) {
        const k = 0.5523, p = (a,b) => at(3 + a * rx2,3.5 + b * ry2 * dir).map(n).join(' ');
        ops.push(`${p(1,0)} m ${p(1,k)} ${p(k,1)} ${p(0,1)} c ${p(-k,1)} ${p(-1,k)} ${p(-1,0)} c`
          + ` ${p(-1,-k)} ${p(-k,-1)} ${p(0,-1)} c ${p(k,-1)} ${p(1,-k)} ${p(1,0)} c h`);
      }
    }
    ops.push('f');
  }
  // One line of words from `left` to at most `right`; returns the glyph count.
  function line(baseline,left,right,size = 1) {
    let count = 0;
    for (let rx = left; ;) {
      const word = 2 + Math.floor(random() * 8);
      if (rx + word * 7.5 * size > right) return count;
      for (let i = 0; i < word; i++, rx += 7.5 * size, count++) glyph(rx,baseline,size,letters[Math.floor(random() * letters.length)]);
      rx += 5 * size;
    }
  }
  // Body paragraphs: every ninth line is blank and the one before it ends short.
  function body(top,bottom) {
    let count = 0;
    for (let i = 0, baseline = top + 10; baseline <= bottom; i++, baseline += 18) {
      if (i % 9 === 8) continue;
      count += line(baseline,60,i % 9 === 7 ? 60 + (RW - 120) * (0.3 + random() * 0.5) : RW - 60);
    }
    return count;
  }
  // The images are screenshots of the same kind of page: 1787x603 as read, stored turned when sideways.
  const iw = sideways ? 603 : 1787, ih = sideways ? 1787 : 603, pixels = Buffer.alloc(iw * ih,255);
  const bar = (rx,ry,drx,dry) => {
    const [x,y,dx,dy] = sideways ? [602 - (ry + dry) + 1,rx,dry,drx] : [rx,ry,drx,dry];
    for (let j = Math.max(0,y); j < Math.min(ih,y + dy); j++) pixels.fill(30,j * iw + Math.max(0,x),j * iw + Math.min(iw,x + dx));
  };
  for (let row = 0, top = 20; top + 16 <= 603 - 20; row++, top += 24) {
    if (row % 9 === 8) continue;
    for (let u = 20; ;) {
      const word = 2 + Math.floor(random() * 8);
      if (u + word * 10 > 1787 - 20) break;
      for (let i = 0; i < word; i++, u += 10) {
        // A stem and one or two strokes per glyph; stroke 2px against 10px cells.
        const parts = [[0,0,2,13],[0,random() < 0.5 ? 0 : 5,8,2],...(random() < 0.5 ? [[6,5,2,8]] : [])];
        for (const [a,b,da,db] of parts) bar(u + a,top + b,da,db);
      }
      u += 7;
    }
  }
  const image = binary(`/Type /XObject /Subtype /Image /Width ${iw} /Height ${ih} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`,
    deflateSync(pixels));
  const flip = '0.75 0 0 -0.75 0 841.92 cm 0.1 g';
  // Page 1 is a cover: a large two-line title, a subtitle and a footer block on mostly white paper.
  ops.length = 0;
  let cover = 0;
  for (const [baseline,size,share] of [[RH * 0.34,2.6,0.75],[RH * 0.34 + 42,2.6,0.55],[RH * 0.34 + 84,1.4,0.6],[RH * 0.34 + 110,1.4,0.4],
    [RH * 0.78,1,0.35],[RH * 0.78 + 18,1,0.3],[RH * 0.78 + 36,1,0.25]]) {
    const span = (RW - 120) * share;
    cover += line(baseline,(RW - span) / 2,(RW + span) / 2,size);
  }
  const page1 = [flip,...ops].join('\n');
  // Page 2: a heading, the four screenshots in a 2x2 grid, then body text.
  ops.length = 0;
  let words = line(80,60,RW * 0.6,1.6);
  const cell = (RW - 130) / 2, tall = cell * 603 / 1787, pictures = [];
  for (let i = 0; i < 4; i++) {
    const [x1,y1] = place(60 + (i % 2) * (cell + 10),110 + Math.floor(i / 2) * (tall + 10));
    const [x2,y2] = place(60 + (i % 2) * (cell + 10) + cell,110 + Math.floor(i / 2) * (tall + 10) + tall);
    const [left,top,width,height] = [Math.min(x1,x2),Math.min(y1,y2),Math.abs(x2 - x1),Math.abs(y2 - y1)];
    pictures.push(`q ${n(width)} 0 0 ${n(-height)} ${n(left)} ${n(top + height)} cm /Im${i + 1} Do Q`);
  }
  words += body(110 + 2 * tall + 40,RH - 60);
  const page2 = [flip,...pictures,...ops].join('\n');
  assert(cover > 60 && words > 1000,`vector fixture shape changed: ${cover}, ${words}`);
  const images = '/XObject << /Im1 7 0 R /Im2 8 0 R /Im3 9 0 R /Im4 10 0 R >>';
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.92 841.92] /Rotate 0 /Resources << >> /Contents 5 0 R >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.92 841.92] /Rotate 0 /Resources << ${images} >> /Contents 6 0 R >>`,
    binary('/Filter /FlateDecode',deflateSync(page1)),binary('/Filter /FlateDecode',deflateSync(page2)),
    image,image,image,image,
  ]);
}
export async function writePdfFixtures(out) {
  for (const sideways of [true,false]) {
    await writeFile(path.join(out,sideways ? 'sideways-vector.pdf' : 'upright-vector.pdf'),vectorPdf(sideways));
  }
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
