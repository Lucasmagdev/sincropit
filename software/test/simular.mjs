// O botão "simular batida" é o caminho principal pra testar o app sem o
// PIT-Q físico. O gerador dele nunca teve teste: morava dentro do main.ts,
// que importa electron, e por isso nenhum teste conseguia importá-lo.
//
// Verifica que o .PTE sintético é lido corretamente pelo MESMO parser que lê
// arquivo real, e que o sinal gerado tem forma de golpe de verdade.
//
// Importante rodar várias vezes: o gerador usa jitter aleatório em toda
// amostra (regra do formato TLV — ver formato-pte.md). Foi justamente uma
// combinação aleatória rara que expôs o bug original de bytes zerados.
import { generateFakePte } from "./build-electron/fakePte.js";
import { parsePte, processBlow, countBlows, availableChannels, extractGeneralParams } from "./build/pte.js";

const RODADAS = 40;
let failures = 0;
const fail = (msg) => { console.log(`  x ${msg}`); failures++; };

console.log(`Gerador do botão "simular batida" — ${RODADAS} rodadas\n`);

let primeiro = null;
for (let rodada = 1; rodada <= RODADAS; rodada++) {
  const buf = generateFakePte();
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  let pte;
  try {
    pte = parsePte(ab);
  } catch (e) {
    fail(`rodada ${rodada}: parsePte lançou erro: ${e.message}`);
    continue;
  }

  const n = countBlows(pte);
  // O App.tsx recusa arquivo com menos de 1 batida — se o gerador produzir
  // isso, o botão "simular" mostraria erro em vez do gráfico.
  if (n < 1) { fail(`rodada ${rodada}: gerou arquivo com ${n} batidas (o app recusaria)`); continue; }

  const g = extractGeneralParams(pte.blocks[0].headerRecords);
  if (g.WS !== 4000) fail(`rodada ${rodada}: WS=${g.WS}, esperado 4000`);
  if (g.LE !== 9.5) fail(`rodada ${rodada}: LE=${g.LE}, esperado 9.5`);
  if (g.MA !== 10) fail(`rodada ${rodada}: MA=${g.MA}, esperado 10`);
  if (g.FS !== 50000) fail(`rodada ${rodada}: FS=${g.FS}, esperado 50000 (igual aos arquivos reais)`);
  if (g.LE <= g.MD) fail(`rodada ${rodada}: LE (${g.LE}) <= MD (${g.MD}) — amplificação indefinida`);

  // canal principal precisa ser detectado como tendo sinal; os de
  // preenchimento NÃO podem virar "sensor" no seletor de canal
  const chans = availableChannels(pte, 0);
  if (!chans.includes(0)) fail(`rodada ${rodada}: canal principal não detectado`);
  if (chans.length > 1) fail(`rodada ${rodada}: blocos de preenchimento apareceram como canais: ${chans}`);

  let r;
  try {
    r = processBlow(pte, 0);
  } catch (e) {
    fail(`rodada ${rodada}: processBlow lançou erro: ${e.message}`);
    continue;
  }

  if (!r.points.length) { fail(`rodada ${rodada}: zero pontos`); continue; }
  const ruins = r.points.filter((p) => !Number.isFinite(p.v) || !Number.isFinite(p.x)).length;
  if (ruins) fail(`rodada ${rodada}: ${ruins} pontos não-finitos`);

  // resolução espacial: precisa render pontos suficientes pra desenhar a
  // estaca inteira com detalhe parecido com o de um arquivo real
  const passoM = (r.points[1]?.x ?? 0) - (r.points[0]?.x ?? 0);
  if (passoM > 0.06) fail(`rodada ${rodada}: ${passoM.toFixed(3)}m por amostra — resolução grossa demais (real ~0.04m)`);
  if (r.points.length < 150) fail(`rodada ${rodada}: só ${r.points.length} pontos pra ${g.LE}m de estaca`);

  // forma de golpe: pico de entrada logo no topo da estaca
  let pico = 0, picoX = 0;
  for (const p of r.points) {
    if (p.x > g.MD) break; // antes de MD o ganho é 1x, então é o pico físico
    if (Math.abs(p.v) > pico) { pico = Math.abs(p.v); picoX = p.x; }
  }
  if (!(pico > 0)) fail(`rodada ${rodada}: sinal totalmente plano`);
  if (picoX < 0.3 || picoX > 1.6) {
    fail(`rodada ${rodada}: pico de entrada em x=${picoX.toFixed(2)}m — nos ensaios reais cai entre 0.7 e 1.1m`);
  }

  // eco de ponta: é o que caracteriza um ensaio PIT. Sem ele, o simulado
  // não serve pra conferir a leitura de comprimento/defeito da estaca.
  const perto = r.points.filter((p) => Math.abs(p.x - g.LE) < 1.2);
  const eco = perto.length ? Math.max(...perto.map((p) => Math.abs(p.v))) : 0;
  const razaoEco = eco / pico;
  if (!(razaoEco > 0.08)) {
    fail(`rodada ${rodada}: sem eco de ponta visível perto de LE (eco/pico = ${razaoEco.toFixed(3)})`);
  }
  // eco MAIOR que o pulso de entrada é impossível numa estaca sã — a
  // reflexão perde energia. Nos ensaios reais a razão fica em 0.13-0.53.
  if (razaoEco > 1) {
    fail(`rodada ${rodada}: eco/pico = ${razaoEco.toFixed(2)} — eco maior que o pulso de entrada é fisicamente impossível`);
  }

  if (rodada === 1) {
    primeiro = { bytes: buf.length, blocos: pte.blocks.length, n, pico, picoX, pontos: r.points.length, passoM, razaoEco: eco / pico };
  }
}

if (primeiro) {
  console.log(`  ${primeiro.bytes} bytes | ${primeiro.blocos} blocos | ${primeiro.n} batida | ${primeiro.pontos} pontos | ${primeiro.passoM.toFixed(3)}m por amostra`);
  console.log(`  pico de entrada em x=${primeiro.picoX.toFixed(2)}m | eco de ponta/pico = ${primeiro.razaoEco.toFixed(2)}`);
}

console.log(failures === 0 ? `\nOK — ${RODADAS} rodadas do gerador lidas pelo parser real` : `\nFALHOU — ${failures} problema(s)`);
process.exit(failures ? 1 : 0);
