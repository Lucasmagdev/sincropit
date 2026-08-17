import { useCallback, useEffect } from "react";
import type { SpectrumPoint } from "../lib/fft";
import { useCanvasSize, type AreaDesenho } from "./useCanvasSize";

interface Props {
  spectrum: SpectrumPoint[];
  maxFreq?: number; // Hz, corta o eixo X (a energia relevante costuma ficar bem abaixo de FS/2)
}

export function SpectrumChart({ spectrum, maxFreq = 5000 }: Props) {
  const desenhar = useCallback(({ ctx, w: W, h: H }: AreaDesenho) => {
    // limpa ANTES da saída antecipada — senão o espectro do ensaio anterior
    // fica na tela quando o novo não tem nada pra desenhar (ver mesma
    // correção em WaveformChart).
    ctx.clearRect(0, 0, W, H);
    if (spectrum.length === 0) return;
    const padL = 64, padR = 20, padT = 20, padB = 36;
    const plotW = W - padL - padR, plotH = H - padT - padB;

    const limite = Number.isFinite(maxFreq) && maxFreq > 0 ? maxFreq : 5000;
    const pts = spectrum.filter((p) => p.freq <= limite);
    if (pts.length === 0) return;

    let vMax = 1e-9;
    for (const p of pts) if (p.magnitude > vMax) vMax = p.magnitude;

    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const ink = isDark ? "#9aa093" : "#5c6259";
    const grid = isDark ? "#22261f" : "#e2e4de";
    const accent = isDark ? "#3d9be8" : "#1c6bb0";

    ctx.clearRect(0, 0, W, H);
    ctx.font = "12px ui-monospace, Consolas, monospace";

    const gridLines = 5;
    for (let i = 0; i <= gridLines; i++) {
      const y = padT + (plotH / gridLines) * i;
      ctx.strokeStyle = grid;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(W - padR, y);
      ctx.stroke();
      const val = vMax - (vMax / gridLines) * i;
      ctx.fillStyle = ink;
      ctx.textAlign = "right";
      ctx.fillText(val.toExponential(1), padL - 8, y + 4);
    }

    ctx.fillStyle = ink;
    ctx.textAlign = "center";
    const xTicks = 8;
    for (let i = 0; i <= xTicks; i++) {
      const f = (limite * i) / xTicks;
      const x = padL + plotW * (f / limite);
      ctx.fillText(f >= 1000 ? `${(f / 1000).toFixed(1)}k` : f.toFixed(0), x, H - padB + 18);
    }
    ctx.fillText("frequência (Hz)", padL + plotW / 2, H - 6);

    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    let started = false;
    for (const p of pts) {
      const x = padL + plotW * (p.freq / limite);
      const y = padT + plotH * (1 - p.magnitude / vMax);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // marca o pico (frequência dominante)
    let peak = pts[0];
    for (const p of pts) if (p.magnitude > peak.magnitude) peak = p;
    if (peak) {
      const x = padL + plotW * (peak.freq / limite);
      const y = padT + plotH * (1 - peak.magnitude / vMax);
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.textAlign = "left";
      ctx.fillText(`${peak.freq.toFixed(0)} Hz`, x + 6, y - 6);
    }
  }, [spectrum, maxFreq]);

  const { containerRef, canvasRef, redesenhar } = useCanvasSize(desenhar);
  useEffect(() => { redesenhar(); }, [desenhar, redesenhar]);

  return (
    <div ref={containerRef} className="w-full h-[clamp(200px,36vh,400px)] print:h-[380px]">
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}
