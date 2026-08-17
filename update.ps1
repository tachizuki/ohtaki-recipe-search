# update.ps1
#
# videos.json を最新の状態に更新する。
# APIキーは同じフォルダの apikey.txt から読む（1行目だけ使う）。
#
#   .\update.ps1
#
# タスクスケジューラから定期実行する場合の設定は README.md を参照。

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$keyFile = Join-Path $PSScriptRoot 'apikey.txt'

if (-not (Test-Path $keyFile)) {
    Write-Host 'apikey.txt がありません。' -ForegroundColor Red
    Write-Host "このフォルダに apikey.txt を作り、YouTube Data API のキー（AIza...）を1行で書いてください。"
    Write-Host "  例) メモ帳で作成 → $keyFile"
    exit 1
}

$key = (Get-Content $keyFile -TotalCount 1).Trim()

if ([string]::IsNullOrWhiteSpace($key)) {
    Write-Host 'apikey.txt が空です。' -ForegroundColor Red
    exit 1
}

$env:YOUTUBE_API_KEY = $key

Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] 更新を開始します" -ForegroundColor Cyan

# 生レスポンスも毎回保存しておく（後から再生成できるようにするため）
node fetch-videos.mjs --raw raw.json

if ($LASTEXITCODE -ne 0) {
    Write-Host '更新に失敗しました。' -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] 更新が完了しました" -ForegroundColor Green
