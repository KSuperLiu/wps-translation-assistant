using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Management;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace TranslationAssistantSetup
{
    internal sealed class WindowsIntegration : IUserIntegration
    {
        private readonly string KeyPath;
        private readonly string Menu;
        public WindowsIntegration()
        {
            KeyPath = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WpsTranslationAssistant";
            Menu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "WPS 翻译助手");
        }
        private WindowsIntegration(string key, string menu) { KeyPath = key; Menu = menu; }
        internal static WindowsIntegration IsolatedTest(string key, string menu)
        {
            if (!key.StartsWith("Software\\WpsTranslationAssistantInstallerTests\\", StringComparison.Ordinal)) throw new IOException("拒绝非隔离测试注册表路径。");
            return new WindowsIntegration(key, Path.GetFullPath(menu));
        }
        private sealed class Snapshot
        {
            public bool Exists;
            public readonly Dictionary<string, object> Values = new Dictionary<string, object>();
            public readonly Dictionary<string, RegistryValueKind> Kinds = new Dictionary<string, RegistryValueKind>();
            public readonly Dictionary<string, byte[]> Shortcuts = new Dictionary<string, byte[]>();
        }
        private static RegistryKey UserHive()
        { return RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, Environment.Is64BitOperatingSystem ? RegistryView.Registry64 : RegistryView.Registry32); }
        private static IEnumerable<string> ShortcutNames { get { return new[] { "管理 WPS 翻译助手.lnk", "卸载 WPS 翻译助手.lnk" }; } }
        public object Capture()
        {
            var snapshot = new Snapshot();
            using (var hive = UserHive()) using (var key = hive.OpenSubKey(KeyPath))
            {
                snapshot.Exists = key != null;
                if (key != null) foreach (string name in key.GetValueNames()) { snapshot.Values[name] = key.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames); snapshot.Kinds[name] = key.GetValueKind(name); }
            }
            InstallPaths.NoLinks(Menu);
            foreach (string name in ShortcutNames)
            {
                string path = Path.Combine(Menu, name); InstallPaths.NoLinks(path);
                snapshot.Shortcuts[name] = File.Exists(path) ? File.ReadAllBytes(path) : null;
            }
            return snapshot;
        }
        public void Register(string version, InstallPaths paths)
        {
            using (var hive = UserHive()) using (var key = hive.CreateSubKey(KeyPath))
            {
                key.SetValue("DisplayName", "WPS 翻译助手"); key.SetValue("DisplayVersion", version);
                key.SetValue("Publisher", "Localization Tools"); key.SetValue("DisplayIcon", paths.ManagerExe);
                key.SetValue("InstallLocation", paths.Plugin); key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
                key.SetValue("UninstallString", "\"" + paths.ManagerExe + "\" /uninstall");
                key.SetValue("ModifyPath", "\"" + paths.ManagerExe + "\" /manage");
                key.SetValue("NoModify", 1, RegistryValueKind.DWord); key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                key.SetValue("EstimatedSize", (int)Math.Min(Int32.MaxValue, Math.Max(1L, Directory.GetFiles(paths.Plugin, "*", SearchOption.AllDirectories).Sum(f => new FileInfo(f).Length) / 1024 + new FileInfo(paths.ManagerExe).Length / 1024)), RegistryValueKind.DWord);
            }
            InstallPaths.NoLinks(Menu); Directory.CreateDirectory(Menu);
            CreateShortcut(Path.Combine(Menu, "管理 WPS 翻译助手.lnk"), paths.ManagerExe, "/manage");
            CreateShortcut(Path.Combine(Menu, "卸载 WPS 翻译助手.lnk"), paths.ManagerExe, "/uninstall");
        }
        public void Remove(InstallPaths paths)
        {
            using (var hive = UserHive()) hive.DeleteSubKeyTree(KeyPath, false);
            InstallPaths.NoLinks(Menu);
            foreach (string name in ShortcutNames) { string file = Path.Combine(Menu, name); InstallPaths.NoLinks(file); if (File.Exists(file)) File.Delete(file); }
            if (Directory.Exists(Menu) && !Directory.EnumerateFileSystemEntries(Menu).Any()) Directory.Delete(Menu);
        }
        public void Restore(object value, InstallPaths paths)
        {
            var snapshot = (Snapshot)value;
            using (var hive = UserHive())
            {
                hive.DeleteSubKeyTree(KeyPath, false);
                if (snapshot.Exists) using (var key = hive.CreateSubKey(KeyPath)) foreach (var item in snapshot.Values) key.SetValue(item.Key, item.Value, snapshot.Kinds[item.Key]);
            }
            foreach (var item in snapshot.Shortcuts)
            {
                string file = Path.Combine(Menu, item.Key); InstallPaths.NoLinks(file);
                if (item.Value == null) { if (File.Exists(file)) File.Delete(file); }
                else { Directory.CreateDirectory(Menu); File.WriteAllBytes(file, item.Value); }
            }
            if (Directory.Exists(Menu) && !Directory.EnumerateFileSystemEntries(Menu).Any()) Directory.Delete(Menu);
        }
        private static void CreateShortcut(string path, string exe, string arguments)
        {
            object shell = null, shortcut = null;
            try
            {
                shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell", true));
                shortcut = shell.GetType().InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
                Type type = shortcut.GetType();
                type.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { exe });
                type.InvokeMember("Arguments", BindingFlags.SetProperty, null, shortcut, new object[] { arguments });
                type.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { Path.GetDirectoryName(exe) });
                type.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { "安装、升级或卸载 WPS 翻译助手" });
                type.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            }
            finally
            {
                if (shortcut != null && Marshal.IsComObject(shortcut)) Marshal.FinalReleaseComObject(shortcut);
                if (shell != null && Marshal.IsComObject(shell)) Marshal.FinalReleaseComObject(shell);
            }
        }
        public static bool WpsRunning()
        {
            int session = Process.GetCurrentProcess().SessionId;
            try
            {
                using (var searcher = new ManagementObjectSearcher("SELECT SessionId, CommandLine, Name FROM Win32_Process WHERE Name='wps.exe' OR Name='et.exe' OR Name='wpsoffice.exe'"))
                using (var processes = searcher.Get())
                foreach (ManagementObject process in processes)
                using (process)
                {
                    if (Convert.ToInt32(process["SessionId"]) != session) continue;
                    if (String.Equals(Convert.ToString(process["Name"]), "wps.exe", StringComparison.OrdinalIgnoreCase)
                        && IsAuxiliaryCommandLine(Convert.ToString(process["CommandLine"]))) continue;
                    return true;
                }
            }
            catch
            {
                // 进程信息不可用时保守阻止，避免 WPS 正在使用配置时更新。
                foreach (string name in new[] { "wps", "et", "wpsoffice" }) foreach (Process process in Process.GetProcessesByName(name))
                    using (process) try { if (!process.HasExited && process.SessionId == session) return true; } catch { }
            }
            return false;
        }
        internal static bool IsAuxiliaryCommandLine(string command)
        {
            // WPS 退出文档后可保留应用中心/CEF 进程。这些不加载表格插件，不能阻止离线安装。
            return Regex.IsMatch(command ?? "", @"^\s*(?:""[^""]+""|\S+)\s+Run\s+", RegexOptions.IgnoreCase)
                && Regex.IsMatch(command, @"(?:^|\s)-Entry=(?:EntryPoint|CefRenderEntryPoint)(?:\s|$)", RegexOptions.IgnoreCase);
        }
        public static bool WpsInstalled()
        {
            using (var key = Registry.ClassesRoot.OpenSubKey("KET.Sheet.12")) if (key != null) return true;
            return false;
        }
    }
}
