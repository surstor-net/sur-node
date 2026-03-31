# SurStor DLFS startup script
# Starts DLFSServer on localhost:8765 if not already running

$port = 8765
$test = try { (Invoke-WebRequest -Uri "http://localhost:$port/dlfs/" -TimeoutSec 2 -UseBasicParsing).StatusCode } catch { 0 }

if ($test -eq 200) {
    Write-Host "DLFS already running on port $port"
    exit 0
}

$javaArgs = '-cp', 'C:\Users\rich\projects\dlfs-test\deps\*', 'convex.dlfs.DLFSServer', "$port"
Start-Process -FilePath 'java' -ArgumentList $javaArgs -WindowStyle Hidden -RedirectStandardOutput 'C:\Users\rich\projects\sur-node\dlfs.log' -RedirectStandardError 'C:\Users\rich\projects\sur-node\dlfs-err.log'
Write-Host "DLFS started on port $port"
