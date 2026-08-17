# Fpit — Preferências de Trabalho

## Ambiente

- **Sempre rodar app Electron (desktop)** — não usar dev server web
- Executável: `c:\Users\Lucas\Desktop\Fpit\software\release\Fpit Visualizador PIT 0.0.0.exe`
- Build com: `npm run dist` (gera release/)

## Documentação

- `software/README.md` — desenvolvedor: estrutura, testes, pendências.
- `software/GUIA-DO-OPERADOR.md` — **quem usa o app em campo**. Explica o que
  o gráfico mostra e, principalmente, as ressalvas que afetam laudo (unidade
  relativa vs cm/s, batidas fracas, correlação entre canais, o que não está
  implementado). Se mudar comportamento visível ao usuário, atualize lá.

## Testes — rodar SEMPRE depois de mexer no parser ou no sinal

```
cd software && npm test
```

Cobre **17 arquivos `.PTE` reais de duas obras diferentes** (B135/B136 com
FS=50kHz e 1024 amostras/bloco; PF e ENCONTRO com FS=129-141kHz, 2048
amostras/bloco e vários canais simultâneos) — 37 golpes no total. Os
arquivos ficam fora do git (dado de cliente), então numa máquina sem eles a
suíte simplesmente pula o que não achar.

Duas suítes:

- `test/regression.mjs` — parser/pipeline real (`src/lib/pte.ts`) contra os 7
  `.PTE` reais em `samples/`: parse, contagem de batidas, extração de
  WS/LE/MD/MA/FS/T1, canais secundários, calibração por pico, ausência de
  NaN/Infinity no gráfico e na FFT.
- `test/robustness.mjs` — 98 entradas degeneradas (lixo, truncado,
  corrompido) com **PRNG semeado** (determinístico e reproduzível de
  propósito: a versão sem semente falhava ~1 em 20 rodadas e era impossível
  de depurar). Garante que nada trava, nada demora, e que lixo resulta em
  `countBlows() < 1` — é assim que o `App.tsx` decide recusar o arquivo.

Rede de segurança do núcleo — qualquer mudança em `pte.ts` precisa passar.

## Simular Batida (recomendado pra testar sem hardware)

Botão **"⚡ simular batida"** na sidebar do app — gera um `.PTE` sintético válido
em memória e mostra o gráfico na hora. Não precisa de pasta configurada nem de
Python. Este é o caminho preferido pra testar o app sem o PIT-Q físico.

O gerador fica em **`electron/fakePte.ts`** (módulo separado, sem importar
electron — antes morava no `main.ts` e por isso nenhum teste conseguia
importá-lo). Coberto por `test/simular.mjs`, que roda 40 vezes e exige que o
traço seja **fisicamente realista**, não só parseável: 0.04 m por amostra
(igual aos arquivos reais), pico de entrada entre 0.3-1.6 m, e eco de ponta
presente mas MENOR que o pulso de entrada. Uma versão anterior gerava um
arquivo que abria normalmente mas cujo traço não parecia ensaio nenhum (o
pulso se espalhava por mais de 20 m) — o que anulava a utilidade do botão.

## Python Scripts (captura real via hardware)

- **`software/pte_writer.py`** — escritor TLV compartilhado (formato real, ver
  `reverse-engineering/formato-pte.md`). Usado por `capture-pit.py`.
- **Captura ao vivo**: `c:\Users\Lucas\Desktop\Fpit\software\capture-pit.py`
  - Requer: `pip install pyserial`
  - Uso: `python capture-pit.py [port_index]`
  - Converte bytes brutos do USB (int32, ver `protocolo-live.md`) em `.PTE` TLV real.
- **`simulate-capture.py`**: DEPRECATED — usa o botão do app em vez disso
  (formato que este script escreve não é TLV válido, não abre no Fpit).
- **`test_pte_writer.py`**: teste de regressão do `pte_writer.py` — roda
  `python test_pte_writer.py` pra confirmar que o escritor ainda produz
  arquivo válido depois de qualquer mudança.

## Limite de erro (ErrorBoundary)

`src/components/ErrorBoundary.tsx` envolve o app inteiro no `main.tsx`. Sem
ele, qualquer exceção durante o render desmonta a árvore do React e sobra
**tela branca sem explicação** — pior num app empacotado, onde o usuário não
tem devtools, e ainda pior no PIT-Q em obra. A tela de erro mostra o detalhe
técnico (copiável) e oferece "tentar novamente" / "recarregar". Verificado em
execução injetando falha real no `getContext` do canvas.

## Regra da escala — comparação entre estacas usa UMA escala só

`peakCalibration` normaliza o pico **da batida processada**. Se a estaca de
comparação for calibrada por conta própria, as duas curvas terminam com pico
idêntico e o gráfico passa a sugerir que as estacas respondem igual —
exatamente o que a comparação deveria revelar ou descartar. Medido: com
calibração separada a diferença de pico entre duas estacas vira **0,0%**;
com escala compartilhada, aparece a diferença real de **11,2%**.

Por isso `BlowResult.escala` expõe o fator aplicado, e a comparação chama
`processBlow(..., { escala: result.escala })` em vez de repassar
`peakCalibration`. Travado por teste.

A **referência do site** tem o mesmo problema por outro caminho: os pontos são
gravados no localStorage **já escalados**. Se a calibração mudar depois de
salvar, referência e vista atual ficam em escalas diferentes (uma referência
em unidade relativa contra uma vista calibrada difere por ~12 ordens de
grandeza e some do gráfico). Por isso `SiteReference.escala` guarda a escala
usada, e o desenho reajusta por `escalaAtual / escalaRef`. O campo é opcional
só por compatibilidade com referências salvas antes desta correção.

## Regra dos canais — nunca misturar sensores no mesmo eixo

Os canais extras são sensores adicionais gravando o mesmo golpe, mas **a
amplitude deles em relação ao principal NÃO é previsível** — depende do
arranjo de sensores daquele ensaio. Medido nos 17 arquivos:

| obra | canais extras | razão principal/secundário |
|---|---|---|
| B135/B136 | 4 | **1620x a 25623x** |
| PF/ENCONTRO | 28 | **0.1x a 5.4x** |

> Correção de uma afirmação anterior: uma versão deste documento dizia que o
> canal secundário é "~5000x menor". Isso vale só para os arquivos B135 — nos
> PF/ENCONTRO os canais têm a mesma ordem de grandeza. Não trate como regra.

Justamente por ser imprevisível é que não se pode juntar canais num eixo Y
compartilhado: quando a razão é grande (caso B135), a curva menor vira **uma
linha reta no zero**, o que se lê como "esse sensor não registrou nada" — falso
e capaz de levar a conclusão errada.

A correlação com o principal também varia bastante (0.99 em alguns canais,
mas −0.05 a −0.48 em outros, com o pico em índice de amostra diferente). Ou
seja, nem todo canal extra é o mesmo evento visto de outro ponto — alguns
podem ser outra coisa. Mais um motivo pra não assumir comparabilidade.

Por isso o app **mostra a correlação** (`correlacaoComPrincipal` em `pte.ts`)
ao lado do seletor de canal e no laudo, com leitura em texto: r≥0.85 = "mesmo
golpe, outro sensor"; 0.5–0.85 = "parecido, mas com diferenças"; abaixo disso
= "pouca relação — confira antes de usar no laudo". Sem esse número todo canal
ocupado parece igualmente confiável. Os valores estão travados por teste
contra medição independente.

Por isso, quando um canal secundário está selecionado:

- a sobreposição inclui **só** as batidas que têm aquele mesmo canal;
- comparação com outra estaca e referência do site **não** entram no gráfico
  (o rótulo avisa que foram ocultadas, em vez de sumirem em silêncio);
- salvar referência do site é bloqueado com explicação;
- **nenhuma calibração é aplicada** — nem a manual (o pico conhecido vem da
  tela do equipamento, que mostra o sensor principal) nem a estimativa física
  (usa 9.5 g/V, sensibilidade do acelerômetro principal). Aplicar qualquer uma
  delas a um canal secundário normalizaria aquele sensor para um valor que
  não é dele: número inventado exibido como medição calibrada. O canal
  secundário fica sempre em unidade relativa, e a UI/laudo dizem isso.

Se for mexer na montagem de `series` no `App.tsx`, mantenha essa regra.

## Regra do rótulo — o que a tela afirma tem que ser o que o dado é

Padrão de bug que apareceu **cinco vezes** neste app, sempre pelo mesmo
motivo: um rótulo derivado do que o usuário *digitou* ou *selecionou* em vez
do que foi *realmente aplicado*. Casos já corrigidos:

- CSV com cabeçalho `v_cms` sobre dado em unidade relativa (canal secundário
  não recebe calibração);
- rótulo do eixo Y e linha de escala do laudo lendo o campo digitado;
- botão "Exportar CSV" mandando a onda com o espectro na tela;
- laudo descrevendo escala de velocidade com o espectro impresso;
- laudo nomeando uma batida enquanto a página mostrava várias (sobreposição,
  comparação, referência).

Regra: **rótulo sai da escala/estado efetivamente aplicado** (`result.escala`,
`viewMode`, `channel`), nunca do campo de entrada. Num software de medição,
rótulo que afirma o que o dado não sustenta é pior que ausência de rótulo —
e some em teste de unidade, só aparece cruzando estados da interface.

## Laudo PDF — o que o `print:` controla

O PDF sai da própria tela via `printToPDF`, então tudo que é controle de UI
leva `print:hidden` (barra lateral, cabeçalho, botões onda/espectro) e existe
um bloco `hidden print:block` no `App.tsx` com a identificação do ensaio.
**Esse bloco não é enfeite**: sem ele o laudo saía com APENAS o gráfico —
sem estaca, operador, cliente, data, parâmetros nem qual batida. Documento
assim é inútil pro cliente. Se mexer no layout de impressão, confira que
esses campos continuam saindo.

Os gráficos usam `print:h-[...]` fixo (não `vh`) porque em contexto de
impressão a altura de viewport não corresponde à página.

## Rodar no PIT-Q (painel industrial, tela pequena)

A janela e os gráficos se adaptam à tela — importante porque o alvo é o
próprio PIT-Q, cujo painel costuma ser 800x600 ou 1024x768:

- `createWindow` dimensiona pela área útil real do monitor. Antes era fixo
  (1360x880, mínimo 960x640) e num monitor de 600px de altura a janela **não
  podia ser encolhida pra caber** — os botões de exportar, no fim da barra
  lateral, ficavam fora da tela e inalcançáveis.
- Os gráficos usam `useCanvasSize` (ResizeObserver + devicePixelRatio) em vez
  de tamanho fixo com escala por CSS. Escalar canvas por CSS **borra o
  traço** — num instrumento de medição, ler a forma da onda com nitidez
  importa. Também evita o gráfico virar uma faixa minúscula em tela pequena.

## Batidas fracas (golpe de teste do operador) — por que o app marca

O operador costuma dar um ou dois golpes de teste antes do golpe bom, e todos
ficam gravados no mesmo `.PTE`. O traço de um golpe fraco tem amplitude baixa
e **pode ser confundido com estaca defeituosa** — daí o app marcar com `~` na
barra lateral e mostrar aviso.

Critério (`marcarBatidasFracas` em `pte.ts`): pico abaixo de **25% do golpe
mais forte do mesmo arquivo**. Compara com o MÁXIMO, não com a mediana —
existe arquivo onde os golpes de teste são maioria (`B135-R1`) e a mediana é
puxada por eles, fazendo o critério falhar. Nos dados reais as fracas ficam em
3-6% do máximo e a legítima mais fraca em 30%, então o limiar cai numa faixa
vazia larga. Travado por teste, incluindo o caso da mediana que falhou.

## Achado importante — NaN em arquivo corrompido nasce da ARITMÉTICA

Não é intuitivo: um `.PTE` com poucos bytes corrompidos gerava milhares de
pontos `NaN` no gráfico **mesmo com quase nenhum NaN nas amostras lidas**. A
causa é que bytes corrompidos viram doubles absurdos (~1e308, perto do limite
do tipo); o filtro e a integração somam esses valores, estouram pro
`Infinity`, e `Infinity - Infinity` = `NaN`. Ou seja, limpar só os NaN lidos
do arquivo NÃO resolve — precisa descartar também as amostras de magnitude
fisicamente impossível (`MAX_PLAUSIBLE_SAMPLE = 1e15` em `pte.ts`; leitura
real desse equipamento não passa de ~5e10). Amostras inválidas são
substituídas por interpolação linear entre as vizinhas boas — zerar criaria
um degrau artificial que o passa-alta viraria um pico falso.

## Achado importante — regra de ouro do formato TLV

**Nenhuma amostra pode ter os 32 bits baixos da mantissa (IEEE754) zerados.**
Isso inclui não só `0.0` exato, mas QUALQUER valor "redondo" — um inteiro puro
(ex: contagem crua de ADC de uma captura real) sempre tem essa região zerada,
não é caso raro. O parser TLV trata um par de bytes zerado como um registro
válido de tamanho zero, corrompendo o header inteiro. Fix: jitter
multiplicativo minúsculo (`v * (1 ± 1e-6)`) em toda amostra antes de gravar —
implementado tanto em `pte_writer.py` (`_perturb`) quanto em `main.ts`
(`perturb`). Se mexer em qualquer gerador de `.PTE` novo, replica essa regra.

## Workflow

1. Abrir Fpit (app desktop, não web) — `software/release/*.exe`
2. Testar sem hardware: botão "⚡ simular batida"
3. Testar com hardware real: `python capture-pit.py`, dar uma batida,
   arquivo salvo em `./capture` — abrir manualmente ou via captura automática
4. "Captura Automática" (pasta + file watcher) é pro fluxo de salvar direto
   do PIT-Q real, não pro simulador

## Problemas Conhecidos

- SerialPort (Node) removido do bundle — falta build tools (Python+VS) pra
  compilar o módulo nativo no `electron-builder`. Aba de captura USB live
  dentro do app (TypeScript) fica desabilitada; o caminho real de captura
  hoje é via `capture-pit.py` (Python, fora do app) + captura automática
  (file watcher) pra importar o resultado.
- **`capture-pit.py` tem limitação de protocolo não resolvida** (ver
  `reverse-engineering/protocolo-live.md`): escuta passiva de porta serial já
  foi tentada antes e falhou — o sensor só transmite depois de um comando
  "iniciar captura" do software oficial (protocolo não decifrado). Script
  precisa rodar JUNTO com o PIT-Q.exe oficial (não no lugar dele), e pode
  falhar por porta ocupada (Windows só libera 1 processo por COM port). Sem
  hardware real pra testar nesta sessão — timeout ajustado pra 180s
  (cobre o atraso de ~130s documentado), mas a captura em si não foi
  validada contra equipamento físico ainda.
