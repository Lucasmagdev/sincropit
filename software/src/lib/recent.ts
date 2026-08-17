export interface RecentEntry {
  filePath: string;
  name: string;
  openedAt: number;
}

const KEY = "fpit.recentFiles";
const MAX = 8;

// O `JSON.parse` já era protegido por try/catch, mas o cast `as RecentEntry[]`
// não valida nada: um localStorage com JSON *válido* de outro formato (ex:
// `{}` ou `"x"`) passava e só quebrava depois, no `.filter()`/`.map()` —
// tela branca. Em app empacotado o usuário não tem como limpar o
// localStorage, então isso deixaria o Fpit inutilizável de vez. Daí a
// validação de forma ser obrigatória aqui.
function isEntry(v: unknown): v is RecentEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.filePath === "string" && typeof e.name === "string" && typeof e.openedAt === "number";
}

export function getRecents(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry).slice(0, MAX);
  } catch {
    return [];
  }
}

/** Remove um arquivo da lista (usado quando ele não abre mais — movido ou
 * apagado). Sem isso a entrada morta ficava na lista pra sempre, e o
 * usuário só descobria clicando de novo. */
export function removeRecent(filePath: string) {
  try {
    const list = getRecents().filter((e) => e.filePath !== filePath);
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // storage indisponível — a lista some sozinha na próxima sessão
  }
}

export function addRecent(entry: Omit<RecentEntry, "openedAt">) {
  try {
    const list = getRecents().filter((e) => e.filePath !== entry.filePath);
    list.unshift({ ...entry, openedAt: Date.now() });
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    // localStorage cheio ou indisponível — a lista de recentes é
    // conveniência, nunca deve impedir o usuário de abrir um arquivo.
  }
}
