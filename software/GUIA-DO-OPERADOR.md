# Fpit — Guia do operador

Como usar o visualizador e, principalmente, **o que ele não garante**. Leia a
seção de limitações antes de usar qualquer número deste app num laudo.

---

## Abrir um ensaio

Três formas:

1. **Abrir arquivo .PTE** — botão laranja no topo.
2. **Arrastar** o arquivo pra janela.
3. **Captura automática** — escolha a pasta onde o PIT-Q salva os ensaios e
   clique em "Iniciar captura automática". Cada arquivo novo abre sozinho, já
   na última batida.

Se o arquivo não for um ensaio válido (ou estiver truncado/corrompido), o app
**recusa e explica** em vez de mostrar tela vazia. O ensaio que já estava
aberto continua aberto.

## Testar sem o equipamento

Botão **"⚡ simular batida"**: gera um ensaio sintético com forma realista
(pulso de entrada perto do topo e eco de ponta perto do comprimento da
estaca). Serve pra conferir que o app está funcionando. **Não é medição** —
não use num laudo.

## O gráfico

- **Eixo X** — distância ao longo da estaca, em metros. Convertido do tempo
  usando a velocidade de onda (WS) do cabeçalho: `x = t × WS / 2`.
- **Eixo Y** — velocidade. Veja "unidade relativa" abaixo.
- **Linha tracejada "Toe (LE)"** — comprimento da estaca declarado no ensaio.
- **espectro** — conteúdo de frequência do sinal, com o pico dominante
  marcado.

## Batidas

O equipamento grava várias batidas por ensaio. Os botões `#1 #2 #3…`
selecionam qual mostrar; **sobrepor todas** desenha as batidas juntas.

- **`~` em âmbar** — golpe bem mais fraco que os outros do mesmo ensaio,
  provavelmente **batida de teste do operador**. A amplitude baixa nesses
  casos **não indica defeito na estaca**. Prefira uma batida forte pro laudo.
- **`⚠` em vermelho** — batida que não pôde ser processada.

## Sensores (canais)

Quando o ensaio tem mais de um sensor, aparece o seletor **principal / ch1 /
ch2…** com um indicador de **semelhança (r)** com o sensor principal:

| |r| | leitura |
|---|---|
| ≥ 0.85 | mesmo golpe, outro sensor |
| 0.5 – 0.85 | parecido, mas com diferenças |
| < 0.5 | **pouca relação — confira antes de usar no laudo** |

O que conta é o **tamanho** de `r`, não o sinal: um `r` bem negativo (ex:
−0,92) é o mesmo golpe com o **sensor montado invertido** — o app avisa isso
explicitamente. Já um `r` perto de zero significa que aquele canal não está
registrando o mesmo impacto.

Isso importa: nem todo canal gravado é o mesmo golpe. Nos arquivos analisados
há canais com `r` próximo de zero, ou seja, registrando outra coisa.

Ao ver um canal secundário, o app **não** mostra comparação com outra estaca
nem a referência do site, e **não** aplica calibração. Não é limitação
arbitrária — a escala de um sensor secundário não é comparável com a do
principal (medimos razões de 0,1× a 25000× conforme o ensaio), e juntar os
dois no mesmo eixo produziria leitura enganosa.

## Comparação e referência

- **Comparar com outra estaca** — desenha outro ensaio em cinza por cima.
- **Salvar como referência do site** — guarda a curva atual como padrão da
  obra, pra confrontar com as próximas estacas (em azul).

**Cuidado com comprimentos diferentes.** A curva sobreposta é desenhada no
eixo X **desta** estaca. Se a outra estaca tiver comprimento diferente, o eco
de ponta dela cai numa posição que, neste gráfico, significa outra coisa — e
pode passar por reflexão no meio do fuste, ou seja, por defeito. O app avisa
quando a diferença passa de 5%, no gráfico e no laudo. As duas curvas seguem
na mesma escala vertical, então a comparação de amplitude continua válida; o
que não se transfere é a **posição** ao longo da estaca.

## Exportar

- **CSV** — os pontos do gráfico. O nome do arquivo já leva estaca, batida e
  canal, pra não sobrescrever.
- **Laudo PDF** — gráfico mais um cabeçalho com estaca, arquivo, data de
  emissão, operador, cliente, qual batida de quantas, todos os parâmetros
  (WS/LE/MD/MA/T1/FS) e a informação de escala.

---

## Limitações — leia antes de usar num laudo

### "Unidade relativa" quer dizer que o eixo Y não está em cm/s

Por padrão o gráfico está em **unidade relativa**: a **forma** da onda e as
**posições** em metros são confiáveis, a **amplitude absoluta** não. Serve pra
avaliar integridade (pulso, reflexões, eco de ponta), que é o objetivo do
ensaio. Não use o valor do eixo Y como velocidade medida.

Duas formas de obter cm/s:

1. **Pico conhecido** (preciso) — digite o valor de pico que o equipamento
   oficial mostrou **pra a batida que está na tela**. O app escala o gráfico
   por ele.

   Dois detalhes que importam:

   - As **outras batidas do mesmo ensaio** entram na **mesma escala**, não são
     calibradas cada uma pelo próprio pico. É de propósito: se cada batida
     fosse normalizada individualmente, todas terminariam com o mesmo pico e a
     diferença real de energia entre elas sumiria — um golpe de teste do
     operador passaria a parecer um golpe bom.
   - O campo **se limpa ao abrir outro ensaio**. O pico conhecido é evidência
     de uma estaca e uma batida específicas; mantê-lo faria a estaca nova ser
     normalizada pelo pico da anterior e sair rotulada como calibrada. Isso
     vale principalmente na captura automática, que carrega um ensaio atrás do
     outro.

2. **Estimativa física** (aproximada, **±25%**) — botão "usar estimativa".
   Calculada pela cadeia ADC → volts → g → m/s² → cm/s. Duas ressalvas:
   assume acelerômetro de **9,5 g/V** (cada unidade tem o seu, gravado no
   certificado dela, e o arquivo `.PTE` não registra qual sensor foi usado), e
   o pico calculado fica sistematicamente ~25% abaixo do equipamento real por
   limitação do filtro. **Prefira sempre o pico conhecido quando tiver.**

### Este app não substitui o software oficial

O formato `.PTE` foi decifrado por engenharia reversa, sem documentação do
fabricante. O parser e o pipeline foram validados contra a tela real do
equipamento e contra 17 arquivos de duas obras, mas **não há garantia do
fabricante**. Para laudo formal, confira contra o software oficial.

### O que não está implementado

- Os filtros **LO/HI/PV** do equipamento não são aplicados nem exibidos (não
  foi possível identificar quais campos do arquivo os representam).
- **Captura ao vivo pelo cabo USB não funciona.** O sensor só transmite depois
  de um comando do software oficial que não conseguimos reproduzir. Use a
  captura automática por pasta, que lê o arquivo depois que o PIT-Q salva.

### Se aparecer uma tela de erro

O app mostra o erro em vez de fechar ou ficar em branco. Use **"Tentar
novamente"** ou **"Recarregar o programa"**; **"Copiar detalhes"** põe a
informação técnica na área de transferência pra você repassar.

Seus arquivos de ensaio **nunca são alterados** — o app só lê `.PTE`. As
únicas escritas em disco são o CSV e o PDF que você mandar salvar.
