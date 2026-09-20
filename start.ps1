# MingBot Start Script
# Usage: .\start.ps1 [start|callback|tunnel|stop|status|logs]
param([string]$Action = 'start')

$ProjectRoot = Split-Path $MyInvocation.MyCommand.Path -Parent
$Script = Join-Path $ProjectRoot 'src\index.js'
$JobName = 'mingbot'

# Bypass system proxy for QQ Guild API
$env:NO_PROXY = 'localhost,127.0.0.1,*api.sgroup.qq.com,*qq.com'

function Write-Log { param($Msg) Write-Host ("[$(Get-Date -Format 'HH:mm:ss')] $Msg") }

function Start-Bot {
    param([bool]$UseCallback = $false)

    Write-Log "Starting MingBot..."
    if ($UseCallback) {
        Write-Log "模式: HTTP回调"
        $env:QQ_BOT_USE_CALLBACK = 'true'
        $env:QQ_BOT_SANDBOX = 'true'
        $env:BOT_PORT = '9000'
    } else {
        Write-Log "模式: WebSocket"
        $env:QQ_BOT_SANDBOX = 'true'
    }
    $env:HTTP_PROXY = ''
    $env:HTTPS_PROXY = ''

    Remove-Job -Name $JobName -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500

    $job = Start-Job -Name $JobName -ScriptBlock {
        param($root, $script, $useCallback, $botPort)
        $env:QQ_BOT_SANDBOX = 'true'
        $env:HTTP_PROXY = ''
        $env:HTTPS_PROXY = ''
        $env:NO_PROXY = 'localhost,127.0.0.1,*api.sgroup.qq.com,*qq.com'
        if ($useCallback) {
            $env:QQ_BOT_USE_CALLBACK = 'true'
            $env:BOT_PORT = $botPort
        }
        Set-Location $root
        & $script
    } -ArgumentList $ProjectRoot, $Script, $UseCallback, '9000'

    Start-Sleep -Seconds 4
    $state = (Get-Job -Id $job.Id -ErrorAction SilentlyContinue).State
    if ($state -eq 'Running') {
        Write-Log "MingBot running in background (Job ID: $($job.Id))"
        Write-Log "View logs: .\start.ps1 logs"
        Write-Log "Stop: .\start.ps1 stop"
    } else {
        $output = Receive-Job -Id $job.Id -ErrorAction SilentlyContinue
        Write-Log "Start failed:`n$output"
        Remove-Job -Id $job.Id -ErrorAction SilentlyContinue
    }
}

function Start-Tunnel {
    Write-Log "Starting cloudflared tunnel..."
    Stop-Process -Name cloudflared -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Start-Process -FilePath 'H:\WorkSpace\MingBot\cloudflared.exe' -ArgumentList 'tunnel','--config','H:\WorkSpace\MingBot\cloudflared.yml','run','mingbot' -NoNewWindow
    Start-Sleep -Seconds 3
    Write-Log "Tunnel started -> https://bot.mingpixel.net/callback"
}

function Stop-Bot {
    Write-Log "Stopping MingBot..."
    $job = Get-Job -Name $JobName -ErrorAction SilentlyContinue
    if ($job) {
        Stop-Job -Id $job.Id
        Start-Sleep -Seconds 2
        Remove-Job -Id $job.Id -ErrorAction SilentlyContinue
        Write-Log "MingBot stopped"
    } else {
        Write-Log "MingBot not running"
    }
}

function Show-Status {
    $job = Get-Job -Name $JobName -ErrorAction SilentlyContinue
    if ($job) {
        Write-Host "[OK] MingBot running (Job ID: $($job.Id))" -ForegroundColor Green
        Write-Host "   State: $($job.State)"
    } else {
        Write-Host "[X] MingBot not running" -ForegroundColor Red
    }
    $cf = Get-Process cloudflared -ErrorAction SilentlyContinue
    if ($cf) {
        Write-Host "[OK] cloudflared tunnel running (PID: $($cf.Id))" -ForegroundColor Green
    } else {
        Write-Host "[X] cloudflared tunnel not running" -ForegroundColor Red
    }
}

function Show-Logs {
    Write-Log "Recent output:"
    $job = Get-Job -Name $JobName -ErrorAction SilentlyContinue
    if ($job) {
        $out = Receive-Job -Id $job.Id -ErrorAction SilentlyContinue
        if ($out) { $out } else { Write-Log "(no output)" }
        Write-Log "Monitoring... (Ctrl+C to exit)"
        while ((Get-Job -Id $job.Id -ErrorAction SilentlyContinue).State -eq 'Running') {
            Start-Sleep -Seconds 2
            $new = Receive-Job -Id $job.Id -ErrorAction SilentlyContinue
            if ($new) { $new | ForEach-Object { Write-Host $_ } }
        }
    } else {
        Write-Log "Bot not running"
    }
}

switch ($Action) {
    'start'    { Start-Bot -UseCallback $false }
    'callback' { Start-Bot -UseCallback $true  }
    'tunnel'   { Start-Tunnel }
    'stop'     { Stop-Bot  }
    'status'   { Show-Status }
    'logs'     { Show-Logs }
    default    { Write-Host "Usage: .\start.ps1 [start|callback|tunnel|stop|status|logs]"; exit 1 }
}
