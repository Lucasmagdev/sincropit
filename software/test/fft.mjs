// A FFT nunca tinha sido verificada contra resultado conhecido — e o usuário
// toma decisão de engenharia (identificar reflexão/defeito na estaca) olhando
// esse espectro. Aqui: senoides de frequência conhecida devem produzir pico
// na frequência certa, e casos degenerados não podem quebrar.
import { computeSpectrum } from "./build/fft.js";

let failures = 0;
const fail = (msg) => { console.log(`  x ${msg}`); failures++; };

function peakFreq(spec) {
  let best = spec[0];
  for (const p of spec) if (p.magnitude > best.magnitude) best = p;
  return best;
}

console.log("FFT — correção contra sinais conhecidos\n");

// 1. senoide pura: pico deve cair na frequência de entrada
for (const [fs, f0, n] of [
  [1000, 50, 1024],
  [50000, 1000, 4096],
  [50000, 12500, 8192],
  [132000, 300, 2048],
]) {
  const sig = new Float64Array(n);
  for (let i = 0; i < n; i++) sig[i] = Math.sin((2 * Math.PI * f0 * i) / fs);
  const spec = computeSpectrum(sig, fs);
  const pk = peakFreq(spec);
  const binHz = fs / (2 * spec.length);
  const erro = Math.abs(pk.freq - f0);
  const ok = erro <= binHz * 2; // tolerância: 2 bins (janela de Hann alarga o pico)
  console.log(`  senoide ${String(f0).padStart(6)}Hz @ fs=${String(fs).padStart(6)} n=${String(n).padStart(5)} -> pico em ${pk.freq.toFixed(1)}Hz (erro ${erro.toFixed(1)}Hz, bin=${binHz.toFixed(1)}Hz) ${ok ? "" : "<-- ERRADO"}`);
  if (!ok) fail(`pico em ${pk.freq.toFixed(1)}Hz, esperado ~${f0}Hz`);
  if (spec.some((p) => !Number.isFinite(p.magnitude) || !Number.isFinite(p.freq))) fail(`espectro com valores não-finitos (f0=${f0})`);
}

// 2. frequência máxima do espectro deve respeitar Nyquist (fs/2)
{
  const fs = 50000, n = 2048;
  const sig = new Float64Array(n);
  for (let i = 0; i < n; i++) sig[i] = Math.sin((2 * Math.PI * 500 * i) / fs);
  const spec = computeSpectrum(sig, fs);
  const maxF = spec[spec.length - 1].freq;
  if (maxF > fs / 2) fail(`frequência máxima ${maxF} passa de Nyquist ${fs / 2}`);
  console.log(`  Nyquist: maior frequência do espectro = ${maxF.toFixed(0)}Hz (limite ${fs / 2}Hz)`);
}

// 3. dois tons: os dois picos precisam aparecer
{
  const fs = 10000, n = 4096;
  const sig = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    sig[i] = Math.sin((2 * Math.PI * 200 * i) / fs) + 0.7 * Math.sin((2 * Math.PI * 1500 * i) / fs);
  }
  const spec = computeSpectrum(sig, fs);
  const binHz = fs / (2 * spec.length);
  const near = (f) => spec.filter((p) => Math.abs(p.freq - f) <= binHz * 3);
  const m200 = Math.max(...near(200).map((p) => p.magnitude));
  const m1500 = Math.max(...near(1500).map((p) => p.magnitude));
  const fundo = spec.filter((p) => Math.abs(p.freq - 200) > binHz * 6 && Math.abs(p.freq - 1500) > binHz * 6);
  const mFundo = Math.max(...fundo.map((p) => p.magnitude));
  console.log(`  dois tons: mag@200Hz=${m200.toExponential(2)} mag@1500Hz=${m1500.toExponential(2)} ruido=${mFundo.toExponential(2)}`);
  if (!(m200 > mFundo * 10)) fail(`tom de 200Hz não se destaca do fundo`);
  if (!(m1500 > mFundo * 10)) fail(`tom de 1500Hz não se destaca do fundo`);
  if (!(m200 > m1500)) fail(`amplitude relativa errada: 200Hz (amp 1.0) deveria ser maior que 1500Hz (amp 0.7)`);
}

// 4. degenerados não podem lançar exceção nem devolver lixo
for (const [nome, sig, fs] of [
  ["vazio", new Float64Array(0), 50000],
  ["1 amostra", new Float64Array([1]), 50000],
  ["2 amostras", new Float64Array([1, -1]), 50000],
  ["fs = 0", new Float64Array(64), 0],
  ["fs negativo", new Float64Array(64), -1],
  ["tudo zero", new Float64Array(512), 50000],
  ["com NaN", Float64Array.from({ length: 512 }, (_, i) => (i === 10 ? NaN : Math.sin(i / 10))), 50000],
  ["com Infinity", Float64Array.from({ length: 512 }, (_, i) => (i === 10 ? Infinity : Math.sin(i / 10))), 50000],
]) {
  try {
    const spec = computeSpectrum(sig, fs);
    const ruins = spec.filter((p) => !Number.isFinite(p.magnitude) || !Number.isFinite(p.freq)).length;
    if (ruins) fail(`"${nome}": ${ruins} pontos não-finitos no espectro`);
    console.log(`  degenerado "${nome}": ${spec.length} pontos, ${ruins} não-finitos`);
  } catch (e) {
    fail(`"${nome}" lançou exceção: ${e.message}`);
  }
}

console.log(failures === 0 ? `\nOK — FFT correta e robusta` : `\nFALHOU — ${failures} problema(s)`);
process.exit(failures ? 1 : 0);
