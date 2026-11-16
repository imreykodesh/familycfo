param([string]$Model = '')
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'
$set = @{ agent_provider = 'gemini'; agent_model_gemini = $Model } | ConvertTo-Json -Compress
Invoke-WebRequest 'http://127.0.0.1:4399/api/settings' -Method Put -ContentType 'application/json' -Body $set -UseBasicParsing | Out-Null
$body = [Text.Encoding]::UTF8.GetBytes((@{ message = 'What is the total balance of the bank accounts? Answer in one short sentence.' } | ConvertTo-Json -Compress))
$t0 = Get-Date
$r = Invoke-WebRequest -Uri 'http://127.0.0.1:4399/api/agent/chat' -Method Post -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 300 -UseBasicParsing
$t = [Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
$lines = $t -split "`n" | Where-Object { $_.StartsWith('data: ') } | ForEach-Object { $_.Substring(6) | ConvertFrom-Json }
"model '$Model' ($([int]((Get-Date) - $t0).TotalSeconds)s)"
$lines | Where-Object { $_.type -eq 'tool' } | ForEach-Object { "  TOOL: $($_.name)" }
"  ERROR: $(($lines | Where-Object { $_.type -eq 'done' } | Select-Object -Last 1).error)"
"  TEXT: " + ((($lines | Where-Object { $_.type -eq 'text' }) | ForEach-Object { $_.text }) -join '').Trim()
