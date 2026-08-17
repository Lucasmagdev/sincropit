// FFT radix-2 (Cooley-Tukey), iterativa, sem dependências externas.
// Entrada real (sinal no tempo), saída = espectro de magnitude (só metade
// positiva, já que entrada é real e o espectro é simétrico).

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

// FFT in-place sobre arrays paralelos re/im, tamanho deve ser potência de 2.
function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;

  // bit-reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k], uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        const nextIm = curRe * wIm + curIm * wRe;
        curRe = nextRe; curIm = nextIm;
      }
    }
  }
}

export interface SpectrumPoint {
  freq: number; // Hz
  magnitude: number; // amplitude linear (não dB)
}

// Calcula o espectro de magnitude de um sinal real amostrado a `fs` Hz.
// Aplica janela de Hann (reduz vazamento espectral) e zero-pad até potência de 2.
export function computeSpectrum(signal: Float64Array | number[], fs: number): SpectrumPoint[] {
  const n0 = signal.length;
  // n0 < 2 não tem espectro definido, e ainda quebrava de duas formas:
  // com n0=0, nextPow2(0)=1 e `half` virava 0.5 -> `new Array(0.5)` lança
  // RangeError; com n0=1, a janela de Hann dividia por (n0-1)=0 e o
  // espectro inteiro virava NaN.
  if (n0 < 2 || !Number.isFinite(fs) || fs <= 0) return [];

  const n = nextPow2(n0);
  const re = new Float64Array(n);
  const im = new Float64Array(n);

  for (let i = 0; i < n0; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n0 - 1)); // janela de Hann
    const v = signal[i];
    re[i] = Number.isFinite(v) ? v * w : 0;
  }

  fftInPlace(re, im);

  const half = n / 2;
  const out: SpectrumPoint[] = new Array(half);
  for (let k = 0; k < half; k++) {
    const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / n0;
    out[k] = { freq: (k * fs) / n, magnitude: mag };
  }
  return out;
}
