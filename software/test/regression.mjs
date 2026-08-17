// Regressão do parser/pipeline REAL do app (src/lib/pte.ts) contra todos os
// arquivos .PTE reais em ../../samples/.
//
// Rodar: npm test   (compila o pte.ts e roda este arquivo)
//
// O que cobre: parse sem erro, contagem de batidas, extração dos parâmetros
// do cabeçalho (WS/LE/MD/MA/FS/T1), sanidade numérica de TODO o pipeline de
// sinal (nenhum NaN/Infinity chegando no gráfico ou na FFT), e limites do
// eixo X. Serve pra pegar regressão em qualquer mudança no parser ou no
// processamento de sinal.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parsePte,
  processBlow,
  countBlows,
  getTextField,
  extractGeneralParams,
  availableChannels,
  estimarPicoAbsoluto,
  marcarBatidasFracas,
  correlacaoComPrincipal,
} from "./build/pte.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.resolve(__dirname, "../../samples");

// Varre mais de uma pasta: além de samples/ (obra B135/B136, FS=50kHz,
// 1024 amostras/bloco), os arquivos PF e ENCONTRO são de OUTRA obra —
// FS 129-141kHz, 2048 amostras/bloco, estacas de ~20m e vários canais
// simultâneos. Exercitam caminhos que os B135 sozinhos não tocam.
const PASTAS = [
  SAMPLES,
  path.resolve(__dirname, "../../reverse-engineering/capturas/testes"),
  path.resolve(__dirname, "../../reverse-engineering/capturateste"),
];

const files = [];
const vistos = new Set();
for (const dir of PASTAS) {
  if (!fs.existsSync(dir)) continue;
  for (const nome of fs.readdirSync(dir).sort()) {
    if (!/\.PTE$/i.test(nome)) continue;
    const full = path.join(dir, nome);
    const chave = `${nome}:${fs.statSync(full).size}`;
    if (vistos.has(chave)) continue; // ignora cópia idêntica em outra pasta
    vistos.add(chave);
    files.push(full);
  }
}

if (!files.length) {
  console.log("Nenhum .PTE encontrado — nada pra testar.");
  process.exit(0);
}

let failures = 0;
const fail = (f, msg) => {
  console.log(`  x [${f}] ${msg}`);
  failures++;
};

console.log(`Parser real do app x ${files.length} arquivos .PTE reais\n`);

for (const full of files) {
  const f = path.basename(full);
  const buf = fs.readFileSync(full);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  let pte;
  try {
    pte = parsePte(ab);
  } catch (e) {
    fail(f, `parsePte lançou erro: ${e.message}`);
    continue;
  }

  const n = countBlows(pte);
  const pile = getTextField(pte.blocks[0].headerRecords, "0303");
  const g = extractGeneralParams(pte.blocks[0].headerRecords);

  console.log(
    `${f}: ${pte.blocks.length} blocos, ${n} batidas, estaca="${pile}", ` +
      `WS=${g.WS} LE=${g.LE} MD=${g.MD} MA=${g.MA} FS=${g.FS}, trailerLen=${pte.trailerLen}`
  );

  if (n < 1) fail(f, `countBlows=${n} — nenhuma batida detectada`);
  if (!g.WS) fail(f, "WS não extraído");
  if (!g.LE) fail(f, "LE não extraído");
  if (!g.MA) fail(f, "MA não extraído");
  if (!g.FS) fail(f, "FS não extraído");
  if (pte.trailerLen !== 0) fail(f, `trailerLen=${pte.trailerLen}, esperado 0`);
  if (g.LE === g.MD) fail(f, `LE === MD (${g.LE}) — divisão por zero na amplificação`);

  for (let i = 0; i < n; i++) {
    let res;
    try {
      res = processBlow(pte, i);
    } catch (e) {
      fail(f, `processBlow(${i}) lançou erro: ${e.message}`);
      continue;
    }

    if (!res.points.length) {
      fail(f, `batida ${i}: zero pontos gerados`);
      continue;
    }

    const bad = res.points.filter((p) => !Number.isFinite(p.v) || !Number.isFinite(p.x));
    if (bad.length) fail(f, `batida ${i}: ${bad.length}/${res.points.length} pontos não-finitos`);

    const maxX = res.points[res.points.length - 1].x;
    if (maxX > g.LE + 1.01) fail(f, `batida ${i}: eixo X chega a ${maxX.toFixed(2)}m > LE+1`);

    const peak = Math.max(...res.points.map((p) => Math.abs(p.v)));
    if (peak === 0) fail(f, `batida ${i}: sinal totalmente zerado`);
    if (!Number.isFinite(peak)) fail(f, `batida ${i}: pico não-finito`);

    const badVel = Array.from(res.velocitySignal).filter((v) => !Number.isFinite(v)).length;
    if (badVel) fail(f, `batida ${i}: velocitySignal tem ${badVel} não-finitos (quebra a FFT)`);

    if (!res.params.T1 || res.params.T1 <= 0) fail(f, `batida ${i}: T1=${res.params.T1} inválido`);
  }

  // Canais secundários (2º acelerômetro): precisam ser detectados E
  // processáveis, senão o app volta a esconder medição real do usuário.
  for (let i = 0; i < n; i++) {
    const chans = availableChannels(pte, i);
    if (!chans.length) { fail(f, `batida ${i}: availableChannels retornou vazio`); continue; }
    if (chans[0] !== 0) fail(f, `batida ${i}: canal 0 (principal) não detectado como tendo sinal`);

    for (const c of chans.slice(1)) {
      console.log(`    canal extra ${c} na batida ${i} — processando`);
      try {
        const r = processBlow(pte, i, { channel: c });
        if (!r.points.length) fail(f, `batida ${i} canal ${c}: zero pontos`);
        const bad = r.points.filter((p) => !Number.isFinite(p.v)).length;
        if (bad) fail(f, `batida ${i} canal ${c}: ${bad} pontos não-finitos`);
      } catch (e) {
        fail(f, `batida ${i} canal ${c}: processBlow lançou erro: ${e.message}`);
      }
    }
  }

  // calibração por pico não pode gerar Infinity/NaN
  try {
    const cal = processBlow(pte, 0, { peakCalibration: 0.2694 });
    const badCal = cal.points.filter((p) => !Number.isFinite(p.v)).length;
    if (badCal) fail(f, `calibração por pico gerou ${badCal} pontos não-finitos`);
  } catch (e) {
    fail(f, `processBlow com peakCalibration lançou erro: ${e.message}`);
  }
}

// --- Calibração absoluta ---------------------------------------------------
// Única referência que existe: a foto da tela do equipamento real pro
// B135-EA (pico 0.2694 cm/s). A estimativa física fica ~24% abaixo por
// limitação do filtro (ver reverse-engineering/plano-melhoria.md); este
// teste trava esse comportamento pra que uma mudança no pipeline não
// desloque a calibração em silêncio.
console.log("\nCalibração absoluta (estimativa física x tela real do equipamento)");
{
  const refPath = path.join(SAMPLES, "B135-EA.PTE");
  if (fs.existsSync(refPath)) {
    const buf = fs.readFileSync(refPath);
    const pte = parsePte(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const PICO_TELA = 0.2694;
    const est = estimarPicoAbsoluto(processBlow(pte, 1));

    if (est === undefined) {
      fail("B135-EA.PTE", "estimarPicoAbsoluto devolveu undefined na batida de referência");
    } else {
      const erroPct = ((est - PICO_TELA) / PICO_TELA) * 100;
      console.log(`  B135-EA batida 1: estimado ${est.toFixed(4)} cm/s | tela real ${PICO_TELA} | erro ${erroPct.toFixed(1)}%`);
      // faixa larga de propósito: trava a ordem de grandeza e o viés
      // conhecido, sem fingir precisão que não temos.
      if (!(erroPct > -35 && erroPct < 10)) {
        fail("B135-EA.PTE", `erro de calibração ${erroPct.toFixed(1)}% saiu da faixa esperada (-35% a +10%)`);
      }
    }
  }

  // plausibilidade física: golpes fortes precisam cair na faixa típica de PIT
  let plausiveis = 0, avaliados = 0;
  for (const full of files) {
    const buf = fs.readFileSync(full);
    const pte = parsePte(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    for (let i = 0; i < countBlows(pte); i++) {
      try {
        const est = estimarPicoAbsoluto(processBlow(pte, i));
        if (est === undefined) continue;
        avaliados++;
        if (est >= 0.002 && est <= 5) plausiveis++;
      } catch { /* batida já coberta pelos testes acima */ }
    }
  }
  console.log(`  ${plausiveis}/${avaliados} golpes com pico estimado em faixa fisicamente possível`);
  if (plausiveis < avaliados) fail("calibração", `${avaliados - plausiveis} golpe(s) com pico absurdo`);
}

// --- Batidas fracas (golpe de teste do operador) ----------------------------
// Lista estabelecida por análise independente e registrada em
// reverse-engineering/plano-melhoria.md. O detector precisa acertar
// exatamente essas — nem deixar passar, nem marcar batida boa como fraca
// (marcar demais faria o engenheiro descartar medição legítima).
console.log("\nDetecção de batidas fracas (golpe de teste do operador)");
{
  const esperado = new Set(["B135-ED.PTE:1", "B135-R1.PTE:1", "B135-R1.PTE:3", "B135-R2.PTE:0"]);
  const detectado = new Set();
  let avaliadas = 0;

  for (const full of files) {
    const nome = path.basename(full);
    const buf = fs.readFileSync(full);
    const pte = parsePte(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const n = countBlows(pte);
    const picos = [];
    for (let i = 0; i < n; i++) {
      try { picos.push(estimarPicoAbsoluto(processBlow(pte, i))); }
      catch { picos.push(undefined); }
    }
    const fracas = marcarBatidasFracas(picos);
    avaliadas += n;
    fracas.forEach((f, i) => { if (f) detectado.add(`${nome}:${i}`); });
  }

  const naoDetectou = [...esperado].filter((x) => !detectado.has(x));
  const falsoPositivo = [...detectado].filter((x) => !esperado.has(x));
  console.log(`  ${avaliadas} batidas avaliadas | detectadas fracas: ${detectado.size}`);
  if (naoDetectou.length) fail("batidas fracas", `não detectou: ${naoDetectou.join(", ")}`);
  if (falsoPositivo.length) fail("batidas fracas", `marcou batida boa como fraca: ${falsoPositivo.join(", ")}`);
  if (!naoDetectou.length && !falsoPositivo.length) console.log("  bate exatamente com a lista documentada");
}

// Critério tem que comparar com o golpe MAIS FORTE, não com a mediana: quando
// os golpes de teste são maioria, eles puxam a mediana e o detector para de
// funcionar (foi o que aconteceu no B135-R1). Este caso trava isso.
{
  const picos = [0.1947, 0.0117, 0.069, 0.0115]; // B135-R1 real
  const fracas = marcarBatidasFracas(picos);
  if (!(fracas[1] && fracas[3])) {
    fail("batidas fracas", "critério não pegou as fracas quando elas são maioria (regressão pra mediana?)");
  }
  if (fracas[0] || fracas[2]) fail("batidas fracas", "marcou batida legítima como fraca no caso B135-R1");
}

// Casos degenerados não podem quebrar nem marcar nada
for (const [nome, entrada] of [
  ["vazio", []],
  ["uma batida só", [0.2]],
  ["tudo undefined", [undefined, undefined]],
  ["tudo zero", [0, 0, 0]],
  ["todas iguais", [0.2, 0.2, 0.2]],
]) {
  const r = marcarBatidasFracas(entrada);
  if (r.length !== entrada.length) fail("batidas fracas", `"${nome}": tamanho do retorno não bate`);
  if (r.some(Boolean)) fail("batidas fracas", `"${nome}": marcou fraca onde não devia`);
}

// --- Escala compartilhada (comparação entre estacas) ------------------------
// A calibração normaliza o pico DA BATIDA processada. Se cada estaca fosse
// calibrada por conta própria, as duas terminariam com pico idêntico e o
// gráfico sugeriria que respondem igual — o oposto do que a comparação serve
// pra mostrar. Por isso a comparação recebe a escala da principal.
console.log("\nEscala compartilhada na comparação entre estacas");
{
  const a = files[0], b = files.find((f) => f !== files[0]);
  if (a && b) {
    const carrega = (p) => {
      const buf = fs.readFileSync(p);
      return parsePte(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    };
    const pteA = carrega(a), pteB = carrega(b);
    const PICO = 0.2694;

    const principal = processBlow(pteA, 0, { peakCalibration: PICO });
    const picoDe = (r) => Math.max(...r.points.filter((p) => p.x <= r.params.MD).map((p) => Math.abs(p.v)));

    // errado: cada uma calibrada por si -> picos iguais, comparação inútil
    const separado = processBlow(pteB, 0, { peakCalibration: PICO });
    const difSeparado = Math.abs(picoDe(separado) - picoDe(principal)) / picoDe(principal);

    // certo: mesma escala nas duas -> diferença real entre as estacas preservada
    const compartilhado = processBlow(pteB, 0, { escala: principal.escala });
    const difCompartilhado = Math.abs(picoDe(compartilhado) - picoDe(principal)) / picoDe(principal);

    console.log(`  ${path.basename(a)} x ${path.basename(b)}`);
    console.log(`    calibrando cada uma: diferença de pico ${(difSeparado * 100).toFixed(1)}% (achata a comparação)`);
    console.log(`    escala compartilhada: diferença de pico ${(difCompartilhado * 100).toFixed(1)}% (preserva)`);

    if (compartilhado.escala !== principal.escala) {
      fail("escala", `opts.escala não foi respeitada (${compartilhado.escala} != ${principal.escala})`);
    }
    if (difSeparado > 0.001) {
      fail("escala", "premissa do teste falhou: calibrar cada uma deveria igualar os picos");
    }
    if (difCompartilhado < 0.01) {
      fail("escala", "escala compartilhada também igualou os picos — comparação continua sem sentido");
    }
    // escala explícita tem que ter precedência sobre peakCalibration
    const ambos = processBlow(pteB, 0, { peakCalibration: PICO, escala: 3 });
    if (ambos.escala !== 3) fail("escala", `opts.escala deveria vencer peakCalibration (veio ${ambos.escala})`);
    // sem calibração nenhuma, escala é 1
    if (processBlow(pteB, 0).escala !== 1) fail("escala", "sem calibração a escala deveria ser 1");

    // entradas inválidas no campo de calibração não podem virar escala:
    // negativo inverteria a onda toda com rótulo de "calibrado"
    for (const ruim of [-5, 0, NaN, Infinity, -Infinity]) {
      const r = processBlow(pteB, 0, { peakCalibration: ruim });
      if (r.escala !== 1) fail("escala", `peakCalibration=${ruim} virou escala ${r.escala} (deveria ser ignorado)`);
      if (r.points.some((p) => !Number.isFinite(p.v))) fail("escala", `peakCalibration=${ruim} gerou pontos não-finitos`);
    }
    // idem pra opts.escala
    for (const ruim of [-2, 0, NaN, Infinity]) {
      if (processBlow(pteB, 0, { escala: ruim }).escala !== 1) {
        fail("escala", `opts.escala=${ruim} deveria ser ignorada`);
      }
    }
  }
}

// --- Escala única dentro do MESMO arquivo -----------------------------------
// Calibrar cada batida pelo próprio pico apaga a diferença real de energia
// entre elas: um golpe de teste do operador passa a parecer um golpe bom,
// contradizendo o aviso de "batida fraca". O app deriva UMA escala da batida
// exibida e aplica a todas.
console.log("\nEscala única entre batidas do mesmo arquivo");
{
  const alvo = files.find((f) => path.basename(f) === "B135-ED.PTE"); // tem batida fraca
  if (alvo) {
    const buf = fs.readFileSync(alvo);
    const pte = parsePte(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const n = countBlows(pte);
    const pico = (r) => Math.max(...r.points.filter((p) => p.x <= r.params.MD).map((p) => Math.abs(p.v)));
    const razao = (a) => Math.max(...a) / Math.min(...a);

    const crus = Array.from({ length: n }, (_, i) => pico(processBlow(pte, i)));
    const porBatida = Array.from({ length: n }, (_, i) => pico(processBlow(pte, i, { peakCalibration: 0.2694 })));
    const escalaUnica = processBlow(pte, 0, { peakCalibration: 0.2694 }).escala;
    const compartilhada = Array.from({ length: n }, (_, i) => pico(processBlow(pte, i, { escala: escalaUnica })));

    console.log(`  razão forte/fraca sem calibração:      ${razao(crus).toFixed(1)}x (diferença física real)`);
    console.log(`  calibrando cada batida:                ${razao(porBatida).toFixed(1)}x (apaga a diferença)`);
    console.log(`  escala única (o que o app faz):        ${razao(compartilhada).toFixed(1)}x (preserva)`);

    if (razao(porBatida) > 5) fail("escala", "premissa do teste falhou: calibrar cada batida deveria achatar as diferenças");
    if (Math.abs(razao(compartilhada) - razao(crus)) > 0.01) {
      fail("escala", `escala única alterou a razão entre batidas (${razao(compartilhada).toFixed(1)}x vs ${razao(crus).toFixed(1)}x)`);
    }
  }
}

// --- Correlação entre canais -----------------------------------------------
// Valores medidos de forma independente (script de análise) — travam tanto o
// cálculo quanto a leitura que a UI faz dele. Se a correlação mudar, ou a
// aritmética quebrou ou o parser passou a ler outro bloco.
console.log("\nCorrelação canal secundário x principal");
{
  const esperado = [
    { arq: "B135-EE.PTE", batida: 0, canal: 2, r: 0.9371 },
    { arq: "B135-EE.PTE", batida: 1, canal: 3, r: 0.9094 },
    { arq: "B135-R2.PTE", batida: 0, canal: 3, r: 0.9917 },
    { arq: "B136-EA.PTE", batida: 1, canal: 3, r: -0.4152 },
  ];

  for (const e of esperado) {
    const full = files.find((f) => path.basename(f) === e.arq);
    if (!full) continue;
    const buf = fs.readFileSync(full);
    const pte = parsePte(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const r = correlacaoComPrincipal(pte, e.batida, e.canal);
    if (r === undefined) {
      fail(e.arq, `correlação indefinida na batida ${e.batida} canal ${e.canal}`);
      continue;
    }
    const dif = Math.abs(r - e.r);
    console.log(`  ${e.arq} b${e.batida} ch${e.canal}: r=${r.toFixed(4)} (esperado ${e.r})`);
    if (dif > 0.01) fail(e.arq, `correlação ${r.toFixed(4)} difere do medido ${e.r} em ${dif.toFixed(4)}`);
  }

  // canal principal não tem correlação consigo mesmo definida nesta função
  const primeiro = files[0];
  if (primeiro) {
    const buf = fs.readFileSync(primeiro);
    const pte = parsePte(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    if (correlacaoComPrincipal(pte, 0, 0) !== undefined) {
      fail("correlação", "canal 0 deveria devolver undefined (não faz sentido correlacionar consigo mesmo)");
    }
    if (correlacaoComPrincipal(pte, 9999, 1) !== undefined) {
      fail("correlação", "batida inexistente deveria devolver undefined");
    }
  }
}

console.log(failures === 0 ? `\nOK — ${files.length} arquivos passaram` : `\nFALHOU — ${failures} problema(s)`);
process.exit(failures ? 1 : 0);
