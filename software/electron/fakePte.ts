// Gerador de .PTE sintético válido (formato TLV real, ver
// reverse-engineering/formato-pte.md) — é o que o botão "simular batida"
// usa pra testar o app sem o PIT-Q físico.
//
// Fica em módulo próprio, SEM importar electron, justamente pra poder ser
// coberto por teste: enquanto morava dentro do main.ts, nenhum teste
// conseguia importá-lo (o import de electron quebra fora do Electron), e o
// caminho principal de teste sem hardware ficava sem verificação nenhuma.
//
// Usa os mesmos valores de campo (WS/LE/MD/MA/FS) observados nos arquivos
// reais B135/B136, então processBlow() trata igual a um arquivo real.

function u16le(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

function tlvInt32(tag: number, value: number): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeInt32LE(value, 0);
  return Buffer.concat([u16le(tag), u16le(4), payload]);
}

function tlvFloat64(tag: number, value: number): Buffer {
  const payload = Buffer.alloc(8);
  payload.writeDoubleLE(value, 0);
  return Buffer.concat([u16le(tag), u16le(8), payload]);
}

function tlvTimestamp(tag: number, d: Date): Buffer {
  const payload = Buffer.alloc(16);
  const vals = [d.getFullYear(), d.getMonth() + 1, d.getDay(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()];
  vals.forEach((v, i) => payload.writeUInt16LE(v, i * 2));
  return Buffer.concat([u16le(tag), u16le(16), payload]);
}

// Evita que uma amostra vire um "valor redondo" em bytes IEEE754. Não é só
// 0.0 exato que colide com o parser TLV: QUALQUER valor cujos 32 bits
// baixos da mantissa fiquem zerados colide — um inteiro puro (ex: contagem
// crua de ADC de um capture real) sempre tem essa região zerada, não é
// caso raro. Jitter multiplicativo cobre qualquer magnitude; aditivo cobre
// só v===0. Ver pte_writer.py (mesma regra, usada no capture real via
// Python) pro achado original.
export function perturb(v: number): number {
  if (v === 0) return 1e-12;
  return v * (1 + (Math.random() - 0.5) * 2e-6);
}

function samplesToBuffer(values: number[]): Buffer {
  const buf = Buffer.alloc(values.length * 8);
  values.forEach((v, i) => buf.writeDoubleLE(perturb(v), i * 8));
  return buf;
}

/**
 * Gera ACELERAÇÃO cujo sinal, depois do pipeline do app (passa-alta →
 * integra → passa-alta → amplificação), vira uma curva de velocidade com
 * cara de ensaio PIT real: pulso de entrada logo no topo da estaca e eco
 * de ponta perto de LE.
 *
 * A versão anterior gerava um seno de 500 Hz decaindo, e o resultado não
 * parecia ensaio nenhum: com FS=10000 e WS=4000 cada amostra vale 0.2 m,
 * então o pulso se espalhava por mais de 20 m e o pico caía no fim do
 * traço. Como o botão existe justamente pra conferir o app sem hardware,
 * um traço irreal tira o sentido dele.
 *
 * Aqui a velocidade desejada é definida primeiro (gaussianas nas posições
 * físicas certas) e a aceleração sai da DERIVADA dela — assim o pipeline
 * reconstrói a forma pretendida em vez de algo arbitrário.
 */
function generateFakeSignal(
  n: number,
  t1: number,
  fs: number,
  ws: number,
  le: number
): number[] {
  // posições físicas: distância x <-> tempo de percurso ida-e-volta
  const tPulso = 0.00045;          // pico de entrada ~0.9 m (bate com os arquivos reais)
  const largura = 0.00022;         // largura do pulso
  const tEco = (2 * le) / ws;      // eco da ponta da estaca
  const amplitude = 6e7;           // escala pra amostra crua ficar na ordem dos arquivos reais

  const velocidade = (t: number) =>
    amplitude * Math.exp(-(((t - tPulso) / largura) ** 2)) -
    0.42 * amplitude * Math.exp(-(((t - tPulso - largura * 1.9) / (largura * 1.5)) ** 2)) +
    // eco pequeno DE PROPÓSITO: a amplificação exponencial do app (MA) chega
    // a ~10x nessa distância, então 0.045 aqui vira ~0.4 do pico no gráfico
    // final — dentro da faixa 0.13-0.53 medida nos ensaios reais. Um valor
    // maior produziria eco maior que o pulso de entrada, o que é impossível
    // numa estaca sã (a reflexão perde energia).
    0.045 * amplitude * Math.exp(-(((t - tEco) / (largura * 2.2)) ** 2));

  const dt = 1 / fs;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i < t1) {
      // nunca usa 0.0 exato — os 8 bytes de um double 0.0 colidem com o
      // parser TLV (trata par de bytes zerado como registro de len=0),
      // fazendo o header vazar pra dentro das amostras. Ruído pequeno
      // mantém o baseline ~0 com bytes IEEE754 não-redondos.
      out.push((Math.random() - 0.5) * 2);
      continue;
    }
    const t = (i - t1) * dt;
    // aceleração = derivada da velocidade (diferença central)
    const a = (velocidade(t + dt) - velocidade(t - dt)) / (2 * dt);
    // ruído de medição pequeno, pra não ficar sinteticamente perfeito
    out.push(a + (Math.random() - 0.5) * amplitude * 1e-3);
  }
  return out;
}

function fillerBlock(m: number): Buffer {
  const header = tlvInt32(0x0605, m);
  const noise = Array.from({ length: m }, () => (Math.random() - 0.5) * 2);
  return Buffer.concat([header, samplesToBuffer(noise)]);
}

export function generateFakePte(): Buffer {
  // mesmos valores dos arquivos reais B135/B136 — inclusive FS, N e T1, que
  // antes eram inventados (FS=10000, N=5000, T1=500) e produziam resolução
  // espacial de 0.2 m por amostra, dez vezes pior que a real.
  const WS = 4000, LE = 9.5, MD = 2, MA = 10, FS = 50000, T1 = 50, N = 1024;

  const header0 = Buffer.concat([
    tlvInt32(0x0403, WS),
    tlvFloat64(0x0404, LE),
    tlvInt32(0x0405, MD),
    tlvInt32(0x0407, MA),
    tlvInt32(0x0414, FS),
    tlvTimestamp(0x0504, new Date()),
    tlvInt32(0x0604, T1),
    tlvInt32(0x0605, N), // marcador de contagem de amostras — precisa ser o último inteiro do header
  ]);

  const block0 = Buffer.concat([header0, samplesToBuffer(generateFakeSignal(N, T1, FS, WS, LE))]);

  return Buffer.concat([block0, fillerBlock(8), fillerBlock(8), fillerBlock(8)]);
}
