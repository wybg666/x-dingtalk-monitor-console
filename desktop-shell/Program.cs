using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace XMonitorDesktop
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
            if (request != null) request.Timeout = timeoutMs;
            return request;
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }

    internal sealed class MainForm : Form
    {
        private const string AppUrl = "http://127.0.0.1:3007/";
        private readonly WebView2 webView;
        private readonly Label loadingLabel;
        private readonly string releaseDir;
        private readonly string appDir;
        private readonly string nodePath;

        public MainForm()
        {
            releaseDir = ResolveReleaseDir();
            appDir = Path.Combine(releaseDir, "app");
            nodePath = Path.Combine(releaseDir, "runtime", "node.exe");

            Text = "推文监控台";
            Width = 1280;
            Height = 900;
            MinimumSize = new Size(1024, 720);
            StartPosition = FormStartPosition.CenterScreen;

            string iconPath = Path.Combine(releaseDir, "app.ico");
            if (File.Exists(iconPath)) Icon = new Icon(iconPath);

            loadingLabel = new Label
            {
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleCenter,
                Font = new Font("Microsoft YaHei UI", 14, FontStyle.Bold),
                ForeColor = Color.White,
                BackColor = Color.FromArgb(12, 30, 55),
                Text = "推文监控台启动中..."
            };

            webView = new WebView2
            {
                Dock = DockStyle.Fill,
                Visible = false
            };

            Controls.Add(webView);
            Controls.Add(loadingLabel);
            Shown += async (_, __) => await BootAsync();
        }

        private async Task BootAsync()
        {
            try
            {
                loadingLabel.Text = "正在检查后台服务...";
                ValidateReleaseFiles();

                if (!IsServiceReady())
                {
                    loadingLabel.Text = "正在启动后台服务...";
                    StartServer();
                    if (!WaitForService(30000))
                    {
                        throw new TimeoutException("后台服务启动超时。请查看 app\\server.err.log。");
                    }
                }

                loadingLabel.Text = "正在打开界面...";
                string profileDir = Path.Combine(appDir, "data", "webview-profile");
                Directory.CreateDirectory(profileDir);
                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, profileDir);
                await webView.EnsureCoreWebView2Async(environment);
                webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
                webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
                webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
                webView.CoreWebView2.NavigationCompleted += (_, args) =>
                {
                    if (args.IsSuccess)
                    {
                        loadingLabel.Visible = false;
                        webView.Visible = true;
                        webView.BringToFront();
                    }
                    else
                    {
                        loadingLabel.Text = "界面加载失败，请重试。";
                    }
                };
                webView.CoreWebView2.Navigate(AppUrl);
            }
            catch (Exception ex)
            {
                loadingLabel.Text = "启动失败：" + ex.Message;
                MessageBox.Show(ex.Message, "推文监控台", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private string ResolveReleaseDir()
        {
            string dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (Directory.Exists(Path.Combine(dir, "app")) && Directory.Exists(Path.Combine(dir, "runtime"))) return dir;

            DirectoryInfo current = new DirectoryInfo(dir);
            for (int i = 0; current != null && i < 6; i++, current = current.Parent)
            {
                string candidate = current.FullName;
                if (Directory.Exists(Path.Combine(candidate, "app")) && Directory.Exists(Path.Combine(candidate, "runtime"))) return candidate;
                string releaseCandidate = Path.Combine(candidate, "release");
                if (Directory.Exists(Path.Combine(releaseCandidate, "app")) && Directory.Exists(Path.Combine(releaseCandidate, "runtime"))) return releaseCandidate;
            }

            return dir;
        }

        private void ValidateReleaseFiles()
        {
            if (!Directory.Exists(appDir)) throw new DirectoryNotFoundException("找不到 app 文件夹。请确认 exe 与 app、runtime 文件夹放在同一目录。");
            if (!File.Exists(nodePath)) throw new FileNotFoundException("找不到 runtime\\node.exe。请确认 runtime 文件夹完整。", nodePath);
        }

        private bool IsServiceReady()
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

        private bool WaitForService(int timeoutMs)
        {
            Stopwatch stopwatch = Stopwatch.StartNew();
            while (stopwatch.ElapsedMilliseconds < timeoutMs)
            {
                if (IsServiceReady()) return true;
                Thread.Sleep(500);
            }
            return false;
        }

        private void StartServer()
        {
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
    }
}
