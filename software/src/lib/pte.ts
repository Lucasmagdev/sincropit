// Parser do formato .PTE (Pile Dynamics PIT-W) — porta em TypeScript do que foi
// validado em reverse-engineering/parse-pte.js e process-signal.js.
// Opera sobre ArrayBuffer (funciona no browser/Electron, sem depender de `fs`).
//
// Ver ../../reverse-engineering/formato-pte.md e plano-melhoria.md pro
// histórico da engenharia reversa e validação contra a tela real do
// equipamento.

export type TlvRecord =
  | { offset: number; tag: string; kind: "text"; len: number; value: string }
  | { offset: number; tag: string; kind: "num"; len: number; value: number | number[] | null };

export interface PteBlock {
  headerRecords: TlvRecord[];
  sampleStart: number;
  sampleCount: number;
}

export interface PteFile {
  buf: DataView;
  blocks: PteBlock[];
  trailerLen: number;
  trailerStart: number;
}

function isPrintableUtf16(buf: DataView, offset: number, charCount: number): boolean {
  for (let i = 0; i < charCount; i++) {
    const lo = buf.getUint8(offset + i * 2);
    const hi = buf.getUint8(offset + i * 2 + 1);
    if (hi !== 0) return false;
    if (lo < 0x09 || (lo > 0x0d && lo < 0x20) || lo > 0x7e) return false;
  }
  return true;
}

function readUtf16le(buf: DataView, offset: number, byteLen: number): string {
  let s = "";
  for (let i = 0; i < byteLen; i += 2) s += String.fromCharCode(buf.getUint16(offset + i, true));
  return s;
}

function parseTlvRun(buf: DataView, off: number): { records: TlvRecord[]; off: number } {
  const records: TlvRecord[] = [];
  while (off + 4 <= buf.byteLength) {
    const tag = buf.getUint16(off, true);
    const len = buf.getUint16(off + 2, true);
    const payloadOff = off + 4;

    const textBytes = len * 2;
    if (len > 0 && len < 300 && payloadOff + textBytes <= buf.byteLength && isPrintableUtf16(buf, payloadOff, len)) {
      const value = readUtf16le(buf, payloadOff, textBytes);
      records.push({ offset: off, tag: tag.toString(16), kind: "text", len, value });
      off = payloadOff + textBytes;
      continue;
    }

    if ([0, 4, 8, 16].includes(len) && payloadOff + len <= buf.byteLength) {
      let value: number | number[] | null;
      if (len === 0) value = null;
      else if (len === 4) value = buf.getInt32(payloadOff, true);
      else if (len === 8) value = buf.getFloat64(payloadOff, true);
      else value = Array.from({ length: 8 }, (_, i) => buf.getUint16(payloadOff + i * 2, true));
      records.push({ offset: off, tag: tag.toString(16), kind: "num", len, value });
      off = payloadOff + len;
      continue;
    }

    break;
  }
  return { records, off };
}

export function parsePte(arrayBuffer: ArrayBuffer): PteFile {
  const buf = new DataView(arrayBuffer);
  const blocks: PteBlock[] = [];
  let off = 0;

  while (off < buf.byteLength) {
    const { records, off: afterHeader } = parseTlvRun(buf, off);

    if (afterHeader >= buf.byteLength) {
      blocks.push({ headerRecords: records, sampleStart: afterHeader, sampleCount: 0 });
      off = afterHeader;
      break;
    }

    const intRecords = records.filter(
      (r): r is TlvRecord & { kind: "num"; value: number } =>
        r.kind === "num" && typeof r.value === "number" && Number.isInteger(r.value) && r.value > 0
    );
    const countCandidate = intRecords.length ? intRecords[intRecords.length - 1].value : null;

    let sampleCount = 0;
    if (countCandidate && afterHeader + countCandidate * 8 <= buf.byteLength) {
      sampleCount = countCandidate;
    } else {
      sampleCount = Math.floor((buf.byteLength - afterHeader) / 8);
    }

    blocks.push({ headerRecords: records, sampleStart: afterHeader, sampleCount });
    off = afterHeader + sampleCount * 8;
    if (sampleCount === 0) break;
  }

  return { buf, blocks, trailerLen: buf.byteLength - off, trailerStart: off };
}

export function readSamples(pte: PteFile, block: PteBlock): Float64Array {
  const out = new Float64Array(block.sampleCount);
  for (let i = 0; i < block.sampleCount; i++) out[i] = pte.buf.getFloat64(block.sampleStart + i * 8, true);
  return out;
}

function findTag(records: TlvRecord[], tag: string): TlvRecord | undefined {
  return records.find((r) => r.tag.replace(/^0+/, "") === tag.replace(/^0+/, "") || r.tag === tag);
}

export interface BlowParams {
  WS: number; // velocidade de onda (m/s)
  LE: number; // comprimento da estaca (m)
  MD: number; // Magnification Delay (m) — onde a amplificação começa
  MA: number; // Magnification Factor
  T1: number; // amostras de pré-trigger
  FS: number; // taxa de amostragem (Hz)
}

export function extractGeneralParams(generalHeader: TlvRecord[]): { WS: number; LE: number; MD: number; MA: number; FS: number } {
  const num = (tag: string, fallback = 0) => {
    const r = findTag(generalHeader, tag);
    return r && r.kind === "num" && typeof r.value === "number" ? r.value : fallback;
  };
  return {
    WS: num("0403"),
    LE: num("0404"),
    MD: num("0405"),
    MA: num("0407"),
    FS: num("0414", 50000),
  };
}

export function extractT1(blockHeader: TlvRecord[]): number | undefined {
  let lastTsIdx = -1;
  blockHeader.forEach((r, i) => {
    if (r.len === 16) lastTsIdx = i;
  });
  if (lastTsIdx < 0) return undefined;
  const r = blockHeader.slice(lastTsIdx + 1).find((r) => r.kind === "num" && r.len === 4);
  return r && r.kind === "num" && typeof r.value === "number" ? r.value : undefined;
}

export interface VelocityPoint {
  x: number; // metros ao longo da estaca
  v: number; // velocidade (unidade relativa, a menos que peakCalibration seja usado)
}

// Butterworth 2ª ordem passa-alta (biquad RBJ audio-eq-cookbook), aplicado
// forward+backward (filtfilt) pra fase zero — substitui a média móvel usada
// antes. Cutoff em Hz, então se comporta igual em qualquer taxa de
// amostragem (a média móvel por nº de amostras não tinha essa propriedade).
// Parâmetro achado por varredura contra os 3 pontos conhecidos da tela real
// (pico 0.2694, vale -0.15, eco de ponta visível) — ver
// reverse-engineering/plano-melhoria.md, seção "Fix v6".
interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

function biquadHighpass(f0: number, fs: number, Q = Math.SQRT1_2): Biquad {
  const w0 = (2 * Math.PI * f0) / fs;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosw0 = Math.cos(w0);
  const b0 = (1 + cosw0) / 2, b1 = -(1 + cosw0), b2 = (1 + cosw0) / 2;
  const a0 = 1 + alpha, a1 = -2 * cosw0, a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function applyBiquad(x: Float64Array, c: Biquad): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const yi = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    y[i] = yi;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = yi;
  }
  return y;
}

function highpass(arr: Float64Array, cutoffHz: number, fs: number): Float64Array {
  const c = biquadHighpass(cutoffHz, fs);
  const fwd = applyBiquad(arr, c);
  const rev = applyBiquad(fwd.slice().reverse(), c);
  return rev.reverse();
}

// Pipeline validado: aceleração -> passa-alta -> integra do trigger -> 2º
// passa-alta na velocidade -> amplificação exponencial (ganho 1x até MD,
// depois cresce até MA em LE). Ver reverse-engineering/plano-melhoria.md.
export interface BlowResult {
  params: BlowParams;
  points: VelocityPoint[];
  /** Sinal de velocidade filtrado, ANTES da amplificação exponencial (índice 0 = amostra T1) — usado pra FFT, já que a amplificação distorce o conteúdo espectral. */
  velocitySignal: Float64Array;
  /** Fator aplicado aos pontos (1 = sem calibração).
   *
   * Exposto porque comparar duas estacas exige a MESMA escala nas duas. Como
   * `peakCalibration` normaliza o pico DA BATIDA processada, aplicá-lo
   * separadamente a cada estaca faria as duas terminarem com pico idêntico —
   * ou seja, o gráfico mostraria as estacas respondendo igual, que é o
   * contrário do que a comparação serve pra revelar. Quem compara deve pegar
   * esta escala da estaca principal e repassá-la via `opts.escala`. */
  escala: number;
}

/** Magnitude acima da qual a amostra é fisicamente impossível pra este
 * equipamento (ADC de 24 bits; medido nos 17 arquivos, a amostra crua não
 * passa de ~5e10 em nenhum canal). Bytes corrompidos podem gerar doubles da
 * ordem de 1e308 — somar/integrar esses valores estoura pro infinito e o
 * `Infinity - Infinity` vira NaN, ou seja, o NaN nasce da ARITMÉTICA, não
 * do arquivo. 1e15 fica ~4 ordens de grandeza acima de qualquer leitura
 * real e ~290 ordens abaixo do overflow.
 *
 * Declarado ANTES de quem usa: `blockHasSignal` depende disto, e const em
 * zona morta temporal quebraria com erro obscuro se alguém chamasse a função
 * durante a inicialização do módulo. */
const MAX_PLAUSIBLE_SAMPLE = 1e15;

const isUsableSample = (v: number) => Number.isFinite(v) && Math.abs(v) < MAX_PLAUSIBLE_SAMPLE;

/** Fração de amostras inválidas acima da qual a batida é considerada
 * inutilizável (arquivo corrompido) em vez de reparável. Arquivos reais
 * íntegros têm 0% no canal principal, então 10% já é bem permissivo. */
const MAX_CORRUPT_FRACTION = 0.1;

/** Um bloco tem sinal real (sensor conectado) ou é canal vazio/desconectado?
 *
 * Canal desconectado grava lixo, não zeros: amostras **denormais (~1e-311)**
 * misturadas com NaN — medido nos arquivos reais. Testar `== 0` não pega
 * esses. Canal com sensor tem desvio padrão de 1e5 pra cima.
 *
 * Usa desvio padrão (não máximo) pra que um único pico espúrio não faça um
 * canal vazio passar por sensor. */
export function blockHasSignal(pte: PteFile, block: PteBlock): boolean {
  if (!block.sampleCount) return false;
  const s = readSamples(pte, block);
  let n = 0, sum = 0;
  for (let i = 0; i < s.length; i++) {
    if (isUsableSample(s[i])) { sum += s[i]; n++; }
  }
  if (n < s.length * 0.5) return false;
  const mean = sum / n;
  let acc = 0;
  for (let i = 0; i < s.length; i++) {
    if (isUsableSample(s[i])) { const d = s[i] - mean; acc += d * d; }
  }
  const sd = Math.sqrt(acc / n);
  // limite superior também: bloco de lixo (header corrompido apontando pra
  // região errada) pode ter desvio astronômico e apareceria como "canal".
  return sd > 1e3 && sd < MAX_PLAUSIBLE_SAMPLE;
}

/** Índices de canal (0-3, dentro do grupo de 4 blocos da batida) que têm
 * sensor de verdade.
 *
 * Muitos ensaios usam só o canal 0, mas vários gravam sensores adicionais —
 * e esse dado existe no arquivo, então precisa ficar visível em vez de ser
 * descartado em silêncio (era o comportamento antigo do app).
 *
 * Não assuma que canal extra = mesmo golpe visto de outro ponto. Medido nos
 * 17 arquivos: a correlação com o principal vai de **0.99 a −0.48**, e a
 * razão de amplitude de **0.1x a 25000x** conforme o arranjo de sensores do
 * ensaio. Use `correlacaoComPrincipal` pra saber caso a caso. */
export function availableChannels(pte: PteFile, blowIndex: number): number[] {
  const base = blowIndex * 4;
  const out: number[] = [];
  for (let c = 0; c < 4; c++) {
    const blk = pte.blocks[base + c];
    if (blk && blockHasSignal(pte, blk)) out.push(c);
  }
  return out;
}

/** Substitui amostras não-finitas (NaN/Infinity) por interpolação linear
 * entre as vizinhas finitas.
 *
 * Por que: um único byte corrompido no arquivo pode virar um NaN em
 * float64, e NaN contamina TODA a cadeia seguinte (baseline -> filtro ->
 * integração acumulativa), fazendo o gráfico inteiro sumir. Medido: 50
 * bytes corrompidos num arquivo real geravam 1237 pontos não-finitos no
 * gráfico. Interpolar preserva a continuidade do sinal; zerar criaria um
 * degrau artificial que o passa-alta transformaria em pico falso. */
function repairSamples(s: Float64Array, blockIdx: number): Float64Array {
  let corrupt = 0;
  for (let i = 0; i < s.length; i++) if (!isUsableSample(s[i])) corrupt++;
  if (!corrupt) return s;

  if (corrupt > s.length * MAX_CORRUPT_FRACTION) {
    throw new Error(
      `bloco ${blockIdx}: ${corrupt} de ${s.length} amostras inválidas ` +
        `(${((corrupt / s.length) * 100).toFixed(1)}%) — dado corrompido demais pra reparar`
    );
  }

  const out = Float64Array.from(s);
  for (let i = 0; i < out.length; i++) {
    if (isUsableSample(out[i])) continue;
    let a = i - 1;
    while (a >= 0 && !isUsableSample(out[a])) a--;
    let b = i + 1;
    while (b < out.length && !isUsableSample(out[b])) b++;

    const hasA = a >= 0, hasB = b < out.length;
    if (hasA && hasB) {
      const t = (i - a) / (b - a);
      out[i] = out[a] + (out[b] - out[a]) * t;
    } else if (hasA) {
      out[i] = out[a];
    } else if (hasB) {
      out[i] = out[b];
    } else {
      out[i] = 0; // bloco inteiro inválido — já barrado pelo limite acima
    }
  }
  return out;
}

export function processBlow(
  pte: PteFile,
  blowIndex: number,
  opts: {
    peakCalibration?: number;
    channel?: number;
    /** Força um fator de escala em vez de derivá-lo de `peakCalibration`.
     * Usado pra desenhar outra estaca na MESMA escala da principal — ver o
     * campo `escala` em BlowResult. Tem precedência sobre peakCalibration. */
    escala?: number;
  } = {}
): BlowResult {
  const blockIdx = blowIndex * 4 + (opts.channel ?? 0);
  const block = pte.blocks[blockIdx];
  if (!block) throw new Error(`bloco ${blockIdx} não existe (arquivo só tem ${pte.blocks.length} blocos)`);

  const general = extractGeneralParams(pte.blocks[0].headerRecords);
  // canais secundários podem não repetir o T1 no próprio cabeçalho — nesse
  // caso usa o do bloco principal da mesma batida (mesmo golpe, mesmo
  // instante de trigger).
  const T1 = extractT1(block.headerRecords) ?? extractT1(pte.blocks[blowIndex * 4]?.headerRecords ?? []);
  if (!general.WS || !general.LE || !general.MA || T1 === undefined) {
    throw new Error(`não consegui extrair WS/LE/MA/T1 do bloco ${blockIdx}`);
  }
  if (T1 <= 0) throw new Error(`T1=${T1} inválido no bloco ${blockIdx} (pré-trigger precisa ser > 0)`);
  if (general.LE <= general.MD) {
    throw new Error(`LE (${general.LE}) precisa ser maior que MD (${general.MD}) — amplificação indefinida`);
  }
  const params: BlowParams = { ...general, T1 };

  const raw = repairSamples(readSamples(pte, block), blockIdx);
  const N = raw.length;
  if (N <= T1) throw new Error(`bloco ${blockIdx} tem ${N} amostras, menos que o pré-trigger T1=${T1}`);

  const baseline = raw.slice(0, T1).reduce((a, b) => a + b, 0) / T1;
  const accelRaw = new Float64Array(N);
  for (let i = 0; i < N; i++) accelRaw[i] = raw[i] - baseline;
  const accelHP = highpass(accelRaw, 100, params.FS);

  const vel = new Float64Array(N);
  for (let i = T1 + 1; i < N; i++) vel[i] = vel[i - 1] + (accelHP[i] + accelHP[i - 1]) / 2;

  const velSlice = vel.slice(T1);
  const tail = highpass(velSlice, 100, params.FS);
  const vel2 = new Float64Array(N);
  for (let i = T1; i < N; i++) vel2[i] = tail[i - T1];

  const { WS, LE, MD, MA, FS } = params;
  const velAmp = new Float64Array(N);
  for (let i = T1; i < N; i++) {
    const x = ((i - T1) / FS) * WS / 2;
    velAmp[i] = x <= MD ? vel2[i] : vel2[i] * Math.pow(MA, (x - MD) / (LE - MD));
  }

  let localPeak = 0;
  for (let i = T1; i < Math.min(T1 + 300, N); i++) localPeak = Math.max(localPeak, Math.abs(velAmp[i]));
  // localPeak=0 significa sinal totalmente plano nesse trecho — sem isso, a
  // divisão gera Infinity e o gráfico inteiro vira NaN.
  // peakCalibration precisa ser POSITIVO: um valor negativo (erro de
  // digitação) daria escala negativa e inverteria a onda inteira, exibida
  // com rótulo de "calibrado" — gráfico espelhado passando por medição.
  const calibracaoValida =
    opts.peakCalibration !== undefined &&
    Number.isFinite(opts.peakCalibration) &&
    opts.peakCalibration > 0;

  const scale =
    opts.escala !== undefined && Number.isFinite(opts.escala) && opts.escala > 0
      ? opts.escala
      : calibracaoValida && localPeak > 0
        ? (opts.peakCalibration as number) / localPeak
        : 1;

  const points: VelocityPoint[] = [];
  for (let i = T1; i < N; i++) {
    const x = ((i - T1) / FS) * WS / 2;
    if (x > LE + 1) break;
    points.push({ x, v: velAmp[i] * scale });
  }

  return { params, points, velocitySignal: vel2.slice(T1), escala: scale };
}

export function countBlows(pte: PteFile): number {
  return Math.floor(pte.blocks.length / 4);
}

/** Sensibilidade do acelerômetro em g's/volt.
 *
 * Vem do certificado de calibração da unidade FÍSICA usada no ensaio — o
 * arquivo .PTE não registra qual sensor foi usado. 9.5 é a série LW539639;
 * outra unidade do mesmo modelo veio com 9.9 (+4%). Por isso a estimativa
 * abaixo é aproximada por natureza, não só pela questão do filtro. */
export const ACC_G_PER_VOLT_PADRAO = 9.5;

/** Incerteza da estimativa de calibração automática. O pico calculado ficou
 * ~24% abaixo da tela real do equipamento (medido em B135-EA); a causa é a
 * fidelidade do filtro, não a cadeia física — ver
 * reverse-engineering/plano-melhoria.md. Exposto aqui pra UI poder declarar
 * a incerteza em vez de fingir precisão. */
export const CALIBRACAO_INCERTEZA_PCT = 25;

/**
 * Estimativa do pico em cm/s pela cadeia física, sem depender de um valor de
 * referência lido da tela do equipamento:
 *
 *   contagem ADC → V (resolução 24 bits / 5 V, campo 0415)
 *                → g (sensibilidade do acelerômetro)
 *                → m/s² (× 9.80665)
 *                → integra (× dt = 1/FS; o pipeline soma sem aplicar dt)
 *                → cm/s (× 100)
 *                ÷ 1e5 (pré-escala do firmware, hipótese validada)
 *
 * Retorna undefined quando não dá pra estimar. Trata-se de ESTIMATIVA:
 * ver CALIBRACAO_INCERTEZA_PCT.
 */
export function estimarPicoAbsoluto(
  blow: BlowResult,
  accGPorVolt: number = ACC_G_PER_VOLT_PADRAO
): number | undefined {
  const { FS, MD } = blow.params;
  if (!Number.isFinite(FS) || FS <= 0 || !Number.isFinite(accGPorVolt) || accGPorVolt <= 0) return undefined;

  const resolucaoAdc = 5 / Math.pow(2, 24); // campo 0415, idêntico em todos os arquivos vistos
  const fator = (resolucaoAdc * accGPorVolt * 9.80665 * 100) / (FS * 1e5);

  // usa o pico inicial (antes de MD), onde o ganho da amplificação é 1x —
  // depois de MD o valor já está multiplicado e não representa o pico físico
  let pico = 0;
  for (const p of blow.points) {
    if (p.x > MD) break;
    const a = Math.abs(p.v);
    if (a > pico) pico = a;
  }
  if (!(pico > 0)) return undefined;

  const est = pico * fator;
  return Number.isFinite(est) && est > 0 ? est : undefined;
}

/** Abaixo desta fração do golpe mais forte do arquivo, a batida é tratada
 * como golpe de teste do operador, não medição válida.
 *
 * Medido nos arquivos reais: as batidas fracas ficam em 3-6% do máximo do
 * arquivo, e a batida legítima mais fraca fica em 30%. O limiar cai numa
 * faixa vazia larga entre os dois grupos, não numa borda ajustada a dedo. */
const FRACAO_BATIDA_FRACA = 0.25;

/**
 * Marca quais batidas são fracas demais pra valer como medição, comparando
 * cada uma com a MAIS FORTE do mesmo arquivo.
 *
 * Por que importa: o operador costuma dar um ou dois golpes de teste antes do
 * golpe bom, e eles ficam gravados no mesmo arquivo. Um golpe fraco produz um
 * traço de baixa amplitude que pode ser confundido com estaca defeituosa —
 * este aviso existe pra evitar essa leitura errada.
 *
 * Compara com o máximo, não com a mediana: em arquivos onde os golpes de
 * teste são MAIORIA (acontece), a mediana é puxada pelos próprios golpes
 * fracos e o critério deixa de funcionar.
 *
 * Recebe os picos já estimados (undefined = batida que não processou).
 * Com menos de 2 batidas não há com o que comparar: ninguém é marcado.
 */
export function marcarBatidasFracas(picos: (number | undefined)[]): boolean[] {
  const validos = picos.filter((p): p is number => typeof p === "number" && p > 0);
  if (validos.length < 2) return picos.map(() => false);
  const maximo = Math.max(...validos);
  if (!(maximo > 0)) return picos.map(() => false);
  return picos.map((p) => typeof p === "number" && p > 0 && p < maximo * FRACAO_BATIDA_FRACA);
}

/**
 * Correlação de Pearson entre um canal secundário e o principal da mesma
 * batida, sobre as amostras cruas.
 *
 * Serve pra o usuário saber se aquele canal é o MESMO golpe visto por outro
 * sensor ou outra coisa. Medido nos 17 arquivos: varia de **0.99** (claramente
 * o mesmo impacto) a **−0.48** (descorrelacionado, com o pico em instante
 * diferente). Sem esse número, todo canal ocupado parece igualmente
 * confiável — e não é.
 *
 * Retorna undefined quando não dá pra calcular (canal principal, bloco
 * ausente, amostras insuficientes).
 */
export function correlacaoComPrincipal(
  pte: PteFile,
  blowIndex: number,
  channel: number
): number | undefined {
  if (channel === 0) return undefined;
  const principal = pte.blocks[blowIndex * 4];
  const secundario = pte.blocks[blowIndex * 4 + channel];
  if (!principal || !secundario) return undefined;

  const a = readSamples(pte, principal);
  const b = readSamples(pte, secundario);
  const n = Math.min(a.length, b.length);
  if (n < 10) return undefined;

  let m = 0, somaA = 0, somaB = 0;
  for (let i = 0; i < n; i++) {
    if (isUsableSample(a[i]) && isUsableSample(b[i])) { somaA += a[i]; somaB += b[i]; m++; }
  }
  if (m < 10) return undefined;

  const mediaA = somaA / m, mediaB = somaB / m;
  let num = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    if (!isUsableSample(a[i]) || !isUsableSample(b[i])) continue;
    const da = a[i] - mediaA, db = b[i] - mediaB;
    num += da * db; varA += da * da; varB += db * db;
  }
  if (!(varA > 0) || !(varB > 0)) return undefined;
  const r = num / Math.sqrt(varA * varB);
  return Number.isFinite(r) ? r : undefined;
}

export function getTextField(records: TlvRecord[], tag: string): string | undefined {
  const r = findTag(records, tag);
  return r && r.kind === "text" ? r.value : undefined;
}
