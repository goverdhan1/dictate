# Requires STA. Streams one JSON object per poll to stdout.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$processMap = @{
  'ms-teams' = 'teams'
  'teams' = 'teams'
  'zoom' = 'zoom'
  'ciscocollabhost' = 'webex'
  'webexhost' = 'webex'
  'webex' = 'webex'
  'ciscowebexstart' = 'webex'
  'livecaptions' = 'livecaptions'
}

$noise = [regex]'(?i)^(mute|unmute|start video|stop video|participants|participant|chat|share|share screen|record|security|reactions|apps|whiteboard|breakout|polls|leave|end|more|view|layout|settings|invite|copy|search|send|reply|like|you|me|cc|captions?|live captions?|closed captions?|transcript|subtitles?|ok|okay|close|cancel|save|done|new chat|meeting|hide|alert)$'
$activityNoise = [regex]'(?i)^(you are (un)?muted( now)?\.?|you are (the )?host now\.?|.+\bis the host now\.?|.+\bhas (joined|left|entered|exited)( the meeting)?\.?|this meeting is being (recorded|transcribed)\.?|recording (has )?(started|stopped|paused|resumed)\.?|captions? are (on|off)\b.*|low network bandwidth\b.*|video now (started|stopped)\.?|waiting for the host.*|host has (joined|left|ended).*)$'
$captionHint = [regex]'(?i)caption|transcript|subtitle|closed.?caption|live.?caption|live.?transcript'
$enableHint = [regex]'(?i)^(show|turn on|enable|start)\s+(live\s+)?(closed\s+)?captions?$|^(live\s+)?captions?$|^closed captions?$|^live transcription$|^show subtitles?$|^turn on captions?$'

function Get-ZoomMeetingId([string]$blob) {
  if (-not $blob) { return '' }
  # High confidence only — never grab bare digit runs from Zoom UI (phone numbers, noise).
  if ($blob -match '(?i)[?&]confno=(\d{9,11})\b') { return $Matches[1] }
  if ($blob -match '(?i)(?:^|[^\w])confno\s*[=:#]?\s*([\d\s-]{9,20})') {
    $digits = ($Matches[1] -replace '\D', '')
    if ($digits.Length -ge 9 -and $digits.Length -le 11) { return $digits }
  }
  if ($blob -match '(?i)(?:meeting\s*id|meeting\s*number)\s*[=:#]?\s*([\d\s-]{9,20})') {
    $digits = ($Matches[1] -replace '\D', '')
    if ($digits.Length -ge 9 -and $digits.Length -le 11) { return $digits }
  }
  if ($blob -match '(?i)zoom\.us/(?:j|s)/(\d{9,11})') { return $Matches[1] }
  if ($blob -match '(?i)(?:app\.)?zoom\.us/wc/join/(\d{9,11})') { return $Matches[1] }
  return ''
}

function Get-ZoomPasscode([string]$blob) {
  if (-not $blob) { return '' }
  if ($blob -match '(?i)[?&]pwd=([^&\s#]+)') {
    try { return [uri]::UnescapeDataString($Matches[1]) } catch { return $Matches[1] }
  }
  if ($blob -match '(?i)(?:passcode|password)\s*[=:]?\s*([A-Za-z0-9._-]{4,32})') {
    return $Matches[1]
  }
  return ''
}

function Get-ZoomFromProcessCommandLine() {
  $out = @{ meetingId = ''; passcode = ''; source = '' }
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'Zoom.exe'" -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
      $cmd = [string]$p.CommandLine
      if (-not $cmd) { continue }
      # Prefer confno from the live meeting process URL — most reliable source.
      if ($cmd -match '(?i)[?&]confno=(\d{9,11})\b') {
        $out.meetingId = $Matches[1]
        $out.source = 'confno'
        if ($cmd -match '(?i)[?&]pwd=([^&\s#]+)') {
          try { $out.passcode = [uri]::UnescapeDataString($Matches[1]) } catch { $out.passcode = $Matches[1] }
        }
        break
      }
      if (-not $out.meetingId) {
        $id = Get-ZoomMeetingId $cmd
        if ($id) {
          $out.meetingId = $id
          $out.source = 'cmdline'
          $out.passcode = Get-ZoomPasscode $cmd
        }
      }
    }
  } catch {}
  return $out
}

function Collect-ZoomMetaText($el, $budget, $parts) {
  if ($budget.Value -le 0 -or $null -eq $el) { return }
  $budget.Value--
  try {
    $name = [string]$el.Current.Name
    $id = [string]$el.Current.AutomationId
    $value = "$name $id"
    if ($value.Length -ge 3) { $parts.Add($value) | Out-Null }
    $tp = Get-TextPattern $el
    if ($tp -and $tp.Length -ge 3) { $parts.Add($tp) | Out-Null }
  } catch {}
  try {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $child = $walker.GetFirstChild($el)
    while ($null -ne $child -and $budget.Value -gt 0) {
      $next = $walker.GetNextSibling($child)
      Collect-ZoomMetaText $child $budget $parts
      $child = $next
    }
  } catch {}
}

function Get-ProcName($el) {
  try {
    $pid = $el.Current.ProcessId
    if (-not $pid) { return $null }
    $p = Get-Process -Id $pid -ErrorAction SilentlyContinue
    if (-not $p) { return $null }
    return $p.ProcessName.ToLowerInvariant()
  } catch { return $null }
}

function Get-Platform($procName, $title) {
  if ($title -match '(?i)live captions') { return 'livecaptions' }
  if ($processMap.ContainsKey($procName)) { return $processMap[$procName] }
  if ($title -match '(?i)microsoft teams|teams meeting') { return 'teams' }
  if ($title -match '(?i)zoom workplace|zoom meeting|\bzoom\b') { return 'zoom' }
  if ($title -match '(?i)webex') { return 'webex' }
  # Meet PWA / window: title-gated so other chrome/msedge windows are ignored.
  if ($title -match '(?i)google meet|meet\.google\.com') { return 'meet' }
  if ($title -match '(?i)^meet(\s+[-–—]|$)') { return 'meet' }
  return $null
}

function Get-TextPattern($el) {
  try {
    $tp = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    if ($tp) {
      $doc = $tp.DocumentRange
      if ($doc) { return ($doc.GetText(-1) | Out-String).Trim() }
    }
  } catch {}
  return $null
}

function Collect-FromElement($el, $budget, $out, $bottomOnly, $winRect, $platform) {
  if ($budget.Value -le 0 -or $null -eq $el) { return }
  $budget.Value--
  try {
    $name = [string]$el.Current.Name
    $id = [string]$el.Current.AutomationId
    $cls = [string]$el.Current.ClassName
    $typeName = [string]$el.Current.ControlType.ProgrammaticName
    $rect = $el.Current.BoundingRectangle
  } catch { return }

  $blob = "$name $id $cls $typeName"
  $isCaptionChrome = $captionHint.IsMatch($blob)
  $isTextish = $typeName -match 'Text|Document|Edit|Custom'

  if ($bottomOnly -and $winRect -and $rect.Height -gt 0) {
    $minY = $winRect.Y + ($winRect.Height * 0.58)
    if ($rect.Y + $rect.Height -lt $minY -and -not $isCaptionChrome) {
      # Keep walking children; skip this node's own text unless caption-related.
    } elseif (-not $isCaptionChrome -and $rect.Y -lt $minY -and -not ($isTextish -and $rect.Y -ge $minY)) {
      # continue to children
    }
  }

  $value = $name
  if ($isTextish) {
    $patternText = Get-TextPattern $el
    if ($patternText) { $value = $patternText }
  }

  $value = ($value -replace '\s+', ' ').Trim()
  if ($value.Length -ge 3 -and -not $noise.IsMatch($value) -and -not $activityNoise.IsMatch($value)) {
    $include = $false
    if ($platform -eq 'livecaptions' -and $isTextish -and $value.Length -ge 3) {
      $include = $true
    } elseif ($isCaptionChrome) {
      $include = $true
    } elseif ($bottomOnly -and $winRect -and $rect.Height -gt 0) {
      $minY = $winRect.Y + ($winRect.Height * 0.58)
      if ($rect.Y -ge $minY -and $value.Length -ge 8) { $include = $true }
    } elseif ($typeName -match 'Document' -and $value.Length -ge 8) {
      $include = $true
    }

    if ($include) {
      $author = ''
      $text = $value
      if ($value -match '^(?<a>.{1,40}?):\s+(?<t>.+)$') {
        $author = $Matches['a'].Trim()
        $text = $Matches['t'].Trim()
      }
      if ($text.Length -ge 2) {
        $out.Add(@{ author = $author; text = $text }) | Out-Null
      }
    }
  }

  try {
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $child = $walker.GetFirstChild($el)
    while ($null -ne $child -and $budget.Value -gt 0) {
      $next = $walker.GetNextSibling($child)
      Collect-FromElement $child $budget $out $bottomOnly $winRect $platform
      $child = $next
    }
  } catch {}
}

function Try-EnableCaptions($window) {
  $budget = @{ Value = 180 }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $stack = New-Object System.Collections.Stack
  $stack.Push($window)
  while ($stack.Count -gt 0 -and $budget.Value -gt 0) {
    $budget.Value--
    $el = $stack.Pop()
    try {
      $name = [string]$el.Current.Name
      $typeName = [string]$el.Current.ControlType.ProgrammaticName
      if ($typeName -match 'Button|MenuItem|SplitButton' -and $enableHint.IsMatch($name)) {
        $pat = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        if ($pat) { $pat.Invoke(); return $true }
      }
      $child = $walker.GetFirstChild($el)
      while ($null -ne $child) {
        $next = $walker.GetNextSibling($child)
        $stack.Push($child)
        $child = $next
      }
    } catch {}
  }
  return $false
}

function Read-Window($window, $platform) {
  $list = New-Object System.Collections.Generic.List[object]
  $budget = @{ Value = 420 }
  $rect = $null
  try { $rect = $window.Current.BoundingRectangle } catch {}
  $bottomOnly = $platform -ne 'livecaptions'
  if ($platform -eq 'livecaptions') { $budget.Value = 220 }
  if ($platform -eq 'teams' -or $platform -eq 'meet') { $budget.Value = 500 }
  Collect-FromElement $window $budget $list $bottomOnly $rect $platform
  return $list
}

$root = [System.Windows.Automation.AutomationElement]::RootElement
$winCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Window
)

$enableTried = @{}

while ($true) {
  $byPlatform = @{}
  $detected = @()
  $meetingId = ''
  $passcode = ''
  $meetingSource = ''
  $fromCmd = Get-ZoomFromProcessCommandLine
  if ($fromCmd.meetingId) {
    $meetingId = $fromCmd.meetingId
    $meetingSource = $fromCmd.source
  }
  if ($fromCmd.passcode) { $passcode = $fromCmd.passcode }

  try {
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)
    for ($i = 0; $i -lt $windows.Count; $i++) {
      $w = $windows.Get($i)
      try {
        $title = [string]$w.Current.Name
        $proc = Get-ProcName $w
        $platform = Get-Platform $proc $title
        if (-not $platform) { continue }
        if ($detected -notcontains $platform) { $detected += $platform }

        # Only use the window title for Meeting ID when labeled — never scrape caption/UI digits.
        if ($platform -eq 'zoom' -and -not $meetingId) {
          $fromTitle = Get-ZoomMeetingId $title
          if ($fromTitle) {
            $meetingId = $fromTitle
            $meetingSource = 'title'
          }
          if (-not $passcode) { $passcode = Get-ZoomPasscode $title }
        }

        $key = "$platform|$proc|$title"
        if (-not $enableTried.ContainsKey($key)) {
          $enableTried[$key] = $true
          [void](Try-EnableCaptions $w)
        }

        $captions = Read-Window $w $platform
        if ($captions.Count -gt 0) {
          if (-not $byPlatform.ContainsKey($platform)) {
            $byPlatform[$platform] = New-Object System.Collections.Generic.List[object]
          }
          foreach ($c in $captions) { $byPlatform[$platform].Add($c) | Out-Null }
        }
      } catch {}
    }
  } catch {}

  $payloadPlatform = ''
  $payloadCaptions = @()
  foreach ($p in @('teams', 'zoom', 'webex', 'meet', 'livecaptions')) {
    if ($byPlatform.ContainsKey($p) -and $byPlatform[$p].Count -gt 0) {
      $payloadPlatform = $p
      $payloadCaptions = @($byPlatform[$p])
      break
    }
  }

  $obj = [ordered]@{
    platform = $payloadPlatform
    detected = @($detected)
    captions = @($payloadCaptions)
    meetingId = $meetingId
    passcode = $passcode
    meetingSource = $meetingSource
  }
  $json = $obj | ConvertTo-Json -Compress -Depth 6
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 900
}
