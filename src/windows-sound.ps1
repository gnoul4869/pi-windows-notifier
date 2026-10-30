# Standalone validation and bounded reading of local WAV files; no executing paths, no URLs, COM, or external players.
function Assert-SoundPath {
  param($Value)
  if ($Value -isnot [string] -or $Value.Length -gt 1024 -or
      $Value -notmatch '^[a-zA-Z]:[\\/]' -or $Value -notmatch '(?i)\.wav$' -or
      $Value -match '[\x00-\x1f\x7f-\x9f\u2028\u2029\ufffe\uffff]' -or
      $Value.Substring(2) -match '[<>:"|?*]') { throw "INPUT_INVALID" }
  [System.Xml.XmlConvert]::VerifyXmlChars($Value) | Out-Null
  foreach ($part in ($Value.Substring(3) -split '[\\/]')) {
    if ($part.Length -eq 0 -or $part -match '[. ]$' -or
        $part -match '(?i)^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\.|$)') { throw "INPUT_INVALID" }
  }
}

function Assert-Wave {
  param([byte[]]$Bytes)
  # Accepts RIFF PCM only: mono/stereo, 8/16 bit, 8-48 kHz, at most fifteen seconds.
  if ($Bytes.Length -lt 44 -or $Bytes.Length -gt 10485760 -or
      [Text.Encoding]::ASCII.GetString($Bytes, 0, 4) -cne "RIFF" -or
      [Text.Encoding]::ASCII.GetString($Bytes, 8, 4) -cne "WAVE" -or
      [BitConverter]::ToUInt32($Bytes, 4) -ne $Bytes.Length - 8) { throw "SOUND_FAILED" }
  $offset = 12
  $rate = 0
  $alignment = 0
  $dataSize = 0
  $hasFormat = $false
  $hasData = $false
  while ($offset -lt $Bytes.Length) {
    if ($Bytes.Length - $offset -lt 8) { throw "SOUND_FAILED" }
    $tag = [Text.Encoding]::ASCII.GetString($Bytes, $offset, 4)
    $size = [long][BitConverter]::ToUInt32($Bytes, $offset + 4)
    $start = $offset + 8
    $end = $start + $size + ($size % 2)
    if ($end -gt $Bytes.Length) { throw "SOUND_FAILED" }
    if ($tag -ceq "fmt ") {
      if ($hasFormat -or ($size -ne 16 -and $size -ne 18)) { throw "SOUND_FAILED" }
      if ([BitConverter]::ToUInt16($Bytes, $start) -ne 1 -or
          ($size -eq 18 -and [BitConverter]::ToUInt16($Bytes, $start + 16) -ne 0)) { throw "SOUND_FAILED" }
      $channels = [BitConverter]::ToUInt16($Bytes, $start + 2)
      $sampleRate = [BitConverter]::ToUInt32($Bytes, $start + 4)
      $rate = [BitConverter]::ToUInt32($Bytes, $start + 8)
      $alignment = [BitConverter]::ToUInt16($Bytes, $start + 12)
      $bits = [BitConverter]::ToUInt16($Bytes, $start + 14)
      if (@(1, 2) -notcontains $channels -or @(8, 16) -notcontains $bits -or
          $sampleRate -lt 8000 -or $sampleRate -gt 48000 -or
          $alignment -ne $channels * ($bits / 8) -or $rate -ne $sampleRate * $alignment) { throw "SOUND_FAILED" }
      $hasFormat = $true
    } elseif ($tag -ceq "data") {
      if (-not $hasFormat -or $hasData -or $size -eq 0) { throw "SOUND_FAILED" }
      $dataSize = $size
      $hasData = $true
    }
    $offset = [int]$end
  }
  if (-not $hasFormat -or -not $hasData -or $dataSize % $alignment -ne 0 -or
      $dataSize -gt [long]$rate * 15) { throw "SOUND_FAILED" }
}

function Read-LocalWave {
  param([string]$Path)
  Assert-SoundPath $Path
  # Rejects network drives and reparse points at every level, so a plain junction/symlink can't point remotely.
  $fullPath = [IO.Path]::GetFullPath($Path)
  $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($fullPath))
  if ($drive.DriveType -ne [IO.DriveType]::Fixed) { throw "SOUND_FAILED" }
  # Checks downward from the disk root and never touches the full path first, which could reach a remote target through a junction.
  $root = [IO.Path]::GetPathRoot($fullPath)
  $current = $root
  $parts = @("") + ($fullPath.Substring($root.Length) -split '\\')
  foreach ($part in $parts) {
    if ($part.Length -gt 0) { $current = [IO.Path]::Combine($current, $part) }
    $attributes = [IO.File]::GetAttributes($current)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        ($current -eq $fullPath -and ($attributes -band [IO.FileAttributes]::Directory) -ne 0)) { throw "SOUND_FAILED" }
  }
  $stream = $null
  try {
    # Once opened, other processes may not write or delete; reading happens into bounded memory from the same handle.
    $stream = [IO.FileStream]::new($fullPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    if ($stream.Length -lt 44 -or $stream.Length -gt 10485760) { throw "SOUND_FAILED" }
    $bytes = New-Object byte[] ([int]$stream.Length)
    $offset = 0
    while ($offset -lt $bytes.Length) {
      $count = $stream.Read($bytes, $offset, $bytes.Length - $offset)
      if ($count -eq 0) { throw "SOUND_FAILED" }
      $offset += $count
    }
    Assert-Wave $bytes
    # PowerShell must not expand bytes into the pipeline; the byte[] type is preserved.
    return ,$bytes
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
  }
}

function Get-WaveDataLayout {
  param([byte[]]$Bytes)
  # Returns the data chunk's position, size, and bit depth; Assert-Wave already validated the format, so this only locates it.
  $offset = 12
  $bits = 0
  $dataStart = 0
  $dataSize = 0
  $hasData = $false
  while ($offset -lt $Bytes.Length) {
    if ($Bytes.Length - $offset -lt 8) { throw "SOUND_FAILED" }
    $tag = [Text.Encoding]::ASCII.GetString($Bytes, $offset, 4)
    $size = [long][BitConverter]::ToUInt32($Bytes, $offset + 4)
    $start = $offset + 8
    if ($start + $size -gt $Bytes.Length) { throw "SOUND_FAILED" }
    if ($tag -ceq "fmt ") {
      $bits = [BitConverter]::ToUInt16($Bytes, $start + 14)
    } elseif ($tag -ceq "data") {
      $dataStart = $start
      $dataSize = $size
      $hasData = $true
    }
    $offset = [int]($start + $size + ($size % 2))
  }
  if (-not $hasData -or $bits -eq 0) { throw "SOUND_FAILED" }
  return @($dataStart, $dataSize, $bits)
}

function Set-WaveGain {
  param([byte[]]$Bytes, [double]$Gain)
  # Scales PCM samples in place: 8-bit is unsigned with a 128 offset, 16-bit is signed; values beyond range are clipped.
  $layout = Get-WaveDataLayout $Bytes
  $start = [int]$layout[0]
  $size = [int]$layout[1]
  $bits = [int]$layout[2]
  if ($bits -eq 16) {
    $samples = [int16[]]::new([int]($size / 2))
    [Buffer]::BlockCopy($Bytes, $start, $samples, 0, $size)
    for ($index = 0; $index -lt $samples.Length; $index++) {
      $value = [Math]::Round([int]$samples[$index] * $Gain)
      if ($value -gt 32767) { $value = 32767 } elseif ($value -lt -32768) { $value = -32768 }
      $samples[$index] = [int16]$value
    }
    [Buffer]::BlockCopy($samples, 0, $Bytes, $start, $size)
  } else {
    for ($index = 0; $index -lt $size; $index++) {
      $value = [Math]::Round(([int]$Bytes[$start + $index] - 128) * $Gain)
      if ($value -gt 127) { $value = 127 } elseif ($value -lt -128) { $value = -128 }
      $Bytes[$start + $index] = [byte]($value + 128)
    }
  }
}

function Play-LocalWave {
  param([string]$Path, [double]$Gain = 1.0)
  $bytes = Read-LocalWave $Path
  # Gain 0 still reads and validates the file (a missing file still reports SOUND_FAILED), but a purely silent clip doesn't occupy the single helper queue.
  if ($Gain -le 0) { return }
  if ($Gain -lt 1) { Set-WaveGain $bytes $Gain }
  $memory = $null
  $player = $null
  try {
    $memory = [IO.MemoryStream]::new($bytes, $false)
    $player = [System.Media.SoundPlayer]::new($memory)
    $player.Load()
    $player.PlaySync()
  } finally {
    if ($null -ne $player) { $player.Dispose() }
    if ($null -ne $memory) { $memory.Dispose() }
  }
}
