// Robustez: o que acontece quando o usuário abre lixo, ou um .PTE truncado
// (arquivo copiado enquanto o equipamento ainda escrevia) / corrompido.
//
// Contrato que este teste protege:
//   1. parsePte nunca trava nem entra em loop longo
//   2. nenhum NaN/Infinity chega no gráfico via processBlow
//   3. lixo resulta em countBlows() < 1 — é assim que o App.tsx decide
//      recusar o arquivo com mensagem clara em vez de mostrar tela em branco
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePte, processBlow, countBlows, availableChannels } from "./build/pte.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.resolve(__dirname, "../../samples");
const HANG_MS = 5000;

// PRNG com semente: corrupção aleatória sem semente dava teste intermitente
// (falhava ~1 em 20 rodadas, impossível de reproduzir). Com semente fixa o
// mesmo conjunto roda sempre igual, e várias sementes por rodada ampliam a
// cobertura de forma determinística.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cases = [];
const mk = (name, bytes, expectNoBlows = false) =>
  cases.push({ name, ab: new Uint8Array(bytes).buffer, expectNoBlows });

mk("vazio (0 bytes)", [], true);
mk("1 byte", [0x42], true);
mk("3 bytes", [1, 2, 3], true);
mk("todos zeros (256B)", new Array(256).fill(0), true);
mk("todos 0xFF (256B)", new Array(256).fill(0xff), true);
mk("texto ASCII", Array.from(Buffer.from("isso nao e um .PTE, e um txt qualquer")), true);

for (const size of [64, 1024, 65536]) {
  const rnd = mulberry32(size);
  const b = [];
  for (let i = 0; i < size; i++) b.push(Math.floor(rnd() * 256));
  mk(`aleatorio ${size}B`, b, true);
}

const realPath = path.join(SAMPLES, "B135-EA.PTE");
if (fs.existsSync(realPath)) {
  const real = fs.readFileSync(realPath);
  for (const frac of [0.01, 0.1, 0.5, 0.9, 0.999]) {
    const n = Math.floor(real.length * frac);
    mk(`B135-EA truncado em ${(frac * 100).toFixed(1)}%`, Array.from(real.subarray(0, n)));
  }
  // vários níveis: 1 byte pega o caso "quase íntegro" (onde um NaN isolado
  // contaminava todo o gráfico), os altos pegam "corrompido demais".
  // Várias sementes por nível — foi uma combinação rara que expôs o bug do
  // NaN, então cobertura ampla importa mais que aleatoriedade real.
  for (const nFlips of [1, 5, 20, 50, 200, 1000, 5000]) {
    for (let seed = 1; seed <= 12; seed++) {
      const rnd = mulberry32(seed * 7919 + nFlips);
      const copy = Buffer.from(real);
      for (let i = 0; i < nFlips; i++) copy[Math.floor(rnd() * copy.length)] = Math.floor(rnd() * 256);
      mk(`B135-EA ${String(nFlips).padStart(4)} byte(s) corrompido(s) seed=${seed}`, Array.from(copy));
    }
  }
}

let failures = 0;
const fail = (name, msg) => { console.log(`  x [${name}] ${msg}`); failures++; };

console.log(`Robustez: ${cases.length} entradas degeneradas\n`);

for (const { name, ab, expectNoBlows } of cases) {
  const t0 = Date.now();
  let info = "";
  try {
    const pte = parsePte(ab);
    const n = countBlows(pte);

    if (expectNoBlows && n >= 1) {
      fail(name, `countBlows=${n} — lixo passando como ensaio válido (o app aceitaria o arquivo)`);
    }

    let nonFinite = 0, errored = 0;
    for (let i = 0; i < Math.min(n, 10); i++) {
      try {
        for (const c of availableChannels(pte, i)) {
          const r = processBlow(pte, i, { channel: c });
          nonFinite += r.points.filter((p) => !Number.isFinite(p.v) || !Number.isFinite(p.x)).length;
          nonFinite += Array.from(r.velocitySignal).filter((v) => !Number.isFinite(v)).length;
        }
      } catch { errored++; } // erro tratado é aceitável: o app mostra no banner
    }
    if (nonFinite) fail(name, `${nonFinite} valores não-finitos vazando pro gráfico/FFT`);
    info = `${pte.blocks.length} blocos, ${n} batidas, ${errored} batida(s) com erro tratado`;
  } catch (e) {
    info = `erro tratado: ${String(e.message).slice(0, 60)}`;
  }

  const dt = Date.now() - t0;
  if (dt > HANG_MS) fail(name, `demorou ${dt}ms (>${HANG_MS}ms) — risco de travar a UI`);
  console.log(`  ${name.padEnd(40)} ${String(dt).padStart(5)}ms  ${info}`);
}

console.log(failures === 0 ? `\nOK — ${cases.length} entradas degeneradas tratadas` : `\nFALHOU — ${failures} problema(s)`);
process.exit(failures ? 1 : 0);
