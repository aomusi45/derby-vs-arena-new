param([string]$Repo = 'D:\webdownload\derby-vs-arena-new')
$ErrorActionPreference='Stop'
$source=Split-Path -Parent $MyInvocation.MyCommand.Path
$page=Join-Path $Repo 'g1-prediction.html'
$race=Join-Path $Repo 'g1-prediction-mile-championship-2026.json'
$list=Join-Path $Repo 'g1-prediction-races.json'
if(!(Test-Path $page) -or !(Test-Path $list)){throw '予想ページまたはレース一覧が見つかりません。正しいGitHubリポジトリを指定してください。'}
$old=[IO.File]::ReadAllText($page,[Text.Encoding]::UTF8)
if($old -notmatch 'function render\(' -or $old -notmatch 'function loadSelected\(' -or $old -notmatch 'g1-prediction-engine.html'){throw '現在の予想ページの構造が想定外です。変更せず停止します。'}
$snippet=[IO.File]::ReadAllText((Join-Path $source 'prediction-integration-v2.js-snippet.txt'),[Text.Encoding]::UTF8)
$marker='id="dbf-mile-cs-integration-v2"'
if($old.Contains($marker)){
  $pattern='(?s)<script id="dbf-mile-cs-integration-v2">.*?</script>'
  $new=[regex]::Replace($old,$pattern,[System.Text.RegularExpressions.MatchEvaluator]{param($m) $snippet})
}else{
  if(!$old.Contains('</body>')){throw 'HTMLの閉じタグがありません。変更せず停止します。'}
  $new=$old.Replace('</body>',$snippet+"`n</body>")
}
$data=Get-Content -LiteralPath (Join-Path $source 'g1-prediction-mile-championship-2026.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if($data.horses.Count -ne 18){throw '18頭分のデータがありません。'}
$nums=@($data.horses|ForEach-Object {$_.horseNumber});$pops=@($data.horses|ForEach-Object {$_.popularity})
if(@($nums|Select-Object -Unique).Count -ne 18 -or @($pops|Select-Object -Unique).Count -ne 18){throw '馬番または人気が重複しています。'}
$catalog=Get-Content -LiteralPath $list -Raw -Encoding UTF8 | ConvertFrom-Json
if(!@($catalog.races|Where-Object {$_.file -eq 'g1-prediction-mile-championship-2026.json' -and $_.enabled -eq $true}).Count){throw 'レース一覧がマイルCSを参照していません。変更せず停止します。'}
Copy-Item $page ($page+'.before-mile-v2.bak') -Force
if(Test-Path $race){Copy-Item $race ($race+'.before-mile-v2.bak') -Force}
[IO.File]::WriteAllText($page,$new,(New-Object Text.UTF8Encoding($false)))
Copy-Item (Join-Path $source 'g1-prediction-mile-championship-2026.json') $race -Force
Write-Host '成功: 予想ページに人気・単勝オッズ表示とJSON検証を追加し、マイルCS JSONを差し替えました。' -ForegroundColor Green
Write-Host '既存のレースエンジン、VSアリーナ本体、開催ワークフローは変更していません。'
Write-Host '次に git diff --check と git diff を確認し、問題なければコミット・pushしてください。'
