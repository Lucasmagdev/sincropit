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

            UrlIngerir = "";
            Token = "";
            MachineId = "pit-" + Guid.NewGuid().ToString();
            Extensoes = new List<string>(new string[] { ".pte", ".ptn", ".pt2" });
            PastaExport = "";
        }

        public static string PastaDados
        {
            get
            {
                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "SincronPIT");
            }
        }

        public static string CaminhoConfig { get { return Path.Combine(PastaDados, "config.txt"); } }
        public static string CaminhoEnviados { get { return Path.Combine(PastaDados, "enviados.txt"); } }

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

        public static Dictionary<string, bool> LerEnviados()
        {
            Dictionary<string, bool> t = new Dictionary<string, bool>();
            try
            {
                if (!File.Exists(Config.CaminhoEnviados)) return t;
                foreach (string l in File.ReadAllLines(Config.CaminhoEnviados))
                {
                    string h = l.Trim();
                    if (h.Length == 64) t[h] = true;
                }
            }
            catch { }
            return t;
        }

        public static void RegistrarEnviado(string sha)
        {
            Directory.CreateDirectory(Config.PastaDados);
            // Append imediato. Se o app for fechado no meio, o que ja subiu
            // continua registrado e nao sobe de novo na proxima abertura.
            File.AppendAllText(Config.CaminhoEnviados, sha + Environment.NewLine);
        }

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
            }
            List<Obra> lista = new List<Obra>(mapa.Values);
            lista.Sort(delegate(Obra a, Obra b) { return b.Arquivos.Count.CompareTo(a.Arquivos.Count); });
            return lista;
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

        public static void Exportar(Config cfg, FileInfo f, string sha)
        {
            string obra = f.Directory != null ? f.Directory.Name : "sem-obra";
            string destino = Path.Combine(Path.Combine(cfg.PastaExport, cfg.MachineId), obra);
            Directory.CreateDirectory(destino);

            string ext = Path.GetExtension(f.Name);
            string baseNome = Path.GetFileNameWithoutExtension(f.Name);
            // sha no nome: dois ensaios de nome igual e conteudo diferente nao
            // se sobrescrevem no pendrive
            string alvo = Path.Combine(destino, baseNome + "." + sha.Substring(0, 12) + ext);

            // copia para temporario e renomeia: pendrive arrancado no meio nao
            // deixa arquivo parcial parecendo integro
            string tmp = alvo + ".parcial";
            File.Copy(f.FullName, tmp, true);
            if (File.Exists(alvo)) File.Delete(alvo);
            File.Move(tmp, alvo);
        }

        public delegate void Progresso(int indice, int total, string nome);

        public static Resultado Sincronizar(Config cfg, List<FileInfo> arquivos, bool exportar, Progresso aoProgredir)
        {
            Dictionary<string, bool> enviados = LerEnviados();
            Resultado res = new Resultado();
            res.Total = arquivos.Count;

            int i = 0;
            foreach (FileInfo f in arquivos)
            {
                i++;
                if (aoProgredir != null) aoProgredir(i, arquivos.Count, f.Name);

                string sha;
                try { sha = Sha256Arquivo(f.FullName); }
                catch (Exception ex)
                {
                    res.Falhas++;
                    res.Erros.Add(f.Name + " : nao consegui ler (" + ex.Message + ")");
                    continue;
                }

                // Dedup local: pega o reenvio e tambem a copia renomeada, que
                // escapa do colapso por caminho feito na varredura.
                if (enviados.ContainsKey(sha)) { res.Duplicados++; continue; }

                if (exportar)
                {
                    try
                    {
                        Exportar(cfg, f, sha);
                        RegistrarEnviado(sha); enviados[sha] = true; res.Novos++;
                    }
                    catch (Exception ex)
                    {
                        res.Falhas++;
                        res.Erros.Add(f.Name + " : falha ao copiar (" + ex.Message + ")");
                    }
                    continue;
                }

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
    // ========================================================================
    public class FormPrincipal : Form
    {
        private Config cfg;
        private Label lblStatus;
        private Label lblPesquisar;
        private TextBox txtPesquisar;
        private ListView lista;
        private ProgressBar barra;
        private TextBox log;
        private Button btnSincronizar, btnAtualizar, btnConfig;
        private System.ComponentModel.BackgroundWorker trabalhador;
        private bool exportando;
        private bool reconstruindoLista;
        private HashSet<string> obrasMarcadas = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        public FormPrincipal()
        {
            cfg = Config.Carregar();
            cfg.Salvar(); // grava o machineId ja na primeira abertura

            Text = "SincronPIT";
            ClientSize = new Size(720, 540);
            MinimumSize = new Size(660, 500);
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Segoe UI", 9f);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
            catch { }

            lblStatus = new Label();
            lblStatus.Location = new Point(12, 12);
            lblStatus.Size = new Size(692, 40);
            lblStatus.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            Controls.Add(lblStatus);

            lblPesquisar = new Label();
            lblPesquisar.Text = "Pesquisar obra:";
            lblPesquisar.Location = new Point(12, 59);
            lblPesquisar.Size = new Size(100, 22);
            lblPesquisar.TextAlign = ContentAlignment.MiddleLeft;
            Controls.Add(lblPesquisar);

            txtPesquisar = new TextBox();
            txtPesquisar.Location = new Point(116, 58);
            txtPesquisar.Size = new Size(588, 22);
            txtPesquisar.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            txtPesquisar.TextChanged += new EventHandler(delegate(object s, EventArgs e) { AplicarFiltroObras(); });
            Controls.Add(txtPesquisar);

            lista = new ListView();
            lista.Location = new Point(12, 88);
            lista.Size = new Size(692, 218);
            lista.View = View.Details;
            lista.CheckBoxes = true;
            lista.FullRowSelect = true;
            lista.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            lista.Columns.Add("Obra", 400);
            lista.Columns.Add("Ensaios", 90);
            lista.Columns.Add("Tamanho", 100);
            lista.ItemCheck += new ItemCheckEventHandler(Lista_ItemCheck);
            Controls.Add(lista);

            barra = new ProgressBar();
            barra.Location = new Point(12, 314);
            barra.Size = new Size(692, 18);
            barra.Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            Controls.Add(barra);

            log = new TextBox();
            log.Location = new Point(12, 340);
            log.Size = new Size(692, 148);
            log.Multiline = true;
            log.ScrollBars = ScrollBars.Vertical;
            log.ReadOnly = true;
            log.BackColor = Color.White;
            log.Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            Controls.Add(log);

            btnSincronizar = new Button();
            btnSincronizar.Text = "Sincronizar";
            btnSincronizar.Location = new Point(12, 496);
            btnSincronizar.Size = new Size(150, 32);
            btnSincronizar.Anchor = AnchorStyles.Left | AnchorStyles.Bottom;
            btnSincronizar.Click += new EventHandler(BtnSincronizar_Click);
            Controls.Add(btnSincronizar);

            btnAtualizar = new Button();
            btnAtualizar.Text = "Atualizar lista";
            btnAtualizar.Location = new Point(172, 496);
            btnAtualizar.Size = new Size(120, 32);
            btnAtualizar.Anchor = AnchorStyles.Left | AnchorStyles.Bottom;
            btnAtualizar.Click += new EventHandler(BtnAtualizar_Click);
            Controls.Add(btnAtualizar);

            btnConfig = new Button();
            btnConfig.Text = "Configurar";
            btnConfig.Location = new Point(302, 496);
            btnConfig.Size = new Size(110, 32);
            btnConfig.Anchor = AnchorStyles.Left | AnchorStyles.Bottom;
            btnConfig.Click += new EventHandler(BtnConfig_Click);
            Controls.Add(btnConfig);

            trabalhador = new System.ComponentModel.BackgroundWorker();
            trabalhador.WorkerReportsProgress = true;
            trabalhador.DoWork += new System.ComponentModel.DoWorkEventHandler(Trabalhador_DoWork);
            trabalhador.ProgressChanged += new System.ComponentModel.ProgressChangedEventHandler(Trabalhador_Progresso);
            trabalhador.RunWorkerCompleted += new System.ComponentModel.RunWorkerCompletedEventHandler(Trabalhador_Fim);

            Shown += new EventHandler(delegate(object s, EventArgs e) { AtualizarLista(); });
        }

        private void Escrever(string txt)
        {
            log.AppendText(DateTime.Now.ToString("HH:mm:ss") + "  " + txt + Environment.NewLine);
            log.SelectionStart = log.TextLength;
            log.ScrollToCaret();
        }

        private List<Obra> obras = new List<Obra>();

        private void Lista_ItemCheck(object sender, ItemCheckEventArgs e)
        {
            if (reconstruindoLista) return;
            Obra obra = lista.Items[e.Index].Tag as Obra;
            if (obra == null) return;
            if (e.NewValue == CheckState.Checked) obrasMarcadas.Add(obra.Nome);
            else obrasMarcadas.Remove(obra.Nome);
        }

        private void AplicarFiltroObras()
        {
            string termo = txtPesquisar == null ? "" : txtPesquisar.Text.Trim();
            reconstruindoLista = true;
            lista.BeginUpdate();
            try
            {
                lista.Items.Clear();
                foreach (Obra o in obras)
                {
                    if (termo.Length > 0 && o.Nome.IndexOf(termo, StringComparison.CurrentCultureIgnoreCase) < 0)
                        continue;

                    ListViewItem item = new ListViewItem(o.Nome);
                    item.SubItems.Add(o.Arquivos.Count.ToString());
                    item.SubItems.Add(Math.Round(o.Bytes / 1048576.0, 1).ToString("0.0") + " MB");
                    item.Tag = o;
                    item.Checked = obrasMarcadas.Contains(o.Nome);
                    lista.Items.Add(item);
                }
            }
            finally
            {
                lista.EndUpdate();
                reconstruindoLista = false;
            }
        }

        private void AtualizarLista()
        {
            Cursor = Cursors.WaitCursor;
            obrasMarcadas.Clear();
            lblStatus.Text = "Procurando ensaios...";
            Application.DoEvents();

            List<FileInfo> todos = Nucleo.Varrer(cfg);
            // Nao calcula sha de 31 mil arquivos so para montar a tela: num
            // Atom de 1 GHz isso levaria minutos. O hash sai na hora do envio,
            // onde ele e necessario de qualquer jeito.
            obras = Nucleo.AgruparPorObra(todos);
            AplicarFiltroObras();

            int jaEnviados = Nucleo.LerEnviados().Count;
            bool online = Nucleo.TemInternet();
            exportando = !online;
            btnSincronizar.Text = online ? "Sincronizar" : "Exportar";

            lblStatus.Text =
                todos.Count + " ensaios em " + obras.Count + " obras.   Ja sincronizados: " + jaEnviados + "." +
                Environment.NewLine +
                "Modo: " + (online ? "envio para a nuvem" : "SEM INTERNET - exportacao para pendrive") +
                "    Equipamento: " + cfg.MachineId;
            Cursor = Cursors.Default;
        }

        private void BtnAtualizar_Click(object sender, EventArgs e) { AtualizarLista(); }

        private void BtnConfig_Click(object sender, EventArgs e)
        {
            using (FormConfig f = new FormConfig(cfg))
            {
                if (f.ShowDialog(this) == DialogResult.OK)
                {
                    cfg.Salvar();
                    Escrever("configuracao salva em " + Config.CaminhoConfig);
                    Escrever("machine_id deste equipamento: " + cfg.MachineId);
                    AtualizarLista();
                }
            }
        }

        private void BtnSincronizar_Click(object sender, EventArgs e)
        {
            if (obrasMarcadas.Count == 0)
            {
                MessageBox.Show("Marque pelo menos uma obra na lista.", "SincronPIT");
                return;
            }

            bool online = Nucleo.TemInternet();
            exportando = !online;

            if (!exportando && (string.IsNullOrEmpty(cfg.UrlIngerir) || string.IsNullOrEmpty(cfg.Token)))
            {
                MessageBox.Show("Falta configurar a URL e o token. Clique em Configurar.", "SincronPIT");
                return;
            }

            if (exportando)
            {
                using (FolderBrowserDialog dlg = new FolderBrowserDialog())
                {
                    dlg.Description = "Sem internet. Escolha o pendrive para exportar os ensaios.";
                    if (dlg.ShowDialog(this) != DialogResult.OK) return;
                    cfg.PastaExport = dlg.SelectedPath;
                    cfg.Salvar();
                }
            }

            List<FileInfo> arquivos = new List<FileInfo>();
            foreach (Obra o in obras)
            {
                if (obrasMarcadas.Contains(o.Nome)) arquivos.AddRange(o.Arquivos);
            }

            btnSincronizar.Enabled = false;
            btnAtualizar.Enabled = false;
            btnConfig.Enabled = false;
            barra.Value = 0;
            barra.Maximum = arquivos.Count;
            Escrever("iniciando: " + arquivos.Count + " arquivos, modo " + (exportando ? "exportar" : "enviar"));

            trabalhador.RunWorkerAsync(arquivos);
        }

        private void Trabalhador_DoWork(object sender, System.ComponentModel.DoWorkEventArgs e)
        {
            List<FileInfo> arquivos = (List<FileInfo>)e.Argument;
            System.ComponentModel.BackgroundWorker bw = (System.ComponentModel.BackgroundWorker)sender;

            // O trabalho roda fora da thread da interface: com 31 mil arquivos
            // a janela ficaria "nao respondendo" e o operador acharia que
            // travou.
            Nucleo.Progresso p = delegate(int i, int total, string nome)
            {
                int pct = total > 0 ? (int)(100.0 * i / total) : 100;
                bw.ReportProgress(pct, i + "|" + total + "|" + nome);
            };
            e.Result = Nucleo.Sincronizar(cfg, arquivos, exportando, p);
        }

        private void Trabalhador_Progresso(object sender, System.ComponentModel.ProgressChangedEventArgs e)
        {
            string[] partes = ((string)e.UserState).Split('|');
            int i = int.Parse(partes[0]);
            barra.Value = Math.Min(i, barra.Maximum);
            lblStatus.Text = partes[0] + " de " + partes[1] + "   " + partes[2];
        }

        private void Trabalhador_Fim(object sender, System.ComponentModel.RunWorkerCompletedEventArgs e)
        {
            btnSincronizar.Enabled = true;
            btnAtualizar.Enabled = true;
            btnConfig.Enabled = true;

            if (e.Error != null) { Escrever("ERRO: " + e.Error.Message); AtualizarLista(); return; }

            Resultado r = (Resultado)e.Result;
            Escrever("novos: " + r.Novos + "   ja existiam: " + r.Duplicados +
                     "   falhas: " + r.Falhas + "   recusados: " + r.Permanentes);
            for (int i = 0; i < r.Erros.Count && i < 20; i++) Escrever("  " + r.Erros[i]);
            if (r.Erros.Count > 20) Escrever("  ... e mais " + (r.Erros.Count - 20));
            if (r.Falhas > 0)
                Escrever("as falhas sao temporarias: clique de novo mais tarde que ele retoma de onde parou");
            AtualizarLista();
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

            Config cfg = new Config();
            cfg.Pastas = new List<string>(new string[] { Path.Combine(tmp, "origem"), Path.Combine(tmp, "espelho") });
            cfg.PastaExport = export;

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

            Console.WriteLine();
            Console.WriteLine("autoteste SincronPIT");
            Console.WriteLine("  pasta temporaria: " + tmp);
            Console.WriteLine();

            try
            {
                List<FileInfo> ensaios = Nucleo.Varrer(cfg);
                Verificar("espelho colapsado, .txt ignorado (4 de 6)", ensaios.Count == 4, "achou " + ensaios.Count);

                int quantosE01 = ensaios.Count(f => f.Name.Equals("E01.PTE", StringComparison.OrdinalIgnoreCase));
                Verificar("obra diferente com mesmo nome nao colapsa", quantosE01 == 2, "E01.PTE apareceu " + quantosE01 + "x");

                Dictionary<string, string> antes = new Dictionary<string, string>();
                foreach (FileInfo f in ensaios) antes[f.FullName] = Nucleo.Sha256Arquivo(f.FullName);

                Resultado r = Nucleo.Sincronizar(cfg, ensaios, true, null);
                Verificar("sobe 3 unicos, sha256 pega a copia renomeada",
                          r.Novos == 3 && r.Duplicados == 1, "novos=" + r.Novos + " dup=" + r.Duplicados);
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
                Verificar("exportou 3 arquivos", copiados.Length == 3, "exportou " + copiados.Length);

                bool integros = true;
                foreach (string cp in copiados)
                    if (!antes.ContainsValue(Nucleo.Sha256Arquivo(cp))) integros = false;
                Verificar("copia bate byte a byte com a origem", integros, "sha do destino nao confere");

                Verificar("nenhum .parcial ficou para tras",
                          !copiados.Any(x => x.EndsWith(".parcial")), "sobrou temporario");

                Resultado r2 = Nucleo.Sincronizar(cfg, ensaios, true, null);
                Verificar("segunda rodada nao reenvia nada",
                          r2.Novos == 0 && r2.Duplicados == 4, "novos=" + r2.Novos + " dup=" + r2.Duplicados);

                Dictionary<string, bool> tabela = Nucleo.LerEnviados();
                Verificar("registro sobrevive a reinicio (3 hashes)", tabela.Count == 3, "tem " + tabela.Count);

                List<Obra> obras = Nucleo.AgruparPorObra(ensaios);
                Verificar("agrupa por obra (X e Y)", obras.Count == 2, "obras=" + obras.Count);

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
                try { File.Delete(Config.CaminhoEnviados); } catch { }
                if (backup != null) { try { File.Copy(backup, enviadosReal, true); File.Delete(backup); } catch { } }
                try { Directory.Delete(tmp, true); } catch { }
            }

            Console.WriteLine();
            if (falhas == 0) { Console.WriteLine("TODOS OS TESTES PASSARAM"); return 0; }
            Console.WriteLine(falhas + " TESTE(S) FALHARAM");
            return 1;
        }
    }
}
