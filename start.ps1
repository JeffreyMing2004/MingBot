# MingBot 启动脚本
# 用法: .\start.ps1 [start|stop|status|logs]
param([string]$Action = 'start')

$ProjectRoot = Split-Path $MyInvocation.MyCommand.Path -Parent
$Script = Join-Path $ProjectRoot 'src\index.js'
$JobName = 'mingbot'

# 禁用系统代理对 QQ API 的影响
$env:NO_PROXY = 'localhost,127.0.0.1,*api.sgroup.qq.com,*qq.com'

function Write-Log { param($Msg) Write-Host ("[$(Get-Date -Format 'HH:mm:ss')] $Msg") }

function Start-Bot {
    Write-Log "启动 MingBot..."
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
        Write-Log "MingBot 已在后台运行 (Job ID: $($job.Id))"
        Write-Log "查看日志: .\start.ps1 logs"
        Write-Log "停止服务: .\start.ps1 stop"
    } else {
        $output = Receive-Job -Id $job.Id -ErrorAction SilentlyContinue
        Write-Log "启动失败:`n$output"
        Remove-Job -Id $job.Id -ErrorAction SilentlyContinue
    }
}

function Stop-Bot {
    Write-Log "停止 MingBot..."
    $job = Get-Job -Name $JobName -ErrorAction SilentlyContinue
    if ($job) {
        Stop-Job -Id $job.Id
        Start-Sleep -Seconds 2
        Remove-Job -Id $job.Id -ErrorAction SilentlyContinue
        Write-Log "MingBot 已停止"
    } else {
        Write-Log "MingBot 未运行"
    }
}

function Show-Status {
    $job = Get-Job -Name $JobName -ErrorAction SilentlyContinue
    if ($job) {
        Write-Host "[OK] MingBot 运行中 (Job ID: $($job.Id))" -ForegroundColor Green
        Write-Host "   状态: $($job.State)"
    } else {
        Write-Host "[X] MingBot 未运行" -ForegroundColor Red
    }
}

function Show-Logs {
    Write-Log "最近输出:"
    $job = Get-Job -Name $JobName -ErrorAction SilentlyContinue
    if ($job) {
        $out = Receive-Job -Id $job.Id -ErrorAction SilentlyContinue
        if ($out) { $out } else { Write-Log "(无输出)" }
        Write-Log "监控中... (Ctrl+C 退出)"
        while ((Get-Job -Id $job.Id -ErrorAction SilentlyContinue).State -eq 'Running') {
            Start-Sleep -Seconds 2
            $new = Receive-Job -Id $job.Id -ErrorAction SilentlyContinue
            if ($new) { $new | ForEach-Object { Write-Host $_ } }
        }
    } else {
        Write-Log "机器人未运行"
    }
}

switch ($Action) {
    'start' { Start-Bot }
    'stop' { Stop-Bot }
    'status' { Show-Status }
    'logs' { Show-Logs }
    default { Write-Host "用法: .\start.ps1 [start|stop|status|logs]"; exit 1 }
}
