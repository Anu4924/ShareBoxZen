using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace ShareBoxZen.Desktop
{
    public class MainForm : Form
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        private static NotifyIcon trayIcon;
        private static ContextMenuStrip trayMenu;
        private static Process serverProcess;
        private static Mutex singleInstanceMutex;
        private static string appDir;
        private static string localIpAddress = "127.0.0.1";
        private const int SERVER_PORT = 3000;
        private static MainForm instance;

        public MainForm()
        {
            instance = this;
            InitializeComponent();
        }

        private void InitializeComponent()
        {
            this.Text = "ShareBoxZen — Hybrid File Transfer Suite";
            this.Size = new Size(620, 480);
            this.MinimumSize = new Size(580, 440);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = Color.FromArgb(16, 16, 16);
            this.ForeColor = Color.FromArgb(245, 242, 235);
            this.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);

            string icoFile = Path.Combine(appDir, "ShareBoxZen.ico");
            if (File.Exists(icoFile))
            {
                try { this.Icon = new Icon(icoFile); } catch { }
            }

            // Top Header Panel
            Panel headerPanel = new Panel();
            headerPanel.Dock = DockStyle.Top;
            headerPanel.Height = 85;
            headerPanel.BackColor = Color.FromArgb(27, 27, 27);
            headerPanel.Padding = new Padding(24, 16, 24, 16);

            Label titleLabel = new Label();
            titleLabel.Text = "ShareBoxZen";
            titleLabel.Font = new Font("Segoe UI", 16f, FontStyle.Bold);
            titleLabel.ForeColor = Color.FromArgb(214, 184, 121); // Champagne Gold
            titleLabel.AutoSize = true;
            titleLabel.Location = new Point(20, 16);
            headerPanel.Controls.Add(titleLabel);

            Label subtitleLabel = new Label();
            subtitleLabel.Text = "Zero-Internet Nearby P2P & Resilient Multi-GB Remote File Sharing";
            subtitleLabel.Font = new Font("Segoe UI", 8.5f, FontStyle.Regular);
            subtitleLabel.ForeColor = Color.FromArgb(170, 164, 154);
            subtitleLabel.AutoSize = true;
            subtitleLabel.Location = new Point(22, 48);
            headerPanel.Controls.Add(subtitleLabel);

            this.Controls.Add(headerPanel);

            // Status Card Panel
            Panel statusCard = new Panel();
            statusCard.Location = new Point(24, 105);
            statusCard.Size = new Size(556, 145);
            statusCard.BackColor = Color.FromArgb(27, 27, 27);
            statusCard.BorderStyle = BorderStyle.FixedSingle;

            Label statusDot = new Label();
            statusDot.Text = "● Server Active & Online";
            statusDot.Font = new Font("Segoe UI", 11f, FontStyle.Bold);
            statusDot.ForeColor = Color.FromArgb(74, 222, 128); // Green
            statusDot.AutoSize = true;
            statusDot.Location = new Point(18, 16);
            statusCard.Controls.Add(statusDot);

            Label localUrlLabel = new Label();
            localUrlLabel.Text = "Local Dashboard:    http://localhost:" + SERVER_PORT;
            localUrlLabel.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
            localUrlLabel.ForeColor = Color.FromArgb(245, 242, 235);
            localUrlLabel.AutoSize = true;
            localUrlLabel.Location = new Point(20, 52);
            statusCard.Controls.Add(localUrlLabel);

            Label lanUrlLabel = new Label();
            lanUrlLabel.Text = "Nearby Devices IP:  http://" + localIpAddress + ":" + SERVER_PORT;
            lanUrlLabel.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
            lanUrlLabel.ForeColor = Color.FromArgb(214, 184, 121);
            lanUrlLabel.AutoSize = true;
            lanUrlLabel.Location = new Point(20, 80);
            statusCard.Controls.Add(lanUrlLabel);

            Label hintLabel = new Label();
            hintLabel.Text = "Phones, laptops, and tablets on your local Wi-Fi can share files directly using this IP.";
            hintLabel.Font = new Font("Segoe UI", 8f, FontStyle.Italic);
            hintLabel.ForeColor = Color.FromArgb(122, 117, 109);
            hintLabel.AutoSize = true;
            hintLabel.Location = new Point(20, 110);
            statusCard.Controls.Add(hintLabel);

            this.Controls.Add(statusCard);

            // Action Buttons
            Button btnOpenBrowser = CreateButton("🚀  Open ShareBoxZen Dashboard", 24, 270, 270, 46, Color.FromArgb(214, 184, 121), Color.FromArgb(16, 16, 16));
            btnOpenBrowser.Font = new Font("Segoe UI", 10f, FontStyle.Bold);
            btnOpenBrowser.Click += (s, e) => OpenAppWindow();
            this.Controls.Add(btnOpenBrowser);

            Button btnCopyLink = CreateButton("📋  Copy Network Link", 310, 270, 270, 46, Color.FromArgb(37, 37, 37), Color.FromArgb(245, 242, 235));
            btnCopyLink.Click += (s, e) => {
                try
                {
                    Clipboard.SetText("http://" + localIpAddress + ":" + SERVER_PORT);
                    MessageBox.Show("Copied to clipboard:\nhttp://" + localIpAddress + ":" + SERVER_PORT, "ShareBoxZen", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                catch { }
            };
            this.Controls.Add(btnCopyLink);

            Button btnOpenStorage = CreateButton("📁  Open Saved Files Folder", 24, 330, 270, 40, Color.FromArgb(37, 37, 37), Color.FromArgb(245, 242, 235));
            btnOpenStorage.Click += (s, e) => {
                string storagePath = Path.Combine(appDir, "storage", "completed");
                if (!Directory.Exists(storagePath)) Directory.CreateDirectory(storagePath);
                try { Process.Start("explorer.exe", storagePath); } catch { }
            };
            this.Controls.Add(btnOpenStorage);

            Button btnMinimize = CreateButton("⬇️  Minimize to System Tray", 310, 330, 270, 40, Color.FromArgb(37, 37, 37), Color.FromArgb(245, 242, 235));
            btnMinimize.Click += (s, e) => {
                this.Hide();
                if (trayIcon != null)
                {
                    trayIcon.ShowBalloonTip(2000, "ShareBoxZen Minimized", "ShareBoxZen is active in the system tray. Double-click to restore.", ToolTipIcon.Info);
                }
            };
            this.Controls.Add(btnMinimize);

            // Handle Form Closing (minimize instead of hard exit)
            this.FormClosing += (s, e) => {
                if (e.CloseReason == CloseReason.UserClosing)
                {
                    e.Cancel = true;
                    this.Hide();
                    if (trayIcon != null)
                    {
                        trayIcon.ShowBalloonTip(2000, "ShareBoxZen Running", "ShareBoxZen is running in the background. Right-click the tray icon to exit.", ToolTipIcon.Info);
                    }
                }
            };
        }

        private Button CreateButton(string text, int x, int y, int w, int h, Color bg, Color fg)
        {
            Button btn = new Button();
            btn.Text = text;
            btn.Location = new Point(x, y);
            btn.Size = new Size(w, h);
            btn.BackColor = bg;
            btn.ForeColor = fg;
            btn.FlatStyle = FlatStyle.Flat;
            btn.FlatAppearance.BorderSize = 0;
            btn.Cursor = Cursors.Hand;
            return btn;
        }

        [STAThread]
        public static void Main(string[] args)
        {
            try
            {
                SetProcessDPIAware();
            }
            catch { }

            bool createdNew;
            singleInstanceMutex = new Mutex(true, "ShareBoxZen_SingleInstance_App_Mutex", out createdNew);
            if (!createdNew)
            {
                // Already running: open browser window and exit duplicate
                OpenAppWindow();
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            appDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            localIpAddress = GetLocalIPv4();

            // 1. Ensure backend server is running
            EnsureServerRunning();

            // 2. Setup System Tray Icon & Context Menu
            SetupSystemTray();

            // 3. Automatically Open App Window in browser/app mode
            OpenAppWindow();

            // 4. Run native form window
            MainForm form = new MainForm();
            Application.Run(form);

            // Clean exit
            Cleanup();
        }

        private static void EnsureServerRunning()
        {
            if (IsServerAlive())
            {
                return;
            }

            string serverExe = Path.Combine(appDir, "ShareBoxZen-Server.exe");
            if (File.Exists(serverExe))
            {
                StartProcessSilently(serverExe, "");
            }
            else
            {
                string serverJs = Path.Combine(appDir, "server.js");
                if (File.Exists(serverJs))
                {
                    StartProcessSilently("node.exe", "\"" + serverJs + "\"");
                }
            }

            for (int i = 0; i < 50; i++)
            {
                Thread.Sleep(200);
                if (IsServerAlive())
                {
                    break;
                }
            }
        }

        private static bool IsServerAlive()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + SERVER_PORT + "/api/info");
                req.Timeout = 800;
                req.Method = "GET";
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    return resp.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        private static void StartProcessSilently(string fileName, string arguments)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = fileName;
                psi.Arguments = arguments;
                psi.WorkingDirectory = appDir;
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                serverProcess = Process.Start(psi);
            }
            catch { }
        }

        public static void OpenAppWindow()
        {
            string url = "http://localhost:" + SERVER_PORT;
            string profileDir = Path.Combine(appDir, "data", "edge_profile");
            try { if (!Directory.Exists(profileDir)) Directory.CreateDirectory(profileDir); } catch { }

            // 1. Try Microsoft Edge with a dedicated profile to prevent singleton collisions
            string edgePath = FindExecutable(new string[] {
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86) + @"\Microsoft\Edge\Application\msedge.exe",
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles) + @"\Microsoft\Edge\Application\msedge.exe",
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) + @"\Microsoft\Edge\Application\msedge.exe"
            });

            bool launched = false;
            if (!string.IsNullOrEmpty(edgePath))
            {
                try
                {
                    ProcessStartInfo psi = new ProcessStartInfo();
                    psi.FileName = edgePath;
                    psi.Arguments = "--user-data-dir=\"" + profileDir + "\" --app=\"" + url + "\" --window-size=1280,850 --no-first-run --no-default-browser-check";
                    psi.UseShellExecute = false;
                    Process p = Process.Start(psi);
                    if (p != null)
                    {
                        Thread.Sleep(800);
                        if (!p.HasExited)
                        {
                            launched = true;
                        }
                    }
                }
                catch { }
            }

            // 2. If Edge didn't stay open, launch standard default browser
            if (!launched)
            {
                try
                {
                    ProcessStartInfo psi = new ProcessStartInfo();
                    psi.FileName = url;
                    psi.UseShellExecute = true;
                    Process.Start(psi);
                }
                catch { }
            }

            if (instance != null)
            {
                try
                {
                    instance.Show();
                    instance.WindowState = FormWindowState.Normal;
                    instance.BringToFront();
                }
                catch { }
            }
        }

        private static string FindExecutable(string[] paths)
        {
            foreach (string p in paths)
            {
                if (File.Exists(p)) return p;
            }
            return null;
        }

        private static void SetupSystemTray()
        {
            trayMenu = new ContextMenuStrip();
            trayMenu.Items.Add("🚀  Open ShareBoxZen Dashboard", null, (s, e) => OpenAppWindow());
            trayMenu.Items.Add("🖥️  Show Desktop Control Window", null, (s, e) => {
                if (instance != null)
                {
                    instance.Show();
                    instance.WindowState = FormWindowState.Normal;
                    instance.BringToFront();
                }
            });
            trayMenu.Items.Add("📋  Copy Local Link (" + localIpAddress + ")", null, (s, e) => {
                try
                {
                    Clipboard.SetText("http://" + localIpAddress + ":" + SERVER_PORT);
                    if (trayIcon != null)
                    {
                        trayIcon.ShowBalloonTip(2000, "Link Copied!", "ShareBoxZen local URL copied to clipboard.", ToolTipIcon.Info);
                    }
                }
                catch { }
            });
            trayMenu.Items.Add("📁  Open Storage Folder", null, (s, e) => {
                string storagePath = Path.Combine(appDir, "storage", "completed");
                if (!Directory.Exists(storagePath)) Directory.CreateDirectory(storagePath);
                try { Process.Start("explorer.exe", storagePath); } catch { }
            });

            trayMenu.Items.Add(new ToolStripSeparator());

            trayMenu.Items.Add("🛑  Exit ShareBoxZen", null, (s, e) => {
                ExitApplication();
            });

            trayIcon = new NotifyIcon();
            trayIcon.Text = "ShareBoxZen - Active (Port " + SERVER_PORT + ")";
            trayIcon.ContextMenuStrip = trayMenu;
            trayIcon.Visible = true;

            string icoFile = Path.Combine(appDir, "ShareBoxZen.ico");
            if (File.Exists(icoFile))
            {
                try { trayIcon.Icon = new Icon(icoFile); } catch { trayIcon.Icon = SystemIcons.Application; }
            }
            else
            {
                trayIcon.Icon = SystemIcons.Application;
            }

            trayIcon.DoubleClick += (s, e) => {
                if (instance != null)
                {
                    instance.Show();
                    instance.WindowState = FormWindowState.Normal;
                    instance.BringToFront();
                }
                OpenAppWindow();
            };
        }

        private static string GetLocalIPv4()
        {
            try
            {
                using (Socket socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, 0))
                {
                    socket.Connect("8.8.8.8", 65530);
                    IPEndPoint endPoint = socket.LocalEndPoint as IPEndPoint;
                    if (endPoint != null)
                    {
                        return endPoint.Address.ToString();
                    }
                }
            }
            catch { }
            return "127.0.0.1";
        }

        private static void ExitApplication()
        {
            Cleanup();
            Environment.Exit(0);
        }

        private static void Cleanup()
        {
            try
            {
                if (trayIcon != null)
                {
                    trayIcon.Visible = false;
                    trayIcon.Dispose();
                    trayIcon = null;
                }
            }
            catch { }

            try
            {
                if (serverProcess != null && !serverProcess.HasExited)
                {
                    serverProcess.Kill();
                    serverProcess = null;
                }
            }
            catch { }

            try
            {
                if (singleInstanceMutex != null)
                {
                    singleInstanceMutex.ReleaseMutex();
                    singleInstanceMutex.Dispose();
                    singleInstanceMutex = null;
                }
            }
            catch { }
        }
    }
}
