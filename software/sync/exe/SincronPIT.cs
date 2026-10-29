// ============================================================================
//  SincronPIT — envia os ensaios do PIT-Q para a nuvem.
//
//  Compilado com o csc.exe que ja vem no Windows (.NET Framework). O PIT-Q
//  roda Windows 10 LTSB 1607 com usuario SEM administrador: nada pode ser
//  instalado, nem runtime nem dependencia. Este .exe nao tem nenhuma.
//
//  LIMITE DE LINGUAGEM: o csc.exe do .NET Framework e da era 4.5 e so aceita
//  C# 5. Nada de interpolacao de string ($""), operador ?. , nameof, membros
//  com corpo de expressao ou inicializador de propriedade automatica.
//
//  REGRA ABSOLUTA: o ensaio original nunca e alterado, movido nem apagado.
//  Todo acesso a arquivo de origem e somente leitura.
// ============================================================================
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;

namespace SincronPIT
{
    // Nas versoes por equipamento, este recurso vai dentro do proprio .exe.
    // A versao generica continua aceitando a configuracao externa existente.
    public static class PerfilEmbutido
    {
        public static readonly string MachineId = "";
        public static readonly string Url = "";
        public static readonly string Token = "";
        public static bool Ativo { get { return MachineId.Length > 0; } }

        static PerfilEmbutido()
        {
            using (Stream recurso = typeof(PerfilEmbutido).Assembly.GetManifestResourceStream("SincronPIT.perfil"))
            {
                if (recurso == null) return;
                using (StreamReader reader = new StreamReader(recurso, Encoding.UTF8))
                {
                    string linha;
                    while ((linha = reader.ReadLine()) != null)
                    {
                        int separador = linha.IndexOf('=');
                        if (separador < 1) continue;
                        string chave = linha.Substring(0, separador).Trim().ToLowerInvariant();
                        string valor = linha.Substring(separador + 1).Trim();
                        if (chave == "machineid") MachineId = valor;
                        else if (chave == "url") Url = valor;
                        else if (chave == "token") Token = valor;
                    }
                }
            }
        }
    }

    // ========================================================================
    // Configuracao
    //
    // Formato chave=valor, uma por linha. Escolhido de proposito no lugar de
    // JSON: numa maquina de campo sem ferramenta nenhuma, um tecnico consegue
    // abrir isto no Bloco de Notas e corrigir um caminho.
    // ========================================================================
    public class Config
    {
        public List<string> Pastas;
        public string UrlIngerir;
        public string Token;
        public string MachineId;
        public List<string> Extensoes;
        public string PastaExport;

        public Config()
        {
            // As duas pastas que a sonda encontrou no PIT-Q real. Ele grava o
            // mesmo ensaio nas duas ao mesmo tempo.
            Pastas = new List<string>();
            Pastas.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PDI\\PIT"));
            string pub = Environment.GetEnvironmentVariable("PUBLIC");
            if (string.IsNullOrEmpty(pub)) pub = "C:\\Users\\Public";
            Pastas.Add(Path.Combine(pub, "Documents\\PDI\\PIT"));

            UrlIngerir = PerfilEmbutido.Url;
            Token = PerfilEmbutido.Token;
            MachineId = PerfilEmbutido.Ativo ? PerfilEmbutido.MachineId : "pit-" + Guid.NewGuid().ToString();
            Extensoes = new List<string>(new string[] { ".pte", ".ptn", ".pt2" });
            PastaExport = "";
        }

        // Usada pelo autoteste para nao tocar nos dados reais do operador.
        public static string PastaBaseForcada;
        public static string PastaBase
        {
            get
            {
                return PastaBaseForcada ?? Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "SincronPIT");
            }
        }

        public static string PastaDados
        {
            get { return PerfilEmbutido.Ativo ? Path.Combine(PastaBase, PerfilEmbutido.MachineId) : PastaBase; }
        }

        public static string CaminhoConfig { get { return Path.Combine(PastaDados, "config.txt"); } }
        // enviados.txt  = chegou na NUVEM (so isso evita reenvio)
        // exportados.txt = foi copiado para pendrive (so informativo)
        // Ate 23/10/2026 a exportacao gravava em enviados.txt e o ensaio que
        // saiu pelo pendrive nunca mais subia quando a internet voltava.
        public static string CaminhoEnviados { get { return Path.Combine(PastaDados, "enviados.txt"); } }
        public static string CaminhoExportados { get { return Path.Combine(PastaDados, "exportados.txt"); } }

        // Semente: um config.txt colocado AO LADO do .exe e adotado na
        // primeira execucao. Serve para entregar o programa ja configurado
        // (URL, token e identidade do equipamento), sem obrigar ninguem a
        // digitar um token de 64 caracteres na tela de um painel industrial.
        // So acontece uma vez: depois disso vale o que esta em %APPDATA%.
        private static void ImportarSementeSeHouver()
        {
            try
            {
                if (File.Exists(CaminhoConfig)) return;
                if (PerfilEmbutido.Ativo)
                {
                    string legado = Path.Combine(PastaBase, "config.txt");
                    if (!File.Exists(legado)) return;
                    bool mesmoEquipamento = File.ReadAllLines(legado).Any(delegate(string l)
                    {
                        return l.Trim().Equals("machineid=" + PerfilEmbutido.MachineId, StringComparison.OrdinalIgnoreCase);
                    });
                    if (!mesmoEquipamento) return;
                    Directory.CreateDirectory(PastaDados);
                    File.Copy(legado, CaminhoConfig, false);
                    foreach (string nome in new string[] { "enviados.txt", "exportados.txt", "hashes.txt" })
                    {
                        string origem = Path.Combine(PastaBase, nome);
                        string destino = Path.Combine(PastaDados, nome);
                        if (File.Exists(origem) && !File.Exists(destino)) File.Copy(origem, destino, false);
                    }
                    return;
                }
                string aoLado = Path.Combine(
                    Path.GetDirectoryName(Application.ExecutablePath), "config.txt");
                if (!File.Exists(aoLado)) return;
                Directory.CreateDirectory(PastaDados);
                File.Copy(aoLado, CaminhoConfig, false);
            }
            catch { /* semente e conveniencia, nunca motivo para nao abrir */ }
        }

        public static Config Carregar()
        {
            Config c = new Config();
            ImportarSementeSeHouver();
            try
            {
                if (!File.Exists(CaminhoConfig)) return c;
                foreach (string linha in File.ReadAllLines(CaminhoConfig))
                {
                    string l = linha.Trim();
                    if (l.Length == 0 || l.StartsWith("#")) continue;
                    int i = l.IndexOf('=');
                    if (i <= 0) continue;
                    string chave = l.Substring(0, i).Trim().ToLowerInvariant();
                    string valor = l.Substring(i + 1).Trim();
                    if (valor.Length == 0) continue;

                    if (chave == "pastas") c.Pastas = new List<string>(valor.Split('|'));
                    else if (chave == "url") c.UrlIngerir = valor;
                    else if (chave == "token") c.Token = valor;
                    else if (chave == "machineid") c.MachineId = valor;
                    else if (chave == "extensoes") c.Extensoes = new List<string>(valor.ToLowerInvariant().Split('|'));
                    else if (chave == "pastaexport") c.PastaExport = valor;
                }
            }
            catch
            {
                // Config ilegivel nao pode impedir o app de abrir: volta ao
                // padrao. Perder configuracao e chato; nao abrir e pior.
                return new Config();
            }
            if (PerfilEmbutido.Ativo)
            {
                if (!c.MachineId.Equals(PerfilEmbutido.MachineId, StringComparison.OrdinalIgnoreCase)) c.Token = "";
                c.MachineId = PerfilEmbutido.MachineId;
                c.UrlIngerir = PerfilEmbutido.Url;
                if (PerfilEmbutido.Token.Length > 0) c.Token = PerfilEmbutido.Token;
            }
            return c;
        }

        public void Salvar()
        {
            Directory.CreateDirectory(PastaDados);
            StringBuilder sb = new StringBuilder();
            sb.AppendLine("# SincronPIT - configuracao");
            sb.AppendLine("pastas=" + string.Join("|", Pastas.ToArray()));
            sb.AppendLine("url=" + UrlIngerir);
            sb.AppendLine("token=" + Token);
            sb.AppendLine("machineid=" + MachineId);
            sb.AppendLine("extensoes=" + string.Join("|", Extensoes.ToArray()));
            sb.AppendLine("pastaexport=" + PastaExport);

            // Grava em temporario e renomeia. Falta de energia no meio da
            // escrita deixaria a config pela metade.
            string tmp = CaminhoConfig + ".tmp";
            File.WriteAllText(tmp, sb.ToString(), Encoding.UTF8);
            if (File.Exists(CaminhoConfig)) File.Delete(CaminhoConfig);
            File.Move(tmp, CaminhoConfig);
        }
    }

    // ========================================================================
    // Resultado do envio de um ensaio.
    //
    // A diferenca entre "tenta de novo" e "nunca mais tenta" e o ponto mais
    // importante daqui. Um arquivo recusado de vez que voltasse para a fila
    // seria retentado para sempre — em obra isso vira um app travado que nao
    // explica nada.
    // ========================================================================
    public enum Estado { Enviado, Duplicado, Permanente, Temporario }

    public class Resultado
    {
        public int Total, Novos, Duplicados, Falhas, Permanentes;
        public List<string> Erros = new List<string>();
    }

    public class Obra
    {
        public string Nome;
        public List<FileInfo> Arquivos = new List<FileInfo>();
        public long Bytes;
        // Data do ensaio mais recente: e a "ordem de execucao" que o operador
        // usa para achar a obra que acabou de ensaiar.
        public DateTime Ultimo = DateTime.MinValue;
        // -1 = ainda nao verificado (o hash sai em segundo plano)
        public int Pendentes = -1;
        // dos pendentes, quantos ja foram copiados para pendrive
        public int NoPendrive;
    }

    // ========================================================================
    // Cache de hash por arquivo.
    //
    // Saber quantos ensaios de cada obra faltam enviar exige o sha256 de cada
    // um. Num Atom isso e lento na primeira vez, entao o resultado fica
    // guardado por caminho+tamanho+data: arquivo que nao mudou nao e lido de
    // novo. Ensaio alterado muda tamanho ou data e e recalculado.
    // ========================================================================
    public static class CacheHash
    {
        private static readonly object trava = new object();
        private static Dictionary<string, string> mapa;

        // O autoteste aponta para um arquivo temporario e nao suja o cache real.
        public static string CaminhoForcado;
        public static string Caminho { get { return CaminhoForcado ?? Path.Combine(Config.PastaDados, "hashes.txt"); } }

        private static string Chave(FileInfo f)
        {
            return f.FullName.ToLowerInvariant() + "|" + f.Length + "|" + f.LastWriteTimeUtc.Ticks;
        }

        private static void Carregar()
        {
            if (mapa != null) return;
            mapa = new Dictionary<string, string>();
            try
            {
                if (!File.Exists(Caminho)) return;
                foreach (string l in File.ReadAllLines(Caminho))
                {
                    int i = l.IndexOf('\t');
                    if (i != 64) continue;
                    mapa[l.Substring(65)] = l.Substring(0, 64);
                }
            }
            catch { /* cache e so atalho: ilegivel = recalcula */ }
        }

        public static void Descartar() { lock (trava) { mapa = null; } }

        public static string Sha(FileInfo f)
        {
            string chave = Chave(f);
            lock (trava)
            {
                Carregar();
                string sha;
                if (mapa.TryGetValue(chave, out sha)) return sha;
            }
            string novo = Nucleo.Sha256Arquivo(f.FullName);
            lock (trava)
            {
                mapa[chave] = novo;
                try
                {
                    Directory.CreateDirectory(Config.PastaDados);
                    File.AppendAllText(Caminho, novo + "\t" + chave + Environment.NewLine);
                }
                catch { }
            }
            return novo;
        }
    }

    // ========================================================================
    // Nucleo — nada aqui depende da interface, para poder ser testado sozinho
    // ========================================================================
    public static class Nucleo
    {
        public static string Sha256Arquivo(string caminho)
        {
            // Streaming: nao carrega o arquivo na memoria. Numa maquina de
            // 1,9 GB isso importa quando a pasta tem 31 mil ensaios.
            using (SHA256 sha = SHA256.Create())
            using (FileStream fs = new FileStream(caminho, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                byte[] h = sha.ComputeHash(fs);
                StringBuilder sb = new StringBuilder(64);
                for (int i = 0; i < h.Length; i++) sb.Append(h[i].ToString("x2"));
                return sb.ToString();
            }
        }

        private static Dictionary<string, bool> LerRegistro(string caminho)
        {
            Dictionary<string, bool> t = new Dictionary<string, bool>();
            try
            {
                if (!File.Exists(caminho)) return t;
                foreach (string l in File.ReadAllLines(caminho))
                {
                    string h = l.Trim();
                    if (h.Length == 64) t[h] = true;
                }
            }
            catch { }
            return t;
        }

        private static void Registrar(string caminho, string sha)
        {
            Directory.CreateDirectory(Config.PastaDados);
            // Append imediato. Se o app for fechado no meio, o que ja foi
            // continua registrado e nao vai de novo na proxima abertura.
            File.AppendAllText(caminho, sha + Environment.NewLine);
        }

        public static Dictionary<string, bool> LerEnviados() { return LerRegistro(Config.CaminhoEnviados); }
        public static Dictionary<string, bool> LerExportados() { return LerRegistro(Config.CaminhoExportados); }
        public static void RegistrarEnviado(string sha) { Registrar(Config.CaminhoEnviados, sha); }
        public static void RegistrarExportado(string sha) { Registrar(Config.CaminhoExportados, sha); }

        public static List<FileInfo> Varrer(Config cfg)
        {
            List<FileInfo> lista = new List<FileInfo>();
            Dictionary<string, bool> relativosVistos = new Dictionary<string, bool>();

            foreach (string raiz in cfg.Pastas)
            {
                if (string.IsNullOrEmpty(raiz) || !Directory.Exists(raiz)) continue;
                string prefixo = Path.GetFullPath(raiz).TrimEnd('\\');

                foreach (string caminho in EnumerarSeguro(prefixo))
                {
                    string ext = Path.GetExtension(caminho).ToLowerInvariant();
                    if (!cfg.Extensoes.Contains(ext)) continue;

                    // O PIT-Q grava o MESMO ensaio nas duas pastas. Contar os
                    // dois faria a tela dizer 546 onde ha 273 — numero que o
                    // operador usa para decidir o que subir. Colapsa pelo
                    // caminho RELATIVO a cada raiz ("OBRA X\E01.PTE"), que e
                    // igual entre espelhos e diferente entre ensaios de
                    // verdade. Nome solto nao serve: duas obras podem ter
                    // E01.PTE, e sao arquivos distintos.
                    string relativo = caminho.Substring(prefixo.Length).TrimStart('\\').ToLowerInvariant();
                    if (relativosVistos.ContainsKey(relativo)) continue;
                    relativosVistos[relativo] = true;

                    try { lista.Add(new FileInfo(caminho)); }
                    catch { }
                }
            }
            return lista;
        }

        // Percorre manualmente: Directory.GetFiles com recursao aborta a
        // varredura inteira ao esbarrar numa pasta sem permissao.
        private static IEnumerable<string> EnumerarSeguro(string raiz)
        {
            Stack<string> pilha = new Stack<string>();
            pilha.Push(raiz);
            while (pilha.Count > 0)
            {
                string dir = pilha.Pop();
                string[] subs = null;
                try { subs = Directory.GetDirectories(dir); }
                catch { subs = new string[0]; }
                for (int i = 0; i < subs.Length; i++) pilha.Push(subs[i]);

                string[] arqs = null;
                try { arqs = Directory.GetFiles(dir); }
                catch { arqs = new string[0]; }
                for (int i = 0; i < arqs.Length; i++) yield return arqs[i];
            }
        }

        public static List<Obra> AgruparPorObra(List<FileInfo> ensaios)
        {
            Dictionary<string, Obra> mapa = new Dictionary<string, Obra>();
            foreach (FileInfo f in ensaios)
            {
                string nome = f.Directory != null ? f.Directory.Name : "(raiz)";
                if (!mapa.ContainsKey(nome))
                {
                    Obra o = new Obra();
                    o.Nome = nome;
                    mapa[nome] = o;
                }
                mapa[nome].Arquivos.Add(f);
                mapa[nome].Bytes += f.Length;
                if (f.LastWriteTime > mapa[nome].Ultimo) mapa[nome].Ultimo = f.LastWriteTime;
            }
            List<Obra> lista = new List<Obra>(mapa.Values);
            // Ordem de execucao: a obra ensaiada por ultimo vem primeiro.
            lista.Sort(delegate(Obra a, Obra b) { return b.Ultimo.CompareTo(a.Ultimo); });
            return lista;
        }

        // Quantos ensaios da obra ainda nao subiram. Usa o cache de hash.
        public static int ContarPendentes(Obra o, Dictionary<string, bool> enviados)
        {
            return ContarPendentes(o, enviados, null);
        }

        public static int ContarPendentes(Obra o, Dictionary<string, bool> enviados, Dictionary<string, bool> exportados)
        {
            int n = 0, pendrive = 0;
            Dictionary<string, bool> vistos = new Dictionary<string, bool>();
            foreach (FileInfo f in o.Arquivos)
            {
                try
                {
                    string sha = CacheHash.Sha(f);
                    if (vistos.ContainsKey(sha)) continue; // copia renomeada conta uma vez
                    vistos[sha] = true;
                    if (enviados.ContainsKey(sha)) continue;
                    n++;
                    if (exportados != null && exportados.ContainsKey(sha)) pendrive++;
                }
                catch { n++; }
            }
            o.NoPendrive = pendrive;
            return n;
        }

        // Busca sem diferenciar maiuscula nem acento: "sao jose" acha "SÃO JOSÉ".
        public static string SemAcento(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            string d = s.Normalize(NormalizationForm.FormD);
            StringBuilder sb = new StringBuilder(d.Length);
            foreach (char c in d)
                if (CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark) sb.Append(c);
            return sb.ToString().Normalize(NormalizationForm.FormC).ToLowerInvariant();
        }

        public static bool TemInternet()
        {
            try
            {
                using (System.Net.Sockets.TcpClient c = new System.Net.Sockets.TcpClient())
                {
                    IAsyncResult r = c.BeginConnect("1.1.1.1", 443, null, null);
                    bool ok = r.AsyncWaitHandle.WaitOne(3000, false) && c.Connected;
                    return ok;
                }
            }
            catch { return false; }
        }

        public static Estado Enviar(Config cfg, FileInfo f, string sha, out string detalhe)
        {
            detalhe = "";
            try
            {
                byte[] bytes = File.ReadAllBytes(f.FullName);

                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(cfg.UrlIngerir);
                req.Method = "POST";
                req.ContentType = "application/octet-stream";
                req.Timeout = 120000;
                req.ReadWriteTimeout = 120000;
                req.Headers.Add("Authorization", "Bearer " + cfg.Token);
                req.Headers.Add("X-Machine-Id", cfg.MachineId);
                req.Headers.Add("X-Nome-Original", f.Name);
                req.Headers.Add("X-Sha256", sha);
                req.Headers.Add("X-Pasta-Origem", f.Directory != null ? f.Directory.Name : "");
                req.Headers.Add("X-Criado-Em", f.LastWriteTimeUtc.ToString("o", CultureInfo.InvariantCulture));
                req.Headers.Add("X-Detectado-Em", DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture));
                req.ContentLength = bytes.Length;

                using (Stream s = req.GetRequestStream()) { s.Write(bytes, 0, bytes.Length); }

                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                using (StreamReader sr = new StreamReader(resp.GetResponseStream()))
                {
                    string corpo = sr.ReadToEnd();
                    if (corpo.IndexOf("\"duplicado\":true", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        detalhe = "ja existia na nuvem";
                        return Estado.Duplicado;
                    }
                    return Estado.Enviado;
                }
            }
            catch (WebException we)
            {
                HttpWebResponse r = we.Response as HttpWebResponse;
                int codigo = r != null ? (int)r.StatusCode : 0;
                switch (codigo)
                {
                    case 401: detalhe = "token invalido ou revogado"; return Estado.Permanente;
                    case 413: detalhe = "arquivo grande demais"; return Estado.Permanente;
                    case 415: detalhe = "extensao nao aceita pelo servidor"; return Estado.Permanente;
                    case 429: detalhe = "limite por hora atingido"; return Estado.Temporario;
                    default:
                        detalhe = codigo > 0 ? ("HTTP " + codigo) : we.Message;
                        return Estado.Temporario;
                }
            }
            catch (Exception ex)
            {
                detalhe = ex.Message;
                return Estado.Temporario;
            }
        }

        // true = copiou; false = este mesmo arquivo ja estava nesse pendrive.
        // Arquivos com nomes diferentes sao preservados mesmo quando possuem
        // conteudo igual: o painel decide depois se representam duplicidade.
        public static bool Exportar(Config cfg, FileInfo f, string sha)
        {
            string obra = f.Directory != null ? f.Directory.Name : "sem-obra";
            string destino = Path.Combine(Path.Combine(cfg.PastaExport, cfg.MachineId), obra);
            Directory.CreateDirectory(destino);

            string ext = Path.GetExtension(f.Name);
            string baseNome = Path.GetFileNameWithoutExtension(f.Name);
            // sha no nome: dois ensaios de nome igual e conteudo diferente nao
            // se sobrescrevem no pendrive
            string marca = "." + sha.Substring(0, 12) + ext;
            string alvo = Path.Combine(destino, baseNome + marca);

            // Repetir a exportacao para o mesmo pendrive continua idempotente,
            // mas um arquivo de outro nome com o mesmo sha ganha seu proprio
            // alvo e tambem e exportado.
            if (File.Exists(alvo))
            {
                try { if (Sha256Arquivo(alvo) == sha) return false; }
                catch { /* destino ilegivel: substitui pela copia integra */ }
            }

            // copia para temporario e renomeia: pendrive arrancado no meio nao
            // deixa arquivo parcial parecendo integro
            string tmp = alvo + ".parcial";
            File.Copy(f.FullName, tmp, true);
            if (File.Exists(alvo)) File.Delete(alvo);
            File.Move(tmp, alvo);
            return true;
        }

        public delegate void Progresso(int indice, int total, string nome);

        public static Resultado Sincronizar(Config cfg, List<FileInfo> arquivos, bool exportar, Progresso aoProgredir)
        {
            return Sincronizar(cfg, arquivos, exportar, false, aoProgredir);
        }

        // conferirNoServidor: manda mesmo o que o registro local diz que ja
        // subiu. O servidor responde "duplicado" para o que ja tem, entao nao
        // duplica nada; serve para recuperar ensaio marcado errado.
        public static Resultado Sincronizar(Config cfg, List<FileInfo> arquivos, bool exportar, bool conferirNoServidor, Progresso aoProgredir)
        {
            Dictionary<string, bool> enviados = LerEnviados();
            Dictionary<string, bool> nestaRodada = new Dictionary<string, bool>();
            Resultado res = new Resultado();
            res.Total = arquivos.Count;

            int i = 0;
            foreach (FileInfo f in arquivos)
            {
                i++;
                if (aoProgredir != null) aoProgredir(i, arquivos.Count, f.Name);

                string sha;
                try { sha = CacheHash.Sha(f); }
                catch (Exception ex)
                {
                    res.Falhas++;
                    res.Erros.Add(f.Name + " : nao consegui ler (" + ex.Message + ")");
                    continue;
                }

                if (exportar)
                {
                    try
                    {
                        // Exportar NAO marca como enviado: o ensaio continua
                        // pendente para a nuvem e sobe quando a internet voltar.
                        if (Exportar(cfg, f, sha)) { RegistrarExportado(sha); res.Novos++; }
                        else res.Duplicados++;
                    }
                    catch (Exception ex)
                    {
                        res.Falhas++;
                        res.Erros.Add(f.Name + " : falha ao copiar (" + ex.Message + ")");
                    }
                    continue;
                }

                // A nuvem ainda deduplica por conteudo. A exportacao para
                // pendrive, acima, preserva cada arquivo para o painel decidir.
                if (nestaRodada.ContainsKey(sha)) { res.Duplicados++; continue; }
                nestaRodada[sha] = true;
                if (enviados.ContainsKey(sha) && !conferirNoServidor) { res.Duplicados++; continue; }

                string detalhe;
                Estado e = Enviar(cfg, f, sha, out detalhe);
                if (e == Estado.Enviado) { RegistrarEnviado(sha); enviados[sha] = true; res.Novos++; }
                else if (e == Estado.Duplicado) { RegistrarEnviado(sha); enviados[sha] = true; res.Duplicados++; }
                else if (e == Estado.Permanente)
                {
                    res.Permanentes++;
                    res.Erros.Add(f.Name + " : " + detalhe + " [nao sera tentado de novo]");
                }
                else
                {
                    res.Falhas++;
                    res.Erros.Add(f.Name + " : " + detalhe);
                }
            }
            return res;
        }
    }

    // ========================================================================
    // Janela
    //
    // Pensada para o painel do PIT-Q: tela pequena, muitas vezes no toque, com
    // o operador de luva e pressa. Por isso: linhas altas, clique em qualquer
    // ponto da linha marca a obra, a obra ensaiada por ultimo aparece primeiro
    // e o botao principal diz exatamente o que vai acontecer.
    // ========================================================================
    public class ListaSemPiscar : ListView
    {
        public ListaSemPiscar() { DoubleBuffered = true; }
    }

    public class FormPrincipal : Form
    {
        // Cores: verde Geoteste para "tudo certo", ambar para "atencao".
        private static readonly Color Verde = Color.FromArgb(21, 128, 61);
        private static readonly Color VerdeClaro = Color.FromArgb(220, 252, 231);
        private static readonly Color Ambar = Color.FromArgb(180, 83, 9);
        private static readonly Color AmbarClaro = Color.FromArgb(254, 243, 199);
        private static readonly Color Vermelho = Color.FromArgb(185, 28, 28);
        private static readonly Color VermelhoClaro = Color.FromArgb(254, 226, 226);
        private static readonly Color Cinza = Color.FromArgb(107, 114, 128);

        private const int ColObra = 0, ColUltimo = 1, ColEnsaios = 2, ColSituacao = 3, ColTamanho = 4;
        private static readonly string[] Titulos = { "Obra", "Último ensaio", "Ensaios", "Situação", "Tamanho" };

        private Config cfg;
        private Panel pnlTopo;
        private Label lblTitulo, lblSub;
        private TextBox txtPesquisar;
        private Button btnLimparBusca;
        private ListaSemPiscar lista;
        private Label lblVazio;
        private Label lblSelecao;
        private LinkLabel lnkPendentes, lnkNenhuma;
        private ProgressBar barra;
        private TextBox log;
        private Button btnSincronizar, btnAtualizar, btnConfig;
        private System.ComponentModel.BackgroundWorker trabalhador;
        private System.ComponentModel.BackgroundWorker verificador;
        private bool exportando;
        private bool online;
        private bool reconstruindoLista;
        private bool ignorarCheckDuploClique;
        private bool reverificarAoTerminar;
        // Resultado do ultimo envio fica no topo ate a proxima acao, sem ser
        // atropelado pela verificacao em segundo plano.
        private bool topoFixo;
        private bool modoReenvio;
        private int colunaOrdem = ColUltimo;
        private bool ordemDesc = true;
        private List<Obra> obras = new List<Obra>();
        private int totalEnsaios;
        private HashSet<string> obrasMarcadas = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wp, string lp);
        private const int EM_SETCUEBANNER = 0x1501;

        public FormPrincipal()
        {
            cfg = Config.Carregar();
            cfg.Salvar(); // grava o machineId ja na primeira abertura

            Text = "SincronPIT";
            ClientSize = new Size(820, 600);
            MinimumSize = new Size(640, 480);
            StartPosition = FormStartPosition.CenterScreen;
            // O painel do PIT-Q pode ter tela pequena: se a janela nao couber,
            // abre maximizada em vez de ficar com botoes fora da tela.
            Rectangle area = Screen.PrimaryScreen.WorkingArea;
            if (Width > area.Width || Height > area.Height) WindowState = FormWindowState.Maximized;
            Font = new Font("Segoe UI", 10f);
            BackColor = Color.White;
            KeyPreview = true;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
            catch { }

            // ---- faixa de status no topo -----------------------------------
            pnlTopo = new Panel();
            pnlTopo.Dock = DockStyle.Top;
            pnlTopo.Height = 66;
            pnlTopo.BackColor = VerdeClaro;
            Controls.Add(pnlTopo);

            lblTitulo = new Label();
            lblTitulo.Font = new Font("Segoe UI", 13f, FontStyle.Bold);
            lblTitulo.Location = new Point(14, 8);
            lblTitulo.Size = new Size(790, 28);
            lblTitulo.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            lblTitulo.Text = "Procurando ensaios...";
            pnlTopo.Controls.Add(lblTitulo);

            lblSub = new Label();
            lblSub.Font = new Font("Segoe UI", 9.5f);
            lblSub.Location = new Point(15, 38);
            lblSub.Size = new Size(790, 22);
            lblSub.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            pnlTopo.Controls.Add(lblSub);

            // ---- pesquisa ---------------------------------------------------
            Label lblPesquisar = new Label();
            lblPesquisar.Text = "Pesquisar obra:";
            lblPesquisar.Location = new Point(12, 80);
            lblPesquisar.Size = new Size(112, 26);
            lblPesquisar.TextAlign = ContentAlignment.MiddleLeft;
            Controls.Add(lblPesquisar);

            txtPesquisar = new TextBox();
            txtPesquisar.Location = new Point(126, 80);
            txtPesquisar.Size = new Size(640, 26);
            txtPesquisar.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            txtPesquisar.TextChanged += new EventHandler(delegate(object s, EventArgs e)
            {
                btnLimparBusca.Visible = txtPesquisar.Text.Length > 0;
                AplicarFiltroObras();
            });
            Controls.Add(txtPesquisar);

            btnLimparBusca = new Button();
            btnLimparBusca.Text = "×";
            btnLimparBusca.Location = new Point(772, 79);
            btnLimparBusca.Size = new Size(36, 28);
            btnLimparBusca.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            btnLimparBusca.FlatStyle = FlatStyle.Flat;
            btnLimparBusca.FlatAppearance.BorderSize = 0;
            btnLimparBusca.Visible = false;
            btnLimparBusca.TabStop = false;
            btnLimparBusca.Click += new EventHandler(delegate(object s, EventArgs e) { txtPesquisar.Clear(); txtPesquisar.Focus(); });
            Controls.Add(btnLimparBusca);

            // ---- lista de obras --------------------------------------------
            lista = new ListaSemPiscar();
            lista.Location = new Point(12, 116);
            lista.Size = new Size(796, 286);
            lista.View = View.Details;
            lista.CheckBoxes = true;
            lista.FullRowSelect = true;
            lista.HideSelection = false;
            lista.ShowItemToolTips = true;
            lista.MultiSelect = false;
            lista.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            // Linha alta para o toque: o ListView usa a altura da ImageList.
            ImageList alturaLinha = new ImageList();
            alturaLinha.ImageSize = new Size(1, 30);
            lista.SmallImageList = alturaLinha;
            for (int i = 0; i < Titulos.Length; i++) lista.Columns.Add(Titulos[i]);
            lista.Columns[ColEnsaios].TextAlign = HorizontalAlignment.Right;
            lista.Columns[ColTamanho].TextAlign = HorizontalAlignment.Right;
            lista.ItemCheck += new ItemCheckEventHandler(Lista_ItemCheck);
            lista.ItemChecked += new ItemCheckedEventHandler(delegate(object s, ItemCheckedEventArgs e) { AtualizarResumoSelecao(); });
            lista.MouseDown += new MouseEventHandler(Lista_MouseDown);
            lista.MouseUp += new MouseEventHandler(delegate(object s, MouseEventArgs e) { ignorarCheckDuploClique = false; });
            lista.KeyDown += new KeyEventHandler(Lista_KeyDown);
            lista.ColumnClick += new ColumnClickEventHandler(Lista_ColumnClick);
            // depois do redimensionamento: a barra vertical so aparece (ou some)
            // quando a lista termina de mudar de tamanho
            lista.Resize += new EventHandler(delegate(object s, EventArgs e)
            {
                if (lista.IsHandleCreated) lista.BeginInvoke(new MethodInvoker(AjustarColunas));
            });
            Controls.Add(lista);

            // Mensagem no meio da lista quando a busca nao acha nada
            lblVazio = new Label();
            lblVazio.AutoSize = false;
            lblVazio.TextAlign = ContentAlignment.MiddleCenter;
            lblVazio.ForeColor = Cinza;
            lblVazio.BackColor = Color.White;
            lblVazio.Visible = false;
            lblVazio.Location = new Point(14, 180);
            lblVazio.Size = new Size(792, 60);
            lblVazio.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            Controls.Add(lblVazio);
            lblVazio.BringToFront();

            // ---- linha de selecao ------------------------------------------
            lblSelecao = new Label();
            lblSelecao.Location = new Point(12, 408);
            lblSelecao.Size = new Size(420, 24);
            lblSelecao.TextAlign = ContentAlignment.MiddleLeft;
            lblSelecao.AutoEllipsis = true;
            lblSelecao.Anchor = AnchorStyles.Left | AnchorStyles.Bottom;
            Controls.Add(lblSelecao);

            lnkPendentes = new LinkLabel();
            lnkPendentes.Text = "Marcar as que têm pendência";
            lnkPendentes.Location = new Point(468, 410);
            lnkPendentes.AutoSize = true;
            lnkPendentes.Anchor = AnchorStyles.Right | AnchorStyles.Bottom;
            lnkPendentes.LinkClicked += new LinkLabelLinkClickedEventHandler(delegate(object s, LinkLabelLinkClickedEventArgs e) { MarcarPendentes(); });
            Controls.Add(lnkPendentes);

            lnkNenhuma = new LinkLabel();
            lnkNenhuma.Text = "Desmarcar todas";
            lnkNenhuma.Location = new Point(684, 410);
            lnkNenhuma.AutoSize = true;
            lnkNenhuma.Anchor = AnchorStyles.Right | AnchorStyles.Bottom;
            lnkNenhuma.LinkClicked += new LinkLabelLinkClickedEventHandler(delegate(object s, LinkLabelLinkClickedEventArgs e) { DesmarcarTodas(); });
            Controls.Add(lnkNenhuma);

            // ---- progresso e registro --------------------------------------
            barra = new ProgressBar();
            barra.Location = new Point(12, 438);
            barra.Size = new Size(796, 12);
            barra.Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            Controls.Add(barra);

            log = new TextBox();
            log.Location = new Point(12, 456);
            log.Size = new Size(796, 86);
            log.Multiline = true;
            log.ScrollBars = ScrollBars.Vertical;
            log.ReadOnly = true;
            log.BackColor = Color.FromArgb(249, 250, 251);
            log.ForeColor = Color.FromArgb(55, 65, 81);
            log.Font = new Font("Consolas", 9f);
            log.Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            Controls.Add(log);

            // ---- botoes -----------------------------------------------------
            btnSincronizar = new Button();
            btnSincronizar.Location = new Point(12, 550);
            btnSincronizar.Size = new Size(420, 40);
            btnSincronizar.Anchor = AnchorStyles.Left | AnchorStyles.Bottom;
            btnSincronizar.Font = new Font("Segoe UI", 11f, FontStyle.Bold);
            btnSincronizar.FlatStyle = FlatStyle.Flat;
            btnSincronizar.FlatAppearance.BorderSize = 0;
            btnSincronizar.ForeColor = Color.White;
            btnSincronizar.Click += new EventHandler(BtnSincronizar_Click);
            btnSincronizar.EnabledChanged += new EventHandler(delegate(object s, EventArgs e) { PintarBotaoPrincipal(); });
            Controls.Add(btnSincronizar);

            btnAtualizar = new Button();
            btnAtualizar.Text = "Atualizar lista";
            btnAtualizar.Location = new Point(560, 550);
            btnAtualizar.Size = new Size(130, 40);
            btnAtualizar.Anchor = AnchorStyles.Right | AnchorStyles.Bottom;
            btnAtualizar.Click += new EventHandler(BtnAtualizar_Click);
            Controls.Add(btnAtualizar);

            btnConfig = new Button();
            btnConfig.Text = "Configurar";
            btnConfig.Location = new Point(698, 550);
            btnConfig.Size = new Size(110, 40);
            btnConfig.Anchor = AnchorStyles.Right | AnchorStyles.Bottom;
            btnConfig.Click += new EventHandler(BtnConfig_Click);
            Controls.Add(btnConfig);

            AcceptButton = null; // Enter na busca nao dispara envio sem querer

            trabalhador = new System.ComponentModel.BackgroundWorker();
            trabalhador.WorkerReportsProgress = true;
            trabalhador.DoWork += new System.ComponentModel.DoWorkEventHandler(Trabalhador_DoWork);
            trabalhador.ProgressChanged += new System.ComponentModel.ProgressChangedEventHandler(Trabalhador_Progresso);
            trabalhador.RunWorkerCompleted += new System.ComponentModel.RunWorkerCompletedEventHandler(Trabalhador_Fim);

            verificador = new System.ComponentModel.BackgroundWorker();
            verificador.WorkerReportsProgress = true;
            verificador.WorkerSupportsCancellation = true;
            verificador.DoWork += new System.ComponentModel.DoWorkEventHandler(Verificador_DoWork);
            verificador.ProgressChanged += new System.ComponentModel.ProgressChangedEventHandler(Verificador_Progresso);
            verificador.RunWorkerCompleted += new System.ComponentModel.RunWorkerCompletedEventHandler(Verificador_Fim);

            KeyDown += new KeyEventHandler(Form_KeyDown);
            Resize += new EventHandler(delegate(object s, EventArgs e) { AjustarRodape(); });
            Shown += new EventHandler(delegate(object s, EventArgs e)
            {
                try { SendMessage(txtPesquisar.Handle, EM_SETCUEBANNER, (IntPtr)1, "Digite o nome da obra ou do cliente"); }
                catch { }
                AjustarColunas();
                AjustarRodape();
                AtualizarLista();
                txtPesquisar.Focus();
            });

            AtualizarResumoSelecao();
        }

        // ---- utilidades de tela ---------------------------------------------

        private void Escrever(string txt)
        {
            log.AppendText(DateTime.Now.ToString("HH:mm:ss") + "  " + txt + Environment.NewLine);
            log.SelectionStart = log.TextLength;
            log.ScrollToCaret();
        }

        private void Topo(string titulo, string sub, Color fundo, Color texto)
        {
            lblTitulo.Text = titulo;
            lblSub.Text = sub;
            pnlTopo.BackColor = fundo;
            lblTitulo.ForeColor = texto;
            lblSub.ForeColor = Color.FromArgb(55, 65, 81);
        }

        private string LinhaEquipamento()
        {
            return (string.IsNullOrEmpty(cfg.Token) ? "Exportação por pendrive — envio online ainda não habilitado"
                : online ? "Conectado à internet — envio para a nuvem" : "Sem internet — os ensaios vão para um pendrive")
                + "     Equipamento: " + cfg.MachineId;
        }

        private void AjustarColunas()
        {
            if (lista.Columns.Count < Titulos.Length) return;
            // Tela estreita (painel pequeno): colunas de apoio encolhem antes
            // do nome da obra, que e o que o operador procura.
            bool estreita = lista.ClientSize.Width < 740;
            int ult = estreita ? 132 : 146, ens = estreita ? 62 : 76, sit = estreita ? 150 : 196, tam = estreita ? 66 : 84;
            lista.Columns[ColUltimo].Width = ult;
            lista.Columns[ColEnsaios].Width = ens;
            lista.Columns[ColSituacao].Width = sit;
            lista.Columns[ColTamanho].Width = tam;
            // reserva a barra de rolagem vertical: sem isso, quando a lista
            // enche, surge uma barra horizontal so por causa dela
            int livre = lista.ClientSize.Width - ult - ens - sit - tam - SystemInformation.VerticalScrollBarWidth - 4;
            lista.Columns[ColObra].Width = Math.Max(140, livre);
        }

        // Posiciona o que depende da largura: links da selecao e botao principal.
        private void AjustarRodape()
        {
            if (btnSincronizar == null) return;
            int direita = ClientSize.Width - 12;
            lnkNenhuma.Left = direita - lnkNenhuma.Width;
            lnkPendentes.Left = lnkNenhuma.Left - 10 - lnkPendentes.Width;
            lblSelecao.Width = Math.Max(120, lnkPendentes.Left - 8 - lblSelecao.Left);
            btnConfig.Left = direita - btnConfig.Width;
            btnAtualizar.Left = btnConfig.Left - 8 - btnAtualizar.Width;
            btnSincronizar.Width = Math.Max(200, Math.Min(460, btnAtualizar.Left - 16 - btnSincronizar.Left));
        }

        private static string Plural(int n, string um, string varios)
        {
            return n + " " + (n == 1 ? um : varios);
        }

        private static string Tamanho(long bytes)
        {
            double mb = bytes / 1048576.0;
            if (mb < 0.1) return Math.Max(1, (int)Math.Round(bytes / 1024.0)) + " KB";
            return mb.ToString("0.0") + " MB";
        }

        private static string Quando(DateTime d)
        {
            if (d == DateTime.MinValue) return "";
            DateTime hoje = DateTime.Today;
            if (d.Date == hoje) return "Hoje " + d.ToString("HH:mm");
            if (d.Date == hoje.AddDays(-1)) return "Ontem " + d.ToString("HH:mm");
            return d.ToString("dd/MM/yyyy HH:mm");
        }

        // ---- lista ------------------------------------------------------------

        private int CompararObras(Obra a, Obra b)
        {
            int c;
            switch (colunaOrdem)
            {
                case ColObra: c = string.Compare(a.Nome, b.Nome, StringComparison.CurrentCultureIgnoreCase); break;
                case ColEnsaios: c = a.Arquivos.Count.CompareTo(b.Arquivos.Count); break;
                case ColSituacao: c = a.Pendentes.CompareTo(b.Pendentes); break;
                case ColTamanho: c = a.Bytes.CompareTo(b.Bytes); break;
                default: c = a.Ultimo.CompareTo(b.Ultimo); break;
            }
            if (c == 0) c = b.Ultimo.CompareTo(a.Ultimo); // desempate: mais recente antes
            return ordemDesc ? -c : c;
        }

        private void PreencherLinha(ListViewItem item, Obra o)
        {
            while (item.SubItems.Count < Titulos.Length) item.SubItems.Add("");
            item.UseItemStyleForSubItems = false;
            item.SubItems[ColObra].Text = o.Nome;
            item.SubItems[ColUltimo].Text = Quando(o.Ultimo);
            item.SubItems[ColEnsaios].Text = o.Arquivos.Count.ToString();
            item.SubItems[ColTamanho].Text = Tamanho(o.Bytes);

            ListViewItem.ListViewSubItem sit = item.SubItems[ColSituacao];
            Color corLinha = Color.FromArgb(17, 24, 39);
            if (o.Pendentes < 0)
            {
                sit.Text = "verificando…";
                sit.ForeColor = Cinza;
                sit.Font = lista.Font;
            }
            else if (o.Pendentes == 0)
            {
                sit.Text = "✓ Tudo na nuvem";
                sit.ForeColor = Verde;
                sit.Font = lista.Font;
                corLinha = Cinza;
                item.ToolTipText = "Todos os ensaios desta obra já estão na nuvem.";
            }
            else
            {
                sit.Text = "● " + o.Pendentes + " a enviar" + (o.NoPendrive > 0 ? " (pendrive)" : "");
                sit.ForeColor = Ambar;
                sit.Font = new Font(lista.Font, FontStyle.Bold);
                item.ToolTipText = o.Pendentes + " ainda não estão na nuvem"
                    + (o.NoPendrive > 0 ? "; " + o.NoPendrive + " já foram copiados para pendrive" : "") + ".";
            }
            for (int i = 0; i < item.SubItems.Count; i++)
                if (i != ColSituacao) item.SubItems[i].ForeColor = corLinha;
            item.SubItems[ColObra].Font = o.Pendentes > 0 ? new Font(lista.Font, FontStyle.Bold) : lista.Font;
        }

        private void AplicarFiltroObras()
        {
            string termo = Nucleo.SemAcento(txtPesquisar == null ? "" : txtPesquisar.Text.Trim());
            List<Obra> visiveis = new List<Obra>();
            foreach (Obra o in obras)
                if (termo.Length == 0 || Nucleo.SemAcento(o.Nome).Contains(termo)) visiveis.Add(o);
            visiveis.Sort(CompararObras);

            reconstruindoLista = true;
            lista.BeginUpdate();
            try
            {
                lista.Items.Clear();
                foreach (Obra o in visiveis)
                {
                    ListViewItem item = new ListViewItem(o.Nome);
                    item.Tag = o;
                    PreencherLinha(item, o);
                    item.Checked = obrasMarcadas.Contains(o.Nome);
                    lista.Items.Add(item);
                }
                for (int i = 0; i < lista.Columns.Count; i++)
                    lista.Columns[i].Text = Titulos[i] + (i == colunaOrdem ? (ordemDesc ? "  ▼" : "  ▲") : "");
            }
            finally
            {
                lista.EndUpdate();
                reconstruindoLista = false;
            }

            if (obras.Count > 0 && visiveis.Count == 0)
            {
                lblVazio.Text = "Nenhuma obra com \"" + txtPesquisar.Text.Trim() + "\".";
                lblVazio.Visible = true;
            }
            else if (obras.Count == 0 && !lblTitulo.Text.StartsWith("Procurando"))
            {
                lblVazio.Text = "Nenhum ensaio encontrado nas pastas configuradas." + Environment.NewLine + "Confira as pastas em Configurar.";
                lblVazio.Visible = true;
            }
            else lblVazio.Visible = false;

            AtualizarResumoSelecao();
        }

        private void Lista_ColumnClick(object sender, ColumnClickEventArgs e)
        {
            if (e.Column == colunaOrdem) ordemDesc = !ordemDesc;
            else
            {
                colunaOrdem = e.Column;
                // nome comeca de A-Z; data, quantidade e pendencia comecam do maior
                ordemDesc = e.Column != ColObra;
            }
            AplicarFiltroObras();
        }

        private void Lista_ItemCheck(object sender, ItemCheckEventArgs e)
        {
            // ListView com checkbox inverte a marca no duplo clique: o
            // operador clicava duas vezes "para garantir" e desmarcava.
            if (ignorarCheckDuploClique) { e.NewValue = e.CurrentValue; return; }
            if (reconstruindoLista) return;
            Obra obra = lista.Items[e.Index].Tag as Obra;
            if (obra == null) return;
            if (e.NewValue == CheckState.Checked) obrasMarcadas.Add(obra.Nome);
            else obrasMarcadas.Remove(obra.Nome);
        }

        private void Lista_MouseDown(object sender, MouseEventArgs e)
        {
            if (e.Clicks > 1) { ignorarCheckDuploClique = true; return; }
            ListViewHitTestInfo hit = lista.HitTest(e.Location);
            // clique na caixinha o proprio ListView ja trata; no resto da
            // linha, marca/desmarca tambem (alvo grande para o dedo)
            if (hit.Item != null && hit.Location != ListViewHitTestLocations.StateImage && e.Button == MouseButtons.Left)
                hit.Item.Checked = !hit.Item.Checked;
        }

        private void Lista_KeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter && lista.FocusedItem != null)
            {
                lista.FocusedItem.Checked = !lista.FocusedItem.Checked;
                e.Handled = true;
            }
        }

        private void Form_KeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Escape && txtPesquisar.Text.Length > 0) { txtPesquisar.Clear(); e.Handled = true; }
            else if (e.KeyCode == Keys.F5 && btnAtualizar.Enabled) { AtualizarLista(); e.Handled = true; }
            else if (e.Control && e.KeyCode == Keys.F) { txtPesquisar.Focus(); txtPesquisar.SelectAll(); e.Handled = true; }
            else if (e.KeyCode == Keys.Down && txtPesquisar.Focused && lista.Items.Count > 0)
            {
                lista.Focus();
                lista.Items[0].Selected = true;
                lista.Items[0].Focused = true;
                e.Handled = true;
            }
        }

        private void MarcarPendentes()
        {
            reconstruindoLista = true;
            try
            {
                foreach (ListViewItem item in lista.Items)
                {
                    Obra o = (Obra)item.Tag;
                    if (o.Pendentes > 0) { obrasMarcadas.Add(o.Nome); item.Checked = true; }
                }
            }
            finally { reconstruindoLista = false; }
            AtualizarResumoSelecao();
        }

        private void DesmarcarTodas()
        {
            obrasMarcadas.Clear();
            reconstruindoLista = true;
            try { foreach (ListViewItem item in lista.Items) item.Checked = false; }
            finally { reconstruindoLista = false; }
            AtualizarResumoSelecao();
        }

        private void AtualizarResumoSelecao()
        {
            if (btnSincronizar == null) return;
            int nObras = 0, nEnsaios = 0, nPendentes = 0;
            bool pendenciaConhecida = true;
            foreach (Obra o in obras)
            {
                if (!obrasMarcadas.Contains(o.Nome)) continue;
                nObras++;
                nEnsaios += o.Arquivos.Count;
                if (o.Pendentes < 0) pendenciaConhecida = false;
                else nPendentes += o.Pendentes;
            }

            // Tudo que esta marcado ja consta como enviado: o unico motivo para
            // mandar de novo e desconfiar do registro (ex.: ensaio que so foi
            // para o pendrive na versao antiga). Ai o botao vira "Reenviar".
            modoReenvio = !exportando && nObras > 0 && pendenciaConhecida && nPendentes == 0;

            int comPendencia = 0;
            foreach (Obra o in obras) if (o.Pendentes > 0) comPendencia++;
            lnkPendentes.Enabled = comPendencia > 0;
            lnkNenhuma.Enabled = nObras > 0;

            if (nObras == 0)
            {
                lblSelecao.Text = "Marque as obras que quer enviar (clique na linha).";
                lblSelecao.ForeColor = Cinza;
                btnSincronizar.Text = exportando ? "Exportar para o pendrive" : "Enviar para a nuvem";
            }
            else
            {
                lblSelecao.ForeColor = Color.FromArgb(17, 24, 39);
                lblSelecao.Text = Plural(nObras, "obra marcada", "obras marcadas") + " · " + Plural(nEnsaios, "ensaio", "ensaios")
                    + (pendenciaConhecida ? " · " + nPendentes + " a enviar" : "");
                string alvo = Plural(nObras, "obra", "obras");
                if (modoReenvio)
                    btnSincronizar.Text = "Reenviar " + alvo + " (conferir no servidor)";
                else
                    btnSincronizar.Text = (exportando ? "Exportar " : "Enviar ") + alvo
                        + (pendenciaConhecida && nPendentes > 0 ? " (" + Plural(nPendentes, "ensaio", "ensaios") + ")" : "")
                        + (exportando ? " para o pendrive" : "");
            }
            bool ocupado = trabalhador != null && trabalhador.IsBusy;
            btnSincronizar.Enabled = nObras > 0 && !ocupado;
            PintarBotaoPrincipal();
        }

        private void PintarBotaoPrincipal()
        {
            if (btnSincronizar.Enabled)
            {
                btnSincronizar.BackColor = exportando ? Ambar : Verde;
                btnSincronizar.ForeColor = Color.White;
            }
            else
            {
                btnSincronizar.BackColor = Color.FromArgb(229, 231, 235);
                btnSincronizar.ForeColor = Cinza;
            }
        }

        private void AtualizarTopoResumo()
        {
            if (topoFixo) return;
            int pend = 0, obrasPend = 0;
            bool completo = true;
            foreach (Obra o in obras)
            {
                if (o.Pendentes < 0) { completo = false; continue; }
                pend += o.Pendentes;
                if (o.Pendentes > 0) obrasPend++;
            }

            string titulo;
            Color fundo = online ? VerdeClaro : AmbarClaro, texto = online ? Verde : Ambar;
            if (obras.Count == 0) titulo = "Nenhum ensaio encontrado";
            else if (!completo) titulo = Plural(obras.Count, "obra", "obras") + " · " + Plural(totalEnsaios, "ensaio", "ensaios") + " — conferindo o que falta enviar…";
            else if (pend == 0) titulo = "✓ Tudo na nuvem — " + Plural(obras.Count, "obra", "obras") + ", " + Plural(totalEnsaios, "ensaio", "ensaios");
            else
            {
                titulo = Plural(pend, "ensaio", "ensaios") + " para enviar em " + Plural(obrasPend, "obra", "obras");
                if (online) { fundo = AmbarClaro; texto = Ambar; }
            }
            Topo(titulo, LinhaEquipamento(), fundo, texto);
        }

        private void AtualizarLista()
        {
            if (verificador.IsBusy) { verificador.CancelAsync(); reverificarAoTerminar = true; }
            Cursor = Cursors.WaitCursor;
            Topo("Procurando ensaios...", "", VerdeClaro, Verde);
            Application.DoEvents();

            List<FileInfo> todos = Nucleo.Varrer(cfg);
            totalEnsaios = todos.Count;
            obras = Nucleo.AgruparPorObra(todos);
            // marca de obra que sumiu da pasta nao pode ficar valendo
            HashSet<string> existentes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (Obra o in obras) existentes.Add(o.Nome);
            obrasMarcadas.RemoveWhere(delegate(string n) { return !existentes.Contains(n); });

            online = !string.IsNullOrEmpty(cfg.Token) && !string.IsNullOrEmpty(cfg.UrlIngerir) && Nucleo.TemInternet();
            exportando = !online;
            AplicarFiltroObras();
            AtualizarTopoResumo();
            Cursor = Cursors.Default;

            // Nao calcula sha de 31 mil arquivos antes de mostrar a tela: num
            // Atom de 1 GHz isso levaria minutos. Confere em segundo plano,
            // da obra mais recente para a mais antiga, com cache.
            if (!verificador.IsBusy) verificador.RunWorkerAsync(new List<Obra>(obras));
        }

        // ---- verificacao em segundo plano -------------------------------------

        private void Verificador_DoWork(object sender, System.ComponentModel.DoWorkEventArgs e)
        {
            System.ComponentModel.BackgroundWorker bw = (System.ComponentModel.BackgroundWorker)sender;
            List<Obra> alvo = (List<Obra>)e.Argument;
            Dictionary<string, bool> enviados = Nucleo.LerEnviados();
            Dictionary<string, bool> exportados = Nucleo.LerExportados();
            for (int i = 0; i < alvo.Count; i++)
            {
                if (bw.CancellationPending) { e.Cancel = true; return; }
                alvo[i].Pendentes = Nucleo.ContarPendentes(alvo[i], enviados, exportados);
                bw.ReportProgress(0, alvo[i]);
            }
        }

        private void Verificador_Progresso(object sender, System.ComponentModel.ProgressChangedEventArgs e)
        {
            Obra o = (Obra)e.UserState;
            foreach (ListViewItem item in lista.Items)
                if (item.Tag == o) { PreencherLinha(item, o); break; }
            AtualizarTopoResumo();
            AtualizarResumoSelecao();
        }

        private void Verificador_Fim(object sender, System.ComponentModel.RunWorkerCompletedEventArgs e)
        {
            if (reverificarAoTerminar)
            {
                reverificarAoTerminar = false;
                verificador.RunWorkerAsync(new List<Obra>(obras));
                return;
            }
            if (colunaOrdem == ColSituacao) AplicarFiltroObras();
            AtualizarTopoResumo();
            AtualizarResumoSelecao();
        }

        // ---- botoes -------------------------------------------------------------

        private void BtnAtualizar_Click(object sender, EventArgs e) { topoFixo = false; AtualizarLista(); }

        private void BtnConfig_Click(object sender, EventArgs e)
        {
            using (FormConfig f = new FormConfig(cfg))
            {
                if (f.ShowDialog(this) == DialogResult.OK)
                {
                    cfg.Salvar();
                    Escrever("configuração salva em " + Config.CaminhoConfig);
                    Escrever("machine_id deste equipamento: " + cfg.MachineId);
                    AtualizarLista();
                }
            }
        }

        private void BtnSincronizar_Click(object sender, EventArgs e)
        {
            if (obrasMarcadas.Count == 0) return;
            topoFixo = false;

            online = !string.IsNullOrEmpty(cfg.Token) && !string.IsNullOrEmpty(cfg.UrlIngerir) && Nucleo.TemInternet();
            exportando = !online;

            if (!exportando && (string.IsNullOrEmpty(cfg.UrlIngerir) || string.IsNullOrEmpty(cfg.Token)))
            {
                MessageBox.Show(this, "Falta configurar o endereço e o token. Clique em Configurar.", "SincronPIT",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            if (exportando)
            {
                using (FolderBrowserDialog dlg = new FolderBrowserDialog())
                {
                    dlg.Description = "Escolha o pendrive para exportar os ensaios.";
                    if (!string.IsNullOrEmpty(cfg.PastaExport) && Directory.Exists(cfg.PastaExport))
                        dlg.SelectedPath = cfg.PastaExport;
                    if (dlg.ShowDialog(this) != DialogResult.OK) return;
                    cfg.PastaExport = dlg.SelectedPath;
                    cfg.Salvar();
                }
            }

            bool conferir = modoReenvio && !exportando;
            if (conferir)
            {
                DialogResult resp = MessageBox.Show(this,
                    "Estas obras já constam como enviadas.\n\n" +
                    "Reenviar confere no servidor: o que já está na nuvem é ignorado (nada duplica) " +
                    "e o que faltar sobe agora.\n\n" +
                    "Use quando um ensaio não aparece na nuvem — por exemplo, os que foram só para " +
                    "o pendrive na versão antiga do programa.\n\nReenviar?",
                    "SincronPIT", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (resp != DialogResult.Yes) return;
            }

            // A verificacao e o envio usam o mesmo cache; um de cada vez.
            if (verificador.IsBusy) verificador.CancelAsync();

            List<FileInfo> arquivos = new List<FileInfo>();
            List<Obra> ordem = new List<Obra>(obras);
            ordem.Sort(delegate(Obra a, Obra b) { return b.Ultimo.CompareTo(a.Ultimo); });
            foreach (Obra o in ordem)
                if (obrasMarcadas.Contains(o.Nome)) arquivos.AddRange(o.Arquivos);

            btnSincronizar.Enabled = false;
            btnAtualizar.Enabled = false;
            btnConfig.Enabled = false;
            lista.Enabled = false;
            barra.Value = 0;
            barra.Maximum = Math.Max(1, arquivos.Count);
            Escrever((exportando ? "exportando " : conferir ? "reenviando (conferindo no servidor) " : "enviando ")
                + Plural(arquivos.Count, "arquivo", "arquivos") + " de " + Plural(obrasMarcadas.Count, "obra", "obras"));
            Topo((exportando ? "Exportando" : "Enviando") + "… não feche o programa", "", online ? VerdeClaro : AmbarClaro, online ? Verde : Ambar);

            trabalhador.RunWorkerAsync(new object[] { arquivos, conferir });
        }

        private void Trabalhador_DoWork(object sender, System.ComponentModel.DoWorkEventArgs e)
        {
            object[] args = (object[])e.Argument;
            List<FileInfo> arquivos = (List<FileInfo>)args[0];
            bool conferir = (bool)args[1];
            System.ComponentModel.BackgroundWorker bw = (System.ComponentModel.BackgroundWorker)sender;

            // O trabalho roda fora da thread da interface: com 31 mil arquivos
            // a janela ficaria "nao respondendo" e o operador acharia que
            // travou.
            Nucleo.Progresso p = delegate(int i, int total, string nome)
            {
                int pct = total > 0 ? (int)(100.0 * i / total) : 100;
                bw.ReportProgress(pct, i + "|" + total + "|" + nome);
            };
            e.Result = Nucleo.Sincronizar(cfg, arquivos, exportando, conferir, p);
        }

        private void Trabalhador_Progresso(object sender, System.ComponentModel.ProgressChangedEventArgs e)
        {
            string[] partes = ((string)e.UserState).Split('|');
            int i = int.Parse(partes[0]);
            barra.Value = Math.Min(i, barra.Maximum);
            lblTitulo.Text = (exportando ? "Exportando " : "Enviando ") + partes[0] + " de " + partes[1] + "… não feche o programa";
            lblSub.Text = partes[2];
        }

        private void Trabalhador_Fim(object sender, System.ComponentModel.RunWorkerCompletedEventArgs e)
        {
            btnAtualizar.Enabled = true;
            btnConfig.Enabled = true;
            lista.Enabled = true;

            if (e.Error != null)
            {
                Escrever("ERRO: " + e.Error.Message);
                AtualizarLista();
                topoFixo = true;
                Topo("Algo deu errado no envio", e.Error.Message, VermelhoClaro, Vermelho);
                return;
            }

            Resultado r = (Resultado)e.Result;
            Escrever("novos: " + r.Novos + "   já existiam: " + r.Duplicados +
                     "   falhas: " + r.Falhas + "   recusados: " + r.Permanentes);
            for (int i = 0; i < r.Erros.Count && i < 20; i++) Escrever("  " + r.Erros[i]);
            if (r.Erros.Count > 20) Escrever("  ... e mais " + (r.Erros.Count - 20));
            if (r.Falhas > 0)
                Escrever("as falhas são temporárias: clique de novo mais tarde que ele retoma de onde parou");

            // obras que terminaram sem falha saem da selecao
            if (r.Falhas == 0 && r.Permanentes == 0) obrasMarcadas.Clear();
            AtualizarLista();

            string verbo = exportando ? "exportados" : "enviados";
            topoFixo = true;
            if (r.Falhas == 0 && r.Permanentes == 0)
                Topo("✓ Pronto: " + r.Novos + " " + verbo + (r.Duplicados > 0 ? ", " + r.Duplicados + " já estavam lá" : ""),
                    exportando
                        ? "Estão no pendrive, mas ainda não na nuvem: quando tiver internet, clique em Enviar."
                        : LinhaEquipamento(),
                    VerdeClaro, Verde);
            else
                Topo("Concluído com problemas: " + r.Novos + " " + verbo + ", " + (r.Falhas + r.Permanentes) + " com erro",
                    r.Falhas > 0 ? "Tente de novo mais tarde: ele continua de onde parou. Detalhes no registro abaixo." : "Detalhes no registro abaixo.",
                    VermelhoClaro, Vermelho);
        }
    }

    // ========================================================================
    // Configuracao — janela simples
    // ========================================================================
    public class FormConfig : Form
    {
        private Config cfg;
        private TextBox txtUrl, txtToken, txtPastas;

        public FormConfig(Config c)
        {
            cfg = c;
            Text = "SincronPIT - configuracao";
            ClientSize = new Size(560, 300);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            MaximizeBox = false; MinimizeBox = false;
            Font = new Font("Segoe UI", 9f);

            Label l1 = new Label();
            l1.Text = "URL da funcao ingerir:";
            l1.Location = new Point(12, 14); l1.Size = new Size(200, 18);
            Controls.Add(l1);

            txtUrl = new TextBox();
            txtUrl.Location = new Point(12, 34); txtUrl.Size = new Size(536, 22);
            txtUrl.Text = cfg.UrlIngerir;
            Controls.Add(txtUrl);

            Label l2 = new Label();
            l2.Text = "Token deste equipamento:";
            l2.Location = new Point(12, 66); l2.Size = new Size(240, 18);
            Controls.Add(l2);

            txtToken = new TextBox();
            txtToken.Location = new Point(12, 86); txtToken.Size = new Size(536, 22);
            txtToken.Text = cfg.Token;
            // Token nao fica visivel na tela: o PIT-Q e um painel em obra, com
            // gente em volta.
            txtToken.UseSystemPasswordChar = true;
            Controls.Add(txtToken);

            Label l3 = new Label();
            l3.Text = "Pastas onde o PIT-Q salva (uma por linha):";
            l3.Location = new Point(12, 118); l3.Size = new Size(360, 18);
            Controls.Add(l3);

            txtPastas = new TextBox();
            txtPastas.Location = new Point(12, 138); txtPastas.Size = new Size(536, 76);
            txtPastas.Multiline = true;
            txtPastas.ScrollBars = ScrollBars.Vertical;
            txtPastas.Text = string.Join(Environment.NewLine, cfg.Pastas.ToArray());
            Controls.Add(txtPastas);

            Label l4 = new Label();
            l4.Text = "machine_id: " + cfg.MachineId;
            l4.Location = new Point(12, 222); l4.Size = new Size(536, 18);
            l4.ForeColor = Color.Gray;
            Controls.Add(l4);

            Button ok = new Button();
            ok.Text = "Salvar"; ok.Location = new Point(372, 254); ok.Size = new Size(84, 30);
            ok.Click += new EventHandler(delegate(object s, EventArgs e)
            {
                cfg.UrlIngerir = txtUrl.Text.Trim();
                cfg.Token = txtToken.Text.Trim();
                List<string> pastas = new List<string>();
                foreach (string linha in txtPastas.Lines)
                {
                    string p = linha.Trim();
                    if (p.Length > 0) pastas.Add(p);
                }
                if (pastas.Count > 0) cfg.Pastas = pastas;
                DialogResult = DialogResult.OK;
            });
            Controls.Add(ok);

            Button cancelar = new Button();
            cancelar.Text = "Cancelar"; cancelar.Location = new Point(464, 254); cancelar.Size = new Size(84, 30);
            cancelar.DialogResult = DialogResult.Cancel;
            Controls.Add(cancelar);

            AcceptButton = ok; CancelButton = cancelar;
        }
    }

    // ========================================================================
    // Entrada
    // ========================================================================
    public static class Programa
    {
        [DllImport("kernel32.dll")]
        private static extern bool AttachConsole(int pid);

        [STAThread]
        public static int Main(string[] args)
        {
            if (args.Length > 0 && (args[0] == "--teste" || args[0] == "-teste"))
            {
                // App de janela nao tem console proprio; anexa ao do chamador
                // para que o autoteste possa ser lido no terminal.
                AttachConsole(-1);
                return Autoteste.Rodar();
            }

            // Windows 10 1607 negocia TLS 1.0 por padrao no .NET Framework, e
            // o Supabase recusa. O erro seria um "conexao encerrada" generico
            // que nao aponta para lugar nenhum. 3072 = Tls12, escrito como
            // numero porque o enum nao existe em alvos antigos.
            try { ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072; }
            catch { }

            // Envio de um arquivo pela linha de comando. Existe para dois
            // usos reais: verificar a ligacao com o servidor sem depender de
            // clicar na janela, e dar ao suporte uma forma de reproduzir uma
            // falha exatamente como o operador a viu.
            if (args.Length > 1 && (args[0] == "--enviar" || args[0] == "-enviar"))
            {
                AttachConsole(-1);
                try
                {
                    Config cfg = Config.Carregar();
                    if (string.IsNullOrEmpty(cfg.UrlIngerir) || string.IsNullOrEmpty(cfg.Token))
                    {
                        Console.WriteLine("faltam url e token na configuracao (" + Config.CaminhoConfig + ")");
                        return 2;
                    }
                    FileInfo fi = new FileInfo(args[1]);
                    if (!fi.Exists) { Console.WriteLine("arquivo nao encontrado: " + args[1]); return 2; }

                    string sha = Nucleo.Sha256Arquivo(fi.FullName);
                    string detalhe;
                    Estado e = Nucleo.Enviar(cfg, fi, sha, out detalhe);
                    Console.WriteLine("machine_id : " + cfg.MachineId);
                    Console.WriteLine("arquivo    : " + fi.Name + "  " + fi.Length + " bytes");
                    Console.WriteLine("sha256     : " + sha);
                    Console.WriteLine("resultado  : " + e + (detalhe.Length > 0 ? ("  (" + detalhe + ")") : ""));
                    if (e == Estado.Enviado || e == Estado.Duplicado)
                    {
                        Nucleo.RegistrarEnviado(sha);
                        return 0;
                    }
                    return 1;
                }
                catch (Exception ex) { Console.WriteLine("ERRO: " + ex.Message); return 1; }
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new FormPrincipal());
            return 0;
        }
    }

    // ========================================================================
    // Autoteste — sem janela e sem rede
    // ========================================================================
    public static class Autoteste
    {
        private static int falhas;

        private static void Verificar(string nome, bool ok, string detalhe)
        {
            if (ok) Console.WriteLine("  ok    " + nome);
            else { Console.WriteLine("  FALHA " + nome + "  -> " + detalhe); falhas++; }
        }

        public static int Rodar()
        {
            falhas = 0;
            string tmp = Path.Combine(Path.GetTempPath(), "sincronpit-teste-" + Guid.NewGuid().ToString("N").Substring(0, 8));
            string origem = Path.Combine(tmp, "origem\\OBRA X");
            string origemY = Path.Combine(tmp, "origem\\OBRA Y");
            string espelho = Path.Combine(tmp, "espelho\\OBRA X");
            string export = Path.Combine(tmp, "export");
            Directory.CreateDirectory(origem);
            Directory.CreateDirectory(origemY);
            Directory.CreateDirectory(espelho);
            Directory.CreateDirectory(export);

            byte[] a = new byte[200]; for (int i = 0; i < 200; i++) a[i] = (byte)(i + 1);
            byte[] b = new byte[200]; for (int i = 0; i < 200; i++) b[i] = (byte)(i + 50);
            byte[] c = new byte[160]; for (int i = 0; i < 160; i++) c[i] = (byte)(i + 90);

            File.WriteAllBytes(Path.Combine(origem, "E01.PTE"), a);
            File.WriteAllBytes(Path.Combine(origem, "E02.PTE"), b);
            File.WriteAllBytes(Path.Combine(origemY, "E01.PTE"), c);   // outra obra, mesmo nome
            File.Copy(Path.Combine(origem, "E01.PTE"), Path.Combine(espelho, "E01.PTE"));
            File.Copy(Path.Combine(origem, "E02.PTE"), Path.Combine(espelho, "OUTRO-NOME.PTE"));
            File.WriteAllText(Path.Combine(origem, "leiame.txt"), "ignorar");

            // OBRA Y foi ensaiada depois da OBRA X (que tem mais ensaios)
            DateTime antigo = new DateTime(2026, 10, 20, 9, 0, 0);
            foreach (string f in Directory.GetFiles(origem)) File.SetLastWriteTime(f, antigo);
            foreach (string f in Directory.GetFiles(espelho)) File.SetLastWriteTime(f, antigo);
            File.SetLastWriteTime(Path.Combine(origemY, "E01.PTE"), antigo.AddDays(2));

            Config cfg = new Config();
            cfg.UrlIngerir = ""; // autoteste nunca acessa o servidor real
            cfg.Pastas = new List<string>(new string[] { Path.Combine(tmp, "origem"), Path.Combine(tmp, "espelho") });
            cfg.PastaExport = export;
            Config.PastaBaseForcada = Path.Combine(tmp, "dados-teste");
            CacheHash.CaminhoForcado = Path.Combine(tmp, "hashes-teste.txt");
            CacheHash.Descartar();

            // Isola o registro de enviados desta rodada de teste do registro
            // real do usuario.
            string enviadosReal = Config.CaminhoEnviados;
            string backup = null;
            if (File.Exists(enviadosReal))
            {
                backup = enviadosReal + ".bak-teste";
                File.Copy(enviadosReal, backup, true);
                File.Delete(enviadosReal);
            }
            string exportadosReal = Config.CaminhoExportados;
            string backupExp = null;
            if (File.Exists(exportadosReal))
            {
                backupExp = exportadosReal + ".bak-teste";
                File.Copy(exportadosReal, backupExp, true);
                File.Delete(exportadosReal);
            }

            Console.WriteLine();
            Console.WriteLine("autoteste SincronPIT");
            Console.WriteLine("  pasta temporaria: " + tmp);
            Console.WriteLine();

            try
            {
                VerificarPerfilEmbutido();
                List<FileInfo> ensaios = Nucleo.Varrer(cfg);
                Verificar("espelho colapsado, .txt ignorado (4 de 6)", ensaios.Count == 4, "achou " + ensaios.Count);

                int quantosE01 = ensaios.Count(f => f.Name.Equals("E01.PTE", StringComparison.OrdinalIgnoreCase));
                Verificar("obra diferente com mesmo nome nao colapsa", quantosE01 == 2, "E01.PTE apareceu " + quantosE01 + "x");

                Dictionary<string, string> antes = new Dictionary<string, string>();
                foreach (FileInfo f in ensaios) antes[f.FullName] = Nucleo.Sha256Arquivo(f.FullName);

                Resultado r = Nucleo.Sincronizar(cfg, ensaios, true, null);
                Verificar("exporta os 4 arquivos, inclusive conteudo duplicado com outro nome",
                          r.Novos == 4 && r.Duplicados == 0, "novos=" + r.Novos + " dup=" + r.Duplicados);
                Verificar("nenhuma falha", r.Falhas == 0, "falhas=" + r.Falhas);

                List<string> mudou = new List<string>();
                foreach (FileInfo f in ensaios)
                    if (Nucleo.Sha256Arquivo(f.FullName) != antes[f.FullName]) mudou.Add(f.Name);
                Verificar("nenhum ensaio original foi alterado", mudou.Count == 0, string.Join(", ", mudou.ToArray()));

                int existem = ensaios.Count(f => File.Exists(f.FullName));
                Verificar("todos os originais continuam existindo", existem == ensaios.Count, "sumiu algum");

                int totalDisco = Directory.GetFiles(Path.Combine(tmp, "origem"), "*", SearchOption.AllDirectories).Length
                               + Directory.GetFiles(Path.Combine(tmp, "espelho"), "*", SearchOption.AllDirectories).Length;
                Verificar("nada foi apagado das pastas de origem", totalDisco == 6, "sobrou " + totalDisco);

                string[] copiados = Directory.GetFiles(export, "*", SearchOption.AllDirectories);
                Verificar("exportou 4 arquivos", copiados.Length == 4, "exportou " + copiados.Length);

                bool integros = true;
                foreach (string cp in copiados)
                    if (!antes.ContainsValue(Nucleo.Sha256Arquivo(cp))) integros = false;
                Verificar("copia bate byte a byte com a origem", integros, "sha do destino nao confere");

                Verificar("nenhum .parcial ficou para tras",
                          !copiados.Any(x => x.EndsWith(".parcial")), "sobrou temporario");

                Resultado r2 = Nucleo.Sincronizar(cfg, ensaios, true, null);
                Verificar("segunda exportacao para o mesmo pendrive nao copia de novo",
                          r2.Novos == 0 && r2.Duplicados == 4, "novos=" + r2.Novos + " dup=" + r2.Duplicados);

                // Defeito ate 23/10/2026: exportar marcava como enviado e o
                // ensaio nunca mais subia para a nuvem.
                Verificar("exportar NAO marca como enviado para a nuvem",
                          Nucleo.LerEnviados().Count == 0, "enviados=" + Nucleo.LerEnviados().Count);
                Verificar("registro de exportados sobrevive a reinicio (3 hashes)",
                          Nucleo.LerExportados().Count == 3, "tem " + Nucleo.LerExportados().Count);

                List<Obra> obras = Nucleo.AgruparPorObra(ensaios);
                Verificar("agrupa por obra (X e Y)", obras.Count == 2, "obras=" + obras.Count);
                Verificar("ordem de execucao: obra ensaiada por ultimo vem primeiro",
                          obras.Count == 2 && obras[0].Nome == "OBRA Y", "primeira=" + (obras.Count > 0 ? obras[0].Nome : "-"));

                Obra obraX = obras[1];
                int pendX = Nucleo.ContarPendentes(obraX, Nucleo.LerEnviados(), Nucleo.LerExportados());
                Verificar("ensaio que so foi para o pendrive continua pendente para a nuvem",
                          pendX == 2 && obraX.NoPendrive == 2, "pendentes=" + pendX + " noPendrive=" + obraX.NoPendrive);

                // simula a nuvem confirmando os dois ensaios unicos da OBRA X
                foreach (FileInfo f in obraX.Arquivos)
                    if (!Nucleo.LerEnviados().ContainsKey(CacheHash.Sha(f))) Nucleo.RegistrarEnviado(CacheHash.Sha(f));
                pendX = Nucleo.ContarPendentes(obraX, Nucleo.LerEnviados());
                Verificar("obra ja enviada para a nuvem nao tem pendencia", pendX == 0, "pendentes=" + pendX);

                Resultado rPula = Nucleo.Sincronizar(cfg, obraX.Arquivos, false, false, null);
                Verificar("envio normal pula o que ja esta na nuvem",
                          rPula.Duplicados == obraX.Arquivos.Count && rPula.Falhas == 0, "dup=" + rPula.Duplicados + " falhas=" + rPula.Falhas);

                // sem URL configurada o envio falha (temporario) sem tocar na
                // rede: prova que o reenvio TENTA mandar em vez de pular
                Resultado rConf = Nucleo.Sincronizar(cfg, obraX.Arquivos, false, true, null);
                Verificar("reenviar confere no servidor em vez de pular",
                          rConf.Falhas == 2 && rConf.Duplicados == 1, "falhas=" + rConf.Falhas + " dup=" + rConf.Duplicados);

                Verificar("busca ignora acento e maiuscula",
                          Nucleo.SemAcento("SÃO JOSÉ - Caçapava").Contains(Nucleo.SemAcento("sao jose - cacapava")), "nao casou");

                int linhasCache = File.ReadAllLines(CacheHash.Caminho).Length;
                CacheHash.Descartar();
                string shaCache = CacheHash.Sha(ensaios[0]);
                Verificar("cache de hash reaproveita sem reler e bate com o sha real",
                          shaCache == antes[ensaios[0].FullName] && File.ReadAllLines(CacheHash.Caminho).Length == linhasCache,
                          "linhas antes=" + linhasCache + " depois=" + File.ReadAllLines(CacheHash.Caminho).Length);

                // pasta inexistente na configuracao nao pode derrubar a varredura
                cfg.Pastas.Add("Z:\\nao\\existe");
                List<FileInfo> aindaVai = Nucleo.Varrer(cfg);
                Verificar("pasta inexistente e ignorada sem erro", aindaVai.Count == 4, "achou " + aindaVai.Count);
            }
            catch (Exception ex)
            {
                Console.WriteLine("  EXCECAO: " + ex);
                falhas++;
            }
            finally
            {
                CacheHash.CaminhoForcado = null;
                CacheHash.Descartar();
                try { File.Delete(Config.CaminhoEnviados); } catch { }
                if (backup != null) { try { File.Copy(backup, enviadosReal, true); File.Delete(backup); } catch { } }
                try { File.Delete(exportadosReal); } catch { }
                if (backupExp != null) { try { File.Copy(backupExp, exportadosReal, true); File.Delete(backupExp); } catch { } }
                Config.PastaBaseForcada = null;
                try { Directory.Delete(tmp, true); } catch { }
            }

            Console.WriteLine();
            if (falhas == 0) { Console.WriteLine("TODOS OS TESTES PASSARAM"); return 0; }
            Console.WriteLine(falhas + " TESTE(S) FALHARAM");
            return 1;
        }

        private static void VerificarPerfilEmbutido()
        {
            if (!PerfilEmbutido.Ativo) return;
            string anterior = Config.PastaBaseForcada;
            Config.PastaBaseForcada = Path.Combine(anterior, "perfil-teste");
            try
            {
                Config novo = Config.Carregar();
                Verificar("exe abre com identidade e servidor embutidos sem TXT externo",
                    novo.MachineId == PerfilEmbutido.MachineId && novo.UrlIngerir == PerfilEmbutido.Url,
                    "perfil nao aplicado");
                Directory.CreateDirectory(Config.PastaBase);
                string legado = Path.Combine(Config.PastaBase, "config.txt");
                string texto = "machineid=" + PerfilEmbutido.MachineId + "\nurl=https://servidor-antigo.invalid/\ntoken=credencial-de-teste\npastas=C:\\pasta-de-teste\n";
                File.WriteAllText(legado, texto);
                string hash = new string('a', 64);
                File.WriteAllText(Path.Combine(Config.PastaBase, "enviados.txt"), hash + "\n");
                Config migrado = Config.Carregar();
                Verificar("adota token e pastas existentes e corrige servidor automaticamente",
                    migrado.Token == (PerfilEmbutido.Token.Length > 0 ? PerfilEmbutido.Token : "credencial-de-teste")
                    && migrado.Pastas.Count == 1 && migrado.Pastas[0] == "C:\\pasta-de-teste"
                    && migrado.UrlIngerir == PerfilEmbutido.Url, "migracao incorreta");
                Verificar("mantem historico e configuracao antiga intactos",
                    Nucleo.LerEnviados().ContainsKey(hash) && File.ReadAllText(legado) == texto,
                    "historico ou original alterado");
                File.WriteAllText(Config.CaminhoConfig, "machineid=outro-pit\ntoken=token-de-outro-pit\nurl=https://errado.invalid/\n");
                Config incorreto = Config.Carregar();
                Verificar("cada exe fixa seu PIT e rejeita token de outro equipamento",
                    incorreto.MachineId == PerfilEmbutido.MachineId && incorreto.Token == PerfilEmbutido.Token
                    && incorreto.UrlIngerir == PerfilEmbutido.Url, "misturou equipamentos");
            }
            finally { Config.PastaBaseForcada = anterior; }
        }
    }
}
