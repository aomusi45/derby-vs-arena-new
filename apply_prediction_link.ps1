$ErrorActionPreference = 'Stop'
$repo = 'D:\webdownload\derby-vs-arena-new'
if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) { throw 'GitHub repository not found.' }
Set-Location -LiteralPath $repo
$dirty = @(git status --porcelain)
if ($LASTEXITCODE -ne 0 -or $dirty.Count -gt 0) { throw 'Uncommitted changes found. Stopped without modification.' }
git pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { throw 'Git pull failed. Stopped.' }
$file = Join-Path $repo 'index.html'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$html = [System.IO.File]::ReadAllText($file, $utf8)
$marker = '<!-- DBF PREDICTION LINK V1 -->'
if ($html.Contains($marker)) { Write-Host 'Prediction link is already installed.'; exit 0 }
$anchor = '<div class="section">'
$idx = $html.IndexOf($anchor, [StringComparison]::Ordinal)
if ($idx -lt 0) { throw 'Expected arena card section not found. No changes made.' }
$block = @'
      <!-- DBF PREDICTION LINK V1 -->
      <section class="panel" aria-label="今週の予想レース" style="min-height:0;margin:0 0 22px;border-color:#d7b570;background:linear-gradient(135deg,#173b33,#0a211e)">
        <div class="num">WEEKLY G1 PREDICTION</div>
        <h2>🏇 今週の予想レース</h2>
        <p>公開された出走馬でVS予想レースを楽しめます。馬場状態・馬体重増減・レース展開・調子を設定して、レースをシミュレーションできます。</p>
        <a href="./g1-prediction.html" style="display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:12px 20px;border:1px solid #ffe0a1;border-radius:8px;background:linear-gradient(180deg,#ffe4ac,#d1a65b);color:#102720;font-weight:900;text-decoration:none">今週の予想レースを開く</a>
        <p class="small">※ 公式VSアリーナの登録馬・開催結果・ランキングには影響しません。</p>
      </section>

'@
$html = $html.Insert($idx, $block)
[System.IO.File]::WriteAllText($file, $html, $utf8)
git add -- index.html
git diff --cached --check
if ($LASTEXITCODE -ne 0) { git restore --staged -- index.html; git restore -- index.html; throw 'Whitespace validation failed; reverted.' }
git diff --cached --quiet
if ($LASTEXITCODE -eq 0) { Write-Host 'No changes needed.'; exit 0 }
git commit -m 'Add weekly prediction race link to arena home'
if ($LASTEXITCODE -ne 0) { throw 'Commit failed. Push was not attempted.' }
git push origin main
if ($LASTEXITCODE -ne 0) { throw 'Push failed. Local commit remains; no force push attempted.' }
Write-Host 'Prediction link pushed to GitHub successfully.'
