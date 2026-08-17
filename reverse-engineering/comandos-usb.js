// Extrai os comandos que o PC MANDA pro sensor (direção OUT), que é a peça
// que falta pra captura ao vivo funcionar.
//
// A análise anterior (parse-pcapng.js) olhou só os pacotes GRANDES de dados,
// que vêm do sensor pro PC (direção IN). O comando de "iniciar captura" — o
// que o sensor espera antes de transmitir — anda na direção contrária, e
// nunca foi examinado. Essa informação já está nas capturas existentes.
//
// Uso: node comandos-usb.js <arquivo.pcapng>
//
// Layout do cabeçalho USBPcap (pcap_header do USBPcap):
//   0  u16  headerLen
//   2  u64  irpId
//  10  u32  status
//  14  u16  function
//  16  u8   info      <- bit 0: 1 = PDO->FDO (device->host, IN)
//  17  u16  bus
//  19  u16  device
//  21  u8   endpoint  <- bit 7: 1 = IN, 0 = OUT
//  22  u8   transfer  <- 0=isoc 1=interrupt 2=control 3=bulk
//  23  u32  dataLength

const fs = require("fs");

function parsePcapng(buf) {
  const packets = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    const blockType = buf.readUInt32LE(off);
    const blockLen = buf.readUInt32LE(off + 4);
    if (blockLen < 12 || off + blockLen > buf.length) break;
    if (blockType === 0x00000006) {
      const bodyOff = off + 8;
      const tsHigh = buf.readUInt32LE(bodyOff + 4);
      const tsLow = buf.readUInt32LE(bodyOff + 8);
      const capturedLen = buf.readUInt32LE(bodyOff + 12);
      const dataOff = bodyOff + 20;
      packets.push({
        ts: (BigInt(tsHigh) << 32n) | BigInt(tsLow),
        data: Buffer.from(buf.subarray(dataOff, dataOff + capturedLen)),
      });
    }
    off += blockLen;
  }
  return packets;
}

const TIPO = { 0: "isoc", 1: "interrupt", 2: "control", 3: "bulk" };

function decode(pkt) {
  const b = pkt.data;
  if (b.length < 27) return null;
  const headerLen = b.readUInt16LE(0);
  if (headerLen < 27 || headerLen > b.length) return null;
  const endpoint = b.readUInt8(21);
  return {
    ts: pkt.ts,
    funcao: b.readUInt16LE(14),
    device: b.readUInt16LE(19),
    endpoint,
    entrada: (endpoint & 0x80) !== 0, // bit 7 = IN
    transfer: TIPO[b.readUInt8(22)] ?? b.readUInt8(22),
    payload: b.subarray(headerLen),
  };
}

const arquivo = process.argv[2];
if (!arquivo) {
  console.error("uso: node comandos-usb.js <arquivo.pcapng>");
  process.exit(1);
}

const pacotes = parsePcapng(fs.readFileSync(arquivo)).map(decode).filter(Boolean);
console.log(`${pacotes.length} pacotes USB decodificados\n`);

// --- panorama: quem fala com quem, em que direção e por qual endpoint ---
const resumo = new Map();
for (const p of pacotes) {
  const chave = `dev${p.device} ep0x${p.endpoint.toString(16).padStart(2, "0")} ${p.transfer} ${p.entrada ? "IN " : "OUT"}`;
  const r = resumo.get(chave) ?? { n: 0, bytes: 0, tamanhos: new Set() };
  r.n++;
  r.bytes += p.payload.length;
  if (p.payload.length) r.tamanhos.add(p.payload.length);
  resumo.set(chave, r);
}
console.log("canal                              pacotes    bytes  tamanhos de payload");
for (const [k, v] of [...resumo.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
  const tam = [...v.tamanhos].sort((a, b) => a - b).slice(0, 6).join(",");
  console.log(`${k.padEnd(34)} ${String(v.n).padStart(7)} ${String(v.bytes).padStart(8)}  ${tam}${v.tamanhos.size > 6 ? ",…" : ""}`);
}

// --- o que interessa: pacotes OUT com conteúdo (comandos do PC pro sensor) ---
const saidas = pacotes.filter((p) => !p.entrada && p.payload.length > 0);
console.log(`\n=== ${saidas.length} pacotes OUT com payload (PC -> sensor) ===`);

if (!saidas.length) {
  console.log("Nenhum. Ou a captura não pegou a direção de saída, ou o comando");
  console.log("vai por transferência de controle sem payload (só no setup packet).");
} else {
  // agrupa por conteúdo: comando repetido aparece muitas vezes idêntico
  const porConteudo = new Map();
  for (const s of saidas) {
    const hex = s.payload.toString("hex");
    const g = porConteudo.get(hex) ?? { n: 0, exemplo: s };
    g.n++;
    porConteudo.set(hex, g);
  }
  console.log(`${porConteudo.size} conteúdos distintos\n`);
  const ordenado = [...porConteudo.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [hex, g] of ordenado.slice(0, 25)) {
    const p = g.exemplo;
    const bytes = Buffer.from(hex, "hex");
    const ascii = [...bytes.subarray(0, 32)]
      .map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : "."))
      .join("");
    console.log(
      `${String(g.n).padStart(5)}x  dev${p.device} ep0x${p.endpoint.toString(16)} ${p.transfer.padEnd(9)} ` +
      `${bytes.length}B  ${hex.slice(0, 64)}${hex.length > 64 ? "…" : ""}  |${ascii}|`
    );
  }
}

// ---------------------------------------------------------------------------
// Decodificador dos quadros de comando do sensor (dev FTDI, bulk OUT).
// Estrutura confirmada em 61/61 quadros das 3 capturas:
//
//   offset  tam  campo
//   0       2    magic 0x6969
//   2       2    código do comando (u16 LE)
//   4       4    marca de tempo/nonce (muda a cada quadro)
//   8       4    identificador fixo da sessão (0x08dee96d nas 3 capturas)
//   12      4    número de sequência (u32 LE, incrementa 1 a 1)
//   16      2    tamanho do payload (u16 LE)
//   18      2    magic 0x9696
//   20      N    payload
//   20+N    1    byte final (checksum — fórmula ainda não identificada;
//                testados XOR, soma, complemento de dois e soma só do
//                payload: nenhum bate)
//
// Uso: node comandos-usb.js <arquivo.pcapng> --quadros
const QUADRO_MAGIC1 = 0x6969;
const QUADRO_MAGIC2 = 0x9696;

function decodificarQuadro(b) {
  if (b.length < 21 || b.readUInt16BE(0) !== QUADRO_MAGIC1) return null;
  const len = b.readUInt16LE(16);
  if (b.readUInt16BE(18) !== QUADRO_MAGIC2 || b.length !== 20 + len + 1) return null;
  return {
    comando: b.readUInt16LE(2),
    nonce: b.readUInt32LE(4),
    sessao: b.readUInt32LE(8),
    sequencia: b.readUInt32LE(12),
    payload: b.subarray(20, 20 + len),
    checksum: b[b.length - 1],
  };
}

if (process.argv.includes("--quadros")) {
  const pk = parsePcapng(fs.readFileSync(arquivo)).map(decode).filter(Boolean);
  const quadros = pk
    .filter((p) => !p.entrada && p.payload.length >= 21)
    .map((p) => ({ p, q: decodificarQuadro(p.payload) }))
    .filter((x) => x.q);
  console.log(`\n=== ${quadros.length} quadros de comando decodificados ===`);
  console.log("seq   cmd     payload");
  for (const { q } of quadros) {
    console.log(
      `${String(q.sequencia).padStart(4)}  0x${q.comando.toString(16).padStart(4, "0")}  ${q.payload.toString("hex") || "(vazio)"}`
    );
  }
}

module.exports = { decodificarQuadro };
