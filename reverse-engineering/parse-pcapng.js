// Parser minimo de .pcapng (capturas USBPcap) pra extrair os pacotes USB
// crus, sem precisar do Wireshark/tshark instalado.
// Uso: node parse-pcapng.js <arquivo.pcapng>

const fs = require("fs");

function parsePcapng(buf) {
  const packets = [];
  let off = 0;
  let le = true; // descoberto pelo Section Header Block

  while (off + 8 <= buf.length) {
    const blockType = buf.readUInt32LE(off);
    const blockLen = buf.readUInt32LE(off + 4);
    if (blockLen < 12 || off + blockLen > buf.length) break;

    if (blockType === 0x0A0D0D0A) {
      // Section Header Block — confirma byte order
      const magic = buf.readUInt32LE(off + 8);
      le = magic === 0x1A2B3C4D;
    } else if (blockType === 0x00000006) {
      // Enhanced Packet Block
      const bodyOff = off + 8;
      const capturedLen = buf.readUInt32LE(bodyOff + 12);
      const dataOff = bodyOff + 20;
      const data = buf.subarray(dataOff, dataOff + capturedLen);
      packets.push({ offset: off, capturedLen, data: Buffer.from(data) });
    }

    off += blockLen;
  }
  return packets;
}

// Header do USBPcap: primeiros 2 bytes = tamanho do header (headerLen),
// depois disso comeca o payload real da transferencia USB.
function stripUsbpcapHeader(pkt) {
  if (pkt.length < 2) return { header: pkt, payload: Buffer.alloc(0) };
  const headerLen = pkt.readUInt16LE(0);
  if (headerLen > pkt.length || headerLen < 2) return { header: pkt, payload: Buffer.alloc(0) };
  return {
    header: pkt.subarray(0, headerLen),
    payload: pkt.subarray(headerLen),
    irpId: pkt.length >= 10 ? pkt.readBigUInt64LE(2) : null,
    dataLength: pkt.length >= headerLen ? headerLen : null,
  };
}

function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("uso: node parse-pcapng.js <arquivo.pcapng>");
    process.exit(1);
  }

  const buf = fs.readFileSync(filePath);
  const packets = parsePcapng(buf);
  console.log(`total de pacotes: ${packets.length}`);

  const withPayload = packets
    .map((p) => ({ ...p, ...stripUsbpcapHeader(p.data) }))
    .filter((p) => p.payload.length > 0);

  console.log(`pacotes com payload (dado real, nao so controle): ${withPayload.length}`);

  // histograma de tamanhos de payload
  const sizes = {};
  for (const p of withPayload) sizes[p.payload.length] = (sizes[p.payload.length] || 0) + 1;
  const topSizes = Object.entries(sizes).sort((a, b) => b[1] - a[1]).slice(0, 20);
  console.log("\ntamanhos de payload mais comuns (tamanho: quantidade):");
  topSizes.forEach(([size, count]) => console.log(`  ${size} bytes: ${count}x`));

  // maiores payloads (provavelmente os que tem dado de amostra)
  const biggest = [...withPayload].sort((a, b) => b.payload.length - a.payload.length).slice(0, 10);
  console.log("\n10 maiores payloads:");
  biggest.forEach((p, i) => {
    console.log(`  #${i} offset=0x${p.offset.toString(16)} tamanho=${p.payload.length} bytes`);
  });

  if (biggest.length) {
    const csvPath = filePath.replace(/\.pcapng$/i, "") + ".packets.json";
    fs.writeFileSync(
      csvPath,
      JSON.stringify(
        withPayload.map((p) => ({ offset: p.offset, len: p.payload.length, hex: p.payload.toString("hex") })),
        null,
        0
      )
    );
    console.log(`\ntodos os payloads exportados (hex) para: ${csvPath}`);
  }
}

main();
