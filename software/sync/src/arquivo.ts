import fs from "node:fs";
import crypto from "node:crypto";

/**
 * Estabilidade e hash — as duas operações que tocam o arquivo do cliente.
 *
 * REGRA ABSOLUTA deste módulo: só leitura. Nada aqui abre para escrita,
 * renomeia, move ou apaga. O ensaio original é intocável.
 */

export interface Assinatura {
  bytes: number;
  mtimeMs: number;
}

export function assinatura(caminho: string): Assinatura | null {
  try {
    const st = fs.statSync(caminho);
    if (!st.isFile()) return null;
    return { bytes: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null; // sumiu, foi renomeado, ou está bloqueado
  }
}

export function iguais(a: Assinatura | null, b: Assinatura | null): boolean {
  return a !== null && b !== null && a.bytes === b.bytes && a.mtimeMs === b.mtimeMs;
}

export type ResultadoEstabilidade =
  | { pronto: true; bytes: number }
  | { pronto: false; motivo: "sumiu" | "ainda_mudando" | "sem_leitura" };

/**
 * O arquivo terminou de ser gravado?
 *
 * Debounce fixo NÃO basta: o produtor pode escrever em pedaços com pausas
 * maiores que o debounce, e aí leríamos um arquivo pela metade — o pior
 * defeito possível aqui, porque geraria um ensaio truncado na nuvem sem
 * ninguém perceber.
 *
 * Critério: tamanho E mtime idênticos em N verificações consecutivas, mais
 * uma abertura de leitura bem-sucedida. Não assumimos que o PIT-W usa lock:
 * a abertura serve pra detectar bloqueio quando existe, não pra depender dele.
 */
export async function aguardarEstabilidade(
  caminho: string,
  verificacoes: number,
  intervaloMs: number
): Promise<ResultadoEstabilidade> {
  let anterior = assinatura(caminho);
  if (!anterior) return { pronto: false, motivo: "sumiu" };

  let iguaisSeguidas = 1;
  while (iguaisSeguidas < verificacoes) {
    await esperar(intervaloMs);
    const atual = assinatura(caminho);
    if (!atual) return { pronto: false, motivo: "sumiu" };
    if (iguais(anterior, atual)) {
      iguaisSeguidas++;
    } else {
      iguaisSeguidas = 1; // mudou: recomeça a contagem
      anterior = atual;
    }
  }

  // parou de mudar; confirma que dá pra ler de fato
  try {
    const fd = fs.openSync(caminho, "r");
    fs.closeSync(fd);
  } catch {
    return { pronto: false, motivo: "sem_leitura" };
  }

  const final = assinatura(caminho);
  if (!iguais(anterior, final)) return { pronto: false, motivo: "ainda_mudando" };
  return { pronto: true, bytes: final!.bytes };
}

/** SHA-256 por streaming: não carrega o arquivo inteiro na memória. Os
 * ensaios são pequenos (50–140 KB), mas o PC é fraco e a regra vale igual. */
export function sha256(caminho: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(caminho);
    s.on("data", (c) => h.update(c));
    s.on("error", reject);
    s.on("end", () => resolve(h.digest("hex")));
  });
}

export function esperar(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
