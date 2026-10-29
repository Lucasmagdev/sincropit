import fs from "node:fs";
import path from "node:path";
import { sha256 } from "./arquivo.js";

/**
 * Para onde o arquivo vai.
 *
 * A interface existe pra que a fase local (pasta simulada) e a fase de nuvem
 * (Supabase) sejam intercambiáveis sem mexer no sincronizador — e pra que os
 * testes rodem sem rede.
 */
export interface Destino {
  /** Envia e devolve o identificador/caminho no destino.
   * Deve lançar em falha recuperável (rede, indisponível) para o
   * sincronizador reagendar com backoff. */
  enviar(origem: string, meta: MetaEnvio): Promise<string>;
  /** Confirma que o conteúdo chegou íntegro. Devolve o sha256 do que está
   * no destino, ou null se não der pra verificar. */
  verificar(caminhoDestino: string): Promise<string | null>;
  descricao(): string;
}

export interface MetaEnvio {
  machineId: string;
  nomeOriginal: string;
  extensao: string;
  bytes: number;
  sha256: string;
  /** Só a pasta de origem, não o caminho completo — evita expor estrutura
   * de diretório do cliente sem necessidade. */
  pastaOrigem: string;
  criadoEm: string | null;
  detectadoEm: string;
}

/**
 * Destino local: copia pra uma pasta. É a "nuvem simulada" da primeira fase,
 * e continua útil depois como espelho/backup local.
 */
export class DestinoPasta implements Destino {
  constructor(private raiz: string) {}

  descricao(): string {
    return `pasta ${this.raiz}`;
  }

  async enviar(origem: string, meta: MetaEnvio): Promise<string> {
    // organiza por máquina e data pra não virar um diretório único gigante
    const dia = meta.detectadoEm.slice(0, 10);
    const dir = path.join(this.raiz, meta.machineId, dia);
    fs.mkdirSync(dir, { recursive: true });

    // nome inclui prefixo do hash: dois ensaios de nome igual e conteúdo
    // diferente não se sobrescrevem
    const base = path.basename(meta.nomeOriginal, meta.extensao);
    const alvo = path.join(dir, `${base}.${meta.sha256.slice(0, 12)}${meta.extensao}`);

    // grava em temporário e renomeia: se cair no meio, não sobra arquivo
    // parcial parecendo íntegro no destino
    const tmp = alvo + ".parcial";
    await fs.promises.copyFile(origem, tmp);
    await fs.promises.rename(tmp, alvo);

    // grava metadados ao lado, pra auditoria enquanto não há banco na nuvem
    await fs.promises.writeFile(alvo + ".json", JSON.stringify(meta, null, 2), "utf-8");
    return alvo;
  }

  async verificar(caminhoDestino: string): Promise<string | null> {
    try {
      return await sha256(caminhoDestino);
    } catch {
      return null;
    }
  }
}
