using System;
using System.IO;
using System.Reflection;
using Microsoft.Win32;

namespace TranslationAssistantSetup
{
    internal static class WindowsIntegrationTests
    {
        [STAThread]
        public static int Main(string[] args)
        {
            if (args.Length != 1) return 2;
            string parent = Path.GetFullPath(args[0]);
            string root = Path.Combine(parent, "integration-" + Guid.NewGuid().ToString("N"));
            string keyPath = "Software\\WpsTranslationAssistantInstallerTests\\" + Guid.NewGuid().ToString("N");
            var paths = new InstallPaths(Path.Combine(root, "addons"), Path.Combine(root, "manager"), Path.Combine(root, "data"));
            var integration = WindowsIntegration.IsolatedTest(keyPath, Path.Combine(root, "menu"));
            using (var hive = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, Environment.Is64BitOperatingSystem ? RegistryView.Registry64 : RegistryView.Registry32))
            {
                try
                {
                    if (!WindowsIntegration.IsAuxiliaryCommandLine("\"D:\\WPS Office\\wps.exe\" Run -Entry=EntryPoint addons.dll --host")
                        || !WindowsIntegration.IsAuxiliaryCommandLine("wps.exe Run /AppUserModelID=Kingsoft.Office.cefhomepage -Entry=CefRenderEntryPoint --type=renderer")
                        || WindowsIntegration.IsAuxiliaryCommandLine("\"D:\\WPS Office\\wps.exe\" /et test.xlsx")
                        || WindowsIntegration.IsAuxiliaryCommandLine("wps.exe test.xlsx Run -Entry=EntryPoint")
                        || WindowsIntegration.IsAuxiliaryCommandLine(null)) throw new Exception("WPS 主程序与后台辅助进程区分失败");
                    Directory.CreateDirectory(paths.Plugin); Directory.CreateDirectory(paths.Manager);
                    File.WriteAllText(Path.Combine(paths.Plugin, "index.html"), "test");
                    File.Copy(Assembly.GetExecutingAssembly().Location, paths.ManagerExe);
                    object empty = integration.Capture();
                    integration.Register("1.1.2", paths);
                    using (var key = hive.OpenSubKey(keyPath))
                    {
                        if (key == null || (string)key.GetValue("DisplayVersion") != "1.1.2" || key.GetValueKind("EstimatedSize") != RegistryValueKind.DWord) throw new Exception("Windows 卸载项注册失败");
                    }
                    if (!File.Exists(Path.Combine(root, "menu", "卸载 WPS 翻译助手.lnk"))) throw new Exception("开始菜单快捷方式创建失败");
                    object prior = integration.Capture();
                    integration.Register("2.0.0", paths); integration.Restore(prior, paths);
                    using (var key = hive.OpenSubKey(keyPath)) if ((string)key.GetValue("DisplayVersion") != "1.1.2") throw new Exception("Windows 注册表恢复失败");
                    integration.Remove(paths);
                    using (var key = hive.OpenSubKey(keyPath)) if (key != null) throw new Exception("Windows 卸载项未删除");
                    integration.Restore(empty, paths);
                    Console.WriteLine("PASS Windows 卸载项 / 开始菜单 / 升级后恢复 / 清理（专用测试注册表及目录）");
                    return 0;
                }
                catch (Exception error) { Console.Error.WriteLine(error); return 1; }
                finally
                {
                    hive.DeleteSubKeyTree(keyPath, false);
                    InstallPaths.DeleteOwnedTree(parent, root, "integration-");
                }
            }
        }
    }
}
