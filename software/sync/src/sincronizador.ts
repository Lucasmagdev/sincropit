import fs from "node:fs";
import path from "node:path";
import { Banco } from "./banco.js";
import { Destino } from "./destino.js";
import { aguardarEstabilidade, esperar, sha256 } from "./arquivo.js";
import type { Config } from "./config.js";

export type Registro = (nivel: "info" | "aviso" | "erro", msg: string) => void;

/**
 * Orquestra: detecta → espera estabilizar → hash → deduplica → fila → envia.
 *
 * Princípios que valem mais que qualquer funcionalidade aqui:
 *  - o arquivo original é somente leitura, sempre;
 *  - nada é enviado antes de terminar de ser gravado;
 *  - nada é enviado duas vezes;
 *  - nada é perdido por queda de rede, de energia ou reinício.
 */
export class Sincronizador {
  private observador: fs.FSWatcher | null = null;
  private rodando = false;
  private laco: Promise<void> | null = null;
  private acordar: (() => void) | null = null;

  constructor(
    private cfg: Config,
    private banco: Banco,
    private destino: Destino,
    private log: Registro = () => {}
  ) {}

  async iniciar(): Promise<void> {
    if (!this.cfg.pastaObservada) throw new Error("pasta observada não configurada");
    if (!fs.existsSync(this.cfg.pastaObservada)) {
      throw new Error(`pasta observada não existe: ${this.cfg.pastaObservada}`);
    }

    const recuperados = this.banco.recuperarInterrompidos();
    if (recuperados) this.log("aviso", `${recuperados} item(ns) interrompidos voltaram pra fila`);

    // Varredura inicial: pega o que foi salvo enquanto o sync estava parado.
    // Sem isso, todo ensaio feito com o serviço desligado seria perdido.
    this.varrer();

    this.observar();
    this.rodando = true;
    this.laco = this.processar();
    this.log("info", `observando ${this.cfg.pastaObservada} → ${this.destino.descricao()}`);
  }

  /** Varre a pasta inteira e enfileira o que ainda não conhecemos. */
  varrer(): number {
    const raiz = this.cfg.pastaObservada!;
    let novos = 0;
    const visitar = (dir: string, profundidade: number) => {
      if (profundidade > 12) return; // trava contra link cíclico
      let entradas: fs.Dirent[];
      try {
        entradas = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // sem permissão ou pasta sumiu no meio da varredura
      }
      for (const e of entradas) {
        const completo = path.join(dir, e.name);
        if (e.isDirectory()) visitar(completo, profundidade + 1);
        else if (e.isFile() && this.interessa(completo)) {
          if (this.banco.registrarDetectado(completo)) novos++;
        }
      }
    };
    visitar(raiz, 0);
    if (novos) this.log("info", `varredura encontrou ${novos} arquivo(s) novo(s)`);
    return novos;
  }

  private interessa(caminho: string): boolean {
    const ext = path.extname(caminho).toLowerCase();
    if (!this.cfg.extensoes.includes(ext)) return false;
    // ignora temporário do próprio destino e restos de escrita parcial
    const nome = path.basename(caminho);
    return !nome.endsWith(".parcial") && !nome.startsWith("~");
  }

  private observar(): void {
    const raiz = this.cfg.pastaObservada!;
    try {
      this.observador = fs.watch(raiz, { recursive: true, persistent: true }, (_evento, nome) => {
        if (!nome) return;
        const completo = path.join(raiz, nome.toString());
        if (!this.interessa(completo)) return;
        if (this.banco.registrarDetectado(completo)) {
          this.log("info", `detectado ${path.basename(completo)}`);
        }
        this.cutucar();
      });

      // SEM ISTO O PROCESSO MORRE: fs.watch emite 'error' quando a pasta
      // some (pendrive removido, rede caiu, pasta renomeada). 'error' sem
      // ouvinte num EventEmitter vira exceção não capturada.
      this.observador.on("error", (e: Error) => {
        this.log("erro", `observador caiu: ${e?.message ?? e}. Vou tentar religar.`);
        this.religar();
      });
    } catch (e) {
      this.log("erro", `não consegui observar a pasta: ${(e as Error).message}`);
      this.religar();
    }
  }

  /** Pasta pode voltar (pendrive replugado, rede restabelecida). Tenta de
   * novo sem desistir e sem consumir CPU. */
  private religar(): void {
    try {
      this.observador?.close();
    } catch { /* já fechado */ }
    this.observador = null;
    if (!this.rodando) return;
    setTimeout(() => {
      if (!this.rodando) return;
      if (this.cfg.pastaObservada && fs.existsSync(this.cfg.pastaObservada)) {
        this.log("info", "pasta voltou; religando observador");
        this.observar();
        this.varrer();
        this.cutucar();
      } else {
        this.religar();
      }
    }, 10_000).unref?.();
  }

  private cutucar(): void {
    this.acordar?.();
  }

  /** Laço principal. Fica dormindo quando não há trabalho — é o que mantém
   * a CPU em zero em repouso. */
  private async processar(): Promise<void> {
    while (this.rodando) {
      let trabalhou = false;

      for (const item of this.banco.itensAguardandoEstabilidade()) {
        if (!this.rodando) break;
        trabalhou = true;
        await this.estabilizar(item.id, item.caminho_origem);
      }

      const proximo = this.banco.proximoParaEnviar();
      if (proximo) {
        trabalhou = true;
        await this.enviar(proximo);
      }

      if (!trabalhou) await this.dormir(30_000);
      else await esperar(10); // cede a CPU entre itens (um envio por vez)
    }
  }

  private dormir(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(finalizar, ms);
      t.unref?.();
      this.acordar = finalizar;
      function finalizar() {
        clearTimeout(t);
        resolve();
      }
    }).then(() => {
      this.acordar = null;
    });
  }

  private async estabilizar(id: string, caminho: string): Promise<void> {
    const r = await aguardarEstabilidade(caminho, this.cfg.verificacoesEstabilidade, this.cfg.intervaloEstabilidadeMs);
    if (!r.pronto) {
      if (r.motivo === "sumiu") {
        // arquivo temporário do produtor, ou movido antes de estabilizar
        this.banco.remover(id);
        this.log("info", `${path.basename(caminho)} sumiu antes de estabilizar; descartado da fila`);
      }
      // ainda_mudando / sem_leitura: fica na fila e tenta na próxima volta
      return;
    }

    const hash = await sha256(caminho);
    const precisaEnviar = this.banco.registrarHash(id, hash, r.bytes);
    this.log(
      "info",
      precisaEnviar
        ? `${path.basename(caminho)} estável (${r.bytes} B) sha256=${hash.slice(0, 12)}…`
        : `${path.basename(caminho)} é duplicado; não será reenviado`
    );
  }

  private async enviar(item: { id: string; caminho_origem: string; nome_original: string; extensao: string; bytes: number | null; sha256: string | null; tentativas: number; detectado_em: string }): Promise<void> {
    if (!item.sha256 || item.bytes === null) {
      this.banco.marcarErroPermanente(item.id, "sem hash/tamanho");
      return;
    }
    this.banco.marcarEnviando(item.id);

    try {
      // Confere que o arquivo não mudou entre estabilizar e enviar. Se mudou,
      // enviaríamos conteúdo diferente do que foi verificado.
      const agora = await sha256(item.caminho_origem);
      if (agora !== item.sha256) {
        this.log("aviso", `${item.nome_original} mudou depois de estabilizar; refazendo`);
        this.banco.marcarRetentar(item.id, "conteudo mudou apos estabilizar", item.tentativas + 1);
        return;
      }

      let criadoEm: string | null = null;
      try {
        criadoEm = fs.statSync(item.caminho_origem).birthtime.toISOString();
      } catch { /* nem todo sistema de arquivos guarda data de criação */ }

      const caminhoDestino = await this.destino.enviar(item.caminho_origem, {
        machineId: this.cfg.machineId,
        nomeOriginal: item.nome_original,
        extensao: item.extensao,
        bytes: item.bytes,
        sha256: item.sha256,
        pastaOrigem: path.basename(path.dirname(item.caminho_origem)),
        criadoEm,
        detectadoEm: item.detectado_em,
      });

      // Integridade ponta a ponta: o que chegou tem que ser byte a byte o
      // que saiu. Sem isso, uma cópia truncada passaria por sucesso.
      const hashDestino = await this.destino.verificar(caminhoDestino);
      if (hashDestino !== null && hashDestino !== item.sha256) {
        this.banco.marcarRetentar(item.id, `sha256 do destino nao confere (${hashDestino?.slice(0, 12)})`, item.tentativas + 1);
        this.log("erro", `${item.nome_original}: hash do destino não confere; vou tentar de novo`);
        return;
      }

      this.banco.marcarEnviado(item.id, caminhoDestino);
      this.log("info", `enviado ${item.nome_original} → ${caminhoDestino}`);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      this.banco.marcarRetentar(item.id, msg, item.tentativas + 1);
      this.log("aviso", `falha ao enviar ${item.nome_original}: ${msg} (tentativa ${item.tentativas + 1})`);
    }
  }

  async parar(): Promise<void> {
    this.rodando = false;
    this.cutucar();
    try {
      this.observador?.close();
    } catch { /* já fechado */ }
    this.observador = null;
    await this.laco;
    this.laco = null;
  }
}
