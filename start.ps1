# MingBot Start Script
# Usage: .\start.ps1 [start|stop|status|logs]
param([string]$Action = 'start')

$ProjectRoot = Split-Path $MyInvocation.MyCommand.Path -Parent
$Script = Join-Path $ProjectRoot 'src\index.js'
$JobName = 'mingbot'

# Bypass system proxy for QQ Guild API
$env:NO_PROXY = 'localhost,127.0.0.1,*api.sgroup.qq.com,*qq.com'

function Write-Log { param($Msg) Write-Host ("[$(Get-Date -Format 'HH:mm:ss')] $Msg") }

function Start-Bot {
    Write-Log "Starting MingBot..."
    $env:QQ_BOT_SANDBOX = 'true'
    $env:HTTP_PROXY = ''
    $env:HTTPS_PROXY = ''

    Remove-Job -Name $JobName -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500

    $job = Start-Job -Name $JobName -ScriptBlock {
        param($root, $script)
        $env:QQ_BOT_SANDBOX = 'true'
        $env:HTTP_PROXY = ''
        $env:HTTPS_PROXY = ''
        $env:NO_PROXY = 'localhost,127.0.0.1,*api.sgroup.qq.com,*qq.com'
        Set-Location $root
        & $script
    } -ArgumentList $ProjectRoot, $Script

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
    'start'  { Start-Bot }
    'stop'   { Stop-Bot }
    'status' { Show-Status }
    'logs'   { Show-Logs }
    default  { Write-Host "Usage: .\start.ps1 [start|stop|status|logs]"; exit 1 }
}
