using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Xml;

namespace TranslationAssistantSetup
{
    internal sealed class InstallPaths
    {
        public const string Product = "WpsTranslationAssistant";
        // WPS 按 name_version 寻址。固定加载容器版本保持本机存储地址稳定；
        // 业务发布版本由安装清单和 Windows 卸载项记录，与此协议版本独立。
        public const string LoaderVersion = "1.0.0";
        public const string PluginFolder = Product + "_" + LoaderVersion;
        public const string Marker = ".translation-assistant-install.xml";
        public const string Ownership = ".translation-assistant-owned";
        public readonly string Addons, Plugin, Manager, Data, Publish;
        public InstallPaths(string addons, string manager, string data)
        {
            Addons = Path.GetFullPath(addons); Plugin = Path.Combine(Addons, PluginFolder);
            Manager = Path.GetFullPath(manager); Data = Path.GetFullPath(data);
            Publish = Path.Combine(Addons, "publish.xml");
        }
        public string ManagerExe { get { return Path.Combine(Manager, "翻译助手管理.exe"); } }
        public static InstallPaths CurrentUser()
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return new InstallPaths(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "kingsoft", "wps", "jsaddons"),
                Path.Combine(local, "Programs", Product), Path.Combine(local, Product + "Data"));
        }
        public static string Inside(string root, string relative)
        {
            if (String.IsNullOrEmpty(relative) || Path.IsPathRooted(relative)) throw new IOException("安装包包含不安全的文件路径。");
            string value = relative.Replace('/', Path.DirectorySeparatorChar);
            if (value.Split(Path.DirectorySeparatorChar).Any(p => p == ".." || p == "." || p.Length == 0 || p.IndexOf(':') >= 0)) throw new IOException("安装包包含不安全的文件路径。");
            string target = Path.GetFullPath(Path.Combine(root, value));
            if (!target.StartsWith(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new IOException("文件路径超出安装目录。");
            return target;
        }
        public static void NoLinks(string root)
        {
            string cursor = Path.GetFullPath(root);
            while (!String.IsNullOrEmpty(cursor))
            {
                if ((Directory.Exists(cursor) || File.Exists(cursor)) && (File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0) throw new IOException("安装路径含符号链接或目录联接，请先移除冲突后重试。");
                cursor = Path.GetDirectoryName(cursor);
            }
        }
        public static void DeleteOwnedTree(string parent, string target, string prefix)
        {
            string full = Path.GetFullPath(target), parentFull = Path.GetFullPath(parent).TrimEnd(Path.DirectorySeparatorChar);
            if (!String.Equals(Path.GetDirectoryName(full), parentFull, StringComparison.OrdinalIgnoreCase) || !Path.GetFileName(full).StartsWith(prefix, StringComparison.Ordinal)) throw new IOException("拒绝清理不属于本安装器的目录。");
            NoLinks(full);
            if (Directory.Exists(full)) { CheckTree(full); Directory.Delete(full, true); }
        }
        public static void CheckTree(string root)
        {
            NoLinks(root);
            foreach (string file in Directory.GetFiles(root)) NoLinks(file);
            foreach (string directory in Directory.GetDirectories(root)) CheckTree(directory);
        }
        public static void CopyTree(string source, string target)
        {
            NoLinks(source); NoLinks(target); Directory.CreateDirectory(target);
            foreach (string file in Directory.GetFiles(source)) { NoLinks(file); File.Copy(file, Path.Combine(target, Path.GetFileName(file)), true); }
            foreach (string directory in Directory.GetDirectories(source)) CopyTree(directory, Path.Combine(target, Path.GetFileName(directory)));
        }
    }

    internal sealed class PayloadManifest
    {
        public Version Version;
        public readonly Dictionary<string, string> Files = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        public static PayloadManifest Parse(byte[] bytes)
        {
            var doc = SafeXml(bytes);
            if (doc.DocumentElement.Name != "translationAssistant" || doc.DocumentElement.GetAttribute("product") != InstallPaths.Product) throw new IOException("安装清单不属于 WPS 翻译助手。");
            var result = new PayloadManifest { Version = new Version(doc.DocumentElement.GetAttribute("version")) };
            foreach (XmlElement node in doc.SelectNodes("/translationAssistant/file"))
            {
                string path = node.GetAttribute("path").Replace('\\', '/');
                InstallPaths.Inside(Path.GetTempPath(), path);
                if (result.Files.ContainsKey(path)) throw new IOException("安装清单含重复文件。");
                result.Files.Add(path, node.GetAttribute("sha256"));
            }
            foreach (string required in new[] { "index.html", "pane.html", "ribbon.xml" }) if (!result.Files.ContainsKey(required)) throw new IOException("安装包缺少必要入口文件：" + required);
            return result;
        }
        public byte[] Serialize()
        {
            var doc = new XmlDocument(); var root = doc.CreateElement("translationAssistant"); doc.AppendChild(root);
            root.SetAttribute("product", InstallPaths.Product); root.SetAttribute("version", Version.ToString());
            foreach (var item in Files.OrderBy(p => p.Key)) { var node = doc.CreateElement("file"); node.SetAttribute("path", item.Key); node.SetAttribute("sha256", item.Value); root.AppendChild(node); }
            return XmlBytes(doc);
        }
        public static XmlDocument SafeXml(byte[] bytes)
        {
            var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null };
            var doc = new XmlDocument { PreserveWhitespace = true, XmlResolver = null };
            using (var input = new MemoryStream(bytes)) using (var reader = XmlReader.Create(input, settings)) doc.Load(reader);
            return doc;
        }
        public static byte[] XmlBytes(XmlDocument doc)
        {
            using (var memory = new MemoryStream())
            {
                using (var writer = XmlWriter.Create(memory, new XmlWriterSettings { Encoding = new UTF8Encoding(false), Indent = false })) doc.Save(writer);
                return memory.ToArray();
            }
        }
        public static string Hash(byte[] bytes) { using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", ""); }
    }

    internal interface IUserIntegration
    {
        object Capture();
        void Register(string version, InstallPaths paths);
        void Remove(InstallPaths paths);
        void Restore(object snapshot, InstallPaths paths);
    }

    internal sealed class InstallResult
    {
        public string Version, BackupDirectory;
        public bool RetainedUserFiles;
    }

    internal sealed class InstallerEngine
    {
        private readonly InstallPaths paths;
        private readonly IUserIntegration integration;
        private readonly Func<bool> wpsRunning;
        private readonly Func<byte[]> payload;
        public InstallerEngine(InstallPaths paths, IUserIntegration integration, Func<bool> wpsRunning, Func<byte[]> payload)
        { this.paths = paths; this.integration = integration; this.wpsRunning = wpsRunning; this.payload = payload; }

        public bool IsRegistered()
        {
            return OwnNodes(ReadConfig()).Count != 0;
        }
        public Version InstalledVersion()
        {
            string marker = Path.Combine(paths.Plugin, InstallPaths.Marker);
            if (File.Exists(marker)) return PayloadManifest.Parse(File.ReadAllBytes(marker)).Version;
            foreach (XmlElement node in OwnNodes(ReadConfig())) { Version version; if (Version.TryParse(node.GetAttribute("version"), out version)) return version; }
            return null;
        }
        private XmlDocument ReadConfig()
        {
            InstallPaths.NoLinks(paths.Publish);
            var doc = File.Exists(paths.Publish) ? PayloadManifest.SafeXml(File.ReadAllBytes(paths.Publish)) : new XmlDocument();
            if (doc.DocumentElement == null) doc.AppendChild(doc.CreateElement("jsplugins"));
            if (doc.DocumentElement.Name != "jsplugins") throw new IOException("WPS 加载项配置格式异常，已停止操作。");
            return doc;
        }
        private static List<XmlElement> OwnNodes(XmlDocument doc)
        {
            return doc.SelectNodes("/jsplugins/*").Cast<XmlNode>().OfType<XmlElement>()
                .Where(n => n.GetAttribute("name") == InstallPaths.Product && (n.GetAttribute("type") == "et" || n.GetAttribute("type") == "")).ToList();
        }
        private void WriteConfig(XmlDocument doc, byte[] expected)
        {
            InstallPaths.NoLinks(paths.Publish);
            byte[] current = File.Exists(paths.Publish) ? File.ReadAllBytes(paths.Publish) : null;
            if (!SameBytes(current, expected)) throw new IOException("加载项配置被其他程序修改，请关闭相关程序后重试。未覆盖其他修改。");
            Directory.CreateDirectory(paths.Addons);
            string temporary = Path.Combine(paths.Addons, ".translation-assistant-config-" + Guid.NewGuid().ToString("N") + ".tmp");
            try
            {
                File.WriteAllBytes(temporary, PayloadManifest.XmlBytes(doc));
                if (File.Exists(paths.Publish)) File.Replace(temporary, paths.Publish, null);
                else File.Move(temporary, paths.Publish);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
        private static bool SameBytes(byte[] a, byte[] b)
        { return a == null || b == null ? a == b : a.SequenceEqual(b); }

        private void RestoreOwnConfig(XmlDocument old)
        {
            byte[] expected = File.Exists(paths.Publish) ? File.ReadAllBytes(paths.Publish) : null;
            var current = ReadConfig();
            foreach (XmlElement node in OwnNodes(current)) node.ParentNode.RemoveChild(node);
            foreach (XmlElement node in OwnNodes(old)) current.DocumentElement.AppendChild(current.ImportNode(node, true));
            WriteConfig(current, expected);
        }
        private string Backup(string operation)
        {
            InstallPaths.NoLinks(paths.Data); Directory.CreateDirectory(paths.Data);
            string directory = Path.Combine(paths.Data, "Backups", DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + operation + "-" + Guid.NewGuid().ToString("N").Substring(0, 8));
            Directory.CreateDirectory(directory);
            if (File.Exists(paths.Publish)) File.Copy(paths.Publish, Path.Combine(directory, "publish.xml"));
            if (Directory.Exists(paths.Plugin)) InstallPaths.CopyTree(paths.Plugin, Path.Combine(directory, "plugin"));
            if (File.Exists(paths.ManagerExe)) File.Copy(paths.ManagerExe, Path.Combine(directory, "manager.exe"));
            return directory;
        }
        private void Preflight()
        {
            if (wpsRunning()) throw new IOException("请先保存工作，正常关闭所有 WPS 窗口，再重试。安装器不会强行结束 WPS。");
            InstallPaths.NoLinks(paths.Addons); InstallPaths.NoLinks(paths.Manager); InstallPaths.NoLinks(paths.Data);
            if (Directory.Exists(paths.Plugin)) InstallPaths.CheckTree(paths.Plugin);
            ReadConfig();
        }
        private PayloadManifest Extract(string directory)
        {
            byte[] bytes = payload();
            if (bytes.Length > 50000000) throw new IOException("安装资源大小异常。");
            using (var memory = new MemoryStream(bytes)) using (var zip = new ZipArchive(memory, ZipArchiveMode.Read))
            {
                var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                ZipArchiveEntry marker = zip.GetEntry(InstallPaths.Marker);
                if (marker == null) throw new IOException("安装包缺少清单。");
                byte[] manifestBytes;
                using (var source = marker.Open()) using (var output = new MemoryStream()) { source.CopyTo(output); manifestBytes = output.ToArray(); }
                var manifest = PayloadManifest.Parse(manifestBytes);
                long total = 0;
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    string relative = entry.FullName.Replace('\\', '/');
                    if (relative.EndsWith("/")) { InstallPaths.Inside(directory, relative.TrimEnd('/')); continue; }
                    string target = InstallPaths.Inside(directory, relative);
                    if (!seen.Add(relative)) throw new IOException("安装包含重复文件路径。");
                    if (entry.Length > 20000000 || (total += entry.Length) > 50000000) throw new IOException("安装资源解压大小异常。");
                    if (relative == InstallPaths.Marker) continue;
                    if (!manifest.Files.ContainsKey(relative)) throw new IOException("安装包含未声明文件。");
                    byte[] content;
                    using (var source = entry.Open()) using (var output = new MemoryStream()) { source.CopyTo(output); content = output.ToArray(); }
                    if (!String.Equals(PayloadManifest.Hash(content), manifest.Files[relative], StringComparison.OrdinalIgnoreCase)) throw new IOException("安装资源校验失败：" + relative);
                    Directory.CreateDirectory(Path.GetDirectoryName(target)); File.WriteAllBytes(target, content);
                }
                if (manifest.Files.Keys.Any(file => !seen.Contains(file))) throw new IOException("安装包文件不完整。");
                return manifest;
            }
        }
        public InstallResult Install(string sourceExe)
        {
            Preflight();
            Directory.CreateDirectory(paths.Addons);
            string stage = Path.Combine(paths.Addons, ".WpsTranslationAssistant-stage-" + Guid.NewGuid().ToString("N"));
            string swap = Path.Combine(paths.Addons, ".WpsTranslationAssistant-old-" + Guid.NewGuid().ToString("N"));
            var oldConfig = ReadConfig();
            byte[] expected = File.Exists(paths.Publish) ? File.ReadAllBytes(paths.Publish) : null;
            bool swapped = false, configChanged = false, managerChanged = false;
            object integrationState = integration.Capture();
            string backup = null;
            try
            {
                var oldVersion = InstalledVersion();
                if (Directory.Exists(paths.Plugin))
                {
                    string stamp = Path.Combine(paths.Plugin, InstallPaths.Ownership);
                    bool owned = File.Exists(Path.Combine(paths.Plugin, InstallPaths.Marker)) || (File.Exists(stamp) && File.ReadAllText(stamp) == InstallPaths.Product)
                        || OwnNodes(oldConfig).Any(n => n.GetAttribute("url").TrimEnd('/', '\\') == InstallPaths.PluginFolder);
                    if (!owned && Directory.EnumerateFileSystemEntries(paths.Plugin).Any()) throw new IOException("目标目录已有未确认归属的文件，未进行覆盖。");
                    InstallPaths.CopyTree(paths.Plugin, stage);
                }
                else Directory.CreateDirectory(stage);
                var manifest = Extract(stage);
                if (oldVersion != null && oldVersion > manifest.Version) throw new IOException("已安装版本高于此安装包，请使用更新的安装包。不会自动降级。");
                var oldMarker = Path.Combine(paths.Plugin, InstallPaths.Marker);
                if (File.Exists(oldMarker)) foreach (var item in PayloadManifest.Parse(File.ReadAllBytes(oldMarker)).Files) if (!manifest.Files.ContainsKey(item.Key)) manifest.Files.Add(item.Key, item.Value);
                File.WriteAllBytes(Path.Combine(stage, InstallPaths.Marker), manifest.Serialize());
                File.WriteAllText(Path.Combine(stage, InstallPaths.Ownership), InstallPaths.Product);
                backup = Backup("install");
                if (wpsRunning()) throw new IOException("检测到 WPS 已启动，请先关闭 WPS 后重试。");
                // 移动前检查两个绝对路径都在专用加载项目录中，并拒绝目录联接。
                InstallPaths.NoLinks(stage); InstallPaths.NoLinks(swap); InstallPaths.NoLinks(paths.Plugin);
                if (Directory.Exists(paths.Plugin)) Directory.Move(paths.Plugin, swap);
                try { Directory.Move(stage, paths.Plugin); swapped = true; }
                catch { if (Directory.Exists(swap)) Directory.Move(swap, paths.Plugin); throw; }
                var current = PayloadManifest.SafeXml(PayloadManifest.XmlBytes(oldConfig));
                string domain = OwnNodes(current).Select(n => n.GetAttribute("customDomain")).FirstOrDefault() ?? "";
                foreach (XmlElement node in OwnNodes(current)) node.ParentNode.RemoveChild(node);
                var registration = current.CreateElement("jsplugin");
                registration.SetAttribute("name", InstallPaths.Product); registration.SetAttribute("type", "et");
                registration.SetAttribute("url", InstallPaths.PluginFolder); registration.SetAttribute("version", InstallPaths.LoaderVersion);
                registration.SetAttribute("enable", "enable_dev"); registration.SetAttribute("install", "null"); registration.SetAttribute("customDomain", domain);
                current.DocumentElement.AppendChild(registration);
                WriteConfig(current, expected); configChanged = true;
                Directory.CreateDirectory(paths.Manager);
                if (!String.Equals(Path.GetFullPath(sourceExe), Path.GetFullPath(paths.ManagerExe), StringComparison.OrdinalIgnoreCase)) { File.Copy(sourceExe, paths.ManagerExe, true); managerChanged = true; }
                integration.Register(manifest.Version.ToString(), paths);
                InstallPaths.DeleteOwnedTree(paths.Addons, swap, ".WpsTranslationAssistant-old-");
                return new InstallResult { Version = manifest.Version.ToString(), BackupDirectory = backup };
            }
            catch (Exception error)
            {
                var rollbackErrors = new List<string>();
                try { integration.Restore(integrationState, paths); } catch (Exception e) { rollbackErrors.Add(e.Message); }
                if (managerChanged) try { string original = backup == null ? "" : Path.Combine(backup, "manager.exe"); if (File.Exists(original)) File.Copy(original, paths.ManagerExe, true); else if (File.Exists(paths.ManagerExe)) File.Delete(paths.ManagerExe); } catch (Exception e) { rollbackErrors.Add(e.Message); }
                if (configChanged) try { RestoreOwnConfig(oldConfig); } catch (Exception e) { rollbackErrors.Add(e.Message); }
                if (swapped) try { InstallPaths.DeleteOwnedTree(paths.Addons, paths.Plugin, InstallPaths.Product); if (Directory.Exists(swap)) Directory.Move(swap, paths.Plugin); } catch (Exception e) { rollbackErrors.Add(e.Message); }
                throw new IOException(error.Message + (rollbackErrors.Count == 0 ? "\r\n已撤回本次未完成的安装。" : "\r\n部分恢复未完成：" + String.Join("；", rollbackErrors) + "\r\n备份：" + backup), error);
            }
            finally { InstallPaths.DeleteOwnedTree(paths.Addons, stage, ".WpsTranslationAssistant-stage-"); }
        }
        public InstallResult Uninstall()
        {
            Preflight();
            var oldConfig = ReadConfig(); var expected = File.Exists(paths.Publish) ? File.ReadAllBytes(paths.Publish) : null;
            object integrationState = integration.Capture(); string backup = Backup("uninstall");
            var marker = Path.Combine(paths.Plugin, InstallPaths.Marker);
            var managed = File.Exists(marker) ? PayloadManifest.Parse(File.ReadAllBytes(marker)).Files.Keys.ToList() : new List<string>();
            bool configChanged = false, filesChanged = false;
            try
            {
                var next = PayloadManifest.SafeXml(PayloadManifest.XmlBytes(oldConfig));
                foreach (XmlElement node in OwnNodes(next)) node.ParentNode.RemoveChild(node);
                WriteConfig(next, expected); configChanged = true;
                foreach (string relative in managed)
                {
                    string file = InstallPaths.Inside(paths.Plugin, relative); InstallPaths.NoLinks(file);
                    if (File.Exists(file)) { File.Delete(file); filesChanged = true; }
                }
                if (File.Exists(marker)) { File.Delete(marker); filesChanged = true; }
                string stamp = Path.Combine(paths.Plugin, InstallPaths.Ownership);
                if (File.Exists(stamp) && File.ReadAllText(stamp) == InstallPaths.Product
                    && !Directory.GetFiles(paths.Plugin, "*", SearchOption.AllDirectories).Any(file => !String.Equals(file, stamp, StringComparison.OrdinalIgnoreCase))) File.Delete(stamp);
                PruneEmpty(paths.Plugin);
                integration.Remove(paths);
                if (File.Exists(paths.ManagerExe)) File.Delete(paths.ManagerExe);
                if (Directory.Exists(paths.Manager) && !Directory.EnumerateFileSystemEntries(paths.Manager).Any()) Directory.Delete(paths.Manager);
                return new InstallResult { BackupDirectory = backup, RetainedUserFiles = Directory.Exists(paths.Plugin) && Directory.EnumerateFileSystemEntries(paths.Plugin).Any() };
            }
            catch (Exception error)
            {
                var rollbackErrors = new List<string>();
                if (filesChanged) try { if (Directory.Exists(Path.Combine(backup, "plugin"))) InstallPaths.CopyTree(Path.Combine(backup, "plugin"), paths.Plugin); } catch (Exception e) { rollbackErrors.Add(e.Message); }
                if (configChanged) try { RestoreOwnConfig(oldConfig); } catch (Exception e) { rollbackErrors.Add(e.Message); }
                try { if (File.Exists(Path.Combine(backup, "manager.exe"))) { Directory.CreateDirectory(paths.Manager); File.Copy(Path.Combine(backup, "manager.exe"), paths.ManagerExe, true); } integration.Restore(integrationState, paths); } catch (Exception e) { rollbackErrors.Add(e.Message); }
                throw new IOException(error.Message + "\r\n卸载未完成，已尝试恢复。" + (rollbackErrors.Count > 0 ? "\r\n恢复提示：" + String.Join("；", rollbackErrors) + "\r\n备份：" + backup : ""), error);
            }
        }
        private static void PruneEmpty(string directory)
        {
            if (!Directory.Exists(directory)) return;
            InstallPaths.NoLinks(directory);
            foreach (string child in Directory.GetDirectories(directory)) PruneEmpty(child);
            if (!Directory.EnumerateFileSystemEntries(directory).Any()) Directory.Delete(directory);
        }
    }
}
