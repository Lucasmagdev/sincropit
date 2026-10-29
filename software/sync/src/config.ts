import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Configuração persistida do Fpit Sync.
 *
 * Fica fora do diretório do programa de propósito: o executável pode ser
 * substituído por uma versão nova sem levar junto a pasta configurada e a
 * fila. No Windows vai pra %APPDATA%\FpitSync\.
 */
export interface Config {
  /** Pasta que o PIT-Q usa pra salvar ensaio. Escolhida na primeira execução —
   * NUNCA presumida: o "Public Documents" dentro da instalação do PIT-Q não
   * foi comprovado como pasta de saída. */
  pastaObservada: string | null;
  /** Destino do envio. Na fase local é uma pasta; depois vira Supabase. */
  destino: { tipo: "pasta"; caminho: string } | { tipo: "supabase"; url: string };
  /** Identificador desta máquina — usado na deduplicação no servidor. */
  machineId: string;
  /** Quantas verificações seguidas de tamanho+mtime iguais para considerar
   * o arquivo pronto. */
  verificacoesEstabilidade: number;
  /** Intervalo entre verificações, em ms. */
  intervaloEstabilidadeMs: number;
  /** Depois disso, o arquivo continua na fila mas para de ser reverificado
   * com frequência (não é descartado). */
  timeoutEstabilidadeMs: number;
  /** Extensões aceitas. Tratadas como binário opaco — não interpretamos. */
  extensoes: string[];
}

export const PADRAO: Omit<Config, "machineId"> = {
  pastaObservada: null,
  destino: { tipo: "pasta", caminho: "" },
  verificacoesEstabilidade: 3,
  intervaloEstabilidadeMs: 1000,
  timeoutEstabilidadeMs: 5 * 60 * 1000,
  extensoes: [".pte", ".ptn", ".pt2"],
};

export function diretorioDados(): string {
  const base =
    process.env.FPIT_SYNC_HOME ??
    process.env.APPDATA ??
    path.join(os.homedir(), ".config");
  return path.join(base, "FpitSync");
}

function caminhoConfig(): string {
  return path.join(diretorioDados(), "config.json");
}

/** Identificador estável da máquina. Gerado uma vez e guardado junto da
 * config — não usamos nome de host nem serial de hardware pra não depender
 * de coisa que muda ou que exponha informação desnecessária. */
function novoMachineId(): string {
  return `pit-${crypto.randomUUID()}`;
}

export function carregar(): Config {
  const arq = caminhoConfig();
  try {
    const bruto: unknown = JSON.parse(fs.readFileSync(arq, "utf-8"));
    if (typeof bruto === "object" && bruto !== null) {
      const c = bruto as Partial<Config>;
      return {
        ...PADRAO,
        machineId: typeof c.machineId === "string" && c.machineId ? c.machineId : novoMachineId(),
        pastaObservada: typeof c.pastaObservada === "string" ? c.pastaObservada : null,
        destino: c.destino ?? PADRAO.destino,
        verificacoesEstabilidade: numeroOu(c.verificacoesEstabilidade, PADRAO.verificacoesEstabilidade, 2, 20),
        intervaloEstabilidadeMs: numeroOu(c.intervaloEstabilidadeMs, PADRAO.intervaloEstabilidadeMs, 50, 60000),
        timeoutEstabilidadeMs: numeroOu(c.timeoutEstabilidadeMs, PADRAO.timeoutEstabilidadeMs, 1000, 3600000),
        extensoes: Array.isArray(c.extensoes) && c.extensoes.length ? c.extensoes.map((e) => String(e).toLowerCase()) : PADRAO.extensoes,
      };
    }
  } catch {
    // sem config ou config corrompida — começa do padrão em vez de quebrar
  }
  return { ...PADRAO, machineId: novoMachineId() };
}

function numeroOu(v: unknown, padrao: number, min: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : padrao;
}

export function salvar(c: Config): void {
  const dir = diretorioDados();
  fs.mkdirSync(dir, { recursive: true });
  // grava em temporário e renomeia: se faltar energia no meio, a config
  // antiga continua íntegra em vez de virar arquivo pela metade
  const tmp = caminhoConfig() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2), "utf-8");
  fs.renameSync(tmp, caminhoConfig());
}
