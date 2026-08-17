// Referência do site (localStorage) — validação de forma e a escala gravada.
//
// Dois riscos cobertos aqui:
//  1. localStorage corrompido: em app empacotado o usuário NÃO tem como
//     limpar, então um objeto inválido aceito aqui deixaria o Fpit
//     inutilizável de vez (tela branca a cada abertura).
//  2. Escala: os pontos são gravados já escalados. Sem guardar a escala, uma
//     referência salva em unidade relativa (~1e11) exibida junto de uma vista
//     calibrada (~0.27 cm/s) difere por ~12 ordens de grandeza.
import { getSiteReference, setSiteReference, clearSiteReference } from "./build/reference.js";

let failures = 0;
const fail = (msg) => { console.log(`  x ${msg}`); failures++; };

// localStorage de mentira, já que isto roda em Node
const loja = new Map();
globalThis.localStorage = {
  getItem: (k) => (loja.has(k) ? loja.get(k) : null),
  setItem: (k, v) => loja.set(k, String(v)),
  removeItem: (k) => loja.delete(k),
};
const CHAVE = "fpit.siteReference";

console.log("Referência do site — validação e escala\n");

// --- ida e volta, com escala ---
{
  clearSiteReference();
  const ok = setSiteReference({ label: "B135-EA", le: 9.5, points: [{ x: 0, v: 1 }, { x: 1, v: -2 }], escala: 5e-13 });
  if (!ok) fail("setSiteReference devolveu false num caso válido");
  const lido = getSiteReference();
  if (!lido) fail("não releu a referência que acabou de salvar");
  else {
    if (lido.label !== "B135-EA") fail(`label veio "${lido.label}"`);
    if (lido.escala !== 5e-13) fail(`escala veio ${lido.escala}, esperado 5e-13`);
    if (lido.points.length !== 2) fail(`pontos: ${lido.points.length}, esperado 2`);
    if (typeof lido.savedAt !== "number") fail("savedAt ausente");
  }
  console.log("  ida e volta com escala: ok");
}

// --- compatibilidade: referência antiga não tem escala ---
{
  loja.set(CHAVE, JSON.stringify({ label: "antiga", le: 9.5, points: [{ x: 0, v: 1 }], savedAt: Date.now() }));
  const lido = getSiteReference();
  if (!lido) fail("referência sem o campo escala deveria continuar sendo aceita (compatibilidade)");
  else if (lido.escala !== undefined) fail(`escala deveria vir undefined, veio ${lido.escala}`);
  console.log("  referência antiga (sem escala) continua válida: ok");
}

// --- lixo no localStorage tem que ser recusado, não explodir ---
const lixos = [
  ["json inválido", "{{{"],
  ["json válido de outro tipo (número)", "42"],
  ["json válido de outro tipo (string)", '"texto"'],
  ["array em vez de objeto", "[1,2,3]"],
  ["objeto sem points", JSON.stringify({ label: "x", le: 9.5, savedAt: 1 })],
  ["points não é array", JSON.stringify({ label: "x", le: 9.5, points: "nao", savedAt: 1 })],
  ["ponto com v não numérico", JSON.stringify({ label: "x", le: 9.5, points: [{ x: 0, v: "a" }], savedAt: 1 })],
  ["ponto com NaN", JSON.stringify({ label: "x", le: 9.5, points: [{ x: 0, v: null }], savedAt: 1 })],
  ["le não numérico", JSON.stringify({ label: "x", le: "9.5", points: [], savedAt: 1 })],
  ["escala zero (divisão por zero no reajuste)", JSON.stringify({ label: "x", le: 9.5, points: [{ x: 0, v: 1 }], savedAt: 1, escala: 0 })],
  ["escala negativa", JSON.stringify({ label: "x", le: 9.5, points: [{ x: 0, v: 1 }], savedAt: 1, escala: -3 })],
  ["escala NaN", JSON.stringify({ label: "x", le: 9.5, points: [{ x: 0, v: 1 }], savedAt: 1, escala: null })],
];
for (const [nome, valor] of lixos) {
  loja.set(CHAVE, valor);
  let r;
  try {
    r = getSiteReference();
  } catch (e) {
    fail(`"${nome}": lançou exceção em vez de recusar (${e.message})`);
    continue;
  }
  if (r !== null) fail(`"${nome}": foi aceito (deveria devolver null)`);
}
console.log(`  ${lixos.length} entradas corrompidas recusadas sem lançar exceção: ok`);

// --- storage indisponível não pode derrubar a UI ---
{
  const antes = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => { throw new Error("storage bloqueado"); },
    setItem: () => { throw new Error("cota estourada"); },
    removeItem: () => { throw new Error("bloqueado"); },
  };
  try {
    if (getSiteReference() !== null) fail("storage quebrado deveria devolver null");
    if (setSiteReference({ label: "x", le: 1, points: [], escala: 1 }) !== false) {
      fail("setSiteReference deveria devolver false quando não consegue gravar");
    }
    clearSiteReference(); // não pode lançar
    console.log("  storage indisponível tratado sem exceção: ok");
  } catch (e) {
    fail(`storage indisponível lançou exceção: ${e.message}`);
  } finally {
    globalThis.localStorage = antes;
  }
}

console.log(failures === 0 ? "\nOK — referência do site validada" : `\nFALHOU — ${failures} problema(s)`);
process.exit(failures ? 1 : 0);
