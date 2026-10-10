using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

namespace XMonitorDesktopLauncher
{
    internal sealed class TimeoutWebClient : WebClient
    {
        private readonly int timeoutMs;

        public TimeoutWebClient(int timeoutMs)
        {
            this.timeoutMs = timeoutMs;
        }

        protected override WebRequest GetWebRequest(Uri address)
        {
            WebRequest request = base.GetWebRequest(address);
            if (request != null)
            {
                request.Timeout = timeoutMs;
            }
            return request;
        }
    }

    internal static class Program
    {
        private const string AppUrl = "http://127.0.0.1:3007/";

        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string releaseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string appDir = Path.Combine(releaseDir, "app");
            string nodePath = Path.Combine(releaseDir, "runtime", "node.exe");

            try
            {
                if (!Directory.Exists(appDir))
                {
                    ShowError("找不到 app 文件夹。请确认推文监控台.exe 与 app、runtime 文件夹放在同一目录。", null);
                    return;
                }

                if (!IsServiceReady())
                {
                    StartServer(appDir, nodePath);
                    if (!WaitForService(30000))
                    {
                        ShowError("后台服务启动超时。请查看 app\\server.err.log。", null);
                        return;
                    }
                }

                OpenDesktopWindow(releaseDir);
            }
            catch (Exception ex)
            {
                ShowError("启动推文监控台失败。", ex);
            }
        }

        private static bool IsServiceReady()
        {
            try
            {
                using (TimeoutWebClient client = new TimeoutWebClient(1200))
                {
                    client.DownloadString(AppUrl + "api/state");
                    return true;
                }
            }
            catch
            {
                return false;
            }
        }

        private static bool WaitForService(int timeoutMs)
        {
            Stopwatch stopwatch = Stopwatch.StartNew();
            while (stopwatch.ElapsedMilliseconds < timeoutMs)
            {
                if (IsServiceReady()) return true;
                Thread.Sleep(500);
            }
            return false;
        }

        private static void StartServer(string appDir, string nodePath)
        {
            if (!File.Exists(nodePath))
            {
                ShowError("找不到 runtime\\node.exe。请确认 runtime 文件夹完整。", null);
                throw new FileNotFoundException("runtime node.exe missing", nodePath);
            }

            ProcessStartInfo info = new ProcessStartInfo
            {
                FileName = nodePath,
                Arguments = "server/index.js",
                WorkingDirectory = appDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            info.EnvironmentVariables["X_MONITOR_NO_AUTO_OPEN"] = "1";
            Process.Start(info);
        }

        private static void OpenDesktopWindow(string releaseDir)
        {
            string browser = FindAppBrowser();
            if (String.IsNullOrEmpty(browser))
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = AppUrl,
                    UseShellExecute = true
                });
                return;
            }

            string profileDir = Path.Combine(releaseDir, "app", "data", "desktop-window-profile");
            Directory.CreateDirectory(profileDir);

            ProcessStartInfo info = new ProcessStartInfo
            {
                FileName = browser,
                Arguments = "--app=" + AppUrl + " --new-window --window-size=1280,900 --user-data-dir=\"" + profileDir + "\"",
                WorkingDirectory = releaseDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            Process.Start(info);
        }

        private static string FindAppBrowser()
        {
            string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

            string[] candidates = new string[]
            {
                Path.Combine(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(localAppData, "Google", "Chrome", "Application", "chrome.exe")
            };

            foreach (string candidate in candidates)
            {
                if (!String.IsNullOrEmpty(candidate) && File.Exists(candidate)) return candidate;
            }
            return null;
        }

        private static void ShowError(string message, Exception ex)
        {
            string body = ex == null ? message : message + Environment.NewLine + Environment.NewLine + ex.Message;
            MessageBox.Show(body, "推文监控台", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
