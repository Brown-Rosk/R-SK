'use strict';
// Minimal QR encoder (byte mode, error correction level M, versions 1–10) producing an SVG. No dependencies.
// Enough for URLs up to ~200 characters.

// --- GF(256) arithmetic ---
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
(() => { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
const mul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;
function rsGenerator(n) { let g = [1]; for (let i = 0; i < n; i++) { const ng = new Array(g.length + 1).fill(0); for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= mul(g[j], EXP[i]); } g = ng; } return g; }
function rsEncode(data, n) { const g = rsGenerator(n); const res = new Array(n).fill(0); for (const d of data) { const f = d ^ res[0]; res.shift(); res.push(0); if (f) for (let j = 0; j < n; j++) res[j] ^= mul(g[j + 1], f); } return res; }

// Version tables for EC level M: [total codewords, ec codewords per block, blocks group1, data cw group1, blocks group2, data cw group2]
const VER_M = { 1: [26, 10, 1, 16, 0, 0], 2: [44, 16, 1, 28, 0, 0], 3: [70, 26, 1, 44, 0, 0], 4: [100, 18, 2, 32, 0, 0], 5: [134, 24, 2, 43, 0, 0], 6: [172, 16, 4, 27, 0, 0], 7: [196, 18, 4, 31, 0, 0], 8: [242, 22, 2, 38, 2, 39], 9: [292, 22, 3, 36, 2, 37], 10: [346, 26, 4, 43, 1, 44] };
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

function encode(text) {
  const bytes = Buffer.from(text, 'utf8');
  let ver = 1; for (; ver <= 10; ver++) { const v = VER_M[ver]; const cap = v[2] * v[3] + v[4] * v[5]; if (bytes.length + 3 <= cap) break; }
  if (ver > 10) throw new Error('Text too long for QR v10');
  const v = VER_M[ver]; const dataCap = v[2] * v[3] + v[4] * v[5];
  // bit stream: mode 0100, count (8 bits for v<10, 16 for v>=10), data, terminator, pad
  const bits = []; const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(4, 4); push(bytes.length, ver < 10 ? 8 : 16); for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataCap * 8 - bits.length)); while (bits.length % 8) bits.push(0);
  const data = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let p = 0; data.length < dataCap; p++) data.push(p % 2 ? 0x11 : 0xec);
  // blocks
  const blocks = []; let off = 0;
  for (let b = 0; b < v[2]; b++) { blocks.push(data.slice(off, off + v[3])); off += v[3]; }
  for (let b = 0; b < v[4]; b++) { blocks.push(data.slice(off, off + v[5])); off += v[5]; }
  const ecs = blocks.map(bl => rsEncode(bl, v[1]));
  const out = []; const maxLen = Math.max(...blocks.map(b => b.length));
  for (let i = 0; i < maxLen; i++) for (const bl of blocks) if (i < bl.length) out.push(bl[i]);
  for (let i = 0; i < v[1]; i++) for (const e of ecs) out.push(e[i]);
  // matrix
  const N = 17 + ver * 4; const m = Array.from({ length: N }, () => new Array(N).fill(null)); // null = data area
  const set = (r, c, val) => { m[r][c] = val; };
  const finder = (r, c) => { for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) { const rr = r + i, cc = c + j; if (rr < 0 || cc < 0 || rr >= N || cc >= N) continue; const on = (i >= 0 && i <= 6 && j >= 0 && j <= 6) && (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4)); set(rr, cc, on ? 1 : 0); } };
  finder(0, 0); finder(0, N - 7); finder(N - 7, 0);
  for (let i = 8; i < N - 8; i++) { if (m[6][i] === null) set(6, i, i % 2 === 0 ? 1 : 0); if (m[i][6] === null) set(i, 6, i % 2 === 0 ? 1 : 0); }
  const al = ALIGN[ver]; for (const r of al) for (const c of al) { if ((r <= 8 && c <= 8) || (r <= 8 && c >= N - 9) || (r >= N - 9 && c <= 8)) continue; for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) set(r + i, c + j, (Math.max(Math.abs(i), Math.abs(j)) === 1) ? 0 : 1); }
  set(N - 8, 8, 1); // dark module
  // reserve format areas
  const fmtCells = []; for (let i = 0; i < 8; i++) { fmtCells.push([8, i < 6 ? i : i + 1]); fmtCells.push([i < 6 ? i : i + 1, 8]); }
  fmtCells.push([8, 7], [8, 8], [7, 8]); for (let i = 0; i < 8; i++) { fmtCells.push([8, N - 1 - i]); fmtCells.push([N - 1 - i, 8]); }
  for (const [r, c] of fmtCells) if (m[r][c] === null) set(r, c, 0);
  // version information (versions 7+): 18-bit Golay code placed near the top-right and bottom-left finders
  if (ver >= 7) {
    let vb = ver << 12; const VG = 0x1f25; for (let i = 17; i >= 12; i--) if ((vb >> i) & 1) vb ^= VG << (i - 12); const vbits = (ver << 12) | vb;
    for (let i = 0; i < 18; i++) { const bit = (vbits >> i) & 1; const a = Math.floor(i / 3), bpos = N - 11 + (i % 3); set(a, bpos, bit); set(bpos, a, bit); }
  }
  const reserved = m.map(row => row.map(x => x !== null));
  // place data
  let bitIdx = 0; const allBits = out.flatMap(b => [7, 6, 5, 4, 3, 2, 1, 0].map(i => (b >> i) & 1));
  for (let col = N - 1; col > 0; col -= 2) { if (col === 6) col--; for (let i = 0; i < N; i++) { const row = ((N - 1 - col) / 2) % 2 === 0 ? N - 1 - i : i; for (const c of [col, col - 1]) { if (!reserved[row][c]) { m[row][c] = allBits[bitIdx++] ?? 0; } } } }
  // masks
  const maskFn = [(r, c) => (r + c) % 2 === 0, (r, c) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => (r * c) % 2 + (r * c) % 3 === 0, (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0, (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0];
  const applyMask = (k) => m.map((row, r) => row.map((v2, c) => reserved[r][c] ? v2 : (v2 ^ (maskFn[k](r, c) ? 1 : 0))));
  const penalty = (g) => { let p = 0; for (let r = 0; r < N; r++) { let run = 1; for (let c = 1; c < N; c++) { if (g[r][c] === g[r][c - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } } for (let c = 0; c < N; c++) { let run = 1; for (let r = 1; r < N; r++) { if (g[r][c] === g[r - 1][c]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } } for (let r = 0; r < N - 1; r++) for (let c = 0; c < N - 1; c++) if (g[r][c] === g[r][c + 1] && g[r][c] === g[r + 1][c] && g[r][c] === g[r + 1][c + 1]) p += 3;
    // rule 3: finder-like 1:1:3:1:1 runs with 4 light modules either side
    const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const matchAt = (get) => { let a = true, b2 = true; for (let i = 0; i < 11; i++) { const v2 = get(i); if (v2 !== P1[i]) a = false; if (v2 !== P2[i]) b2 = false; } return a || b2; };
    for (let r = 0; r < N; r++) for (let c = 0; c <= N - 11; c++) { if (matchAt(i => g[r][c + i])) p += 40; if (matchAt(i => g[c + i][r])) p += 40; }
    // rule 4: dark module proportion
    let dark = 0; for (const row of g) for (const v2 of row) dark += v2; const pctDark = dark * 100 / (N * N); p += Math.floor(Math.abs(pctDark - 50) / 5) * 10;
    return p; };
  let best = null, bestP = Infinity, bestK = 0;
  for (let k = 0; k < 8; k++) { const g = applyMask(k); const p = penalty(g); if (p < bestP) { bestP = p; best = g; bestK = k; } }
  // format info (EC level M = 00, mask k) with BCH
  let fmt = (0b00 << 3) | bestK; let bch = fmt << 10; const G = 0b10100110111; for (let i = 14; i >= 10; i--) if ((bch >> i) & 1) bch ^= G << (i - 10); const fbits = ((fmt << 10) | bch) ^ 0b101010000010010;
  const fb = (i) => (fbits >> i) & 1;
  for (let i = 0; i < 6; i++) { best[8][i] = fb(14 - i); best[i][8] = fb(i); }
  best[8][7] = fb(8); best[8][8] = fb(7); best[7][8] = fb(6);
  for (let i = 0; i < 8; i++) best[8][N - 8 + i] = fb(7 - i);
  for (let i = 0; i < 7; i++) best[N - 1 - i][8] = fb(14 - i);
  best[N - 8][8] = 1; // dark module
  return best;
}

function svg(text, size = 240, quiet = 4) {
  const m = encode(text); const N = m.length; const scale = size / (N + quiet * 2);
  let d = '';
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (m[r][c]) d += `M${((c + quiet) * scale).toFixed(2)} ${((r + quiet) * scale).toFixed(2)}h${scale.toFixed(2)}v${scale.toFixed(2)}h-${scale.toFixed(2)}z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="QR code"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

module.exports = { encode, svg };
