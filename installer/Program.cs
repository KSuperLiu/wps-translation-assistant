using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Security.Principal;
using System.Threading;
using System.Windows.Forms;

namespace TranslationAssistantSetup
{
    internal static class Program
    {
        public static byte[] Payload()
        {
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            using (var memory = new MemoryStream())
            { if (stream == null) throw new IOException("缺少内置安装资源。"); stream.CopyTo(memory); return memory.ToArray(); }
        }
        public static Version PayloadVersion()
        {
            using (var memory = new MemoryStream(Payload())) using (var zip = new ZipArchive(memory, ZipArchiveMode.Read))
            using (var source = zip.GetEntry(InstallPaths.Marker).Open()) using (var output = new MemoryStream())
            { source.CopyTo(output); return PayloadManifest.Parse(output.ToArray()).Version; }
        }
        [STAThread]
        public static void Main(string[] args)
        {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            var paths = InstallPaths.CurrentUser();
            string self = Assembly.GetExecutingAssembly().Location;
            // 管理程序从临时副本运行，避免更新或卸载时锁住自身文件。
            if (String.Equals(Path.GetFullPath(self), Path.GetFullPath(paths.ManagerExe), StringComparison.OrdinalIgnoreCase))
            {
                string temporary = Path.Combine(Path.GetTempPath(), "WpsTranslationAssistant-Manage-" + Guid.NewGuid().ToString("N") + ".exe");
                try
                {
                    File.Copy(self, temporary);
                    Process.Start(new ProcessStartInfo(temporary, args.Contains("/uninstall") ? "/uninstall" : "/manage") { UseShellExecute = false });
                }
                catch (Exception error) { MessageBox.Show("无法启动管理程序：" + error.Message, "WPS 翻译助手", MessageBoxButtons.OK, MessageBoxIcon.Error); }
                return;
            }
            string sid = WindowsIdentity.GetCurrent().User.Value;
            bool created;
            using (var mutex = new Mutex(true, "Local\\WpsTranslationAssistant.Setup." + sid, out created))
            {
                if (!created) { MessageBox.Show("安装或管理窗口已经打开，请使用已有窗口。", "WPS 翻译助手"); return; }
                try { Application.Run(new SetupForm(paths, self, args.Contains("/uninstall"))); }
                catch (Exception error) { MessageBox.Show(error.Message, "WPS 翻译助手", MessageBoxButtons.OK, MessageBoxIcon.Error); }
            }
        }
    }

    internal sealed class SetupForm : Form
    {
        private readonly InstallPaths paths;
        private readonly InstallerEngine engine;
        private readonly string self;
        private readonly Version packageVersion;
        private readonly Label version, status;
        private readonly Button install, uninstall;
        private readonly Color green = Color.FromArgb(32, 116, 91);
        public SetupForm(InstallPaths paths, string self, bool uninstallMode)
        {
            this.paths = paths; this.self = self; packageVersion = Program.PayloadVersion();
            engine = new InstallerEngine(paths, new WindowsIntegration(), WindowsIntegration.WpsRunning, Program.Payload);
            Text = uninstallMode ? "卸载 WPS 翻译助手" : "WPS 翻译助手 · 安装与管理";
            ClientSize = new Size(650, 452); FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen; Font = new Font("Microsoft YaHei UI", 9F); BackColor = Color.FromArgb(247, 249, 248);
            Icon = Icon.ExtractAssociatedIcon(self);
            var header = new Panel { Dock = DockStyle.Top, Height = 98, BackColor = green };
            header.Controls.Add(new Label { Text = "WPS 翻译助手", ForeColor = Color.White, AutoSize = true, Font = new Font(Font.FontFamily, 21F, FontStyle.Bold), Location = new Point(25, 17) });
            header.Controls.Add(new Label { Text = "离线安装  ·  覆盖升级  ·  仅当前 Windows 用户", ForeColor = Color.FromArgb(220, 238, 229), AutoSize = true, Location = new Point(28, 62) });
            Controls.Add(header);
            version = new Label { Location = new Point(28, 119), Size = new Size(594, 28), Font = new Font(Font.FontFamily, 10F) }; Controls.Add(version);
            Controls.Add(new Label { Text = "插件安装位置", AutoSize = true, ForeColor = Color.FromArgb(91, 111, 101), Location = new Point(28, 157) });
            Controls.Add(new TextBox { Text = paths.Plugin, ReadOnly = true, Multiline = true, BorderStyle = BorderStyle.FixedSingle, Location = new Point(28, 180), Size = new Size(594, 48), BackColor = Color.White });
            Controls.Add(new Label { Text = "使用者无需 Node.js、网站或额外下载。\r\n安装和卸载前，请保存工作并正常关闭所有 WPS 窗口。", Location = new Point(28, 245), Size = new Size(594, 45), ForeColor = Color.FromArgb(75, 97, 86) });
            status = new Label { Location = new Point(28, 301), Size = new Size(594, 58), ForeColor = Color.FromArgb(75, 97, 86) }; Controls.Add(status);
            install = new Button { Location = new Point(28, 377), Size = new Size(190, 42), FlatStyle = FlatStyle.Flat, BackColor = green, ForeColor = Color.White, Text = "安装 / 升级" };
            install.FlatAppearance.BorderSize = 0; install.Click += delegate { Run(false); }; Controls.Add(install);
            uninstall = new Button { Location = new Point(232, 377), Size = new Size(150, 42), FlatStyle = FlatStyle.Flat, BackColor = Color.White, Text = "卸载插件" };
            uninstall.FlatAppearance.BorderColor = Color.FromArgb(203, 216, 208); uninstall.Click += delegate { Run(true); }; Controls.Add(uninstall);
            var backups = new LinkLabel { Text = "打开设置与备份目录", AutoSize = true, LinkColor = green, Location = new Point(445, 390) };
            backups.LinkClicked += delegate { Directory.CreateDirectory(paths.Data); Process.Start(new ProcessStartInfo(paths.Data) { UseShellExecute = true }); }; Controls.Add(backups);
            RefreshState(null);
            if (uninstallMode) ActiveControl = uninstall;
        }
        private void RefreshState(string result)
        {
            try
            {
                Version installed = engine.InstalledVersion(); bool registered = engine.IsRegistered();
                version.Text = "安装包版本：" + packageVersion + "      当前：" + (installed != null ? installed.ToString() : registered ? "开发版 / 网页版" : "未安装");
                install.Enabled = WindowsIntegration.WpsInstalled() && (installed == null || installed <= packageVersion);
                install.Text = installed != null && installed == packageVersion ? "修复当前版本" : registered || installed != null ? "升级 / 切换为离线版" : "安装翻译助手";
                uninstall.Enabled = registered || installed != null || File.Exists(paths.ManagerExe);
                status.Text = result ?? (!WindowsIntegration.WpsInstalled() ? "未检测到 WPS 表格。请先安装支持 JavaScript 加载项的 Windows WPS。"
                    : installed != null && installed > packageVersion ? "已安装更新版本，此安装包不会降级覆盖。"
                    : WindowsIntegration.WpsRunning() ? "WPS 当前仍在运行。准备好后关闭 WPS，再点击安装或卸载。" : "准备就绪。升级保留用户设置；其他 WPS 插件配置不受影响。");
            }
            catch (Exception error) { install.Enabled = false; uninstall.Enabled = false; status.Text = error.Message; }
        }
        private void Run(bool remove)
        {
            if (remove && MessageBox.Show("确定卸载 WPS 翻译助手？\r\n其他 WPS 插件不变，用户设置与备份会保留。", "卸载确认", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
            install.Enabled = false; uninstall.Enabled = false; UseWaitCursor = true;
            status.Text = remove ? "正在卸载…" : "正在校验资源并安装…"; Refresh();
            try
            {
                InstallResult result = remove ? engine.Uninstall() : engine.Install(self);
                RefreshState(remove ? "卸载完成。重新打开 WPS 后，翻译助手选项卡将消失。\r\n设置、未归属的用户文件及备份已保留。"
                    : "安装完成。重新打开 WPS 表格，点击“翻译助手 → 打开助手”。\r\n以后运行新版安装包即可升级；开始菜单和 Windows 应用列表中均可卸载。");
            }
            catch (Exception error)
            {
                try { Directory.CreateDirectory(paths.Data); File.AppendAllText(Path.Combine(paths.Data, "setup.log"), DateTime.Now.ToString("s") + " " + error + Environment.NewLine); } catch { }
                RefreshState(error.Message);
                MessageBox.Show(error.Message, "操作未完成", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            finally { UseWaitCursor = false; }
        }
    }
}
