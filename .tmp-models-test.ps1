[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'
for ($i = 0; $i -lt 40; $i++) {
  try { Invoke-WebRequest 'http://127.0.0.1:4399/api/agent' -UseBasicParsing -TimeoutSec 2 | Out-Null; break }
  catch { [Threading.Thread]::Sleep(1000) }
}
foreach ($p in 'claude', 'gemini', 'kiro') {
  $t0 = Get-Date
  $r = Invoke-WebRequest "http://127.0.0.1:4399/api/agent/models?provider=$p" -UseBasicParsing -TimeoutSec 150
  $j = [Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray()) | ConvertFrom-Json
  $ms = [int]((Get-Date) - $t0).TotalMilliseconds
  "== $p ($ms ms): $($j.models.Count) models, default '$($j.defaultModel)', source '$($j.source)', error '$($j.error)'"
  $j.models | Select-Object -First 25 | ForEach-Object { "   $($_.id) | $($_.name) | ctx $($_.contextTokens) | rate $($_.rate)" }
}
# saving a model and a bad id
$ok = Invoke-WebRequest 'http://127.0.0.1:4399/api/settings' -Method Put -ContentType 'application/json' -Body '{"agent_model_gemini":"gemini-2.5-flash"}' -UseBasicParsing
"save ok: $($ok.StatusCode)"
try { Invoke-WebRequest 'http://127.0.0.1:4399/api/settings' -Method Put -ContentType 'application/json' -Body '{"agent_model_kiro":"x; rm -rf /"}' -UseBasicParsing | Out-Null; 'bad id ACCEPTED' } catch { "bad id rejected: $($_.ErrorDetails.Message)" }
$meta = Invoke-RestMethod 'http://127.0.0.1:4399/api/meta'
"saved: agent_model_gemini = $($meta.settings.agent_model_gemini)"
