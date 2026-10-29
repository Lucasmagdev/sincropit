import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { diretorioDados } from "./config.js";

/**
 * Fila persistente em SQLite.
 *
 * Usa o `node:sqlite` EMBUTIDO no Node, não o better-sqlite3: qualquer
 * dependência nativa precisa de node-gyp, que já falhou neste projeto (foi
 * o que inviabilizou o serialport). Num PC industrial sem ferramentas de
 * build, dependência nativa é risco de não instalar.
 *
 * Precisa sobreviver a: reinício do sincronizador, reinício do Windows,
 * queda de internet, falha parcial de envio e destino indisponível.
 */

export type Estado =
  | "aguardando_estabilidade"
  | "pendente"
  | "enviando"
  | "enviado"
  | "retentar"
  | "erro_permanente";

export interface Item {
  id: string;
  caminho_origem: string;
  nome_original: string;
  extensao: string;
  bytes: number | null;
  sha256: string | null;
  estado: Estado;
  tentativas: number;
  ultimo_erro: string | null;
  detectado_em: string;
  enviado_em: string | null;
  proxima_tentativa_em: number;
  caminho_destino: string | null;
}

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS itens (
  id                    TEXT PRIMARY KEY,
  caminho_origem        TEXT NOT NULL,
  nome_original         TEXT NOT NULL,
  extensao              TEXT NOT NULL,
  bytes                 INTEGER,
  sha256                TEXT,
  estado                TEXT NOT NULL,
  tentativas            INTEGER NOT NULL DEFAULT 0,
  ultimo_erro           TEXT,
  detectado_em          TEXT NOT NULL,
  enviado_em            TEXT,
  proxima_tentativa_em  INTEGER NOT NULL DEFAULT 0,
  caminho_destino       TEXT
);

-- Deduplicação por CONTEÚDO, não por nome: o mesmo ensaio pode ser salvo com
-- nomes diferentes, e nomes iguais podem ter conteúdo diferente. O índice é
-- parcial porque sha256 só existe depois que o arquivo estabiliza.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sha256 ON itens(sha256) WHERE sha256 IS NOT NULL;

-- Evita enfileirar o mesmo caminho duas vezes enquanto ainda não terminou.
CREATE INDEX IF NOT EXISTS idx_origem ON itens(caminho_origem);
CREATE INDEX IF NOT EXISTS idx_estado ON itens(estado, proxima_tentativa_em);
`;

export class Banco {
  private db: DatabaseSync;

  constructor(caminho?: string) {
    const arq = caminho ?? path.join(diretorioDados(), "fila.db");
    if (arq !== ":memory:") fs.mkdirSync(path.dirname(arq), { recursive: true });
    this.db = new DatabaseSync(arq);
    // WAL: sobrevive melhor a queda de energia e não trava leitura durante escrita
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec(ESQUEMA);
  }

  /**
   * Recuperação de inicialização: item que ficou em `enviando` quando o
   * processo morreu não pode ficar preso. Volta pra `pendente` — reenviar é
   * seguro porque a deduplicação por sha256 no destino absorve repetição.
   */
  recuperarInterrompidos(): number {
    const r = this.db
      .prepare("UPDATE itens SET estado = 'pendente', ultimo_erro = 'interrompido; reprocessando' WHERE estado = 'enviando'")
      .run();
    return Number(r.changes);
  }

  /** Registra um caminho recém-detectado. Ignora se já existe item ativo pro
   * mesmo caminho (evento duplicado do fs.watch é comum). */
  registrarDetectado(caminho: string): string | null {
    const ativo = this.db
      .prepare("SELECT id FROM itens WHERE caminho_origem = ? AND estado NOT IN ('enviado','erro_permanente') LIMIT 1")
      .get(caminho) as { id: string } | undefined;
    if (ativo) return null;

    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO itens (id, caminho_origem, nome_original, extensao, estado, detectado_em)
         VALUES (?, ?, ?, ?, 'aguardando_estabilidade', ?)`
      )
      .run(id, caminho, path.basename(caminho), path.extname(caminho).toLowerCase(), new Date().toISOString());
    return id;
  }

  /** Já enviamos exatamente este conteúdo? */
  jaEnviado(sha256: string): boolean {
    const r = this.db.prepare("SELECT 1 FROM itens WHERE sha256 = ? AND estado = 'enviado' LIMIT 1").get(sha256);
    return r !== undefined;
  }

  /** Grava hash/tamanho e move pra `pendente`. Se o conteúdo já existir na
   * base (mesmo arquivo redetectado, ou cópia com outro nome), marca como
   * enviado sem reenviar. Devolve true se ainda precisa enviar. */
  registrarHash(id: string, sha256: string, bytes: number): boolean {
    if (this.jaEnviado(sha256)) {
      this.db
        .prepare("UPDATE itens SET estado = 'enviado', sha256 = NULL, bytes = ?, ultimo_erro = 'duplicado; ja enviado' WHERE id = ?")
        .run(bytes, id);
      return false;
    }
    try {
      this.db.prepare("UPDATE itens SET sha256 = ?, bytes = ?, estado = 'pendente' WHERE id = ?").run(sha256, bytes, id);
      return true;
    } catch {
      // colisão no índice único: outro item já tem esse conteúdo em andamento
      this.db
        .prepare("UPDATE itens SET estado = 'enviado', bytes = ?, ultimo_erro = 'duplicado; outro item tem o mesmo conteudo' WHERE id = ?")
        .run(bytes, id);
      return false;
    }
  }

  /** Próximo item pronto pra enviar, respeitando backoff. Um por vez. */
  proximoParaEnviar(agora = Date.now()): Item | null {
    const r = this.db
      .prepare(
        `SELECT * FROM itens
         WHERE estado IN ('pendente','retentar') AND proxima_tentativa_em <= ?
         ORDER BY detectado_em LIMIT 1`
      )
      .get(agora) as Item | undefined;
    return r ?? null;
  }

  itensAguardandoEstabilidade(): Item[] {
    return this.db.prepare("SELECT * FROM itens WHERE estado = 'aguardando_estabilidade' ORDER BY detectado_em").all() as Item[];
  }

  marcarEnviando(id: string): void {
    this.db.prepare("UPDATE itens SET estado = 'enviando' WHERE id = ?").run(id);
  }

  marcarEnviado(id: string, caminhoDestino: string): void {
    this.db
      .prepare("UPDATE itens SET estado = 'enviado', enviado_em = ?, caminho_destino = ?, ultimo_erro = NULL WHERE id = ?")
      .run(new Date().toISOString(), caminhoDestino, id);
  }

  /** Falha recuperável: agenda nova tentativa com backoff exponencial. */
  marcarRetentar(id: string, erro: string, tentativas: number): void {
    const espera = Math.min(2 ** Math.min(tentativas, 10) * 1000, 15 * 60 * 1000);
    this.db
      .prepare("UPDATE itens SET estado = 'retentar', tentativas = ?, ultimo_erro = ?, proxima_tentativa_em = ? WHERE id = ?")
      .run(tentativas, erro.slice(0, 500), Date.now() + espera, id);
  }

  marcarErroPermanente(id: string, erro: string): void {
    this.db.prepare("UPDATE itens SET estado = 'erro_permanente', ultimo_erro = ? WHERE id = ?").run(erro.slice(0, 500), id);
  }

  remover(id: string): void {
    this.db.prepare("DELETE FROM itens WHERE id = ?").run(id);
  }

  contagemPorEstado(): Record<string, number> {
    const linhas = this.db.prepare("SELECT estado, COUNT(*) n FROM itens GROUP BY estado").all() as { estado: string; n: number }[];
    return Object.fromEntries(linhas.map((l) => [l.estado, Number(l.n)]));
  }

  todos(): Item[] {
    return this.db.prepare("SELECT * FROM itens ORDER BY detectado_em").all() as Item[];
  }

  fechar(): void {
    this.db.close();
  }
}
