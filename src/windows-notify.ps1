# Fixed helper: accepts only validated channel settings, static text, and local WAV paths; never arbitrary commands.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot "windows-sound.ps1")

function Write-Result {
  param([string]$Code, [bool]$Toast, [string]$Sound)
  [Console]::Out.WriteLine((@{ code = $Code; toast = $Toast; sound = $Sound } | ConvertTo-Json -Compress))
}
function Assert-Keys {
  param($Value, [string[]]$Keys)
  if ($Value -isnot [pscustomobject]) { throw "INPUT_INVALID" }
  $names = @($Value.PSObject.Properties.Name)
  if ($names.Count -ne $Keys.Count) { throw "INPUT_INVALID" }
  foreach ($name in $names) {
    if ($Keys -cnotcontains $name) { throw "INPUT_INVALID" }
  }
}
function Assert-Text {
  param($Value, [int]$Limit)
  if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt $Limit -or
      $Value -match '[\x00-\x1f\x7f-\x9f\u2028\u2029\ufffe\uffff]') { throw "INPUT_INVALID" }
  # Unpaired UTF-16 surrogates are rejected as well; valid emoji are kept.
  [System.Xml.XmlConvert]::VerifyXmlChars($Value) | Out-Null
}

function Assert-JsonSurrogates {
  param([string]$Value)
  # ConvertFrom-Json turns unpaired surrogates into replacement characters; check the raw JSON escapes first.
  foreach ($match in [regex]::Matches($Value, '"(?:[^"\\]|\\.)*"')) {
    $text = $match.Value
    for ($i = 1; $i -lt $text.Length - 1; $i++) {
      if ($text[$i] -cne '\') { continue }
      if ($text[$i + 1] -cne 'u') { $i++; continue }
      $code = [Convert]::ToInt32($text.Substring($i + 2, 4), 16)
      if ($code -ge 0xd800 -and $code -le 0xdbff) {
        if ($i + 12 -gt $text.Length - 1 -or $text.Substring($i + 6, 2) -cne '\u') { throw "INPUT_INVALID" }
        $low = [Convert]::ToInt32($text.Substring($i + 8, 4), 16)
        if ($low -lt 0xdc00 -or $low -gt 0xdfff) { throw "INPUT_INVALID" }
        $i += 11
      } elseif ($code -ge 0xdc00 -and $code -le 0xdfff) {
        throw "INPUT_INVALID"
      } else { $i += 5 }
    }
  }
}

try {
  $buffer = New-Object char[] 4097
  $size = 0
  while ($size -lt $buffer.Length) {
    $count = [Console]::In.Read($buffer, $size, $buffer.Length - $size)
    if ($count -eq 0) { break }
    $size += $count
  }
  if ($size -eq 0 -or $size -gt 4096) { throw "INPUT_INVALID" }
  $json = -join $buffer[0..($size - 1)]
  Assert-JsonSurrogates $json
  $inputData = $json | ConvertFrom-Json
  Assert-Keys $inputData @("kind", "toast", "sound")
  if ($inputData.kind -isnot [string] -or
      @("permission", "question", "completed", "aborted", "failed") -cnotcontains $inputData.kind) { throw "INPUT_INVALID" }
  Assert-Keys $inputData.toast @("enabled", "title", "message")
  if ($inputData.toast.enabled -isnot [bool]) { throw "INPUT_INVALID" }
  Assert-Text $inputData.toast.title 128
  Assert-Text $inputData.toast.message 512
  # volume may be omitted (legacy helper input defaults to 1.0); when present it must be a 0-1 linear amplitude gain.
  $hasVolume = $inputData.sound.PSObject.Properties.Name -ccontains "volume"
  $soundKeys = @("enabled", "source")
  if ($hasVolume) { $soundKeys += "volume" }
  Assert-Keys $inputData.sound $soundKeys
  if ($inputData.sound.enabled -isnot [bool]) { throw "INPUT_INVALID" }
  # ConvertFrom-Json (PowerShell 5.1) parses decimals as Decimal and integers as Int32/Int64; bool is not accepted.
  $soundVolume = 1.0
  if ($hasVolume) {
    $rawVolume = $inputData.sound.volume
    if (-not ($rawVolume -is [double] -or $rawVolume -is [decimal] -or $rawVolume -is [single] -or
              $rawVolume -is [int] -or $rawVolume -is [long] -or $rawVolume -is [short] -or
              $rawVolume -is [byte])) { throw "INPUT_INVALID" }
    $soundVolume = [double]$rawVolume
    if ($soundVolume -lt 0 -or $soundVolume -gt 1) { throw "INPUT_INVALID" }
  }
  if ($inputData.sound.source.type -ceq "system") {
    Assert-Keys $inputData.sound.source @("type", "name")
    if ($inputData.sound.source.type -isnot [string] -or $inputData.sound.source.name -isnot [string] -or
        @("Asterisk", "Beep", "Exclamation", "Hand", "Question") -cnotcontains $inputData.sound.source.name) { throw "INPUT_INVALID" }
  } elseif ($inputData.sound.source.type -ceq "file") {
    Assert-Keys $inputData.sound.source @("type", "path")
    if ($inputData.sound.source.type -isnot [string]) { throw "INPUT_INVALID" }
    Assert-SoundPath $inputData.sound.source.path
  } else { throw "INPUT_INVALID" }
}
catch {
  Write-Result "INPUT_INVALID" $false "failed"
  exit 1
}

$toastOk = $false
$soundStatus = "disabled"
if ($inputData.toast.enabled) {
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
      [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $nodes = $xml.GetElementsByTagName("text")
    $nodes.Item(0).AppendChild($xml.CreateTextNode($inputData.toast.title)) | Out-Null
    $nodes.Item(1).AppendChild($xml.CreateTextNode($inputData.toast.message)) | Out-Null
    $audio = $xml.CreateElement("audio")
    $audio.SetAttribute("silent", "true")
    $xml.DocumentElement.AppendChild($audio) | Out-Null
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Microsoft.Windows.PowerShell")
    $notifier.Show($toast)
    $toastOk = $true
  }
  catch { $toastOk = $false }
}

if ($inputData.sound.enabled) {
  try {
    if ($inputData.sound.source.type -ceq "file") {
      Play-LocalWave $inputData.sound.source.path $soundVolume
    } else {
      # SystemSounds has no volume interface, so volume applies to file sounds only.
      # The fixed switch uses no reflection, dynamic member access, or external players.
      switch -CaseSensitive ($inputData.sound.source.name) {
        "Asterisk" { [System.Media.SystemSounds]::Asterisk.Play() }
        "Beep" { [System.Media.SystemSounds]::Beep.Play() }
        "Exclamation" { [System.Media.SystemSounds]::Exclamation.Play() }
        "Hand" { [System.Media.SystemSounds]::Hand.Play() }
        "Question" { [System.Media.SystemSounds]::Question.Play() }
      }
      # Play is asynchronous; the bounded wait doesn't guarantee the sound was actually delivered, and no other player is created.
      Start-Sleep -Milliseconds 750
    }
    $soundStatus = "played"
  }
  catch { $soundStatus = "failed" }
}

$toastFailed = $inputData.toast.enabled -and -not $toastOk
$soundFailed = $inputData.sound.enabled -and $soundStatus -eq "failed"
$code = if ($toastFailed) {
  if ($soundFailed) { "BOTH_FAILED" } else { "TOAST_FAILED" }
} else {
  if ($soundFailed) { "SOUND_FAILED" } else { "OK" }
}
Write-Result $code $toastOk $soundStatus
if ($code -eq "OK") { exit 0 } else { exit 1 }
