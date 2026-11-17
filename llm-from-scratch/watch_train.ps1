# 实时查看训练进度（解决 Windows 控制台 GBK 导致中文日志乱码的问题）
# 用法：在项目目录右键"使用 PowerShell 运行"，或终端执行：powershell -File watch_train.ps1

chcp 65001 | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "正在实时显示 train.log（UTF-8），按 Ctrl+C 退出..." -ForegroundColor Cyan
Get-Content -Path "train.log" -Encoding UTF8 -Wait
