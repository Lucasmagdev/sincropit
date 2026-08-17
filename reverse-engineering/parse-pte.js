// Parser exploratório do formato .PTE (engenharia reversa)
// Uso: node parse-pte.js <arquivo.PTE>
//
// Formato observado (empírico, sujeito a revisão):
//   Sequência de registros [tag:u16 LE][len:u16 LE][payload]
//   - tags "x01"/"x02"/"x03" (grupos 0-3): texto, payload = len * 2 bytes (UTF16LE)
//   - tags "x04"/"x05" (grupo numérico): payload = len bytes
//     (int32 se len=4, float64 se len=8, "timestamp" de 8 campos u16 se len=16)
//   - o arquivo é dividido em BLOCOS: um cabeçalho TLV (metadata geral + por-bloco)
//     seguido de um número N de amostras float64 (N = último valor inteiro "pequeno"
//     lido antes do bloco quebrar o padrão TLV). Isso se repete várias vezes
//     (múltiplas capturas/canais no mesmo arquivo).

const fs = require("fs");

function isPrintableUtf16(buf, offset, charCount) {
  for (let i = 0; i < charCount; i++) {
    const lo = buf[offset + i * 2];
    const hi = buf[offset + i * 2 + 1];
    if (hi !== 0) return false;
    if (lo < 0x09 || (lo > 0x0d && lo < 0x20) || lo > 0x7e) return false;
  }
  return true;
}

// Tenta ler registros TLV a partir de `off`. Retorna { records, off } —
// para no primeiro registro que não bate com nenhum padrão conhecido.
function parseTlvRun(buf, off) {
  const records = [];
  while (off + 4 <= buf.length) {
    const tag = buf.readUInt16LE(off);
    const len = buf.readUInt16LE(off + 2);
    const payloadOff = off + 4;

    const textBytes = len * 2;
    if (len > 0 && len < 300 && payloadOff + textBytes <= buf.length &&
        isPrintableUtf16(buf, payloadOff, len)) {
      const text = buf.toString("utf16le", payloadOff, payloadOff + textBytes);
      records.push({ offset: off, tag: tag.toString(16), kind: "text", len, value: text });
      off = payloadOff + textBytes;
      continue;
    }

    if ([0, 4, 8, 16].includes(len) && payloadOff + len <= buf.length) {
      let value;
      if (len === 0) value = null;
      else if (len === 4) value = buf.readInt32LE(payloadOff);
      else if (len === 8) value = buf.readDoubleLE(payloadOff);
      else if (len === 16) value = Array.from({ length: 8 }, (_, i) => buf.readUInt16LE(payloadOff + i * 2));
      records.push({ offset: off, tag: tag.toString(16), kind: "num", len, value });
      off = payloadOff + len;
      continue;
    }

    break;
  }
  return { records, off };
}

function parse(filePath) {
  const buf = fs.readFileSync(filePath);
  const blocks = []; // { headerRecords, sampleStart, sampleCount }
  let off = 0;

  while (off < buf.length) {
    const { records, off: afterHeader } = parseTlvRun(buf, off);

    if (afterHeader >= buf.length) {
      // acabou o arquivo dentro de um cabeçalho, sem bloco de amostras
      blocks.push({ headerRecords: records, sampleStart: afterHeader, sampleCount: 0 });
      off = afterHeader;
      break;
    }

    // candidato a tamanho do bloco = último inteiro "razoável" lido no cabeçalho
    const intRecords = records.filter((r) => r.kind === "num" && Number.isInteger(r.value) && r.value > 0);
    const countCandidate = intRecords.length ? intRecords[intRecords.length - 1].value : null;

    let sampleCount = 0;
    if (countCandidate && afterHeader + countCandidate * 8 <= buf.length) {
      sampleCount = countCandidate;
    } else {
      // não achou candidato plausível: assume que o resto do arquivo é um único bloco
      sampleCount = Math.floor((buf.length - afterHeader) / 8);
    }

    blocks.push({ headerRecords: records, sampleStart: afterHeader, sampleCount });
    off = afterHeader + sampleCount * 8;

    if (sampleCount === 0) break; // evita loop infinito se não avançar
  }

  const consumed = off;
  const trailerLen = buf.length - consumed;

  return { buf, blocks, trailerLen, trailerStart: consumed };
}

function summarizeBlock(buf, block, idx) {
  const { headerRecords, sampleStart, sampleCount } = block;
  console.log(`\n--- bloco ${idx} — header @0x${(headerRecords[0]?.offset ?? sampleStart).toString(16)} (${headerRecords.length} registros), amostras @0x${sampleStart.toString(16)} (${sampleCount}) ---`);
  for (const r of headerRecords) {
    const val = typeof r.value === "string" ? JSON.stringify(r.value) : r.value;
    console.log(`  0x${r.offset.toString(16).padStart(4, "0")}  tag=${r.tag.padStart(4, "0")}  ${r.kind}  len=${r.len}  valor=${val}`);
  }
  if (sampleCount > 0) {
    const samples = new Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) samples[i] = buf.readDoubleLE(sampleStart + i * 8);
    const finite = samples.filter(Number.isFinite);
    const min = finite.length ? Math.min(...finite) : NaN;
    const max = finite.length ? Math.max(...finite) : NaN;
    console.log(`  amostras: ${sampleCount} (${finite.length} finitas, ${sampleCount - finite.length} não-finitas)  min=${min}  max=${max}`);
    console.log(`  primeiras 5: ${samples.slice(0, 5).map((n) => n.toFixed?.(3) ?? n).join(", ")}`);
    return samples;
  }
  return [];
}

module.exports = { parse, parseTlvRun, summarizeBlock };

function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("uso: node parse-pte.js <arquivo.PTE>");
    process.exit(1);
  }

  const { buf, blocks, trailerLen, trailerStart } = parse(filePath);

  console.log(`arquivo: ${filePath} (${buf.length} bytes)`);
  console.log(`blocos encontrados: ${blocks.length}`);

  const allSamples = [];
  blocks.forEach((b, i) => {
    const s = summarizeBlock(buf, b, i);
    allSamples.push(s);
  });

  if (trailerLen > 0) {
    console.log(`\ntrailer (${trailerLen} bytes) @0x${trailerStart.toString(16)}: ${buf.subarray(trailerStart).toString("hex")}`);
  }

  const csvPath = filePath.replace(/\.PTE$/i, "") + ".samples.csv";
  const lines = [];
  allSamples.forEach((samples, blockIdx) => {
    samples.forEach((v, i) => lines.push(`${blockIdx},${i},${v}`));
  });
  fs.writeFileSync(csvPath, "bloco,indice,valor\n" + lines.join("\n"));
  console.log(`\namostras exportadas para: ${csvPath}`);
}

if (require.main === module) main();
