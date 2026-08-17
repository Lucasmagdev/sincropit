import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  erro: Error | null;
  pilha: string | null;
}

/**
 * Rede de proteção contra erro não tratado na renderização.
 *
 * Sem isto, qualquer exceção durante o render desmonta a árvore inteira do
 * React e o usuário fica com **tela branca sem nenhuma explicação**. Isso é
 * pior num app empacotado: no Electron o usuário não tem console/devtools à
 * mão pra descobrir o que aconteceu, e no PIT-Q (painel industrial, em obra)
 * menos ainda.
 *
 * Aqui o erro vira uma tela legível, com a mensagem técnica disponível pra
 * copiar e um botão pra recomeçar sem precisar fechar e reabrir o programa.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { erro: null, pilha: null };

  static getDerivedStateFromError(erro: Error): Partial<State> {
    return { erro };
  }

  componentDidCatch(erro: Error, info: ErrorInfo) {
    // fica no console pra quem abrir o devtools; a UI abaixo cobre quem não abre
    console.error("Erro não tratado na interface:", erro, info.componentStack);
    this.setState({ pilha: info.componentStack ?? null });
  }

  render() {
    const { erro, pilha } = this.state;
    if (!erro) return this.props.children;

    const detalhe = [erro.stack ?? `${erro.name}: ${erro.message}`, pilha ? `\nComponentes:${pilha}` : ""].join("");

    return (
      <div className="h-screen w-screen overflow-auto bg-neutral-950 text-neutral-100 p-8">
        <div className="mx-auto max-w-3xl space-y-4">
          <h1 className="text-xl font-semibold text-amber-400">O Fpit encontrou um erro inesperado</h1>
          <p className="text-sm text-neutral-300">
            A tela foi interrompida pra não mostrar informação possivelmente errada. Nenhum arquivo de
            ensaio foi alterado — os <code>.PTE</code> são sempre abertos como somente leitura.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => this.setState({ erro: null, pilha: null })}
              className="rounded bg-amber-600 hover:bg-amber-500 px-4 py-2 text-sm font-medium text-white"
            >
              Tentar novamente
            </button>
            <button
              onClick={() => window.location.reload()}
              className="rounded border border-neutral-700 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-800"
            >
              Recarregar o programa
            </button>
            <button
              onClick={() => navigator.clipboard?.writeText(detalhe)}
              className="rounded border border-neutral-700 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-800"
            >
              Copiar detalhes
            </button>
          </div>
          <details className="rounded border border-neutral-800 bg-neutral-900/60 p-3" open>
            <summary className="cursor-pointer text-xs uppercase tracking-widest text-neutral-500 font-mono">
              detalhes técnicos
            </summary>
            <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-snug text-neutral-400">
              {detalhe}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
