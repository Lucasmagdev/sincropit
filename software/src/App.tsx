import { useEffect, useMemo, useState } from "react";
import {
  FolderOpen,
  Download,
  FileText,
  GitCompare,
  Bookmark,
  BookmarkX,
  Activity,
  AudioWaveform,
  X,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Radio,
} from "lucide-react";
import {
  parsePte,
  processBlow,
  countBlows,
  getTextField,
  availableChannels,
  correlacaoComPrincipal,
  estimarPicoAbsoluto,
  marcarBatidasFracas,
  ACC_G_PER_VOLT_PADRAO,
  CALIBRACAO_INCERTEZA_PCT,
  type PteFile,
} from "./lib/pte";
import { WaveformChart, type Series } from "./components/WaveformChart";
import { SpectrumChart } from "./components/SpectrumChart";
import { computeSpectrum } from "./lib/fft";
import { getRecents, addRecent, removeRecent, type RecentEntry } from "./lib/recent";
import { getSiteReference, setSiteReference, clearSiteReference, type SiteReference } from "./lib/reference";

interface LoadedFile {
  name: string;
  filePath?: string;
  pte: PteFile;
}

const BLOW_COLORS = ["#b5760a", "#3d7fb5", "#5b8f3d", "#9a4fb5", "#b54f4f", "#4fb5a3"];
const COMPARE_COLOR = "#7a7a7a";
const REF_COLOR = "#3d9be8";

/** Monta o CSV rotulando a unidade a partir da escala REALMENTE aplicada.
 *
 * Antes o rótulo saía do campo de calibração digitado pelo usuário — e isso
 * mentia num caso concreto: em canal secundário o app não aplica calibração
 * (a sensibilidade daquele sensor é desconhecida), mas o campo digitado
 * continua preenchido, então o arquivo saía com cabeçalho `v_cms` sobre
 * dados em unidade relativa. Um CSV mal rotulado vai pro cliente e sobrevive
 * à sessão; quem abrir depois lê o cabeçalho como verdade. */
function csvForPoints(points: { x: number; v: number }[], escalaAplicada: number): string {
  const header = escalaAplicada !== 1 ? "x_m,v_cms" : "x_m,v_relativo";
  return header + "\n" + points.map((p) => `${p.x},${p.v}`).join("\n");
}

/** CSV do espectro. Existe porque o botão de exportar precisa entregar o que
 * está NA TELA: antes ele mandava sempre a onda, mesmo com o espectro em
 * exibição, e o usuário recebia um arquivo com conteúdo diferente do gráfico
 * que estava olhando. */
function csvForSpectrum(spectrum: { freq: number; magnitude: number }[]): string {
  return "freq_hz,magnitude\n" + spectrum.map((p) => `${p.freq},${p.magnitude}`).join("\n");
}

function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3 border-b border-neutral-800">
      <p className="text-[10px] uppercase tracking-widest text-neutral-500 font-mono mb-2">{title}</p>
      {children}
    </div>
  );
}

function App() {
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [blowIndex, setBlowIndex] = useState(0);
  const [channel, setChannel] = useState(0);
  const [overlay, setOverlay] = useState(false);
  const [calibrationInput, setCalibrationInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<"pdf" | "csv" | null>(null);
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const [recents, setRecents] = useState<RecentEntry[]>([]);

  const [compareFile, setCompareFile] = useState<LoadedFile | null>(null);
  const [compareBlowIndex, setCompareBlowIndex] = useState(0);

  const [viewMode, setViewMode] = useState<"onda" | "espectro">("onda");
  const [siteRef, setSiteRef] = useState<SiteReference | null>(null);
  const [showRef, setShowRef] = useState(false);

  const [watchFolder, setWatchFolder] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  const [autoNotice, setAutoNotice] = useState<string | null>(null);

  useEffect(() => {
    setRecents(getRecents());
    setSiteRef(getSiteReference());
    const saved = localStorage.getItem("pit-watch-folder");
    if (saved) setWatchFolder(saved);
  }, []);

  function loadBuffer(name: string, buffer: ArrayBuffer, filePath?: string, jumpToLastBlow?: boolean) {
    try {
      const pte = parsePte(buffer);
      // parsePte é tolerante por natureza (não existe marcador de fim de
      // header no formato, ele só para quando os bytes deixam de parecer TLV),
      // então lixo/arquivo truncado "passa" com zero batidas. Sem esta
      // checagem o app aceitava o arquivo, mostrava ✓ verde no cabeçalho e
      // deixava a tela em branco, sem nenhuma explicação.
      const blows = countBlows(pte);
      if (blows < 1) {
        setError(`"${name}" não contém nenhuma batida — não parece um ensaio .PTE válido (ou está truncado/corrompido).`);
        return;
      }
      setFile({ name, filePath, pte });
      setBlowIndex(jumpToLastBlow ? blows - 1 : 0);
      setChannel(0);
      // O pico conhecido é evidência de UMA estaca/batida específica, lida da
      // tela do equipamento. Mantê-lo ao abrir outro ensaio faria o app
      // normalizar a estaca nova pelo pico da anterior e rotular como
      // "cm/s calibrado" — grave na captura automática, que carrega um
      // ensaio atrás do outro sem o usuário reabrir nada.
      setCalibrationInput("");
      setError(null);
      setExportedPath(null);
      if (filePath) {
        addRecent({ filePath, name });
        setRecents(getRecents());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handlePickWatchFolder() {
    if (!window.pit) return;
    const folder = await window.pit.pickFolder();
    if (!folder) return;
    setWatchFolder(folder);
    localStorage.setItem("pit-watch-folder", folder);
    if (watching) {
      await window.pit.watchFolder(folder);
    }
  }

  async function handleToggleWatch() {
    if (!window.pit || !watchFolder) return;
    if (watching) {
      await window.pit.stopWatch();
      setWatching(false);
    } else {
      const ok = await window.pit.watchFolder(watchFolder);
      setWatching(ok);
    }
  }

  useEffect(() => {
    if (!window.pit) return;
    return window.pit.onFileChanged((data) => {
      loadBuffer(data.name, data.buffer, data.filePath, true);
      setAutoNotice(`Novo ensaio detectado: ${data.name}`);
      setTimeout(() => setAutoNotice(null), 6000);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // a observação morre sozinha se a pasta sumir (pendrive removido, rede
  // caiu). Sem este aviso o botão continuaria dizendo "Observando" pra
  // sempre e nenhum ensaio novo chegaria, sem explicação nenhuma.
  useEffect(() => {
    if (!window.pit) return;
    return window.pit.onWatchError((msg) => {
      setWatching(false);
      setError(`A captura automática parou: ${msg}`);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (window.pit && watching) window.pit.stopWatch();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadCompareBuffer(name: string, buffer: ArrayBuffer, filePath?: string) {
    try {
      const pte = parsePte(buffer);
      // mesma validação do arquivo principal: sem ela, um arquivo inválido
      // entrava como "comparação" sem nenhuma batida — aparecia o nome na
      // barra lateral, nenhum botão de batida, e nada era desenhado, sem
      // explicação nenhuma.
      if (countBlows(pte) < 1) {
        setError(`"${name}" não contém nenhuma batida — não serve como comparação.`);
        return;
      }
      setCompareFile({ name, filePath, pte });
      setCompareBlowIndex(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleOpenClick() {
    if (window.pit) {
      const result = await window.pit.openFileDialog();
      if (result) loadBuffer(result.name, result.buffer, result.filePath);
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".PTE,.pte";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      loadBuffer(f.name, await f.arrayBuffer());
    };
    input.click();
  }

  async function handleOpenCompareClick() {
    if (window.pit) {
      const result = await window.pit.openFileDialog();
      if (result) loadCompareBuffer(result.name, result.buffer, result.filePath);
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".PTE,.pte";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      loadCompareBuffer(f.name, await f.arrayBuffer());
    };
    input.click();
  }

  async function handleOpenRecent(entry: RecentEntry) {
    if (!window.pit) return;
    const result = await window.pit.readPath(entry.filePath);
    if (result) loadBuffer(result.name, result.buffer, result.filePath);
    else {
      // tira da lista: sem isso a entrada morta ficava lá pra sempre e o
      // usuário só descobria clicando de novo.
      removeRecent(entry.filePath);
      setError(`Não consegui reabrir ${entry.name} — arquivo pode ter sido movido/apagado.`);
      setRecents(getRecents());
    }
  }

  function handleDrop(ev: React.DragEvent) {
    ev.preventDefault();
    const f = ev.dataTransfer.files[0];
    if (!f) return;
    f.arrayBuffer()
      .then((buf) => loadBuffer(f.name, buf))
      // sem o catch, uma falha de leitura (arquivo removido no meio do
      // arrasto, permissão negada) virava rejeição não tratada e o usuário
      // não recebia aviso nenhum — a tela simplesmente não mudava.
      .catch((e) => setError(`Não consegui ler "${f.name}": ${e instanceof Error ? e.message : String(e)}`));
  }

  async function handleExportPdf() {
    if (!file || !window.pit) return;
    setExporting("pdf");
    setExportedPath(null);
    try {
      const sufixoCanal = channel > 0 ? `.ch${channel}` : "";
      const suggested = `${file.name.replace(/\.PTE$/i, "")}.blow${blowIndex + 1}${sufixoCanal}.pdf`;
      setExportedPath(await window.pit.exportPdf(suggested));
    } catch (e) {
      // sem este catch, a falha virava rejeição não tratada: o botão parava
      // de girar e o usuário não recebia explicação nenhuma.
      setError(`Falha ao exportar o PDF: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(null);
    }
  }

  async function handleExportCsv() {
    if (!file || !result) return;
    setExporting("csv");
    setExportedPath(null);
    // inclui o canal no nome quando não é o principal — sem isso, dois
    // exports da mesma batida em sensores diferentes sairiam com nome
    // idêntico e um sobrescreveria o outro no relatório.
    const sufixoCanal = channel > 0 ? `.ch${channel}` : "";
    // exporta o que está EM EXIBIÇÃO, e diz no nome do arquivo qual é —
    // antes mandava a onda mesmo com o espectro na tela.
    const ehEspectro = viewMode === "espectro";
    const sufixoTipo = ehEspectro ? ".espectro" : "";
    const suggested = `${file.name.replace(/\.PTE$/i, "")}.blow${blowIndex + 1}${sufixoCanal}${sufixoTipo}.csv`;
    const csv = ehEspectro ? csvForSpectrum(spectrum) : csvForPoints(result.points, result.escala);
    try {
      if (window.pit) {
        setExportedPath(await window.pit.exportCsv(suggested, csv));
      } else {
        const blob = new Blob([csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = suggested;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      setError(`Falha ao exportar o CSV: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(null);
    }
  }

  const nBlows = file ? countBlows(file.pte) : 0;
  const compareNBlows = compareFile ? countBlows(compareFile.pte) : 0;
  const peakCalibration = calibrationInput.trim() ? Number(calibrationInput) : undefined;

  // canais com sensor de verdade nesta batida. Quase todo ensaio usa só o
  // canal 0, mas alguns gravam um 2º acelerômetro — sem isso o app
  // descartaria medição real que está no arquivo.
  // Canais com sensor de verdade em cada batida. Fonte única: `channels` sai
  // daqui em vez de recalcular — duas contagens independentes do mesmo dado
  // podem divergir e produzir estado inconsistente (ex: o seletor mostrando
  // um canal que a montagem do gráfico considera inexistente).
  const canaisPorBatida = useMemo(() => {
    if (!file) return [];
    return Array.from({ length: nBlows }, (_, i) => availableChannels(file.pte, i));
  }, [file, nBlows]);

  const channels = useMemo(
    () => canaisPorBatida[blowIndex] ?? [0],
    [canaisPorBatida, blowIndex]
  );

  // volta pro canal principal se o canal atual não existir nesta batida
  useEffect(() => {
    if (!channels.includes(channel)) setChannel(channels[0] ?? 0);
  }, [channels, channel]);

  const allResults = useMemo(() => {
    if (!file) return [];

    // processa cada batida no canal escolhido quando ela tem esse canal;
    // as que não têm ficam no principal.
    const canalDe = (i: number) => (canaisPorBatida[i]?.includes(channel) ? channel : 0);

    // UMA escala pro arquivo inteiro, derivada da batida exibida.
    //
    // `peakCalibration` normaliza o pico DA BATIDA processada. Passá-lo a
    // cada batida faria todas terminarem com o mesmo pico, apagando a
    // diferença real de energia entre elas: medido no B135-ED, a razão entre
    // a batida mais forte e a mais fraca cai de 32.4x para 1.7x — um golpe de
    // teste do operador passaria a parecer um golpe bom, contradizendo o
    // próprio aviso de "batida fraca" que o app mostra pra ela.
    //
    // A calibração vem da tela do equipamento, que mostra o SENSOR PRINCIPAL;
    // em canal secundário ela não se aplica (sensibilidade desconhecida) e a
    // escala fica 1.
    let escalaComum = 1;
    try {
      const chSel = canalDe(blowIndex);
      const calSel = chSel === 0 ? peakCalibration : undefined;
      escalaComum = processBlow(file.pte, blowIndex, { peakCalibration: calSel, channel: chSel }).escala;
    } catch {
      escalaComum = 1;
    }

    const out: (ReturnType<typeof processBlow> | null)[] = [];
    for (let i = 0; i < nBlows; i++) {
      try {
        out.push(processBlow(file.pte, i, { escala: escalaComum, channel: canalDe(i) }));
      } catch {
        out.push(null);
      }
    }
    return out;
  }, [file, nBlows, peakCalibration, channel, canaisPorBatida, blowIndex]);

  useEffect(() => {
    if (!file) return;
    const falhas = allResults.filter((r) => r === null).length;
    if (!falhas) {
      setError(null);
    } else if (falhas === allResults.length) {
      // todas falharam: a área do gráfico fica vazia, então o banner é a
      // única coisa que explica o que houve.
      setError(`Nenhuma das ${allResults.length} batidas pôde ser processada — arquivo provavelmente corrompido.`);
    } else {
      setError(`${falhas} de ${allResults.length} batidas não puderam ser processadas (dado insuficiente no bloco).`);
    }
  }, [allResults, file]);

  const result = allResults[blowIndex] ?? null;

  const compareBatidasFracas = useMemo(() => {
    if (!compareFile) return [];
    const picos: (number | undefined)[] = [];
    for (let i = 0; i < compareNBlows; i++) {
      try {
        picos.push(estimarPicoAbsoluto(processBlow(compareFile.pte, i)));
      } catch {
        picos.push(undefined);
      }
    }
    return marcarBatidasFracas(picos);
  }, [compareFile, compareNBlows]);

  const compareResult = useMemo(() => {
    if (!compareFile) return null;
    try {
      // Usa a MESMA escala da estaca principal, não uma calibração própria.
      // Se cada uma fosse normalizada pelo próprio pico, as duas curvas
      // terminariam com altura idêntica e o gráfico sugeriria que as estacas
      // respondem igual — justamente o que a comparação deveria revelar ou
      // descartar.
      return processBlow(compareFile.pte, compareBlowIndex, { escala: result?.escala });
    } catch {
      return null;
    }
  }, [compareFile, compareBlowIndex, result?.escala]);

  const spectrum = useMemo(() => {
    if (!result) return [];
    return computeSpectrum(result.velocitySignal, result.params.FS);
  }, [result]);

  // A estimativa precisa sair do resultado SEM calibração aplicada: `result`
  // já vem multiplicado por peakCalibration quando o usuário digita um valor,
  // e estimar em cima disso devolveria o próprio valor digitado.
  // quão parecido o canal escolhido é com o principal — ver comentário em
  // correlacaoComPrincipal: nem todo canal ocupado é o mesmo golpe
  const correlacaoCanal = useMemo(() => {
    if (!file || channel === 0) return undefined;
    try {
      return correlacaoComPrincipal(file.pte, blowIndex, channel);
    } catch {
      return undefined;
    }
  }, [file, blowIndex, channel]);

  const picoEstimado = useMemo(() => {
    // Só faz sentido no sensor principal: a cadeia física usa a
    // sensibilidade do acelerômetro de 9.5 g/V, e não sabemos a calibração
    // do sensor secundário (o .PTE não registra qual sensor é cada canal).
    // Aplicá-la ao canal secundário devolveria ~4e-5 cm/s — número sem
    // significado físico, apresentado como se fosse estimativa.
    if (!file || channel !== 0) return undefined;
    try {
      return estimarPicoAbsoluto(processBlow(file.pte, blowIndex));
    } catch {
      return undefined;
    }
  }, [file, blowIndex, channel]);

  // Golpes de teste do operador ficam gravados junto com os bons. Um golpe
  // fraco gera traço de baixa amplitude que pode passar por estaca
  // defeituosa — marcar evita essa leitura errada.
  const batidasFracas = useMemo(() => {
    if (!file) return [];
    const picos: (number | undefined)[] = [];
    for (let i = 0; i < nBlows; i++) {
      try {
        picos.push(estimarPicoAbsoluto(processBlow(file.pte, i)));
      } catch {
        picos.push(undefined);
      }
    }
    return marcarBatidasFracas(picos);
  }, [file, nBlows]);

  function handleSaveReference() {
    if (!file || !result) return;
    // referência do site é curva-padrão pra comparar com outras estacas —
    // a escala de um sensor secundário não é comparável com a do principal
    // (medido: razão de 0.1x a 25000x conforme o ensaio), então a curva
    // gravada seria confrontada depois com estacas em outra escala.
    if (channel !== 0) {
      setError("Salve a referência a partir do sensor principal — a escala do canal secundário não é comparável com a das outras estacas.");
      return;
    }
    const label = getTextField(file.pte.blocks[0].headerRecords, "0303") ?? file.name;
    // grava a escala usada: os pontos vão já escalados, e sem esse dado a
    // referência ficaria incomparável se a calibração mudasse depois
    if (!setSiteReference({ label, le: result.params.LE, points: result.points, escala: result.escala })) {
      setError("Não consegui salvar a referência (armazenamento local cheio ou indisponível).");
      return;
    }
    setSiteRef(getSiteReference());
    setShowRef(true);
  }

  function handleClearReference() {
    clearSiteReference();
    setSiteRef(null);
    setShowRef(false);
  }

  // Sobreposição só junta batidas do MESMO sensor. Misturar canais no mesmo
  // eixo Y é enganoso: a amplitude de um canal secundário em relação ao
  // principal é imprevisível (medido: 0.1x a 25000x conforme o ensaio).
  // Quando a razão é grande, a curva menor vira uma linha reta no zero — e
  // "reta no zero" se lê como "sensor não registrou nada", que é falso.
  const series: Series[] = overlay
    ? allResults
        .map((r, i) => ({ r, i }))
        .filter(({ i }) => channel === 0 || canaisPorBatida[i]?.includes(channel))
        .map(({ r, i }) => ({
          label: `#${i + 1}`,
          points: r?.points ?? [],
          color: BLOW_COLORS[i % BLOW_COLORS.length],
          highlighted: i === blowIndex,
        }))
    : result
      ? [{ label: `#${blowIndex + 1}`, points: result.points, color: BLOW_COLORS[blowIndex % BLOW_COLORS.length], highlighted: true }]
      : [];

  // Comparação e referência vêm sempre do sensor principal. Sobrepô-las a uma
  // vista de canal secundário juntaria escalas não comparáveis no mesmo eixo,
  // podendo achatar uma das curvas contra o zero — leitura enganosa. Então
  // elas só entram no gráfico quando o canal principal está selecionado.
  const sobreposicaoExternaOculta = channel !== 0 && (!!compareResult || (showRef && !!siteRef));

  if (compareResult && channel === 0) {
    series.push({
      label: `${compareFile?.name ?? "comparação"} #${compareBlowIndex + 1}`,
      points: compareResult.points,
      color: COMPARE_COLOR,
      highlighted: false,
    });
  }

  // Referência de estaca com comprimento diferente é armadilha: o eixo X e a
  // linha "Toe (LE)" são da estaca ATUAL, então o eco de ponta da referência
  // cai numa posição que, lida no eixo atual, parece um defeito no meio do
  // fuste. 5% de diferença já muda a posição do eco de forma perceptível.
  const refComprimentoDiferente =
    !!siteRef && !!result && Math.abs(siteRef.le - result.params.LE) > result.params.LE * 0.05;

  // Mesma armadilha na comparação entre estacas: a curva da outra estaca é
  // desenhada no eixo X DESTA, então o eco de ponta dela cai numa posição
  // que aqui significa outra coisa.
  const comparacaoComprimentoDiferente =
    !!compareResult &&
    !!result &&
    Math.abs(compareResult.params.LE - result.params.LE) > result.params.LE * 0.05;

  if (showRef && siteRef && channel === 0) {
    // Reajusta a referência pra escala da vista atual. Os pontos foram
    // gravados já escalados; se a calibração mudou desde então, desenhar os
    // valores originais colocaria duas escalas diferentes no mesmo eixo (uma
    // referência em unidade relativa contra uma vista calibrada difere por
    // ~12 ordens de grandeza e some do gráfico).
    const escalaRef = siteRef.escala ?? 1; // referência antiga = sem calibração
    const escalaAtual = result?.escala ?? 1;
    const ajuste = escalaAtual / escalaRef;
    const pontosRef =
      ajuste === 1 ? siteRef.points : siteRef.points.map((p) => ({ x: p.x, v: p.v * ajuste }));
    series.push({ label: `referência: ${siteRef.label}`, points: pontosRef, color: REF_COLOR, highlighted: false });
  }

  const pileName = file ? getTextField(file.pte.blocks[0].headerRecords, "0303") : undefined;
  const operator = file ? getTextField(file.pte.blocks[0].headerRecords, "0202") : undefined;
  const company = file ? getTextField(file.pte.blocks[0].headerRecords, "0203") : undefined;
  const comparePileName = compareFile ? getTextField(compareFile.pte.blocks[0].headerRecords, "0303") : undefined;

  return (
    <div
      className="h-screen flex bg-neutral-950 text-neutral-100 overflow-hidden select-none"
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      {/* Sidebar */}
      {/* mais estreita em tela pequena (o PIT-Q é um painel industrial):
          320px de barra lateral num monitor de 800px deixaria pouco espaço
          pro gráfico, que é o que importa. */}
      <aside className="w-72 xl:w-80 shrink-0 bg-neutral-900/60 border-r border-neutral-800 flex flex-col overflow-y-auto print:hidden">
        <div className="flex items-center gap-2.5 px-4 py-4 border-b border-neutral-800">
          <img src="/icon.png" alt="" className="w-7 h-7 rounded-md" />
          <div>
            <p className="text-sm font-semibold leading-tight">Fpit</p>
            <p className="text-[10px] text-neutral-500 font-mono leading-tight">Visualizador PIT</p>
          </div>
        </div>

        <SidebarSection title="Captura automática">
          <div className="space-y-2">
            <button
              onClick={handlePickWatchFolder}
              disabled={!window.pit}
              className="w-full flex items-center gap-2 rounded border border-dashed border-neutral-700 px-3 py-2 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-50"
              title={!window.pit ? "Disponível só no app desktop" : undefined}
            >
              <FolderOpen size={14} />
              <span className="truncate" title={watchFolder ?? undefined}>
                {watchFolder ?? "escolher pasta de saída do PIT-Q"}
              </span>
            </button>
            {watchFolder && (
              <button
                onClick={handleToggleWatch}
                className={`w-full flex items-center justify-center gap-2 rounded px-3 py-2 text-xs font-medium transition-colors ${
                  watching
                    ? "bg-emerald-700/80 text-white hover:bg-emerald-700"
                    : "border border-neutral-700 text-neutral-300 hover:bg-neutral-800"
                }`}
              >
                <Radio size={14} className={watching ? "animate-pulse" : undefined} />
                {watching ? "Observando — clique pra parar" : "Iniciar captura automática"}
              </button>
            )}
            <button
              onClick={async () => {
                try {
                  const data = await window.pit?.sim.generateSignal();
                  if (data) loadBuffer(data.name, data.buffer, data.filePath, true);
                  else setError("Não consegui gerar o sinal simulado.");
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
              disabled={!window.pit}
              className="w-full flex items-center justify-center gap-2 rounded px-3 py-2 text-xs font-medium transition-colors bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-50 disabled:cursor-not-allowed"
              title={!window.pit ? "Disponível só no app desktop" : undefined}
            >
              ⚡ simular batida
            </button>
          </div>
        </SidebarSection>

        {/* Ensaio + seletor de batida/canal dependem só do ARQUIVO estar
            aberto, não do processamento ter dado certo — se a batida
            selecionada falha, o usuário precisa continuar podendo trocar
            pra outra (antes a barra lateral sumia inteira e ele ficava
            preso, sem saída). */}
        {file && (
          <>
            <SidebarSection title="Ensaio">
              <div className="space-y-1 text-sm">
                <p className="font-mono text-neutral-100 truncate" title={file.name}>{pileName ?? file.name}</p>
                <p className="text-neutral-500 text-xs truncate">{operator ?? "operador não informado"}</p>
                <p className="text-neutral-500 text-xs truncate">{company ?? "cliente não informado"}</p>
              </div>
            </SidebarSection>

            <SidebarSection title="Batida">
              <div className="flex flex-wrap gap-1.5 mb-2">
                {Array.from({ length: nBlows }, (_, i) => {
                  const falhou = allResults[i] === null;
                  const fraca = batidasFracas[i];
                  return (
                    <button
                      key={i}
                      onClick={() => setBlowIndex(i)}
                      title={
                        falhou
                          ? "esta batida não pôde ser processada"
                          : fraca
                            ? "golpe fraco — provavelmente batida de teste do operador, não medição válida"
                            : undefined
                      }
                      className={`rounded px-2.5 py-1 text-xs font-mono border transition-colors ${
                        i === blowIndex
                          ? "text-white border-transparent"
                          : falhou
                            ? "border-red-900/70 text-red-400/70 hover:bg-neutral-800"
                            : fraca
                              ? "border-amber-900/70 text-amber-500/70 hover:bg-neutral-800"
                              : "border-neutral-700 text-neutral-400 hover:bg-neutral-800"
                      }`}
                      style={i === blowIndex ? { background: falhou ? "#7f1d1d" : BLOW_COLORS[i % BLOW_COLORS.length] } : undefined}
                    >
                      #{i + 1}
                      {falhou ? " ⚠" : fraca ? " ~" : ""}
                    </button>
                  );
                })}
              </div>
              <label className="flex items-center gap-2 text-xs text-neutral-400">
                <input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} />
                sobrepor todas
              </label>

              {channels.length > 1 && (
                <div className="mt-3 pt-3 border-t border-neutral-800">
                  <p className="text-[10px] uppercase tracking-widest text-neutral-500 font-mono mb-1.5">
                    sensor ({channels.length} canais nesta batida)
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {channels.map((c) => (
                      <button
                        key={c}
                        onClick={() => setChannel(c)}
                        title={c === 0 ? "canal principal" : `canal secundário ${c}`}
                        className={`rounded px-2.5 py-1 text-xs font-mono border transition-colors ${
                          c === channel
                            ? "bg-neutral-100 text-neutral-900 border-transparent"
                            : "border-neutral-700 text-neutral-400 hover:bg-neutral-800"
                        }`}
                      >
                        {c === 0 ? "principal" : `ch${c}`}
                      </button>
                    ))}
                  </div>

                  {/* Correlação com o principal: medido nos arquivos reais,
                      um canal extra pode ser o mesmo golpe (r≈0.99) ou algo
                      sem relação (r≈0 ou negativo, pico em outro instante).
                      Sem este número todo canal parece igualmente confiável. */}
                  {correlacaoCanal !== undefined && (
                    <p className="mt-1.5 text-[10px] leading-snug text-neutral-500">
                      Semelhança com o principal:{" "}
                      <span className="font-mono text-neutral-400">r = {correlacaoCanal.toFixed(2)}</span>
                      {" — "}
                      {Math.abs(correlacaoCanal) >= 0.85
                        ? correlacaoCanal < 0
                          ? "mesmo golpe, sensor montado invertido"
                          : "mesmo golpe, outro sensor"
                        : Math.abs(correlacaoCanal) >= 0.5
                          ? "parecido, mas com diferenças"
                          : "pouca relação com o principal — confira antes de usar no laudo"}
                    </p>
                  )}
                </div>
              )}
            </SidebarSection>
          </>
        )}

        {file && result ? (
          <>
            <SidebarSection title="Parâmetros">
              <div className="grid grid-cols-3 gap-1.5 text-xs">
                {[
                  ["MA", result.params.MA],
                  ["MD", result.params.MD],
                  ["LE", result.params.LE],
                  ["WS", result.params.WS],
                  ["T1", result.params.T1],
                  ["FS", result.params.FS],
                ].map(([k, v]) => (
                  <div key={k} className="bg-neutral-800/60 rounded px-2 py-1.5">
                    <p className="text-[9px] uppercase text-neutral-500 font-mono">{k}</p>
                    <p className="font-mono tabular-nums text-neutral-200">{v}</p>
                  </div>
                ))}
              </div>
            </SidebarSection>

            <SidebarSection title="Calibração">
              <label className="flex flex-col gap-1 text-xs text-neutral-400">
                pico conhecido (cm/s)
                <input
                  type="number"
                  step="0.0001"
                  value={calibrationInput}
                  onChange={(e) => setCalibrationInput(e.target.value)}
                  placeholder="ex: 0.2694"
                  className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 font-mono text-neutral-100 focus:outline-none focus:border-amber-600"
                />
              </label>

              {/* Estimativa pela cadeia física (ADC -> V -> g -> m/s2 -> cm/s).
                  Aplicada só por ação explícita e com a incerteza declarada:
                  o pico calculado fica ~25% abaixo do equipamento real por
                  limitação do filtro, e a sensibilidade do acelerômetro varia
                  por unidade física (o .PTE não registra qual sensor foi
                  usado). Ver reverse-engineering/plano-melhoria.md. */}
              {channel !== 0 && (
                <p className="mt-2 pt-2 border-t border-neutral-800 text-[10px] leading-snug text-neutral-500">
                  A calibração vale só pro sensor principal — não sabemos a
                  sensibilidade do canal secundário, então ele fica em unidade
                  relativa.
                </p>
              )}

              {picoEstimado !== undefined && (
                <div className="mt-2 pt-2 border-t border-neutral-800 space-y-1.5">
                  <p className="text-[11px] text-neutral-400">
                    Estimativa física:{" "}
                    <span className="font-mono text-neutral-200">{picoEstimado.toFixed(4)} cm/s</span>
                  </p>
                  <p className="text-[10px] leading-snug text-neutral-600">
                    ±{CALIBRACAO_INCERTEZA_PCT}% — assume acelerômetro de {ACC_G_PER_VOLT_PADRAO} g/V.
                    Prefira o pico real do equipamento quando tiver.
                  </p>
                  <button
                    onClick={() => setCalibrationInput(picoEstimado.toFixed(4))}
                    className="w-full rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800"
                  >
                    usar estimativa
                  </button>
                </div>
              )}
            </SidebarSection>

            <SidebarSection title="Comparação">
              <div className="space-y-2">
                {!compareFile ? (
                  <button
                    onClick={handleOpenCompareClick}
                    className="w-full flex items-center gap-2 rounded border border-dashed border-neutral-700 px-3 py-2 text-xs text-neutral-400 hover:bg-neutral-800"
                  >
                    <GitCompare size={14} /> comparar com outra estaca
                  </button>
                ) : (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-neutral-400 truncate" title={comparePileName ?? compareFile.name}>
                        {comparePileName ?? compareFile.name}
                      </span>
                      <button onClick={() => setCompareFile(null)} className="text-neutral-500 hover:text-neutral-200">
                        <X size={14} />
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {/* mesma marcação de golpe fraco do ensaio principal:
                          comparar contra uma batida de teste do operador
                          mostraria uma curva baixa que se lê como defeito na
                          outra estaca. */}
                      {Array.from({ length: compareNBlows }, (_, i) => {
                        const fraca = compareBatidasFracas[i];
                        return (
                          <button
                            key={i}
                            onClick={() => setCompareBlowIndex(i)}
                            title={fraca ? "golpe fraco — provavelmente batida de teste do operador" : undefined}
                            className={`rounded px-2 py-0.5 text-xs font-mono border ${
                              i === compareBlowIndex
                                ? "text-white border-transparent"
                                : fraca
                                  ? "border-amber-900/70 text-amber-500/70 hover:bg-neutral-800"
                                  : "border-neutral-700 text-neutral-400 hover:bg-neutral-800"
                            }`}
                            style={i === compareBlowIndex ? { background: COMPARE_COLOR } : undefined}
                          >
                            #{i + 1}
                            {fraca ? " ~" : ""}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {!siteRef ? (
                  <button
                    onClick={handleSaveReference}
                    className="w-full flex items-center gap-2 rounded border border-dashed border-neutral-700 px-3 py-2 text-xs text-neutral-400 hover:bg-neutral-800"
                  >
                    <Bookmark size={14} /> salvar como referência do site
                  </button>
                ) : (
                  <div className="flex items-center justify-between rounded border border-neutral-800 px-3 py-2">
                    <label className="flex items-center gap-2 text-xs text-neutral-400 truncate">
                      <input type="checkbox" checked={showRef} onChange={(e) => setShowRef(e.target.checked)} />
                      <span className="truncate" title={siteRef.label}>ref: {siteRef.label}</span>
                    </label>
                    <button onClick={handleClearReference} className="text-neutral-500 hover:text-neutral-200 shrink-0 ml-2">
                      <BookmarkX size={14} />
                    </button>
                  </div>
                )}
              </div>
            </SidebarSection>

            <div className="px-4 py-3 space-y-2 mt-auto">
              <button
                onClick={handleExportCsv}
                disabled={exporting !== null}
                className="w-full flex items-center justify-center gap-2 rounded border border-neutral-700 px-3 py-2 text-xs font-medium text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
              >
                <Download size={14} />{" "}
                {exporting === "csv"
                  ? "Exportando…"
                  : viewMode === "espectro"
                    ? "Exportar CSV (espectro)"
                    : "Exportar CSV (onda)"}
              </button>
              <button
                onClick={handleExportPdf}
                disabled={exporting !== null || !window.pit}
                title={!window.pit ? "Disponível só no app desktop" : undefined}
                className="w-full flex items-center justify-center gap-2 rounded border border-neutral-700 px-3 py-2 text-xs font-medium text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
              >
                <FileText size={14} /> {exporting === "pdf" ? "Exportando…" : "Exportar laudo PDF"}
              </button>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center px-6 text-center">
            <p className="text-xs text-neutral-600">Abra um ensaio pra ver os controles aqui.</p>
          </div>
        )}
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0">
        <header className="flex items-center justify-between px-5 py-3 border-b border-neutral-800 shrink-0 print:hidden">
          <div className="flex items-center gap-2 min-w-0">
            {file ? (
              <>
                <CheckCircle2 size={15} className="text-emerald-500 shrink-0" />
                <span className="text-sm font-mono truncate">{file.name}</span>
              </>
            ) : (
              <span className="text-sm text-neutral-500">Nenhum ensaio aberto</span>
            )}
          </div>
          <button
            onClick={handleOpenClick}
            className="flex items-center gap-2 rounded bg-amber-600 hover:bg-amber-500 px-3.5 py-1.5 text-sm font-medium text-white transition-colors"
          >
            <FolderOpen size={15} /> Abrir arquivo .PTE
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {autoNotice && (
            <div className="flex items-start gap-2 rounded border border-amber-800 bg-amber-950/40 px-3 py-2.5 text-sm text-amber-300">
              <Radio size={16} className="shrink-0 mt-0.5" />
              {autoNotice}
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded border border-red-900 bg-red-950/50 px-3 py-2.5 text-sm text-red-300">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              {error}
            </div>
          )}

          {exportedPath && (
            <div className="flex items-start gap-2 rounded border border-emerald-900 bg-emerald-950/50 px-3 py-2.5 text-sm text-emerald-300">
              <CheckCircle2 size={16} className="shrink-0 mt-0.5" />
              Salvo em: {exportedPath}
            </div>
          )}

          {!file && (
            <div
              className="h-full min-h-[420px] flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-neutral-800 text-neutral-600"
            >
              <AudioWaveform size={40} strokeWidth={1.2} />
              <p className="text-sm">Abra um arquivo .PTE ou arraste aqui</p>
              {recents.length > 0 && (
                <div className="mt-4 text-left">
                  <p className="text-[10px] uppercase tracking-widest text-neutral-700 font-mono mb-2 flex items-center gap-1.5">
                    <Clock size={11} /> recentes
                  </p>
                  <ul className="space-y-1">
                    {recents.map((r) => (
                      <li key={r.filePath}>
                        <button onClick={() => handleOpenRecent(r)} className="text-sm font-mono text-amber-500 hover:underline">
                          {r.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* batida selecionada falhou, mas o arquivo tem outras boas — sem
              isso a área do gráfico ficava em branco sem dizer qual batida
              é o problema nem que dá pra escolher outra. */}
          {file && !result && (
            <div className="h-full min-h-[420px] flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-neutral-800 text-neutral-500">
              <AlertTriangle size={36} strokeWidth={1.2} className="text-amber-600" />
              <p className="text-sm">
                A batida #{blowIndex + 1}
                {channel > 0 ? ` (canal ${channel})` : ""} não pôde ser processada.
              </p>
              {nBlows > 1 && <p className="text-xs text-neutral-600">Escolha outra batida na barra lateral.</p>}
            </div>
          )}

          {/* Cabeçalho que só aparece no PDF. A barra lateral e o cabeçalho
              da tela ficam ocultos na impressão, então sem este bloco o
              laudo saía com APENAS o gráfico: sem nome da estaca, sem
              operador, sem data, sem parâmetros e sem dizer qual batida —
              inútil como documento pra cliente. */}
          {file && result && (
            <div className="hidden print:block mb-4">
              <div className="flex items-baseline justify-between border-b border-neutral-400 pb-2 mb-3">
                <h1 className="text-lg font-semibold">Ensaio de Integridade de Estaca (PIT)</h1>
                <span className="text-xs">Fpit — Visualizador PIT</span>
              </div>
              <div className="grid grid-cols-3 gap-x-6 gap-y-1 text-xs">
                <p><strong>Estaca:</strong> {pileName ?? file.name}</p>
                <p><strong>Arquivo:</strong> {file.name}</p>
                <p><strong>Emitido em:</strong> {new Date().toLocaleString("pt-BR")}</p>
                <p><strong>Operador/data do ensaio:</strong> {operator ?? "não informado"}</p>
                <p><strong>Cliente:</strong> {company ?? "não informado"}</p>
                <p>
                  <strong>Batida:</strong> #{blowIndex + 1} de {nBlows}
                  {channel > 0 ? ` · sensor ch${channel}` : ""}
                  {channel > 0 && correlacaoCanal !== undefined
                    ? ` (r=${correlacaoCanal.toFixed(2)} vs principal)`
                    : ""}
                  {batidasFracas[blowIndex] ? " · GOLPE FRACO (batida de teste)" : ""}
                </p>
                <p><strong>WS:</strong> {result.params.WS} m/s</p>
                <p><strong>LE:</strong> {result.params.LE} m</p>
                <p><strong>MD:</strong> {result.params.MD} m</p>
                <p><strong>MA:</strong> {result.params.MA}</p>
                <p><strong>T1:</strong> {result.params.T1} amostras</p>
                <p><strong>FS:</strong> {result.params.FS} Hz</p>
                {/* O laudo precisa dizer QUAL gráfico está impresso: a linha
                    de escala vertical descreve velocidade e não faz sentido
                    quando o que está na página é o espectro. */}
                <p className="col-span-3">
                  <strong>Gráfico:</strong>{" "}
                  {viewMode === "onda"
                    ? "onda de velocidade × distância na estaca"
                    : "espectro de frequência (FFT) do sinal de velocidade"}
                </p>
                {/* O laudo precisa identificar TODAS as curvas impressas. Com
                    sobreposição, comparação ou referência ligadas, a página
                    mostra várias curvas enquanto o cabeçalho nomeia uma única
                    batida — quem recebe o documento não teria como saber o
                    que são as outras linhas. */}
                {viewMode === "onda" && (overlay || (compareResult && channel === 0) || (showRef && siteRef && channel === 0)) && (
                  <p className="col-span-3">
                    <strong>Curvas no gráfico:</strong>{" "}
                    {[
                      overlay
                        ? channel === 0
                          ? `todas as ${nBlows} batidas deste ensaio (destaque na #${blowIndex + 1})`
                          : `batidas com sensor ch${channel} (destaque na #${blowIndex + 1})`
                        : `batida #${blowIndex + 1}`,
                      compareResult && channel === 0
                        ? `comparação em cinza: ${comparePileName ?? compareFile?.name} #${compareBlowIndex + 1}` +
                          (comparacaoComprimentoDiferente
                            ? ` (estaca de ${compareResult.params.LE}m — comprimento diferente desta, o eco de ponta dela não coincide com o Toe)`
                            : "")
                        : null,
                      showRef && siteRef && channel === 0
                        ? `referência em azul: ${siteRef.label}` +
                          (refComprimentoDiferente
                            ? ` (estaca de ${siteRef.le}m — comprimento diferente desta, o eco de ponta dela não coincide com o Toe)`
                            : "")
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
                {viewMode === "onda" && (
                  <p className="col-span-3">
                    <strong>Escala vertical:</strong>{" "}
                    {/* sai da escala REALMENTE aplicada, não do campo digitado —
                        ver csvForPoints */}
                    {result.escala !== 1
                      ? `calibrada por pico conhecido = ${peakCalibration} cm/s`
                      : channel !== 0
                        ? "unidade relativa — calibração não se aplica a sensor secundário"
                        : "unidade relativa (não calibrada em cm/s)"}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* aviso na área principal: sem isso, a batida fraca só se
              distingue por um "~" pequeno na barra lateral, e o traço de
              baixa amplitude passa fácil por estaca defeituosa. */}
          {file && result && batidasFracas[blowIndex] && (
            <div className="flex items-start gap-2 rounded border border-amber-900 bg-amber-950/30 px-3 py-2.5 text-sm text-amber-300/90">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span>
                Batida #{blowIndex + 1} é bem mais fraca que as outras deste ensaio — provavelmente
                golpe de teste do operador. A amplitude baixa aqui não indica defeito na estaca;
                prefira uma das batidas fortes pro laudo.
              </span>
            </div>
          )}

          {file && result && (
            <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-[11px] uppercase tracking-widest text-neutral-500 font-mono">
                  {viewMode === "onda"
                    ? `Velocidade (${result.escala !== 1 ? "cm/s calibrado" : "unidade relativa"}) × distância (m)`
                    : "Espectro de frequência (FFT)"}
                  {viewMode === "onda" && overlay &&
                    (channel === 0
                      ? " · todas as batidas"
                      : ` · batidas com sensor ch${channel} (${series.filter((s) => s.points.length).length})`)}
                  {viewMode === "onda" && compareResult && channel === 0 && " · cinza = comparação"}
                  {viewMode === "onda" && compareResult && channel === 0 && comparacaoComprimentoDiferente &&
                    ` (ATENÇÃO: a comparação é de estaca de ${compareResult.params.LE}m, esta tem ${result.params.LE}m — o eco de ponta dela não corresponde ao Toe deste gráfico)`}
                  {viewMode === "onda" && showRef && siteRef && channel === 0 && " · azul = referência"}
                  {viewMode === "onda" && showRef && siteRef && channel === 0 && refComprimentoDiferente &&
                    ` (ATENÇÃO: referência é de estaca de ${siteRef.le}m, esta tem ${result.params.LE}m — o eco de ponta dela não corresponde ao Toe deste gráfico)`}
                  {viewMode === "onda" && sobreposicaoExternaOculta &&
                    " · comparação/referência ocultas (escala do sensor principal não é comparável com a deste canal)"}
                </p>
                <div className="flex gap-1 print:hidden">
                  <button
                    onClick={() => setViewMode("onda")}
                    className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-mono border ${
                      viewMode === "onda" ? "bg-neutral-100 text-neutral-900 border-transparent" : "border-neutral-700 text-neutral-400 hover:bg-neutral-800"
                    }`}
                  >
                    <AudioWaveform size={13} /> onda
                  </button>
                  <button
                    onClick={() => setViewMode("espectro")}
                    className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-mono border ${
                      viewMode === "espectro" ? "bg-neutral-100 text-neutral-900 border-transparent" : "border-neutral-700 text-neutral-400 hover:bg-neutral-800"
                    }`}
                  >
                    <Activity size={13} /> espectro
                  </button>
                </div>
              </div>
              {viewMode === "onda" ? (
                <WaveformChart series={series} le={result.params.LE} />
              ) : (
                <SpectrumChart spectrum={spectrum} maxFreq={Math.min(result.params.FS / 2, 5000)} />
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
