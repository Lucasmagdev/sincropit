# Fpit — Visualizador PIT

App desktop (Electron + React + TypeScript + Tailwind) pra abrir e visualizar
arquivos `.PTE` do equipamento Pile Dynamics PIT-QV/QFV. Parser e pipeline de
sinal validados contra a tela real do equipamento — ver
`../reverse-engineering/formato-pte.md` e `plano-melhoria.md`.

**Quem vai usar o app** (e não mexer no código) deve ler o
[Guia do operador](GUIA-DO-OPERADOR.md) — ele explica o que o gráfico mostra e,
principalmente, o que o app **não** garante.

## Rodar em desenvolvimento

```
npm install
npm run dev
```

## Testes — rodar sempre que mexer no parser ou no sinal

```
npm test
```

Quatro suítes, todas contra o código real do app:

| suíte | o que cobre |
|---|---|
| `test/regression.mjs` | 17 arquivos `.PTE` reais de 2 obras (37 golpes): parse, parâmetros, canais, calibração, batidas fracas, correlação entre canais |
| `test/robustness.mjs` | 98 entradas degeneradas (lixo, truncado, corrompido) com PRNG semeado |
| `test/fft.mjs` | correção da FFT contra sinais de frequência conhecida + casos degenerados |
| `test/simular.mjs` | 40 rodadas do gerador do botão "simular batida", exigindo traço fisicamente realista |

Os arquivos `.PTE` ficam fora do git (dado de cliente); numa máquina sem eles
a suíte pula o que não encontrar.

## Empacotar (.exe portátil)

```
npm run dist
```

Gera `release/Fpit Visualizador PIT <versão>.exe` — roda direto, sem instalador.

## Estrutura

- `electron/main.ts` — processo main: diálogos nativos, exportação de PDF via
  `webContents.printToPDF`, observação de pasta (file watcher).
- `electron/fakePte.ts` — gerador do `.PTE` sintético do botão "simular
  batida". Fica separado do `main.ts` **de propósito**: sem importar electron,
  dá pra cobrir por teste.
- `src/lib/pte.ts` — núcleo: parser do formato `.PTE` + pipeline de sinal
  (filtro Butterworth, integração, amplificação exponencial), detecção de
  canais, batidas fracas e estimativa de calibração. Opera sobre
  `ArrayBuffer`, sem depender de `fs`.
- `src/lib/fft.ts` — FFT radix-2 pro espectro.
- `src/components/` — gráficos em canvas (`useCanvasSize` cuida de nitidez e
  redimensionamento) e `ErrorBoundary`.
- `src/App.tsx` — UI.

## Pendências conhecidas

- **Calibração absoluta** — a cadeia física está estruturalmente validada
  (ADC → V → g → m/s² → cm/s, com pré-escala de 1e5 do firmware), mas o pico
  calculado fica ~25% abaixo do equipamento real. A causa é a fidelidade do
  filtro, **não** a calibração: o vale bate dentro de 7% sem parâmetro livre.
  Ver `plano-melhoria.md`. Baixar o cutoff do filtro melhora a amplitude mas
  **arruína o eco de ponta** — não faça isso, o motivo está documentado lá.
- **Campos LO/HI/PV** não mapeados — bloqueado por falta de dado: em todos os
  arquivos disponíveis esses campos são zero.
- **Campos 0505/0506** não identificados. As duas hipóteses óbvias (saturação
  e fator de ganho por batida) foram testadas e **refutadas** — ver
  `formato-pte.md` antes de tentar de novo.
- **Captura USB ao vivo** não funciona: o sensor só transmite depois de um
  comando do software oficial, cujo protocolo não foi decifrado. O caminho
  real hoje é o file watcher importando o `.PTE` salvo pelo PIT-Q.
- **Caminhos IPC do Electron** (botão simular, diálogos, watcher, PDF) não
  têm teste automatizado end-to-end — a lógica interna é testada, mas a
  integração só é confirmada abrindo o app.
