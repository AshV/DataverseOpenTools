using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace DvOpenTools.Proxy;

internal static class Program
{
    private const string ToolPrefix = "dvopentools_";
    private static readonly TimeSpan TokenTtl = TimeSpan.FromMinutes(40);
    private static readonly Regex ManifestScriptRegex = new(
        @"<script[^>]+id=[""']dvopentools-manifest[""'][^>]*>([\s\S]*?)<\/script>",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex PacUrlRegex = new(
        @"https://[a-zA-Z0-9.-]+\.(?:dynamics\.com|dynamics\.cn|microsoftdynamics\.us|appsplatform\.us)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex WebResourceDiscoveryRegex = new(
        @"/api/data/v[^/]+/webresourceset",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex WebResourcePrefixRegex = new(
        @"startswith\(name,'([^']+)'\)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly SemaphoreSlim TokenLock = new(1, 1);
    private static CachedToken? _cachedToken;

    private static readonly HttpClient Http = new(new HttpClientHandler
    {
        AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate | DecompressionMethods.Brotli,
        AllowAutoRedirect = false
    })
    {
        Timeout = TimeSpan.FromSeconds(120)
    };

    private sealed record CachedToken(string Value, string Source, DateTimeOffset FetchedAtUtc);

    private sealed class ProxyOptions
    {
        public string EnvUrl { get; set; } = "";
        public int Port { get; set; } = 8787;
        public string Auth { get; set; } = "auto";
        public bool LocalOnly { get; set; }
        public bool BuildManifest { get; set; }
        public bool BuildBundle { get; set; }
        public string BundleOut { get; set; } = "";
        public bool Help { get; set; }
    }

    public static async Task<int> Main(string[] args)
    {
        var rootDir = ResolveWorkspaceRoot();
        var toolsDir = Path.Combine(rootDir, "tools");
        var opts = ParseArgs(args);

        if (opts.Help)
        {
            PrintUsage();
            return 0;
        }

        if (opts.BuildManifest)
        {
            var items = BuildToolsManifest(rootDir, toolsDir);
            Console.WriteLine($"[dev-server] Wrote tools/manifest.json ({items.Count} tools).");
            return 0;
        }

        if (opts.BuildBundle)
        {
            var (outPath, count, bytes) = BuildToolsBundle(rootDir, toolsDir, opts.BundleOut);
            Console.WriteLine($"[dev-server] Wrote {Path.GetRelativePath(rootDir, outPath)} ({count} tools, {bytes / 1024.0:F1} KB).");
            return 0;
        }

        if (!opts.LocalOnly && string.IsNullOrEmpty(opts.EnvUrl))
        {
            var detected = DetectPacOrgUrl();
            if (!string.IsNullOrEmpty(detected))
            {
                opts.EnvUrl = detected;
                Console.WriteLine($"[dev-server] Auto-detected Dataverse org from `pac org who`: {detected}");
            }
            else
            {
                Console.WriteLine("[dev-server] No --env provided and `pac org who` unavailable; starting in --local-only UI mode.");
                opts.LocalOnly = true;
            }
        }

        if (!opts.LocalOnly)
        {
            try
            {
                await GetBearerTokenAsync(opts, forceRefresh: false);
                Console.WriteLine($"[dev-server] Server-side Bearer token acquired via {_cachedToken?.Source} (kept in .NET memory only).");
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[dev-server] Warning: Initial token fetch failed ({ex.Message}). API calls will retry when requested.");
            }
        }

        using var listener = new HttpListener();
        var prefix = $"http://127.0.0.1:{opts.Port}/";
        listener.Prefixes.Add(prefix);
        listener.Start();

        Console.WriteLine();
        Console.WriteLine($"⚡ DV Open Tools Local Server (.NET) running at: {prefix}dvopentools_host.html");
        Console.WriteLine($"   Workspace root: {rootDir}");
        Console.WriteLine($"   Mode: {(opts.LocalOnly ? "Local UI only (no Dataverse proxy)" : $"Proxying /api/data/* -> {opts.EnvUrl}")}");
        Console.WriteLine($"   Local tools auto-discovered: {ListLocalToolWebResources(rootDir, toolsDir).Count}");
        Console.WriteLine("   Press Ctrl+C to stop.");
        Console.WriteLine();

        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            cts.Cancel();
            try { listener.Stop(); } catch { }
        };

        try
        {
            while (!cts.IsCancellationRequested && listener.IsListening)
            {
                HttpListenerContext ctx;
                try
                {
                    ctx = await listener.GetContextAsync();
                }
                catch (HttpListenerException) when (cts.IsCancellationRequested || !listener.IsListening)
                {
                    break;
                }
                catch (ObjectDisposedException)
                {
                    break;
                }

                _ = Task.Run(() => HandleRequestAsync(ctx, rootDir, toolsDir, opts));
            }
        }
        catch (OperationCanceledException) { }

        return 0;
    }

    private static void PrintUsage()
    {
        Console.WriteLine("""
DV Open Tools — Local C# (.NET) Dev Server & Auth Proxy

Usage:
  dotnet run --project dev-server -- [--env https://yourorg.crm.dynamics.com] [--port 8787] [--auth auto|pac|az|env] [--local-only]

Options:
  --env <url>       Target Dataverse org URL (auto-detected via `pac org who` if omitted)
  --port <num>      Local HTTP port (default: 8787)
  --auth <mode>     Token source: auto (default), pac (`pac auth token`), az (`az account get-access-token`), or env (DV_TOKEN)
  --local-only      Serve local HTML tools without proxying Dataverse API calls
  --build-manifest  Regenerate tools/manifest.json from tools/dvopentools_*.html and exit
  --build-bundle    Generate a single-file tool bundle HTML (default: dist/dvopentools_bundle_all.html)
""");
    }

    private static string ResolveWorkspaceRoot()
    {
        var candidates = new[]
        {
            Directory.GetCurrentDirectory(),
            Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), "..")),
            AppContext.BaseDirectory,
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".."))
        };

        foreach (var c in candidates)
        {
            var dir = c;
            for (var i = 0; i < 6 && !string.IsNullOrEmpty(dir); i++)
            {
                if (File.Exists(Path.Combine(dir, "dvopentools_host.html")) &&
                    Directory.Exists(Path.Combine(dir, "tools")))
                {
                    return Path.GetFullPath(dir);
                }
                dir = Directory.GetParent(dir)?.FullName ?? "";
            }
        }
        return Directory.GetCurrentDirectory();
    }

    private static ProxyOptions ParseArgs(string[] args)
    {
        var opts = new ProxyOptions
        {
            EnvUrl = NormalizeEnvUrl(Environment.GetEnvironmentVariable("DV_ENV_URL") ?? ""),
            Port = int.TryParse(Environment.GetEnvironmentVariable("PORT"), out var p) && p > 0 ? p : 8787,
            Auth = (Environment.GetEnvironmentVariable("DV_AUTH_MODE") ?? "auto").Trim().ToLowerInvariant()
        };

        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            if (arg is "--help" or "-h") opts.Help = true;
            else if (arg == "--local-only") opts.LocalOnly = true;
            else if (arg == "--build-manifest") opts.BuildManifest = true;
            else if (arg == "--build-bundle")
            {
                opts.BuildBundle = true;
                if (i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal)) opts.BundleOut = args[++i];
            }
            else if (arg.StartsWith("--build-bundle=", StringComparison.Ordinal)) { opts.BuildBundle = true; opts.BundleOut = arg[15..]; }
            else if (arg == "--env" && i + 1 < args.Length) opts.EnvUrl = NormalizeEnvUrl(args[++i]);
            else if (arg.StartsWith("--env=")) opts.EnvUrl = NormalizeEnvUrl(arg[6..]);
            else if (arg == "--port" && i + 1 < args.Length) opts.Port = int.TryParse(args[++i], out var pv) && pv > 0 ? pv : 8787;
            else if (arg.StartsWith("--port=")) opts.Port = int.TryParse(arg[7..], out var pv2) && pv2 > 0 ? pv2 : 8787;
            else if (arg == "--auth" && i + 1 < args.Length) opts.Auth = args[++i].Trim().ToLowerInvariant();
            else if (arg.StartsWith("--auth=")) opts.Auth = arg[7..].Trim().ToLowerInvariant();
        }
        return opts;
    }

    private static string NormalizeEnvUrl(string raw)
    {
        var s = (raw ?? "").Trim();
        if (string.IsNullOrEmpty(s)) return "";
        if (!s.StartsWith("http://", StringComparison.OrdinalIgnoreCase) &&
            !s.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            s = "https://" + s;
        }
        return Uri.TryCreate(s, UriKind.Absolute, out var uri)
            ? uri.GetLeftPart(UriPartial.Authority)
            : s.TrimEnd('/');
    }

    private static string RunCli(string fileName, string arguments, int timeoutMs = 15000)
    {
        static (int exitCode, string stdout, string stderr) Exec(string exe, string args, int ms)
        {
            var psi = new ProcessStartInfo
            {
                FileName = exe,
                Arguments = args,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using var proc = Process.Start(psi) ?? throw new InvalidOperationException($"Failed to start `{exe}`.");
            var stdoutTask = proc.StandardOutput.ReadToEndAsync();
            var stderrTask = proc.StandardError.ReadToEndAsync();
            if (!proc.WaitForExit(ms))
            {
                try { proc.Kill(entireProcessTree: true); } catch { }
                throw new TimeoutException($"`{exe}` timed out after {ms}ms.");
            }
            return (proc.ExitCode, stdoutTask.GetAwaiter().GetResult(), stderrTask.GetAwaiter().GetResult());
        }

        (int exitCode, string stdout, string stderr) result;
        try
        {
            result = Exec(fileName, arguments, timeoutMs);
        }
        catch when (OperatingSystem.IsWindows())
        {
            // Support .cmd/.bat shims such as az.cmd on Windows
            result = Exec("cmd.exe", $"/d /c {fileName} {arguments}", timeoutMs);
        }

        if (result.exitCode != 0)
        {
            var msg = string.IsNullOrWhiteSpace(result.stderr) ? result.stdout : result.stderr;
            throw new InvalidOperationException($"`{fileName}` exited with {result.exitCode}: {msg.Trim()}");
        }
        return result.stdout;
    }

    private static string DetectPacOrgUrl()
    {
        try
        {
            var output = RunCli("pac", "org who", 8000);
            var match = PacUrlRegex.Match(output);
            return match.Success ? match.Value : "";
        }
        catch
        {
            return "";
        }
    }

    private static (string Value, string Source)? AcquireTokenFromCli(string envUrl, string authMode)
    {
        static (string Value, string Source)? TryEnv()
        {
            var raw = (Environment.GetEnvironmentVariable("DV_TOKEN") ?? "").Trim();
            if (raw.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
                raw = raw[7..].Trim();
            return string.IsNullOrEmpty(raw) ? null : (raw, "DV_TOKEN env");
        }

        static (string Value, string Source) TryPac()
        {
            var output = RunCli("pac", "auth token", 15000);
            var lines = output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            for (var i = lines.Length - 1; i >= 0; i--)
            {
                if (lines[i].Length > 40 && lines[i].Split('.').Length == 3)
                    return (lines[i], "pac auth token");
            }
            throw new InvalidOperationException("Could not find JWT in `pac auth token` output.");
        }

        (string Value, string Source) TryAz()
        {
            if (string.IsNullOrEmpty(envUrl))
                throw new InvalidOperationException("Environment URL is required for `az account get-access-token`.");
            var output = RunCli("az", $"account get-access-token --resource \"{envUrl}\" --query accessToken -o tsv", 15000).Trim();
            if (string.IsNullOrEmpty(output) || output.Split('.').Length != 3)
                throw new InvalidOperationException("Invalid token returned by `az`.");
            return (output, "az account get-access-token");
        }

        if (authMode == "env") return TryEnv();
        if (authMode == "pac") return TryPac();
        if (authMode == "az") return TryAz();

        var envTok = TryEnv();
        if (envTok is not null) return envTok;

        var errs = new List<string>();
        try { return TryPac(); } catch (Exception ex) { errs.Add(ex.Message); }
        try { return TryAz(); } catch (Exception ex) { errs.Add(ex.Message); }
        throw new InvalidOperationException($"No token source succeeded:\n  - {string.Join("\n  - ", errs)}");
    }

    private static async Task<string?> GetBearerTokenAsync(ProxyOptions opts, bool forceRefresh)
    {
        if (opts.LocalOnly || string.IsNullOrEmpty(opts.EnvUrl)) return null;

        await TokenLock.WaitAsync();
        try
        {
            if (!forceRefresh && _cachedToken is not null && DateTimeOffset.UtcNow - _cachedToken.FetchedAtUtc < TokenTtl)
            {
                return _cachedToken.Value;
            }
            var acquired = AcquireTokenFromCli(opts.EnvUrl, opts.Auth);
            if (acquired is null) return null;
            _cachedToken = new CachedToken(acquired.Value.Value, acquired.Value.Source, DateTimeOffset.UtcNow);
            return _cachedToken.Value;
        }
        finally
        {
            TokenLock.Release();
        }
    }

    private static string? ResolveSafeLocalFile(string relName, string baseDir)
    {
        var pathPart = relName.Split('?')[0];
        var clean = Uri.UnescapeDataString(pathPart).TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
        var fullBase = Path.GetFullPath(baseDir);
        var resolved = Path.GetFullPath(Path.Combine(fullBase, clean));
        if (!resolved.StartsWith(fullBase + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) &&
            !string.Equals(resolved, fullBase, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }
        return File.Exists(resolved) ? resolved : null;
    }

    private static List<(string Name, string DisplayName)> ListLocalToolWebResources(string rootDir, string toolsDir, string prefix = ToolPrefix)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var dir in new[] { toolsDir, rootDir })
        {
            if (!Directory.Exists(dir)) continue;
            foreach (var filePath in Directory.EnumerateFiles(dir, "*.html"))
            {
                var name = Path.GetFileName(filePath);
                if (name.StartsWith(prefix, StringComparison.Ordinal) &&
                    !string.Equals(name, $"{prefix}host.html", StringComparison.Ordinal) &&
                    !string.Equals(name, $"{prefix}template.html", StringComparison.Ordinal))
                {
                    seen.Add(name);
                }
            }
        }

        return seen
            .OrderBy(n => n, StringComparer.Ordinal)
            .Select(n => (n, n[prefix.Length..^5]))
            .ToList();
    }

    private static List<JsonObject> BuildToolsManifest(string rootDir, string toolsDir, string prefix = ToolPrefix)
    {
        var items = new List<(string Category, string Name, JsonObject Obj)>();
        foreach (var (wrName, _) in ListLocalToolWebResources(rootDir, toolsDir, prefix))
        {
            var fullPath = ResolveSafeLocalFile(wrName, toolsDir) ?? ResolveSafeLocalFile(wrName, rootDir);
            if (fullPath is null) continue;
            var raw = File.ReadAllText(fullPath, Encoding.UTF8);
            JsonObject? meta = null;
            var m = ManifestScriptRegex.Match(raw);
            if (m.Success)
            {
                try { meta = JsonNode.Parse(m.Groups[1].Value) as JsonObject; } catch { }
            }

            var fallbackName = wrName[prefix.Length..^5];
            var category = meta?["category"]?.GetValue<string>() ?? "General";
            var name = meta?["name"]?.GetValue<string>() ?? fallbackName;

            var obj = new JsonObject
            {
                ["wrName"] = wrName,
                ["id"] = meta?["id"]?.GetValue<string>() ?? fallbackName.ToLowerInvariant(),
                ["name"] = name,
                ["icon"] = meta?["icon"]?.GetValue<string>() ?? "🔧",
                ["category"] = category,
                ["version"] = meta?["version"]?.GetValue<string>() ?? "1.0.0",
                ["minHostVersion"] = meta?["minHostVersion"]?.DeepClone(),
                ["description"] = meta?["description"]?.GetValue<string>() ?? "",
                ["sizeBytes"] = new FileInfo(fullPath).Length
            };
            items.Add((category, name, obj));
        }

        var sorted = items
            .OrderBy(x => x.Category, StringComparer.Ordinal)
            .ThenBy(x => x.Name, StringComparer.Ordinal)
            .Select(x => x.Obj)
            .ToList();

        if (Directory.Exists(toolsDir))
        {
            var arr = new JsonArray(sorted.Cast<JsonNode?>().ToArray());
            var json = arr.ToJsonString(new JsonSerializerOptions
            {
                WriteIndented = true,
                Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
            }) + "\n";
            File.WriteAllText(Path.Combine(toolsDir, "manifest.json"), json, new UTF8Encoding(false));
        }

        return sorted;
    }

    private static (string OutPath, int Count, int Bytes) BuildToolsBundle(string rootDir, string toolsDir, string? outPath, string prefix = ToolPrefix)
    {
        var manifest = BuildToolsManifest(rootDir, toolsDir, prefix);
        var bundleTools = new JsonArray();
        var rows = new StringBuilder();
        foreach (var item in manifest)
        {
            var wrName = item["wrName"]?.GetValue<string>() ?? "";
            var fullPath = ResolveSafeLocalFile(wrName, toolsDir) ?? ResolveSafeLocalFile(wrName, rootDir);
            if (fullPath is null) continue;
            var toolHtml = File.ReadAllText(fullPath, Encoding.UTF8);
            var clone = item.DeepClone().AsObject();
            clone["html"] = toolHtml;
            bundleTools.Add(clone);

            var icon = WebUtility.HtmlEncode(item["icon"]?.GetValue<string>() ?? "🔧");
            var name = WebUtility.HtmlEncode(item["name"]?.GetValue<string>() ?? wrName);
            var cat = WebUtility.HtmlEncode(item["category"]?.GetValue<string>() ?? "General");
            var ver = WebUtility.HtmlEncode(item["version"]?.GetValue<string>() ?? "1.0.0");
            var sizeKb = (item["sizeBytes"]?.GetValue<long>() ?? 0) / 1024.0;
            rows.AppendLine($"      <tr><td>{icon} {name}</td><td><code>{WebUtility.HtmlEncode(wrName)}</code></td><td>{cat}</td><td>v{ver}</td><td>{sizeKb:F1} KB</td></tr>");
        }

        var payload = new JsonObject
        {
            ["bundleVersion"] = 1,
            ["name"] = "DV Open Tools Complete Bundle",
            ["createdAt"] = DateTimeOffset.UtcNow.ToString("O"),
            ["tools"] = bundleTools
        };
        var rawJson = payload.ToJsonString(new JsonSerializerOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping })
            .Replace("<", "\\u003c");
        var html = $$"""
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>DV Open Tools — Bundled Tool Pack ({{bundleTools.Count}} tools)</title>
  <style>body{font-family:Segoe UI,system-ui,sans-serif;max-width:900px;margin:32px auto;padding:0 16px;color:#1e293b}table{width:100%;border-collapse:collapse;margin-top:16px;font-size:13px}th,td{border:1px solid #cbd5e1;padding:8px 10px;text-align:left}th{background:#f1f5f9}</style>
</head>
<body>
  <h1>📦 DV Open Tools — Bundled Tool Pack ({{bundleTools.Count}} tools)</h1>
  <p>Upload this single HTML Web Resource alongside <code>dvopentools_host.html</code> (name starting with <code>dvopentools_</code>), or import it in the Host via <strong>Load Tool from File</strong>.</p>
  <table>
    <thead><tr><th>Tool</th><th>Source File</th><th>Category</th><th>Version</th><th>Size</th></tr></thead>
    <tbody>
{{rows}}    </tbody>
  </table>
  <script type="application/json" id="dvopentools-bundle">{{rawJson}}</script>
</body>
</html>
""";
        var resolvedOut = string.IsNullOrWhiteSpace(outPath)
            ? Path.Combine(rootDir, "dist", "dvopentools_bundle_all.html")
            : Path.GetFullPath(Path.Combine(rootDir, outPath));
        Directory.CreateDirectory(Path.GetDirectoryName(resolvedOut)!);
        var bytes = Encoding.UTF8.GetBytes(html);
        File.WriteAllBytes(resolvedOut, bytes);
        return (resolvedOut, bundleTools.Count, bytes.Length);
    }

    private static string MimeTypeFor(string filePath) => Path.GetExtension(filePath).ToLowerInvariant() switch
    {
        ".html" or ".htm" => "text/html; charset=utf-8",
        ".js" => "application/javascript; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".json" => "application/json; charset=utf-8",
        ".md" => "text/markdown; charset=utf-8",
        _ => "application/octet-stream"
    };

    private static void ApplyCorsHeaders(HttpListenerRequest req, HttpListenerResponse res)
    {
        res.Headers["Access-Control-Allow-Origin"] = "*";
        res.Headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, PUT, DELETE, OPTIONS";
        res.Headers["Access-Control-Allow-Headers"] = req.Headers["Access-Control-Request-Headers"]
            ?? "Content-Type, Accept, OData-MaxVersion, OData-Version, Prefer, If-Match, If-None-Match";
        res.Headers["Access-Control-Expose-Headers"] = "*";
        res.Headers["Access-Control-Allow-Private-Network"] = "true";
    }

    private static async Task WriteBytesAsync(HttpListenerResponse res, int statusCode, string contentType, byte[] bytes, string? cacheControl = null)
    {
        res.StatusCode = statusCode;
        res.ContentType = contentType;
        if (!string.IsNullOrEmpty(cacheControl))
            res.Headers["Cache-Control"] = cacheControl;
        res.ContentLength64 = bytes.Length;
        await res.OutputStream.WriteAsync(bytes);
        res.OutputStream.Close();
    }

    private static async Task ServeFileAsync(HttpListenerResponse res, string filePath)
    {
        var bytes = await File.ReadAllBytesAsync(filePath);
        await WriteBytesAsync(res, 200, MimeTypeFor(filePath), bytes, "no-store");
    }

    private static async Task HandleRequestAsync(HttpListenerContext ctx, string rootDir, string toolsDir, ProxyOptions opts)
    {
        var req = ctx.Request;
        var res = ctx.Response;
        try
        {
            ApplyCorsHeaders(req, res);

            if (string.Equals(req.HttpMethod, "OPTIONS", StringComparison.OrdinalIgnoreCase))
            {
                res.StatusCode = 204;
                res.Close();
                return;
            }

            var rawUrl = req.RawUrl ?? "/";
            var reqPath = rawUrl.Split('?')[0];

            if (reqPath == "/_proxy/status")
            {
                var targetHost = Uri.TryCreate(opts.EnvUrl, UriKind.Absolute, out var u) ? u.Host : "";
                var payload = JsonSerializer.Serialize(new
                {
                    ok = true,
                    localOnly = opts.LocalOnly,
                    targetUrl = opts.EnvUrl ?? "",
                    targetHost,
                    localToolsCount = ListLocalToolWebResources(rootDir, toolsDir).Count
                });
                await WriteBytesAsync(res, 200, "application/json; charset=utf-8", Encoding.UTF8.GetBytes(payload), "no-store");
                return;
            }

            if (reqPath is "/" or "/index.html")
            {
                var homeFile = ResolveSafeLocalFile("index.html", rootDir) ?? ResolveSafeLocalFile("dvopentools_host.html", rootDir);
                if (homeFile is not null) { await ServeFileAsync(res, homeFile); return; }
            }

            if (reqPath == "/dvopentools_host.html")
            {
                var hostFile = ResolveSafeLocalFile("dvopentools_host.html", rootDir);
                if (hostFile is not null) { await ServeFileAsync(res, hostFile); return; }
            }

            if (reqPath.StartsWith("/WebResources/", StringComparison.Ordinal))
            {
                var wrName = reqPath["/WebResources/".Length..];
                var localTool = ResolveSafeLocalFile(wrName, toolsDir) ?? ResolveSafeLocalFile(wrName, rootDir);
                if (localTool is not null) { await ServeFileAsync(res, localTool); return; }

                if (!opts.LocalOnly && !string.IsNullOrEmpty(opts.EnvUrl))
                {
                    var body = await ReadRequestBodyAsync(req);
                    await ProxyToDataverseAsync(req, res, rawUrl, rootDir, toolsDir, opts, body, retried: false);
                    return;
                }
            }

            if (reqPath.StartsWith("/api/data/", StringComparison.Ordinal))
            {
                var body = await ReadRequestBodyAsync(req);
                if (opts.LocalOnly || string.IsNullOrEmpty(opts.EnvUrl))
                {
                    if (Regex.IsMatch(reqPath, @"/webresourceset", RegexOptions.IgnoreCase))
                    {
                        var localList = ListLocalToolWebResources(rootDir, toolsDir)
                            .Select(x => new { name = x.Name, displayname = x.DisplayName });
                        var json = JsonSerializer.Serialize(new { value = localList });
                        await WriteBytesAsync(res, 200, "application/json; charset=utf-8", Encoding.UTF8.GetBytes(json));
                        return;
                    }

                    var errJson = JsonSerializer.Serialize(new
                    {
                        error = new { message = "Running in local-only mode (pass --env https://yourorg.crm.dynamics.com to proxy live Dataverse calls)." }
                    });
                    await WriteBytesAsync(res, 503, "application/json; charset=utf-8", Encoding.UTF8.GetBytes(errJson));
                    return;
                }

                await ProxyToDataverseAsync(req, res, rawUrl, rootDir, toolsDir, opts, body, retried: false);
                return;
            }

            var otherLocal = ResolveSafeLocalFile(reqPath, rootDir);
            if (otherLocal is not null) { await ServeFileAsync(res, otherLocal); return; }

            await WriteBytesAsync(res, 404, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Not Found"));
        }
        catch (Exception ex)
        {
            try
            {
                var errJson = JsonSerializer.Serialize(new { error = new { message = $"Local .NET proxy error: {ex.Message}" } });
                await WriteBytesAsync(res, 500, "application/json; charset=utf-8", Encoding.UTF8.GetBytes(errJson));
            }
            catch { }
        }
    }

    private static async Task<byte[]> ReadRequestBodyAsync(HttpListenerRequest req)
    {
        if (!req.HasEntityBody) return Array.Empty<byte>();
        using var ms = new MemoryStream();
        await req.InputStream.CopyToAsync(ms);
        return ms.ToArray();
    }

    private static async Task ProxyToDataverseAsync(
        HttpListenerRequest req,
        HttpListenerResponse res,
        string rawUrl,
        string rootDir,
        string toolsDir,
        ProxyOptions opts,
        byte[] reqBody,
        bool retried)
    {
        string? token;
        try
        {
            token = await GetBearerTokenAsync(opts, retried);
        }
        catch (Exception ex)
        {
            var errJson = JsonSerializer.Serialize(new { error = new { message = $"Local dev-server token error: {ex.Message}" } });
            await WriteBytesAsync(res, 401, "application/json; charset=utf-8", Encoding.UTF8.GetBytes(errJson));
            return;
        }

        var targetUri = new Uri(new Uri(opts.EnvUrl), rawUrl);
        using var msg = new HttpRequestMessage(new HttpMethod(req.HttpMethod), targetUri);
        msg.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        msg.Headers.TryAddWithoutValidation("Accept", req.Headers["Accept"] ?? "application/json");
        msg.Headers.TryAddWithoutValidation("OData-MaxVersion", req.Headers["OData-MaxVersion"] ?? "4.0");
        msg.Headers.TryAddWithoutValidation("OData-Version", req.Headers["OData-Version"] ?? "4.0");

        if (!string.IsNullOrEmpty(req.Headers["Prefer"]))
            msg.Headers.TryAddWithoutValidation("Prefer", req.Headers["Prefer"]);
        if (!string.IsNullOrEmpty(req.Headers["If-Match"]))
            msg.Headers.TryAddWithoutValidation("If-Match", req.Headers["If-Match"]);
        if (!string.IsNullOrEmpty(req.Headers["If-None-Match"]))
            msg.Headers.TryAddWithoutValidation("If-None-Match", req.Headers["If-None-Match"]);

        if (reqBody.Length > 0)
        {
            msg.Content = new ByteArrayContent(reqBody);
            if (!string.IsNullOrEmpty(req.ContentType))
                msg.Content.Headers.TryAddWithoutValidation("Content-Type", req.ContentType);
        }

        HttpResponseMessage proxyRes;
        try
        {
            proxyRes = await Http.SendAsync(msg, HttpCompletionOption.ResponseHeadersRead);
        }
        catch (Exception ex)
        {
            var errJson = JsonSerializer.Serialize(new { error = new { message = $"Dataverse proxy error: {ex.Message}" } });
            await WriteBytesAsync(res, 502, "application/json; charset=utf-8", Encoding.UTF8.GetBytes(errJson));
            return;
        }

        using (proxyRes)
        {
            if (proxyRes.StatusCode == HttpStatusCode.Unauthorized && !retried)
            {
                await ProxyToDataverseAsync(req, res, rawUrl, rootDir, toolsDir, opts, reqBody, retried: true);
                return;
            }

            var isWebResourceDiscovery = string.Equals(req.HttpMethod, "GET", StringComparison.OrdinalIgnoreCase) &&
                                         WebResourceDiscoveryRegex.IsMatch(rawUrl);

            var respBytes = await proxyRes.Content.ReadAsByteArrayAsync();
            CopySanitizedResponseHeaders(proxyRes, res);

            if (isWebResourceDiscovery && proxyRes.StatusCode == HttpStatusCode.OK)
            {
                try
                {
                    var node = JsonNode.Parse(respBytes)?.AsObject();
                    var valueArr = node?["value"]?.AsArray();
                    if (node is not null && valueArr is not null)
                    {
                        var prefixMatch = WebResourcePrefixRegex.Match(Uri.UnescapeDataString(rawUrl));
                        var prefix = prefixMatch.Success ? prefixMatch.Groups[1].Value : ToolPrefix;
                        var seen = new HashSet<string>(
                            valueArr.Select(x => x?["name"]?.GetValue<string>() ?? "").Where(x => !string.IsNullOrEmpty(x)),
                            StringComparer.OrdinalIgnoreCase);

                        foreach (var wr in ListLocalToolWebResources(rootDir, toolsDir, prefix))
                        {
                            if (!seen.Contains(wr.Name))
                            {
                                valueArr.Add(new JsonObject
                                {
                                    ["name"] = wr.Name,
                                    ["displayname"] = wr.DisplayName
                                });
                            }
                        }

                        var merged = Encoding.UTF8.GetBytes(node.ToJsonString());
                        await WriteBytesAsync(res, 200, "application/json; charset=utf-8", merged);
                        return;
                    }
                }
                catch { }
            }

            var contentType = proxyRes.Content.Headers.ContentType?.ToString() ?? "application/octet-stream";
            await WriteBytesAsync(res, (int)proxyRes.StatusCode, contentType, respBytes);
        }
    }

    private static void CopySanitizedResponseHeaders(HttpResponseMessage src, HttpListenerResponse dst)
    {
        static bool Skip(string name)
        {
            var lk = name.ToLowerInvariant();
            return lk is "connection" or "keep-alive" or "transfer-encoding" or "content-length" or "content-encoding" or "set-cookie" or "content-type"
                || lk.StartsWith("access-control-", StringComparison.Ordinal);
        }

        foreach (var h in src.Headers)
        {
            if (Skip(h.Key)) continue;
            try { dst.Headers[h.Key] = string.Join(", ", h.Value); } catch { }
        }
        foreach (var h in src.Content.Headers)
        {
            if (Skip(h.Key)) continue;
            try { dst.Headers[h.Key] = string.Join(", ", h.Value); } catch { }
        }
    }
}
