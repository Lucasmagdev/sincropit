import { useCallback, useEffect } from "react";
import type { VelocityPoint } from "../lib/pte";
import { useCanvasSize, type AreaDesenho } from "./useCanvasSize";

export interface Series {
  label: string;
  points: VelocityPoint[];
  color: string;
  highlighted?: boolean;
}

interface Props {
  series: Series[];
  le: number;
}

// Arredonda pra cima num "número bonito" (1/1.5/2/3/4/5/7.5/10 × potência de 10) —
// mesma convenção de escala vista nas telas reais do PIT-W (topo do eixo Y
// sempre um número redondo, fundo = -metade do topo).
function niceCeil(v: number): number {
  if (v <= 0) return 0.01;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const steps = [1, 1.5, 2, 3, 4, 5, 7.5, 10];
  const n = steps.find((s) => norm <= s) ?? 10;
  return n * mag;
}

export function WaveformChart({ series, le }: Props) {
  const desenhar = useCallback(({ ctx, w: W, h: H }: AreaDesenho) => {
    // Limpar ANTES de qualquer saída antecipada: sem isso, um ensaio que não
    // rende nenhuma curva deixava o gráfico ANTERIOR na tela — o usuário via
    // a onda da estaca anterior sob o nome da estaca nova e podia tirar
    // conclusão de engenharia sobre o dado errado.
    ctx.clearRect(0, 0, W, H);

    const nonEmpty = series.filter((s) => s.points.length > 0);
    if (nonEmpty.length === 0) return;
    const padL = 64, padR = 20, padT = 20, padB = 36;
    const plotW = W - padL - padR, plotH = H - padT - padB;

    // LE inválido (arquivo corrompido) tornaria o eixo X degenerado e a
    // divisão por xMax daria NaN/Infinity em toda coordenada.
    const xMax = Number.isFinite(le) && le > 0 ? le : 1;
    const clipped = nonEmpty.map((s) => ({ ...s, points: s.points.filter((p) => p.x <= xMax) }));

    // laço em vez de Math.max(...array): o spread passa cada ponto como
    // argumento e estoura a pilha (~65k args) quando várias batidas longas
    // são sobrepostas.
    let dataMax = 0, dataMin = 0;
    for (const s of clipped) {
      for (const p of s.points) {
        if (p.v > dataMax) dataMax = p.v;
        if (p.v < dataMin) dataMin = p.v;
      }
    }
    const vMax = niceCeil(Math.max(dataMax, -2 * dataMin, 0.01));
    const vMin = -vMax / 2;
    const range = vMax - vMin;

    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const ink = isDark ? "#9aa093" : "#5c6259";
    const grid = isDark ? "#22261f" : "#e2e4de";
    const accent = isDark ? "#e8a33d" : "#b5760a";
    const zeroLine = isDark ? "#4a4438" : "#c9b28a";

    ctx.clearRect(0, 0, W, H);
    ctx.font = "12px ui-monospace, Consolas, monospace";

    const gridLines = 6;
    for (let i = 0; i <= gridLines; i++) {
      const y = padT + (plotH / gridLines) * i;
      ctx.strokeStyle = grid;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(W - padR, y);
      ctx.stroke();
      // `vMax - passo*i` acumula erro de ponto flutuante: a linha do zero
      // saía como "-5.55e-17" em vez de "0.000". Num gráfico de medição isso
      // parece ruído ou defeito do programa. Valores desprezíveis perto da
      // escala do eixo são exatamente zero.
      const bruto = vMax - (range / gridLines) * i;
      const val = Math.abs(bruto) < range * 1e-9 ? 0 : bruto;
      ctx.fillStyle = ink;
      ctx.textAlign = "right";
      const label = Math.abs(val) >= 1000 || (Math.abs(val) < 0.001 && val !== 0) ? val.toExponential(2) : val.toFixed(3);
      ctx.fillText(label, padL - 8, y + 4);
    }

    const zeroY = padT + plotH * (vMax / range);
    ctx.strokeStyle = zeroLine;
    ctx.beginPath();
    ctx.moveTo(padL, zeroY);
    ctx.lineTo(W - padR, zeroY);
    ctx.stroke();

    ctx.fillStyle = ink;
    ctx.textAlign = "center";
    const xTicks = 8;
    for (let i = 0; i <= xTicks; i++) {
      const xv = (xMax * i) / xTicks;
      const x = padL + plotW * (xv / xMax);
      ctx.fillText(xv.toFixed(1), x, H - padB + 18);
    }
    ctx.fillText("distância na estaca (m)", padL + plotW / 2, H - 6);

    const leX = padL + plotW;
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.4;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(leX, padT);
    ctx.lineTo(leX, H - padB);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.fillStyle = accent;
    ctx.textAlign = "right";
    ctx.fillText("Toe (LE)", leX - 4, padT + 12);

    const ordered = [...clipped].sort((a, b) => Number(!!a.highlighted) - Number(!!b.highlighted));
    for (const s of ordered) {
      if (s.points.length === 0) continue;
      ctx.strokeStyle = s.color;
      ctx.globalAlpha = s.highlighted || clipped.length === 1 ? 1 : 0.45;
      ctx.lineWidth = s.highlighted || clipped.length === 1 ? 1.8 : 1.2;
      ctx.beginPath();
      s.points.forEach((p, i) => {
        const x = padL + plotW * (p.x / xMax);
        const y = padT + plotH * ((vMax - p.v) / range);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }, [series, le]);

  const { containerRef, canvasRef, redesenhar } = useCanvasSize(desenhar);
  // redesenha quando os dados mudam (o observer só cobre mudança de tamanho)
  useEffect(() => { redesenhar(); }, [desenhar, redesenhar]);

  return (
    <div ref={containerRef} className="w-full h-[clamp(240px,42vh,480px)] print:h-[440px]">
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}
