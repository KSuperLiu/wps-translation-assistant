using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Xml;

namespace TranslationAssistantSetup
{
    internal sealed class FakeIntegration : IUserIntegration
    {
        public bool Registered, FailRegister, FailRemove;
        public Action OnCapture;
        public object Capture() { if (OnCapture != null) OnCapture(); return Registered; }
        public void Register(string version, InstallPaths paths) { Registered = true; if (FailRegister) throw new IOException("模拟注册失败"); }
        public void Remove(InstallPaths paths) { Registered = false; if (FailRemove) throw new IOException("模拟卸载失败"); }
        public void Restore(object value, InstallPaths paths) { Registered = (bool)value; }
    }
    internal static class EngineTests
    {
        private static string parent;
        private static int passed;
        private static readonly string self = Assembly.GetExecutingAssembly().Location;
        private static readonly string foreign = "<jsplugins><jsplugin name=\"AnotherPlugin\" type=\"et\" url=\"keep-me\"/><jsplugin name=\"WpsTranslationAssistant\" type=\"wps\" url=\"keep-word\"/></jsplugins>";
        private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
        private static void Throws(Action action, string expected)
        {
            try { action(); } catch (Exception error) { Check(error.Message.Contains(expected), "错误不匹配：" + error.Message); return; }
            throw new Exception("预期应拒绝操作：" + expected);
        }
        private static byte[] Payload(string version, string text, bool corrupt, string attack)
        {
            var manifest = new PayloadManifest { Version = new Version(version) };
            var files = new Dictionary<string, byte[]> { { "index.html", Encoding.UTF8.GetBytes("<html>" + text + "</html>") }, { "pane.html", Encoding.UTF8.GetBytes("pane") }, { "ribbon.xml", Encoding.UTF8.GetBytes("<customUI/>") }, { "assets/" + text + ".js", Encoding.UTF8.GetBytes(text) } };
            foreach (var item in files) manifest.Files[item.Key] = PayloadManifest.Hash(item.Value);
            using (var memory = new MemoryStream())
            {
                using (var zip = new ZipArchive(memory, ZipArchiveMode.Create, true))
                {
                    using (var output = zip.CreateEntry(InstallPaths.Marker).Open()) { byte[] data = manifest.Serialize(); output.Write(data, 0, data.Length); }
                    foreach (var item in files) using (var output = zip.CreateEntry(item.Key).Open()) { byte[] data = corrupt && item.Key == "index.html" ? new byte[] { 0 } : item.Value; output.Write(data, 0, data.Length); }
                    if (attack != null) using (var output = zip.CreateEntry(attack).Open()) output.WriteByte(1);
                }
                return memory.ToArray();
            }
        }
        private static void Run(string name, Action<InstallPaths, FakeIntegration> action)
        {
            string root = Path.Combine(parent, "case-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            var paths = new InstallPaths(Path.Combine(root, "addons"), Path.Combine(root, "manager"), Path.Combine(root, "data"));
            var integration = new FakeIntegration();
            try { action(paths, integration); passed++; Console.WriteLine("PASS " + name); }
            catch { Console.WriteLine("FAILED " + name + "；现场：" + root); throw; }
            InstallPaths.DeleteOwnedTree(parent, root, "case-");
        }
        private static InstallerEngine Engine(InstallPaths p, FakeIntegration i, string version, string value)
        { return new InstallerEngine(p, i, delegate { return false; }, delegate { return Payload(version, value, false, null); }); }
        private static void Seed(InstallPaths p, string xml) { Directory.CreateDirectory(p.Addons); File.WriteAllText(p.Publish, xml); }
        private static int OwnCount(InstallPaths p) { return PayloadManifest.SafeXml(File.ReadAllBytes(p.Publish)).SelectNodes("/jsplugins/*[@name='WpsTranslationAssistant' and @type='et']").Count; }
        public static int Main(string[] args)
        {
            if (args.Length != 2) { Console.Error.WriteLine("需要隔离测试目录和实际资源 ZIP"); return 2; }
            parent = Path.GetFullPath(args[0]); Directory.CreateDirectory(parent);
            try
            {
                Run("首次安装与离线注册", (p, i) => { Engine(p, i, "1.1.2", "one").Install(self); Check(i.Registered && OwnCount(p) == 1, "注册失败"); Check(File.Exists(p.ManagerExe), "管理程序缺失"); Check(File.ReadAllText(Path.Combine(p.Plugin, "index.html")).Contains("one"), "资源缺失"); var node=PayloadManifest.SafeXml(File.ReadAllBytes(p.Publish)).SelectSingleNode("/jsplugins/jsplugin"); Check(Path.GetFileName(p.Plugin)==InstallPaths.Product+"_"+node.Attributes["version"].Value && node.Attributes["url"].Value==Path.GetFileName(p.Plugin), "不符合 WPS 本地加载目录约定"); });
                Run("保留其他插件与同名文字插件", (p, i) => { Seed(p, foreign); Engine(p, i, "1.1.2", "one").Install(self); var d = PayloadManifest.SafeXml(File.ReadAllBytes(p.Publish)); Check(d.SelectSingleNode("/jsplugins/*[@name='AnotherPlugin']").Attributes["url"].Value == "keep-me", "其他插件被改动"); Check(d.SelectSingleNode("/jsplugins/*[@type='wps']").Attributes["url"].Value == "keep-word", "文字插件被改动"); });
                Run("开发版迁移为一个本地加载项", (p, i) => { Seed(p, "<jsplugins><jspluginonline name='WpsTranslationAssistant' type='et' url='http://127.0.0.1:3890/' customDomain='keep-domain'/></jsplugins>"); Engine(p, i, "1.1.2", "one").Install(self); var d = PayloadManifest.SafeXml(File.ReadAllBytes(p.Publish)); Check(OwnCount(p) == 1 && d.SelectNodes("/jsplugins/jspluginonline").Count == 0, "旧开发入口未替换"); Check(d.SelectSingleNode("/jsplugins/jsplugin").Attributes["customDomain"].Value == "keep-domain", "自定义域未保留"); });
                Run("覆盖升级与用户文件保留", (p, i) => { Engine(p, i, "1.0.0", "old").Install(self); File.WriteAllText(Path.Combine(p.Plugin, "user-settings.json"), "KEEP"); Engine(p, i, "2.0.0", "new").Install(self); Check(OwnCount(p) == 1 && File.ReadAllText(Path.Combine(p.Plugin, "index.html")).Contains("new"), "升级失败"); Check(File.ReadAllText(Path.Combine(p.Plugin, "user-settings.json")) == "KEEP", "用户设置丢失"); });
                Run("同版本修复不产生重复入口", (p, i) => { Engine(p, i, "1.0.0", "one").Install(self); Engine(p, i, "1.0.0", "two").Install(self); Check(OwnCount(p) == 1 && File.ReadAllText(Path.Combine(p.Plugin, "index.html")).Contains("two"), "修复失败"); });
                Run("拒绝旧包降级", (p, i) => { Engine(p, i, "2.0.0", "new").Install(self); Throws(() => Engine(p, i, "1.0.0", "old").Install(self), "不会自动降级"); Check(File.ReadAllText(Path.Combine(p.Plugin, "index.html")).Contains("new"), "旧包覆盖了新包"); });
                Run("卸载仅移除本插件并保留用户文件", (p, i) => { Seed(p, foreign); var e = Engine(p, i, "1.0.0", "one"); e.Install(self); File.WriteAllText(Path.Combine(p.Plugin, "user.json"), "KEEP"); e.Uninstall(); Check(!i.Registered && OwnCount(p) == 0 && !File.Exists(p.ManagerExe), "未完全卸载"); Check(File.ReadAllText(Path.Combine(p.Plugin, "user.json")) == "KEEP", "用户数据被删"); Check(PayloadManifest.SafeXml(File.ReadAllBytes(p.Publish)).SelectNodes("/jsplugins/*").Count == 2, "其他配置被删"); });
                Run("卸载后可重装并恢复用户文件", (p, i) => { var e = Engine(p, i, "1.0.0", "one"); e.Install(self); File.WriteAllText(Path.Combine(p.Plugin, "user.json"), "KEEP"); e.Uninstall(); e.Install(self); Check(OwnCount(p) == 1 && File.ReadAllText(Path.Combine(p.Plugin, "user.json")) == "KEEP", "重装失败"); });
                Run("升级后的历史资源均可卸载", (p, i) => { Engine(p, i, "1.0.0", "old").Install(self); var e = Engine(p, i, "2.0.0", "new"); e.Install(self); e.Uninstall(); Check(!Directory.Exists(p.Plugin), "历史受管资源未清理"); });
                Run("WPS 运行时不写配置", (p, i) => { Seed(p, foreign); var e = new InstallerEngine(p, i, delegate { return true; }, delegate { return Payload("1.0.0", "one", false, null); }); Throws(() => e.Install(self), "关闭所有 WPS"); Check(File.ReadAllText(p.Publish) == foreign, "WPS 运行时修改了配置"); });
                Run("提交前 WPS 启动时停止安装", (p, i) => { Seed(p, foreign); int calls = 0; var e = new InstallerEngine(p, i, delegate { return ++calls > 1; }, delegate { return Payload("1.0.0", "one", false, null); }); Throws(() => e.Install(self), "WPS 已启动"); Check(File.ReadAllText(p.Publish) == foreign && !Directory.Exists(p.Plugin), "已产生安装改动"); });
                Run("损坏资源校验失败不安装", (p, i) => { var e = new InstallerEngine(p, i, delegate { return false; }, delegate { return Payload("1.0.0", "one", true, null); }); Throws(() => e.Install(self), "校验失败"); Check(!Directory.Exists(p.Plugin) && !File.Exists(p.Publish), "损坏包被安装"); });
                Run("阻止压缩包路径穿越", (p, i) => { var e = new InstallerEngine(p, i, delegate { return false; }, delegate { return Payload("1.0.0", "one", false, "../escape.txt"); }); Throws(() => e.Install(self), "不安全"); Check(!File.Exists(Path.Combine(p.Addons, "escape.txt")), "写到了安装目录之外"); });
                Run("阻止 Windows 大小写重复路径", (p, i) => { var e = new InstallerEngine(p, i, delegate { return false; }, delegate { return Payload("1.0.0", "one", false, "INDEX.HTML"); }); Throws(() => e.Install(self), "重复文件"); });
                Run("配置并发修改不被覆盖且资源回滚", (p, i) => { Seed(p, foreign); i.OnCapture = () => File.WriteAllText(p.Publish, "<jsplugins><jsplugin name='NewOther' type='et'/></jsplugins>"); Throws(() => Engine(p, i, "1.0.0", "one").Install(self), "其他程序修改"); Check(File.ReadAllText(p.Publish).Contains("NewOther") && !Directory.Exists(p.Plugin), "并发配置被覆盖"); });
                Run("注册失败回滚资源和配置", (p, i) => { Seed(p, foreign); i.FailRegister = true; Throws(() => Engine(p, i, "1.0.0", "one").Install(self), "模拟注册失败"); Check(!Directory.Exists(p.Plugin) && OwnCount(p) == 0 && !i.Registered && !File.Exists(p.ManagerExe), "回滚失败"); });
                Run("升级失败恢复旧版本", (p, i) => { Engine(p, i, "1.0.0", "old").Install(self); i.FailRegister = true; Throws(() => Engine(p, i, "2.0.0", "new").Install(self), "模拟注册失败"); Check(File.ReadAllText(Path.Combine(p.Plugin, "index.html")).Contains("old") && Engine(p, i, "1.0.0", "old").InstalledVersion().ToString() == "1.0.0", "旧版本未恢复"); });
                Run("卸载失败恢复插件和卸载入口", (p, i) => { var e = Engine(p, i, "1.0.0", "one"); e.Install(self); i.FailRemove = true; Throws(() => e.Uninstall(), "模拟卸载失败"); Check(File.Exists(Path.Combine(p.Plugin, "index.html")) && File.Exists(p.ManagerExe) && OwnCount(p) == 1 && i.Registered, "卸载失败后恢复不完整"); });
                Run("拒绝未知目录覆盖", (p, i) => { Directory.CreateDirectory(p.Plugin); File.WriteAllText(Path.Combine(p.Plugin, "unknown.txt"), "KEEP"); Throws(() => Engine(p, i, "1.0.0", "one").Install(self), "未确认归属"); Check(File.ReadAllText(Path.Combine(p.Plugin, "unknown.txt")) == "KEEP", "未知文件被改动"); });
                Run("异常 XML 配置不被覆盖", (p, i) => { Seed(p, "<broken>"); Throws(() => Engine(p, i, "1.0.0", "one").Install(self), ""); Check(File.ReadAllText(p.Publish) == "<broken>", "异常配置被覆盖"); });
                Run("实际发布资源安装、校验、修复与卸载", (p, i) => {
                    var bytes = File.ReadAllBytes(args[1]);
                    var e = new InstallerEngine(p, i, delegate { return false; }, delegate { return bytes; });
                    e.Install(self); e.Install(self);
                    var manifest = PayloadManifest.Parse(File.ReadAllBytes(Path.Combine(p.Plugin, InstallPaths.Marker)));
                    Check(manifest.Files.Count > 5, "实际发布资源不完整");
                    foreach (var item in manifest.Files) Check(PayloadManifest.Hash(File.ReadAllBytes(InstallPaths.Inside(p.Plugin, item.Key))) == item.Value, "发布资源校验不一致：" + item.Key);
                    e.Uninstall(); Check(!Directory.Exists(p.Plugin) && !File.Exists(p.ManagerExe) && OwnCount(p) == 0, "实际资源卸载不完整");
                });
                Console.WriteLine("RESULT " + passed + "/21 passed; isolated filesystem only, no real registry changes.");
                return 0;
            }
            catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        }
    }
}
