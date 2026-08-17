// Converte o bloco de sinal real (bloco 0 = 1ª batida) de um .PTE em velocidade
// × distância na estaca, replicando o pipeline padrão de processamento de PIT:
//   aceleração crua -> filtro passa-alta (remove deriva) -> integra a partir do
//   trigger -> amplificação exponencial (parâmetro MA da tela) -> eixo em metros
//   via velocidade de onda (WS).
//
// Validado visualmente contra a tela real do equipamento pra B135-EA (ver
// reverse-engineering/plano-melhoria.md). Calibração ABSOLUTA de amplitude
// (unidade real cm/s) ainda não resolvida — a saída aqui é proporcional, não
// em cm/s de verdade, a menos que --peak seja informado.
//
// Uso:
//   node process-signal.js <arquivo.PTE> [--peak=0.2694] [--blow=0]
//     --peak   valor conhecido do pico real (cm/s), da tela do equipamento,
//              pra calibrar a escala. Sem isso, a saída fica em unidade relativa.
//     --blow   índice da batida a processar (bloco = blow*4). Default 0.

const fs = require("fs");
const { parse } = require("./parse-pte.js");

function findTag(records, tag) {
  return records.find((r) => r.tag.replace(/^0+/, "") === tag.replace(/^0+/, "") || r.tag === tag);
}

// Butterworth 2ª ordem passa-alta (RBJ audio-eq-cookbook biquad), aplicado
// forward+backward (filtfilt) pra fase zero — substitui a média móvel usada
// nas versões v1-v5. Cutoff em Hz, então o filtro se comporta igual em
// qualquer taxa de amostragem (a média móvel por nº de amostras não tinha
// essa propriedade: nos arquivos PF, com FS 132-141kHz em vez de 50kHz, a
// mesma janela em amostras corresponderia a um cutoff bem mais alto).
// Achado por varredura de parâmetro contra os 3 pontos conhecidos da tela
// real (pico 0.2694, vale -0.15, eco de ponta visível) — ver
// reverse-engineering/filter-sweep.js e filter-sweep-fine.js. Cutoff de
// ~80-130Hz em ambos os estágios (aceleração e velocidade) cravou o vale em
// -0.150 (era -0.165-0.173 com média móvel), sem perder pico nem explodir o
// eco de ponta nas 27 batidas + 9 arquivos PF testados.
function biquadHighpass(f0, fs, Q = Math.SQRT1_2) {
  const w0 = (2 * Math.PI * f0) / fs;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosw0 = Math.cos(w0);
  const b0 = (1 + cosw0) / 2, b1 = -(1 + cosw0), b2 = (1 + cosw0) / 2;
  const a0 = 1 + alpha, a1 = -2 * cosw0, a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}
function applyBiquad(x, c) {
  const y = new Array(x.length).fill(0);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const yi = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    y[i] = yi;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = yi;
  }
  return y;
}
function highpass(arr, cutoffHz, fs) {
  const c = biquadHighpass(cutoffHz, fs);
  const fwd = applyBiquad(arr, c);
  return applyBiquad(fwd.slice().reverse(), c).reverse();
}

function extractBlowParams(generalHeader, blockHeader) {
  const WS = findTag(generalHeader, "0403")?.value;
  const LE = findTag(generalHeader, "0404")?.value;
  const MD = findTag(generalHeader, "0405")?.value; // Magnification Delay (m) — confirmado contra manual PDI
  const MA = findTag(generalHeader, "0407")?.value;

  // T1 = primeiro registro numérico de 4 bytes logo depois do último timestamp
  // (len=16) no cabeçalho por-bloco — ver formato-pte.md.
  let lastTsIdx = -1;
  blockHeader.forEach((r, i) => { if (r.len === 16) lastTsIdx = i; });
  const T1 = lastTsIdx >= 0 ? blockHeader.slice(lastTsIdx + 1).find((r) => r.kind === "num" && r.len === 4)?.value : undefined;

  return { WS, LE, MD, MA, T1 };
}

function processBlow(buf, blocks, blowIndex, { peak } = {}) {
  const blockIdx = blowIndex * 4;
  const block = blocks[blockIdx];
  if (!block) throw new Error(`bloco ${blockIdx} não existe (arquivo só tem ${blocks.length} blocos)`);

  const { WS, LE, MD, MA, T1 } = extractBlowParams(blocks[0].headerRecords, block.headerRecords);
  if (!WS || !LE || !MA || !T1 || MD === undefined) {
    throw new Error(`não consegui extrair WS/LE/MD/MA/T1 do bloco ${blockIdx} (WS=${WS} LE=${LE} MD=${MD} MA=${MA} T1=${T1})`);
  }

  const FS = findTag(blocks[0].headerRecords, "0414")?.value || 50000; // taxa de amostragem
  const N = block.sampleCount;
  const raw = new Array(N);
  for (let i = 0; i < N; i++) raw[i] = buf.readDoubleLE(block.sampleStart + i * 8);

  const baseline = raw.slice(0, T1).reduce((a, b) => a + b, 0) / T1;
  const accelRaw = raw.map((v) => v - baseline);
  const accelHP = highpass(accelRaw, 100, FS); // Butterworth 2ª ordem, cutoff 100Hz

  const vel = new Array(N).fill(0);
  for (let i = T1 + 1; i < N; i++) vel[i] = vel[i - 1] + (accelHP[i] + accelHP[i - 1]) / 2;

  // 2º passa-alta, agora na velocidade já integrada: a integração reintroduz
  // deriva de baixa frequência que o 1º filtro (na aceleração) não pega toda —
  // sem isso a amplificação exponencial explode essa deriva residual perto do
  // fim do registro (visto comparando várias batidas/arquivos, não só B135-EA).
  // Isso é um artefato da NOSSA integração simplificada, não do equipamento
  // original (nos ensaios que temos, o filtro HI do equipamento vinha
  // desligado — HI=0.0 — e mesmo assim o toe saía limpo).
  const tail = highpass(vel.slice(T1), 100, FS);
  const vel2 = vel.map((v, i) => (i < T1 ? 0 : tail[i - T1]));

  // Amplificação exponencial: SEM ganho (1x) até a distância MD (metros) —
  // não a partir do trigger — e só depois disso cresce até atingir MA na
  // distância LE (ponta da estaca). Confirmado contra manual PDI: "Magnification
  // Delay (MD) identifies the BEGINNING of the magnification function" — antes
  // eu amplificava a partir do trigger, o que é errado.
  const velAmp = vel2.map((v, i) => {
    if (i < T1) return 0;
    const x = ((i - T1) / FS) * WS / 2;
    if (x <= MD) return v;
    const gain = Math.pow(MA, (x - MD) / (LE - MD));
    return v * gain;
  });

  let localPeak = 0;
  for (let i = T1; i < Math.min(T1 + 300, N); i++) localPeak = Math.max(localPeak, Math.abs(velAmp[i]));
  const scale = peak ? peak / localPeak : 1;

  const points = [];
  for (let i = T1; i < N; i++) {
    const x = ((i - T1) / FS) * WS / 2;
    if (x > LE + 1) break;
    points.push({ x: Number(x.toFixed(4)), v: Number((velAmp[i] * scale).toFixed(6)) });
  }

  return { params: { WS, LE, MA, T1, FS }, points, calibrated: !!peak };
}

function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("uso: node process-signal.js <arquivo.PTE> [--peak=0.2694] [--blow=0]");
    process.exit(1);
  }
  const peakArg = process.argv.find((a) => a.startsWith("--peak="));
  const blowArg = process.argv.find((a) => a.startsWith("--blow="));
  const peak = peakArg ? Number(peakArg.split("=")[1]) : undefined;
  const blow = blowArg ? Number(blowArg.split("=")[1]) : 0;

  const { buf, blocks } = parse(filePath);
  const { params, points, calibrated } = processBlow(buf, blocks, blow, { peak });

  console.log(`arquivo: ${filePath}  batida: ${blow}`);
  console.log(`parâmetros: WS=${params.WS} LE=${params.LE} MA=${params.MA} T1=${params.T1} FS=${params.FS}`);
  console.log(`calibrado em cm/s: ${calibrated ? "sim (--peak informado)" : "não — valores relativos, não cm/s reais"}`);
  console.log(`pontos: ${points.length} (x de 0 a ~${points[points.length - 1].x}m)`);

  const csvPath = filePath.replace(/\.PTE$/i, "") + `.blow${blow}.velocity.csv`;
  fs.writeFileSync(csvPath, "x_m,v" + (calibrated ? "_cms" : "_rel") + "\n" + points.map((p) => `${p.x},${p.v}`).join("\n"));
  console.log(`exportado: ${csvPath}`);
}

module.exports = { processBlow, extractBlowParams };

if (require.main === module) main();
