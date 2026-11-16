<#
.SYNOPSIS
    סנכרון דו-כיווני של המאגר המקומי מול GitHub: משיכה, ואם יש מה לדחוף - גם דחיפה.

.DESCRIPTION
    גנרי לכל פרויקט: מעתיקים את git-sync.ps1 + git-sync.cmd לשורש המאגר ומפעילים בלחיצה כפולה על git-sync.cmd.

    סקריפט אחד לכל המצבים. אין צורך להחליט מראש אם רוצים למשוך או לדחוף:

      אין שינוי בשני הצדדים   ->  לא נעשה כלום, רק דיווח "מעודכן".
      יש חדש רק בשרת          ->  משיכה (fast-forward).
      יש חדש רק במחשב         ->  דחיפה לשרת.
      יש חדש בשני הצדדים      ->  משיכה, מיזוג, ואז דחיפה.

    מה הסקריפט עושה בפועל:
      1. fetch מכל ה-remotes.
      2. שינויים מקומיים שלא נשמרו (כולל קבצים חדשים) נשמרים אוטומטית ב-commit,
         כדי שהם ייכללו בדחיפה ולא יישארו רק במחשב. קבצים שמוחרגים ב-.gitignore לא נכללים.
      3. בודק מראש (בלי לגעת בקבצים) אם המיזוג ייצור קונפליקט.
         אם בטוח: מעדכן. אם צפוי קונפליקט: לא משנה כלום, ומציג בדיוק אילו קבצים מתנגשים.
      4. דוחף לשרת את מה שחדש במחשב. לעולם לא push --force.
      5. מעדכן גם ענפים מקומיים אחרים שרק מפגרים אחרי השרת (fast-forward בלבד).
      6. מציג סיכום ורמזים (למשל flutter pub get אם pubspec השתנה).

    העדכון הוא "הכל או כלום" ברמת הענף: עדכון חלקי של קבצים בודדים היה משאיר את הקוד במצב לא עקבי.
    המיזוג נעשה ב-merge ולא ב-rebase: זה מה שהבדיקה המוקדמת יודעת לחזות במדויק, כשל מתבטל
    מעצמו בלי להשאיר את המאגר באמצע פעולה, וזה לא דורש אף פעם push --force.

.PARAMETER DryRun
    רק בדיקה ודיווח - בלי לשנות שום דבר (לא commit, לא מיזוג, לא דחיפה).

.PARAMETER NoPush
    לא לדחוף לשרת. שינויים מקומיים עדיין נשמרים ב-commit מקומי והמשיכה מתבצעת כרגיל.

.PARAMETER Message
    הודעת ה-commit לשינויים המקומיים. ברירת מחדל: "git-sync: local changes <תאריך ושעה>".

.PARAMETER NoPause
    לא לחכות ל-Enter בסוף (לשימוש מתוך טרמינל/אוטומציה).
#>
param(
    [switch]$DryRun,
    [switch]$NoPush,
    [string]$Message,
    [switch]$NoPause
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# מעל כמה קבצים בקומיט אוטומטי מוצגת אזהרה (חשד שמשהו לא מוחרג ב-.gitignore)
$ManyFilesWarning = 200

# ---------------------------------------------------------------- helpers

function Write-Step([string]$msg) { Write-Host ""; Write-Host "> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Write-Err([string]$msg)  { Write-Host "  [X]  $msg" -ForegroundColor Red }
function Write-Info([string]$msg) { Write-Host "       $msg" -ForegroundColor Gray }

$script:LogFile = $null
function Write-Log([string]$msg) {
    if ($script:LogFile) {
        try { Add-Content -LiteralPath $script:LogFile -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" -Encoding UTF8 } catch { }
    }
}

# מריץ git ומחזיר קוד יציאה + שורות פלט (ללא אזהרות CRLF רועשות)
function Invoke-Git([string[]]$GitArgs) {
    $out = & git -c core.quotepath=false @GitArgs 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
    $lines = @($out | Where-Object { $_ -notmatch '^warning: (in the working copy|LF will be replaced|CRLF will be replaced)' })
    return [pscustomobject]@{ Code = $code; Lines = $lines; Text = ($lines -join "`n") }
}

function Show-Lines([string[]]$lines, [int]$max = 25) {
    $shown = @($lines | Where-Object { $_ -ne '' } | Select-Object -First $max)
    foreach ($l in $shown) { Write-Info $l }
    $total = @($lines | Where-Object { $_ -ne '' }).Count
    if ($total -gt $max) { Write-Info "... ועוד $($total - $max)" }
}

# ---------------------------------------------------------------- main

$exitCode = 0
try {
    Write-Host "==============================================" -ForegroundColor Cyan
    Write-Host "   סנכרון מאגר מול GitHub (git-sync)"           -ForegroundColor Cyan
    Write-Host "   משיכה, ואם יש מה לדחוף - גם דחיפה"           -ForegroundColor Cyan
    if ($DryRun) { Write-Host "   מצב בדיקה בלבד - לא ישתנה דבר" -ForegroundColor Yellow }
    if ($NoPush) { Write-Host "   מצב ללא דחיפה - משיכה בלבד"    -ForegroundColor Yellow }
    Write-Host "==============================================" -ForegroundColor Cyan

    # --- 1. סביבה ומאגר
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Err "git לא מותקן או לא נמצא ב-PATH."
        $exitCode = 1; return
    }

    $startDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
    Set-Location -LiteralPath $startDir
    $top = Invoke-Git @('rev-parse', '--show-toplevel')
    if ($top.Code -ne 0) {
        Write-Err "התיקייה '$startDir' אינה בתוך מאגר git."
        $exitCode = 1; return
    }
    $repoRoot = $top.Lines[0]
    Set-Location -LiteralPath $repoRoot
    $gitDir = (Invoke-Git @('rev-parse', '--absolute-git-dir')).Lines[0]
    $script:LogFile = Join-Path $gitDir 'git-sync.log'
    Write-Log "---- start (DryRun=$DryRun NoPush=$NoPush) in $repoRoot"

    Write-Step "מאגר: $repoRoot"

    # --- 2. פעולה תקועה / נעילה
    $busy = @()
    if (Test-Path -LiteralPath (Join-Path $gitDir 'MERGE_HEAD'))       { $busy += 'merge' }
    if (Test-Path -LiteralPath (Join-Path $gitDir 'rebase-merge'))     { $busy += 'rebase' }
    if (Test-Path -LiteralPath (Join-Path $gitDir 'rebase-apply'))     { $busy += 'rebase/am' }
    if (Test-Path -LiteralPath (Join-Path $gitDir 'CHERRY_PICK_HEAD')) { $busy += 'cherry-pick' }
    if (Test-Path -LiteralPath (Join-Path $gitDir 'REVERT_HEAD'))      { $busy += 'revert' }
    if ($busy.Count -gt 0) {
        Write-Err "יש פעולת git שלא הסתיימה: $($busy -join ', '). סיים או בטל אותה קודם."
        $exitCode = 1; return
    }
    if (Test-Path -LiteralPath (Join-Path $gitDir 'index.lock')) {
        Write-Err "קיים קובץ נעילה index.lock - תהליך git אחר רץ (או קרס). סגור אותו ונסה שוב."
        $exitCode = 1; return
    }
    $unmerged = Invoke-Git @('diff', '--name-only', '--diff-filter=U')
    if ($unmerged.Lines.Count -gt 0) {
        Write-Err "יש קבצים במצב קונפליקט שלא נפתר:"
        Show-Lines $unmerged.Lines
        $exitCode = 1; return
    }

    # --- 3. ענף נוכחי
    $branchRes = Invoke-Git @('symbolic-ref', '--short', '-q', 'HEAD')
    if ($branchRes.Code -ne 0 -or -not $branchRes.Lines) {
        Write-Err "HEAD במצב detached (לא על ענף). עבור לענף לפני סנכרון."
        $exitCode = 1; return
    }
    $branch = $branchRes.Lines[0]
    Write-Info "ענף נוכחי: $branch"

    # --- 4. fetch
    $remotes = @((Invoke-Git @('remote')).Lines | Where-Object { $_ })
    if ($remotes.Count -eq 0) {
        Write-Err "למאגר אין remote מוגדר."
        $exitCode = 1; return
    }
    Write-Step "מושך מידע מהשרת (fetch)..."
    $fetch = Invoke-Git @('fetch', '--all', '--prune')
    if ($fetch.Code -ne 0) {
        Write-Err "fetch נכשל (רשת / הרשאות):"
        Show-Lines $fetch.Lines
        $exitCode = 1; return
    }
    Write-Ok "המידע מהשרת עודכן."

    # --- 5. upstream ויעד הדחיפה
    $mainRemote = if ($remotes -contains 'origin') { 'origin' } else { $remotes[0] }
    $pushRemoteRes = Invoke-Git @('config', '--get', "branch.$branch.remote")
    $pushRemote = if ($pushRemoteRes.Code -eq 0 -and $pushRemoteRes.Lines) { $pushRemoteRes.Lines[0] } else { $mainRemote }

    $branchIsNew = $false
    $upstream = $null
    $upRes = Invoke-Git @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
    if ($upRes.Code -eq 0 -and $upRes.Lines) {
        $upstream = $upRes.Lines[0]
    } else {
        $candidate = "$mainRemote/$branch"
        if ((Invoke-Git @('rev-parse', '--verify', '--quiet', "refs/remotes/$candidate")).Code -eq 0) {
            $upstream = $candidate
            Write-Warn "לענף אין upstream מוגדר - משתמש ב-$upstream."
        } else {
            $branchIsNew = $true
            Write-Warn "הענף '$branch' לא קיים בשרת - אין מה למשוך; הוא ייווצר בדחיפה."
        }
    }
    if ($upstream) { Write-Info "מקור עדכון: $upstream" }

    # --- 6. שמירת שינויים מקומיים ב-commit (כדי שייכללו בדחיפה)
    $statusLines = @((Invoke-Git @('status', '--porcelain=v1')).Lines | Where-Object { $_ })
    $committedNow = $false
    if ($statusLines.Count -gt 0) {
        Write-Step "נמצאו $($statusLines.Count) שינויים מקומיים שלא נשמרו:"
        Show-Lines $statusLines
        if ($statusLines.Count -gt $ManyFilesWarning) {
            Write-Warn "זה הרבה קבצים. אם יש כאן תוצרי בנייה או קבצים זמניים - כדאי להחריג אותם ב-.gitignore."
        }

        $email = Invoke-Git @('config', '--get', 'user.email')
        $uname = Invoke-Git @('config', '--get', 'user.name')
        if ($email.Code -ne 0 -or -not $email.Lines -or $uname.Code -ne 0 -or -not $uname.Lines) {
            Write-Err "לא ניתן לשמור commit: שם המשתמש או האימייל של git לא מוגדרים."
            Write-Info 'הגדר פעם אחת:  git config --global user.name "השם שלך"'
            Write-Info 'ואז:           git config --global user.email "המייל שלך"'
            $exitCode = 1; return
        }

        $commitMsg = if ($Message) { $Message } else { "git-sync: local changes $(Get-Date -Format 'yyyy-MM-dd HH:mm')" }
        if ($DryRun) {
            Write-Ok "מצב בדיקה: היו נשמרים $($statusLines.Count) קבצים ב-commit."
        } else {
            $add = Invoke-Git @('add', '-A', '--', '.')
            if ($add.Code -ne 0) {
                Write-Err "הוספת הקבצים ל-commit נכשלה - לא בוצע שינוי:"
                Show-Lines $add.Lines
                $exitCode = 1; return
            }
            $staged = Invoke-Git @('diff', '--cached', '--name-only')
            if (@($staged.Lines | Where-Object { $_ }).Count -eq 0) {
                Write-Info "אין שינויים שאפשר לשמור (ייתכן שכולם מוחרגים ב-.gitignore)."
            } else {
                $ci = Invoke-Git @('commit', '-m', $commitMsg)
                if ($ci.Code -ne 0) {
                    Write-Err "שמירת ה-commit נכשלה - לא בוצע עדכון:"
                    Show-Lines $ci.Lines
                    Invoke-Git @('reset') | Out-Null
                    $exitCode = 1; return
                }
                $committedNow = $true
                $newSha = (Invoke-Git @('rev-parse', 'HEAD')).Lines[0]
                Write-Ok "השינויים המקומיים נשמרו ב-commit $($newSha.Substring(0,7)): $commitMsg"
                Write-Log "committed $newSha ($($statusLines.Count) entries)"
            }
        }
    } else {
        Write-Info "אין שינויים מקומיים שלא נשמרו."
    }

    # --- 7. מצב מול השרת
    $ahead = 0; $behind = 0
    if ($upstream) {
        $counts = (Invoke-Git @('rev-list', '--left-right', '--count', "HEAD...$upstream")).Lines[0] -split '\s+'
        $ahead = [int]$counts[0]; $behind = [int]$counts[1]
    } else {
        # ענף חדש: נספרים רק ה-commits שאינם על אף ענף בשרת
        $ahead = [int](Invoke-Git @('rev-list', '--count', 'HEAD', '--not', '--remotes')).Lines[0]
    }

    if ($behind -eq 0 -and $ahead -eq 0) {
        Write-Ok "המאגר מעודכן בשני הכיוונים - אין מה למשוך ואין מה לדחוף."
    }

    # --- 8. משיכה ומיזוג (רק אם יש מה למשוך)
    if ($behind -gt 0) {
        Write-Step "מגיעים $behind commits חדשים מהשרת:"
        Show-Lines (Invoke-Git @('log', '--oneline', '--no-decorate', '-n', '15', "HEAD..$upstream")).Lines 15
        $incoming = @((Invoke-Git @('diff', '--name-only', "HEAD...$upstream")).Lines | Where-Object { $_ })
        Write-Info "קבצים שמשתנים בשרת: $($incoming.Count)"
        if ($ahead -gt 0) { Write-Warn "יש גם $ahead commits מקומיים - יבוצע מיזוג, ואחריו דחיפה." }

        # --- 8א. קבצים שהשרת מוסיף וקיימים אצלך בלי מעקב (בפועל: מוחרגים ב-.gitignore)
        Write-Step "בודק מראש התנגשויות..."
        $blockedUntracked = @()
        $identicalUntracked = @()
        $added = @((Invoke-Git @('diff', '--name-only', '--diff-filter=AR', "HEAD...$upstream")).Lines | Where-Object { $_ })
        $onDisk = @($added | Where-Object { Test-Path -LiteralPath (Join-Path $repoRoot $_) -PathType Leaf })
        if ($onDisk.Count -gt 0) {
            $tracked = @((Invoke-Git (@('ls-files', '--') + $onDisk)).Lines)
            foreach ($p in $onDisk) {
                if ($tracked -contains $p) { continue }
                $localHash  = (Invoke-Git @('hash-object', '--', $p)).Lines[0]
                $remoteHash = (Invoke-Git @('rev-parse', "${upstream}:$p")).Lines[0]
                if ($localHash -and $localHash -eq $remoteHash) { $identicalUntracked += $p } else { $blockedUntracked += $p }
            }
        }

        # --- 8ב. מיזוג מדומה: האם המיזוג ייצור קונפליקט
        # בדרך כלל השינויים המקומיים כבר נשמרו ב-commit, ולכן HEAD מייצג את הצד שלנו במדויק.
        # ב-DryRun לא נשמר commit, ולכן בונים ממצב העבודה commit זמני (stash create) רק לצורך
        # הבדיקה - פעולה שלא נוגעת בקבצים ולא בענפים.
        $predictRef = 'HEAD'
        if ($DryRun -and $statusLines.Count -gt 0) {
            $wip = @((Invoke-Git @('stash', 'create')).Lines | Where-Object { $_ -match '^[0-9a-f]{40}$' })
            if ($wip.Count -gt 0) { $predictRef = $wip[-1] }
        }

        $conflicts = @()
        $predictOk = $true
        if ($ahead -gt 0 -or $predictRef -ne 'HEAD') {
            $mt = Invoke-Git @('merge-tree', '--write-tree', '--name-only', '--no-messages', $predictRef, $upstream)
            if ($mt.Code -eq 1) {
                $conflicts = @($mt.Lines | Select-Object -Skip 1 | Where-Object { $_ } | Sort-Object -Unique)
            } elseif ($mt.Code -ne 0) {
                # git ישן מ-2.38 - בדיקה שמרנית: כל קובץ ששונה גם מקומית וגם בשרת נחשב התנגשות
                $predictOk = $false
                $base = (Invoke-Git @('merge-base', $predictRef, $upstream)).Lines[0]
                $localChanged = @((Invoke-Git @('diff', '--name-only', $base, $predictRef)).Lines | Where-Object { $_ })
                $conflicts = @($localChanged | Where-Object { $incoming -contains $_ })
            }
        }

        if ($conflicts.Count -gt 0 -or $blockedUntracked.Count -gt 0) {
            Write-Err "העדכון לא בוצע - הוא היה יוצר קונפליקט. לא שונה שום קובץ."
            if ($conflicts.Count -gt 0) {
                Write-Warn "קבצים ששונו גם אצלך וגם בשרת באותם מקומות:"
                Show-Lines $conflicts
            }
            if ($blockedUntracked.Count -gt 0) {
                Write-Warn "קבצים מקומיים (לא במעקב) שהשרת מוסיף בתוכן שונה:"
                Show-Lines $blockedUntracked
            }
            Write-Host ""
            if ($DryRun) {
                Write-Info "מצב בדיקה - לא נשמר ולא נדחף דבר."
            } elseif ($committedNow) {
                Write-Info "השינויים שלך שמורים ב-commit מקומי - שום דבר לא אבד, וגם לא נדחף לשרת."
            } else {
                Write-Info "שום דבר לא שונה ולא נדחף לשרת."
            }
            Write-Info "אפשרויות: למזג ידנית, להעביר את הקבצים הנ""ל לתיקייה אחרת ולהריץ שוב,"
            Write-Info "או לבטל את השינויים המקומיים בקבצים האלה."
            Write-Log "blocked: conflicts=$($conflicts -join ';') untracked=$($blockedUntracked -join ';')"
            $exitCode = 2; return
        }
        if ($predictOk) { Write-Ok "אין התנגשויות צפויות." } else { Write-Warn "git ישן - בוצעה בדיקה שמרנית בלבד." }

        if ($DryRun) {
            Write-Ok "מצב בדיקה: העדכון היה עובר בהצלחה. לא בוצע שינוי."
        } else {
            Write-Step "מעדכן את הענף '$branch'..."
            $before = (Invoke-Git @('rev-parse', 'HEAD')).Lines[0]
            Write-Log "before=$before upstream=$upstream ahead=$ahead behind=$behind"

            foreach ($p in $identicalUntracked) {
                Remove-Item -LiteralPath (Join-Path $repoRoot $p) -Force
                Write-Info "הוסר עותק מקומי זהה לשרת: $p"
            }

            if ($ahead -eq 0) {
                $mg = Invoke-Git @('merge', '--ff-only', $upstream)
            } else {
                $mg = Invoke-Git @('merge', '--no-edit', $upstream)
            }
            if ($mg.Code -ne 0) {
                Write-Err "העדכון נכשל:"
                Show-Lines $mg.Lines
                if (Test-Path -LiteralPath (Join-Path $gitDir 'MERGE_HEAD')) { Invoke-Git @('merge', '--abort') | Out-Null }
                Write-Info "שום דבר לא נדחף לשרת. השינויים שלך שמורים ב-commit מקומי."
                Write-Log "merge failed"
                $exitCode = 1; return
            }

            if (Test-Path -LiteralPath (Join-Path $repoRoot '.gitmodules')) {
                $sm = Invoke-Git @('submodule', 'update', '--init', '--recursive')
                if ($sm.Code -eq 0) { Write-Ok "submodules עודכנו." } else { Write-Warn "עדכון submodules נכשל."; Show-Lines $sm.Lines 5 }
            }

            $after = (Invoke-Git @('rev-parse', 'HEAD')).Lines[0]
            Write-Ok "הענף '$branch' עודכן: $($before.Substring(0,7)) -> $($after.Substring(0,7))"
            Write-Info "(מצב קודם לשחזור במקרה הצורך: $before)"
            Write-Log "after=$after"

            # --- 8ג. רמזים לפי קבצים שהשתנו
            $changed = @((Invoke-Git @('diff', '--name-only', $before, $after)).Lines | Where-Object { $_ })
            $hints = [ordered]@{}
            foreach ($f in $changed) {
                $name = Split-Path $f -Leaf
                if ($name -in @('pubspec.yaml', 'pubspec.lock'))                    { $hints['flutter pub get'] = 1 }
                if ($f -like '*.arb')                                               { $hints['flutter gen-l10n'] = 1 }
                if ($name -in @('package.json', 'package-lock.json'))               { $hints['npm install'] = 1 }
                if ($name -in @('requirements.txt', 'pyproject.toml'))              { $hints['pip install -r requirements.txt'] = 1 }
                if ($name -in @('build.gradle', 'build.gradle.kts', 'Podfile.lock')) { $hints["בנייה נקייה (שינוי ב-$name)"] = 1 }
            }
            if ($hints.Count -gt 0) {
                Write-Step "מומלץ להריץ בעקבות השינויים:"
                foreach ($h in $hints.Keys) { Write-Info $h }
            }
        }
    }

    # --- 9. דחיפה לשרת (רק אם יש מה לדחוף)
    if ($DryRun) {
        $toPush = $ahead
        if ($committedNow) { $toPush++ }
        if ($NoPush) {
            Write-Info "מצב ללא דחיפה - לא נדחף דבר."
        } elseif ($toPush -gt 0 -or $branchIsNew) {
            Write-Ok "מצב בדיקה: היו נדחפים commits לשרת ($pushRemote/$branch)."
        }
    } else {
        $pushCount = 0
        if ($upstream) {
            $pushCount = [int](Invoke-Git @('rev-list', '--count', "$upstream..HEAD")).Lines[0]
        } elseif ($branchIsNew) {
            $pushCount = [int](Invoke-Git @('rev-list', '--count', 'HEAD', '--not', '--remotes')).Lines[0]
        }

        if ($pushCount -eq 0 -and -not $branchIsNew) {
            if ($behind -gt 0) { Write-Info "אין commits מקומיים לדחיפה." }
        } elseif ($NoPush) {
            Write-Warn "יש $pushCount commits מקומיים שלא נדחפו (מצב ללא דחיפה)."
        } else {
            if ($branchIsNew) {
                Write-Step "יוצר בשרת את הענף '$branch' ודוחף $pushCount commits..."
            } else {
                Write-Step "דוחף לשרת $pushCount commits ($pushRemote/$branch)..."
            }
            Show-Lines (Invoke-Git @('log', '--oneline', '--no-decorate', '-n', '15', '--not', '--remotes')).Lines 15

            $pushArgs = @('push')
            if ($branchIsNew -or -not $upstream) { $pushArgs += '-u' }
            $pushArgs += @($pushRemote, "HEAD:refs/heads/$branch")
            $ps = Invoke-Git $pushArgs

            if ($ps.Code -ne 0) {
                Write-Err "הדחיפה נכשלה:"
                Show-Lines $ps.Lines
                if ($ps.Text -match 'non-fast-forward|fetch first|!\s+\[rejected\]') {
                    Write-Warn "מישהו דחף לשרת בדיוק באותו זמן. הרץ את הסקריפט שוב - הוא ימשוך וידחוף."
                } else {
                    Write-Warn "ייתכנו בעיות רשת או הרשאות. השינויים שמורים ב-commit מקומי ולא אבדו."
                }
                Write-Log "push failed: $($ps.Text)"
                $exitCode = 1; return
            }
            Write-Ok "נדחפו $pushCount commits ל-$pushRemote/$branch."
            Write-Log "pushed $pushCount to $pushRemote/$branch"
        }
    }

    # --- 10. ענפים מקומיים אחרים שרק מפגרים - fast-forward בטוח
    $checkedOut = @((Invoke-Git @('worktree', 'list', '--porcelain')).Lines |
        Where-Object { $_ -like 'branch refs/heads/*' } | ForEach-Object { $_.Substring('branch refs/heads/'.Length) })
    $refs = (Invoke-Git @('for-each-ref', '--format=%(refname:short)|%(upstream:short)|%(upstream:track)', 'refs/heads')).Lines
    $updatedOthers = @()
    foreach ($r in $refs) {
        $parts = $r -split '\|'
        if ($parts.Count -lt 3) { continue }
        $b = $parts[0]; $u = $parts[1]; $track = $parts[2]
        if (-not $u -or $b -eq $branch -or $checkedOut -contains $b) { continue }
        if ($track -notmatch '^\[behind \d+\]$') { continue }
        if ($DryRun) { $updatedOthers += "$b (יעודכן)"; continue }
        $old = (Invoke-Git @('rev-parse', "refs/heads/$b")).Lines[0]
        $new = (Invoke-Git @('rev-parse', $u)).Lines[0]
        if ((Invoke-Git @('update-ref', "refs/heads/$b", $new, $old)).Code -eq 0) { $updatedOthers += $b }
    }
    if ($updatedOthers.Count -gt 0) {
        Write-Step "ענפים מקומיים נוספים שעודכנו (fast-forward):"
        Show-Lines $updatedOthers
    }

    Write-Host ""
    if ($exitCode -eq 0) { Write-Host "  הסנכרון הסתיים." -ForegroundColor Green }
}
catch {
    Write-Err "שגיאה לא צפויה: $($_.Exception.Message)"
    Write-Log "exception: $($_.Exception.Message)"
    $exitCode = 1
}
finally {
    Write-Log "---- end exit=$exitCode"
    if (-not $NoPause) {
        Write-Host ""
        Read-Host "לחץ Enter לסגירה" | Out-Null
    }
    exit $exitCode
}
