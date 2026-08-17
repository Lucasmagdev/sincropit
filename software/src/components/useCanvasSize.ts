import { useCallback, useEffect, useRef } from "react";

export interface AreaDesenho {
  ctx: CanvasRenderingContext2D;
  /** largura em pixels CSS (desenhe usando estas coordenadas) */
  w: number;
  /** altura em pixels CSS */
  h: number;
}

/**
 * Canvas que acompanha o container, com nitidez correta e **desenho
 * síncrono**.
 *
 * Dois motivos pra existir:
 *
 * 1. Tamanho fixo escalado por CSS BORRA o traço, e em tela pequena (o PIT-Q
 *    é um painel industrial) o gráfico virava uma faixa minúscula. Aqui o
 *    buffer é dimensionado em pixels FÍSICOS (CSS x devicePixelRatio) e o
 *    contexto é escalado, então o desenho continua em coordenadas CSS.
 *
 * 2. O desenho NÃO passa por estado do React. Medido: com redimensionamento
 *    via `setState` + `useEffect`, o canvas levava um frame (~16ms) pra
 *    acompanhar o container. Isso quebrava a exportação de PDF, que muda o
 *    layout (esconde a barra lateral) e captura em seguida — o gráfico saía
 *    desenhado na largura antiga. Chamando o desenho direto no callback do
 *    ResizeObserver, o canvas está sempre correto no mesmo frame.
 */
export function useCanvasSize(desenhar: (area: AreaDesenho) => void) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // guarda a função mais recente sem re-assinar o observer a cada render
  const desenharRef = useRef(desenhar);
  desenharRef.current = desenhar;

  const redesenhar = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const r = container.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));

    const dpr = Math.min(window.devicePixelRatio || 1, 3); // acima de 3x só gasta memória
    const larguraFisica = Math.round(w * dpr);
    const alturaFisica = Math.round(h * dpr);
    // mexer em canvas.width já limpa o buffer; só atribui se mudou
    if (canvas.width !== larguraFisica) canvas.width = larguraFisica;
    if (canvas.height !== alturaFisica) canvas.height = alturaFisica;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    desenharRef.current({ ctx, w, h });
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    redesenhar();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", redesenhar);
      return () => window.removeEventListener("resize", redesenhar);
    }
    const ro = new ResizeObserver(redesenhar);
    ro.observe(el);
    return () => ro.disconnect();
  }, [redesenhar]);

  return { containerRef, canvasRef, redesenhar };
}
