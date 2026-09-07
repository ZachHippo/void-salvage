$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:5500/")
$listener.Start()
Write-Host "Serving $root on http://localhost:5500/  (Ctrl+C to stop)"
$mime = @{ ".html"="text/html"; ".js"="application/javascript"; ".css"="text/css" }
while ($listener.IsListening) {
    $context = $listener.GetContext()
    $req = $context.Request
    $res = $context.Response
    $path = $req.Url.LocalPath
    if ($path -eq "/") { $path = "/index.html" }
    $filePath = Join-Path $root $path.TrimStart("/")
    Write-Host "$($req.HttpMethod) $path"
    if (Test-Path $filePath -PathType Leaf) {
        $ext = [System.IO.Path]::GetExtension($filePath)
        $contentType = $mime[$ext]
        if (-not $contentType) { $contentType = "application/octet-stream" }
        $bytes = [System.IO.File]::ReadAllBytes($filePath)
        $res.ContentType = $contentType
        $res.ContentLength64 = $bytes.Length
        # A HEAD request wants the headers only -- writing a body here overruns
        # Content-Length and throws ProtocolViolationException.
        if ($req.HttpMethod -ne "HEAD") {
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
        }
    } else {
        $res.StatusCode = 404
    }
    $res.OutputStream.Close()
}
