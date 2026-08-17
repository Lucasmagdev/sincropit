import type { VelocityPoint } from "./pte";

export interface SiteReference {
  label: string; // nome da estaca/ensaio usado como referência
  le: number;
  points: VelocityPoint[];
  savedAt: number;
  /** Escala aplicada aos pontos no momento de salvar (1 = unidade relativa).
   *
   * Sem isto a referência quebrava ao mudar a calibração: os pontos são
   * gravados JÁ escalados, então uma referência salva em unidade relativa
   * (~1e11) exibida junto de uma vista calibrada (~0.27 cm/s) diferia por
   * ~12 ordens de grandeza e destruía o gráfico. Guardando a escala dá pra
   * reajustar pra escala atual na hora de desenhar.
   *
   * Opcional por compatibilidade: referência salva antes desta correção não
   * tem o campo e é tratada como escala 1. */
  escala?: number;
}

const KEY = "fpit.siteReference";

// Mesma armadilha da lista de recentes: o try/catch cobria só JSON inválido,
// mas JSON *válido* com outro formato passava pelo cast e só quebrava depois
// — aqui era pior, porque `siteRef.points` indefinido ia direto pro gráfico.
function isReference(v: unknown): v is SiteReference {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.label !== "string" || typeof r.le !== "number" || typeof r.savedAt !== "number") return false;
  // escala é opcional (referências antigas não têm), mas se vier tem que ser
  // um número usável — senão viraria divisão por zero/NaN no reajuste
  if (r.escala !== undefined && (typeof r.escala !== "number" || !Number.isFinite(r.escala) || r.escala <= 0)) {
    return false;
  }
  if (!Array.isArray(r.points)) return false;
  return r.points.every(
    (p) =>
      typeof p === "object" && p !== null &&
      Number.isFinite((p as VelocityPoint).x) && Number.isFinite((p as VelocityPoint).v)
  );
}

export function getSiteReference(): SiteReference | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isReference(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Retorna false se não deu pra salvar (cota do localStorage estourada, por
 * exemplo) — quem chama decide como avisar o usuário. Antes, um
 * QuotaExceededError aqui subia como exceção não tratada no meio do clique. */
export function setSiteReference(ref: Omit<SiteReference, "savedAt">): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...ref, savedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

export function clearSiteReference() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // storage indisponível — nada a fazer, e não é motivo pra derrubar a UI
  }
}
