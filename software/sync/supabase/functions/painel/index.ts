// ============================================================================
// Edge Function `painel` — página web para o administrativo baixar ensaios.
//
// Serve o próprio HTML. Não há hospedagem separada: a página sai do mesmo
// domínio da API, o que também evita CORS.
//
// SEM IMPORTS, igual à `ingerir`. A página fala com o PostgREST, o Auth e o
// Storage por `fetch` direto.
//
// O que esta função NÃO faz, de propósito: ela não tem service_role e não
// consulta nada. Ela devolve HTML e nada mais. Todo acesso a dado acontece no
// navegador, com o token do usuário logado, e passa pelas políticas de RLS —
// se alguém abrir a página sem estar autorizado, não vê linha nenhuma.
// ============================================================================

const URL_BASE = Deno.env.get("SUPABASE_URL") ?? "";
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const PAGINA = (base: string, anon: string) => `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ensaios PIT — Geoteste</title>
<style>
  :root {
    --ground:#F2F4F4; --surface:#fff; --surface-2:#E8EDEC;
    --ink:#14201F; --ink-2:#3D4C4B; --ink-3:#6B7A79;
    --line:#D3DAD9; --accent:#0E6F6B; --accent-ink:#0A4F4C; --accent-soft:#DCEAE8;
    --erro:#8A2020; --erro-soft:#F6E0E0;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground:#0E1514; --surface:#16211F; --surface-2:#1D2A28;
      --ink:#E7EDEB; --ink-2:#B2C1BE; --ink-3:#7E8F8C;
      --line:#2A3836; --accent:#4FC3B8; --accent-ink:#8BDCD4; --accent-soft:#14312E;
      --erro:#E88A8A; --erro-soft:#331717;
    }
  }
  *,*::before,*::after { box-sizing:border-box; }
  body {
    margin:0; background:var(--ground); color:var(--ink);
    font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;
  }
  .wrap { max-width:1060px; margin:0 auto; padding:28px 18px 64px; }
  header { display:flex; flex-wrap:wrap; gap:10px 18px; align-items:baseline; margin-bottom:22px; }
  h1 { font-size:21px; margin:0; letter-spacing:-.01em; }
  .sub { color:var(--ink-3); font-size:13px; }
  .espaco { flex:1 1 auto; }

  .cartao {
    background:var(--surface); border:1px solid var(--line); border-radius:4px;
    padding:22px; max-width:420px;
  }
  label { display:block; font-size:12px; text-transform:uppercase; letter-spacing:.08em;
          color:var(--ink-3); margin-bottom:5px; }
  input {
    width:100%; padding:9px 11px; font-size:15px; font-family:inherit;
    border:1px solid var(--line); border-radius:3px;
    background:var(--ground); color:var(--ink); margin-bottom:14px;
  }
  input:focus-visible, button:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
  button {
    font:inherit; font-weight:600; cursor:pointer; border-radius:3px;
    border:1px solid var(--accent); background:var(--accent); color:#fff;
    padding:9px 16px;
  }
  button:disabled { opacity:.5; cursor:default; }
  button.leve { background:transparent; color:var(--accent-ink); border-color:var(--line); font-weight:500; padding:5px 11px; font-size:13px; }

  .barra { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:16px; }
  .barra input, .barra select {
    margin:0; width:auto; min-width:190px; padding:7px 10px; font-size:14px;
    border:1px solid var(--line); border-radius:3px; background:var(--surface); color:var(--ink);
  }

  .rolagem { overflow-x:auto; border:1px solid var(--line); border-radius:4px; background:var(--surface); }
  table { border-collapse:collapse; width:100%; min-width:800px; font-size:14px; }
  th,td { text-align:left; padding:8px 11px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { font-size:11.5px; text-transform:uppercase; letter-spacing:.07em; color:var(--ink-3);
       background:var(--surface-2); position:sticky; top:0; }
  tbody tr:last-child td { border-bottom:none; }
  tbody tr:hover { background:var(--surface-2); }
  td.num { font-variant-numeric:tabular-nums; }
  .vazio { padding:30px; text-align:center; color:var(--ink-3); }

  .aviso { padding:10px 13px; border-radius:3px; margin-bottom:14px; font-size:14px; }
  .aviso.erro { background:var(--erro-soft); color:var(--erro); }
  .aviso.info { background:var(--accent-soft); color:var(--accent-ink); }
  .oculto { display:none !important; }
  footer { margin-top:22px; color:var(--ink-3); font-size:12.5px; }
</style>
</head>
<body>
<div class="wrap">

  <header>
    <div>
      <h1>Ensaios PIT</h1>
      <div class="sub" id="assinatura">Geoteste — arquivos enviados pelo equipamento</div>
    </div>
    <div class="espaco"></div>
    <button class="leve oculto" id="sair">Sair</button>
  </header>

  <div id="avisoLogin" class="aviso erro oculto"></div>

  <!-- Login -->
  <section id="telaLogin" class="cartao">
    <form id="formLogin">
      <label for="email">E-mail</label>
      <input id="email" type="email" autocomplete="username" required>
      <label for="senha">Senha</label>
      <input id="senha" type="password" autocomplete="current-password" required>
      <button id="btEntrar" type="submit">Entrar</button>
    </form>
  </section>

  <!-- Lista -->
  <section id="telaLista" class="oculto">
    <div class="barra">
      <input id="busca" type="search" placeholder="Buscar estaca ou obra">
      <select id="filtroObra"><option value="">Todas as obras</option></select>
      <select id="filtroExt">
        <option value="">Todos os tipos de arquivo</option>
        <option value=".pte">.PTE</option>
        <option value=".ptn">.PTN</option>
        <option value=".pt2">.PT2</option>
      </select>
      <button class="leve" id="btAtualizar" type="button">Atualizar</button>
      <span class="sub" id="contagem"></span>
    </div>

    <div id="avisoLista" class="aviso info oculto"></div>

    <div class="rolagem">
      <table>
        <thead>
          <tr>
            <th>Estaca</th><th>Obra</th><th>Arquivo</th>
            <th>Tipo</th><th>Diâm.</th><th>Compr.</th><th>Arrasam.</th>
            <th>Data do ensaio</th><th>Tamanho</th><th></th>
          </tr>
        </thead>
        <tbody id="linhas"></tbody>
      </table>
      <div class="vazio oculto" id="semNada">Nenhum ensaio encontrado.</div>
    </div>

    <footer>
      Os campos de estaca vêm do que foi digitado no equipamento durante o ensaio.
      Servem como referência, não como medição.
    </footer>
  </section>

</div>

<script>
const BASE = ${JSON.stringify(base)};
const ANON = ${JSON.stringify(anon)};
const CHAVE_SESSAO = "ensaios_pit_sessao";

const $ = (id) => document.getElementById(id);
let sessao = null;
let ensaios = [];

function guardarSessao(s) {
  sessao = s;
  try { localStorage.setItem(CHAVE_SESSAO, JSON.stringify(s)); } catch (e) { /* navegador sem storage */ }
}
function lerSessao() {
  try { return JSON.parse(localStorage.getItem(CHAVE_SESSAO) || "null"); } catch (e) { return null; }
}
function limparSessao() {
  sessao = null;
  try { localStorage.removeItem(CHAVE_SESSAO); } catch (e) { /* idem */ }
}

function mostrarErroLogin(msg) {
  const el = $("avisoLogin");
  el.textContent = msg;
  el.classList.toggle("oculto", !msg);
}

async function entrar(email, senha) {
  const r = await fetch(BASE + "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password: senha }),
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(
      r.status === 400
        ? "E-mail ou senha incorretos."
        : (dados.msg || dados.error_description || "Não consegui entrar. Tente de novo.")
    );
  }
  return dados;
}

function autorizacao() {
  return { apikey: ANON, authorization: "Bearer " + sessao.access_token };
}

async function carregar() {
  $("avisoLista").classList.add("oculto");
  const r = await fetch(
    BASE + "/rest/v1/ensaios_para_diario?select=*&order=recebido_em.desc&limit=2000",
    { headers: autorizacao() }
  );
  if (r.status === 401) { sair(); throw new Error("sessão expirada"); }
  if (!r.ok) throw new Error("Não consegui carregar a lista (" + r.status + ").");
  ensaios = await r.json();

  if (ensaios.length === 0) {
    const el = $("avisoLista");
    el.textContent =
      "Você entrou, mas nenhum ensaio apareceu. Isso normalmente quer dizer que este " +
      "e-mail ainda não foi liberado para ver o acervo — peça a liberação.";
    el.classList.remove("oculto");
  }

  const obras = Array.from(new Set(ensaios.map((e) => e.pasta_origem).filter(Boolean))).sort();
  const sel = $("filtroObra");
  const atual = sel.value;
  sel.innerHTML = '<option value="">Todas as obras</option>' +
    obras.map((o) => '<option>' + escapar(o) + '</option>').join("");
  sel.value = atual;

  desenhar();
}

function escapar(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function tamanho(b) {
  if (b == null) return "";
  return b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB";
}
function data(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString("pt-BR") + " " +
    d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}
function numero(v, sufixo) {
  return (v === null || v === undefined || v === "") ? "" : Number(v) + sufixo;
}

function desenhar() {
  const termo = $("busca").value.trim().toLowerCase();
  const obra = $("filtroObra").value;
  const ext = $("filtroExt").value;

  const vis = ensaios.filter((e) => {
    if (obra && e.pasta_origem !== obra) return false;
    if (ext && !String(e.nome_original || "").toLowerCase().endsWith(ext)) return false;
    if (termo) {
      const alvo = ((e.estaca_nome || "") + " " + (e.nome_original || "") + " " + (e.pasta_origem || "")).toLowerCase();
      if (!alvo.includes(termo)) return false;
    }
    return true;
  });

  $("contagem").textContent = vis.length + " de " + ensaios.length + " ensaios";
  $("semNada").classList.toggle("oculto", vis.length > 0);

  $("linhas").innerHTML = vis.map((e) =>
    "<tr>" +
      "<td>" + escapar(e.estaca_nome || "—") + "</td>" +
      "<td>" + escapar(e.pasta_origem || "—") + "</td>" +
      "<td>" + escapar(e.nome_original) + "</td>" +
      "<td>" + escapar(e.estaca_tipo || "") + "</td>" +
      '<td class="num">' + numero(e.diametro_cm ? Math.round(e.diametro_cm) : null, " cm") + "</td>" +
      '<td class="num">' + numero(e.profundidade_sugerida_m, " m") + "</td>" +
      '<td class="num">' + numero(e.arrasamento_sugerido_m, " m") + "</td>" +
      "<td>" + escapar(data(e.criado_no_equipamento || e.recebido_em)) + "</td>" +
      '<td class="num">' + tamanho(e.bytes) + "</td>" +
      '<td><button class="leve" type="button" data-id="' + escapar(e.id) + '">Baixar</button></td>' +
    "</tr>"
  ).join("");
}

// O arquivo fica em bucket privado. O download sai por URL assinada de vida
// curta, pedida na hora do clique — nunca por link permanente.
async function baixar(id, bt) {
  const e = ensaios.find((x) => x.id === id);
  if (!e) return;
  const rotulo = bt.textContent;
  bt.disabled = true; bt.textContent = "…";
  try {
    const r = await fetch(BASE + "/storage/v1/object/sign/ensaios/" + e.storage_path, {
      method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, autorizacao()),
      body: JSON.stringify({ expiresIn: 120 }),
    });
    if (!r.ok) throw new Error("assinatura recusada (" + r.status + ")");
    const { signedURL } = await r.json();
    const a = document.createElement("a");
    a.href = BASE + "/storage/v1" + signedURL;
    a.download = e.nome_original;
    document.body.appendChild(a); a.click(); a.remove();
  } catch (err) {
    const el = $("avisoLista");
    el.className = "aviso erro";
    el.textContent = "Não consegui preparar o download de " + e.nome_original + ": " + err.message;
    el.classList.remove("oculto");
  } finally {
    bt.disabled = false; bt.textContent = rotulo;
  }
}

function mostrarLista() {
  $("telaLogin").classList.add("oculto");
  $("telaLista").classList.remove("oculto");
  $("sair").classList.remove("oculto");
  $("assinatura").textContent = sessao && sessao.user ? sessao.user.email : "";
}
function sair() {
  limparSessao();
  $("telaLista").classList.add("oculto");
  $("sair").classList.add("oculto");
  $("telaLogin").classList.remove("oculto");
  $("assinatura").textContent = "Geoteste — arquivos enviados pelo equipamento";
}

$("formLogin").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  mostrarErroLogin("");
  const bt = $("btEntrar");
  bt.disabled = true; bt.textContent = "Entrando…";
  try {
    guardarSessao(await entrar($("email").value.trim(), $("senha").value));
    mostrarLista();
    await carregar();
  } catch (err) {
    mostrarErroLogin(err.message);
  } finally {
    bt.disabled = false; bt.textContent = "Entrar";
  }
});

$("sair").addEventListener("click", sair);
$("btAtualizar").addEventListener("click", () => carregar().catch(() => {}));
$("busca").addEventListener("input", desenhar);
$("filtroObra").addEventListener("change", desenhar);
$("filtroExt").addEventListener("change", desenhar);
$("linhas").addEventListener("click", (ev) => {
  const bt = ev.target.closest("button[data-id]");
  if (bt) baixar(bt.getAttribute("data-id"), bt);
});

// Sessão guardada: tenta entrar direto. Se o token expirou, o carregar()
// devolve 401 e a tela de login volta sozinha.
sessao = lerSessao();
if (sessao && sessao.access_token) {
  mostrarLista();
  carregar().catch(() => sair());
}
</script>
</body>
</html>`;

Deno.serve((req: Request): Response => {
  if (req.method !== "GET") return new Response("use GET", { status: 405 });
  return new Response(PAGINA(URL_BASE, ANON), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // A página é pública; o que ela mostra não é. Todo dado passa por login
      // e pelas políticas de RLS.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
    },
  });
});
