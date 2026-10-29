// ===========================================================================
// Teste ponta a ponta dos dois campos: L1 (arrasamento) e (I) tipo da estaca.
//
// Não confere "o servidor concorda consigo mesmo". Fabrica variantes de
// arquivos REAIS com valores que ESTE script escolhe, manda pelo
// SincronPIT.exe de verdade, e lê de volta do Supabase para comparar com o
// valor escrito. Se algum elo da cadeia mexer no número, o teste acusa.
//
//   node testar-campos-sync.mjs <ref> <management-token> <caminho-do-exe>
// ===========================================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const [REF, TOKEN, EXE, DEVTOKEN, SCHEMA_ARG] = process.argv.slice(2);
if (!REF || !TOKEN || !EXE || !DEVTOKEN) {
  console.error("uso: node testar-campos-sync.mjs <ref> <management-token> <exe> <token-do-equipamento> [schema=public]");
  process.exit(2);
}
// As tabelas podem viver em schema custom (ex: "pit", quando o projeto é
// compartilhado com outro app). A query roda via API de administração, que
// executa como superuser — schema é só qualificação de nome, sem precisar de
// Accept-Profile (isso só importa para chamadas PostgREST/REST, não aqui).
const SCHEMA = SCHEMA_ARG || "public";

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`SQL ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

// --- localiza os registros TLV que vamos alterar ---------------------------
function pr(b, o, n) {
  for (let i = 0; i < n; i++) {
    if (b[o + i * 2 + 1] !== 0) return false;
    const lo = b[o + i * 2];
    if (lo < 0x09 || (lo > 0x0d && lo < 0x20) || lo > 0x7e) return false;
  }
  return true;
}
function localizar(buf) {
  const l1 = [], t304 = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const tag = buf.readUInt16LE(off), len = buf.readUInt16LE(off + 2), p = off + 4;
    const T = tag.toString(16).padStart(4, "0");
    if (len === 0) { off = p; continue; }
    if (len < 300 && p + len * 2 <= buf.length && pr(buf, p, len)) {
      if (T === "0304") t304.push({ off: p, len });
      off = p + len * 2; continue;
    }
    if (len === 8 && p + 8 <= buf.length) { if (T === "0419") l1.push(p); off = p + 8; continue; }
    if (len === 4 && p + 4 <= buf.length) { off = p + 4; continue; }
    if (len === 16 && p + 16 <= buf.length) { off = p + 16; continue; }
    off += 2;
  }
  return { l1, t304 };
}

// Escreve o tipo mantendo EXATAMENTE o mesmo comprimento de campo, para não
// deslocar o resto do arquivo (o formato não tem índice; tudo é sequencial).
function escreverTipo(buf, alvo, texto) {
  const preenchido = texto.padEnd(alvo.len, " ").slice(0, alvo.len);
  for (let i = 0; i < alvo.len; i++) buf.writeUInt16LE(preenchido.charCodeAt(i), alvo.off + i * 2);
}

const CASOS = [
  { base: "E15-arrasamento.PTE", nome: "TESTE-A.PTE",
    l1: [0.35, 1.85, 12.4], tipo: "RZ",
    esperaTipo: "RZ", esperaL1: 12.4,
    porque: "tres configuracoes com L1 diferente — a view tem que trazer a ULTIMA" },
  { base: "E15-arrasamento.PTE", nome: "TESTE-B.PTE",
    l1: [0.55], tipo: "hC",
    esperaTipo: "HC", esperaL1: 0.55,
    porque: "tipo em caixa mista tem que chegar normalizado em maiusculas" },
  { base: "C1-nome-com-espacos.PTE", nome: "TESTE-C.PTE",
    l1: [2.75], tipo: "RAIZ  ",
    esperaTipo: "RAIZ", esperaL1: 2.75,
    porque: "campo com espacos sobrando tem que chegar aparado" },
  { base: "C1-nome-com-espacos.PTE", nome: "TESTE-D.PTE",
    l1: [0.05], tipo: "PM",
    esperaTipo: "PM", esperaL1: 0.05,
    porque: "valor pequeno com duas casas decimais" },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sync-teste-"));
console.log(`arquivos de teste em ${tmp}\n`);

// O teste monta o ambiente do cliente do zero: copia o .exe e escreve o
// config.txt ao lado. Roda em qualquer máquina sem instalação prévia — e de
// quebra exercita a semente de configuração.
const dirExe = path.join(tmp, "cliente");
fs.mkdirSync(dirExe);
const exeTeste = path.join(dirExe, "SincronPIT.exe");
fs.copyFileSync(EXE, exeTeste);
fs.writeFileSync(
  path.join(dirExe, "config.txt"),
  [
    "# gerado pelo teste",
    "pastas=",
    `url=https://${REF}.supabase.co/functions/v1/ingerir`,
    `token=${DEVTOKEN}`,
    "machineid=pit-4959cf",
    "extensoes=.pte|.ptn|.pt2",
    "pastaexport=",
  ].join("\r\n"),
  "utf-8"
);

// A semente só é adotada quando não existe config em %APPDATA%. Limpa antes
// para o teste valer, e de novo no fim para esta máquina não ficar se passando
// pelo PIT-Q nem guardar o token do equipamento.
const dirDados = path.join(process.env.APPDATA ?? os.homedir(), "SincronPIT");
const limparDados = () => { try { fs.rmSync(dirDados, { recursive: true, force: true }); } catch { /* nada a limpar */ } };
limparDados();

const preparados = [];
for (const c of CASOS) {
  const buf = fs.readFileSync(path.join("../../samples", c.base));
  const { l1, t304 } = localizar(buf);
  if (!l1.length) { console.log(`  ! ${c.base} nao tem campo 0419; caso ignorado`); continue; }
  if (!t304.length) { console.log(`  ! ${c.base} nao tem campo 0304; caso ignorado`); continue; }

  // L1 por configuração; se o caso der menos valores que configurações,
  // repete o último
  l1.forEach((pos, i) => buf.writeDoubleLE(c.l1[Math.min(i, c.l1.length - 1)], pos));
  escreverTipo(buf, t304[0], c.tipo);

  const destino = path.join(tmp, c.nome);
  fs.writeFileSync(destino, buf);
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  preparados.push({ ...c, caminho: destino, sha, configs: l1.length });
  console.log(`  ${c.nome}: ${l1.length} config(s), L1 escrito=${c.l1.join(",")}, tipo escrito=${JSON.stringify(c.tipo)}`);
}

console.log("\nenviando pelo SincronPIT.exe...\n");
for (const p of preparados) {
  try {
    const saida = execFileSync(exeTeste, ["--enviar", p.caminho], { encoding: "utf-8", timeout: 180000 });
    p.envio = /resultado\s*:\s*(\w+)/.exec(saida)?.[1] ?? "?";
  } catch (e) {
    p.envio = "ERRO";
    p.erroEnvio = (e.stdout || e.message || "").toString().trim().slice(0, 200);
  }
  console.log(`  ${p.nome}: ${p.envio}${p.erroEnvio ? " — " + p.erroEnvio : ""}`);
}

console.log("\nlendo de volta do Supabase...\n");
let falhas = 0;
for (const p of preparados) {
  const linhas = await sql(
    `select estaca_tipo, arrasamento_sugerido_m::text as l1, n_configuracoes
       from ${SCHEMA}.ensaios_para_diario where sha256 = '${p.sha}'`
  );
  const todas = await sql(
    `select string_agg(q.arrasamento_m::text, ',' order by q.ordem) v
       from ${SCHEMA}.ensaio_parametros q join ${SCHEMA}.ensaios e on e.id = q.ensaio_id
      where e.sha256 = '${p.sha}'`
  );
  const problemas = [];
  if (!linhas.length) {
    problemas.push("NAO CHEGOU no banco");
  } else {
    const g = linhas[0];
    if (g.estaca_tipo !== p.esperaTipo) problemas.push(`tipo: veio "${g.estaca_tipo}", esperado "${p.esperaTipo}"`);
    if (Number(g.l1) !== p.esperaL1) problemas.push(`L1: veio ${g.l1}, esperado ${p.esperaL1}`);
    if (g.n_configuracoes !== p.configs) problemas.push(`configs: ${g.n_configuracoes} vs ${p.configs}`);
    const esperadoTodas = p.l1.length === p.configs ? p.l1.join(",")
      : Array.from({ length: p.configs }, (_, i) => p.l1[Math.min(i, p.l1.length - 1)]).join(",");
    if ((todas[0]?.v ?? "") !== esperadoTodas) problemas.push(`serie: "${todas[0]?.v}" vs "${esperadoTodas}"`);
  }
  const marca = problemas.length ? "FALHA" : "ok   ";
  console.log(`${marca} ${p.nome.padEnd(12)} tipo=${linhas[0]?.estaca_tipo ?? "-"} L1=${linhas[0]?.l1 ?? "-"} serie=[${todas[0]?.v ?? "-"}]`);
  console.log(`      ${p.porque}`);
  if (problemas.length) { problemas.forEach((x) => console.log(`      -> ${x}`)); falhas++; }
}

// Limpa os registros de teste para não poluir o acervo real.
for (const p of preparados) await sql(`delete from ${SCHEMA}.ensaios where sha256 = '${p.sha}'`);
limparDados();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${preparados.length} casos; ${falhas} falha(s). Registros de teste removidos do banco.`);
process.exit(falhas ? 1 : 0);
