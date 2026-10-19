#Requires -Version 7.0
<#
.SYNOPSIS
  Bulk edits of the repo catalogue through Excel, as CSV files.

.DESCRIPTION
    pwsh src/scripts/excel.ps1 export [out/catalogue]     (or: npm run excel -- export)
    pwsh src/scripts/excel.ps1 import [out/catalogue]     (or: npm run excel -- import)

  export writes Integrations.csv, Systems.csv and Domains.csv (UTF-8) into the folder. Edit them in Excel and save
  each one as "CSV UTF-8 (Comma delimited)". import checks all three with the same rules as the build and only then
  rewrites catalogue/ (domains.json, systems.json, integrations/*.json). Review the result with `git diff` and raise
  a PR as usual.

  The checks are a copy of the error checks in lib/store.mjs (buildFromStore, checkVocab, canonicalRecord) and
  lib/files.mjs (readStore), with the same messages. Keep them in step: store.test.mjs runs both on the same broken
  catalogues and compares what they say.

.PARAMETER Command
  export or import.
.PARAMETER Folder
  Where the CSV files are written to or read from. Default: out/catalogue in the repo.
.PARAMETER Config
  The config folder (source.json, vocab.json). Default: src/config.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)] [string] $Command,
  [Parameter(Position = 1)] [string] $Folder,
  [string] $Config
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Messages hold "…" and the names people write: send them as UTF-8 when they go to a file or another program.
if ([Console]::IsOutputRedirected -or [Console]::IsErrorRedirected) { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) }

$ROOT = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')) # src/
$REPO = [IO.Path]::GetFullPath((Join-Path $ROOT '..'))        # the repo: out/
$Utf8 = [Text.UTF8Encoding]::new($false)
$StrictUtf8 = [Text.UTF8Encoding]::new($false, $true)
$Ordinal = [StringComparer]::Ordinal
$LINK_SEP = ' | '  # between a link's text and url in the Note links cell
$LIST_SEP = '; '   # between system names and aliases (names can contain "/")

function Fail([string] $Message) {
  [Console]::Error.WriteLine($Message)
  exit 1
}

# ---- JSON, read and written the way the Node scripts do -----------------------------------------------------------
# Objects are ordered and case-sensitive (so "Notes" is an unknown field, not "notes"), and nothing is turned into a
# date. Written like JSON.stringify(value, null, 2), so a record exported and imported unchanged is byte-identical.

function New-Obj { , [Collections.Specialized.OrderedDictionary]::new($Ordinal) }

function ConvertFrom-JsonElement([Text.Json.JsonElement] $E) {
  switch ($E.ValueKind) {
    'Object' { $o = New-Obj; foreach ($p in $E.EnumerateObject()) { $o[$p.Name] = ConvertFrom-JsonElement $p.Value }; return , $o }
    'Array' { $l = [Collections.Generic.List[object]]::new(); foreach ($x in $E.EnumerateArray()) { $l.Add((ConvertFrom-JsonElement $x)) }; return , $l }
    'String' { return $E.GetString() }
    'Number' { return $E.GetDouble() }
    'True' { return $true }
    'False' { return $false }
    default { return $null }
  }
}

# { Value } or { Issue } (BAD_JSON, an error), like readJsonFile in lib/files.mjs.
function Read-JsonFile([string] $Path, [string] $Label = $Path) {
  if (-not [IO.File]::Exists($Path)) { return @{ Issue = (New-Issue 'BAD_JSON' "${Label}: file not found." $Label) } }
  try {
    $text = [IO.File]::ReadAllText($Path, $Utf8).TrimStart([char]0xFEFF)
    $doc = [Text.Json.JsonDocument]::Parse($text)
    try { return @{ Value = (ConvertFrom-JsonElement $doc.RootElement) } } finally { $doc.Dispose() }
  } catch [Text.Json.JsonException] {
    return @{ Issue = (New-Issue 'BAD_JSON' "${Label}: isn't valid JSON ($($_.Exception.Message))." $Label) }
  }
}

function Read-Json([string] $Path) {
  $r = Read-JsonFile $Path
  if ($r.Contains('Issue')) { Fail $r.Issue.Message }
  return , $r.Value
}

function ConvertTo-JsonText($V, [string] $Indent = '') {
  if ($null -eq $V) { return 'null' }
  if ($V -is [string]) { return Format-JsonString $V }
  if ($V -is [bool]) { return $V ? 'true' : 'false' }
  if ($V -is [double] -or $V -is [int] -or $V -is [long]) { return ([double]$V).ToString('R', [Globalization.CultureInfo]::InvariantCulture) }
  $inner = "$Indent  "
  if ($V -is [Collections.IDictionary]) {
    if ($V.Count -eq 0) { return '{}' }
    $parts = foreach ($k in $V.Keys) { "$inner$(Format-JsonString $k): $(ConvertTo-JsonText $V[$k] $inner)" }
    return "{`n$($parts -join ",`n")`n$Indent}"
  }
  if ($V.Count -eq 0) { return '[]' }
  $parts = foreach ($x in $V) { "$inner$(ConvertTo-JsonText $x $inner)" }
  return "[`n$($parts -join ",`n")`n$Indent]"
}

$JsonEscapes = @{ [char]'"' = '\"'; [char]'\' = '\\'; [char]8 = '\b'; [char]12 = '\f'; [char]10 = '\n'; [char]13 = '\r'; [char]9 = '\t' }

function Format-JsonString([string] $S) {
  $sb = [Text.StringBuilder]::new('"')
  for ($i = 0; $i -lt $S.Length; $i++) {
    $c = $S[$i]
    $code = [int]$c
    $pairedHigh = [char]::IsHighSurrogate($c) -and $i + 1 -lt $S.Length -and [char]::IsLowSurrogate($S[$i + 1])
    $pairedLow = [char]::IsLowSurrogate($c) -and $i -gt 0 -and [char]::IsHighSurrogate($S[$i - 1])
    if ($JsonEscapes.ContainsKey($c)) { [void]$sb.Append($JsonEscapes[$c]) }
    elseif ($code -lt 0x20 -or ([char]::IsSurrogate($c) -and -not $pairedHigh -and -not $pairedLow)) { [void]$sb.Append('\u').Append($code.ToString('x4')) }
    else { [void]$sb.Append($c) }
  }
  return $sb.Append('"').ToString()
}

function Write-JsonFile([string] $Path, $Value) {
  $bytes = $Utf8.GetBytes((ConvertTo-JsonText $Value) + "`n")
  if ([IO.File]::Exists($Path) -and [Linq.Enumerable]::SequenceEqual([byte[]][IO.File]::ReadAllBytes($Path), [byte[]]$bytes)) { return $false }
  [IO.File]::WriteAllBytes($Path, $bytes)
  return $true
}

# ---- The checks (lib/store.mjs, lib/catalogue.mjs, lib/files.mjs) --------------------------------------------------

$INTEGRATION_FIELDS = @('id', 'link', 'release', 'workload', 'source', 'target', 'dataFlow', 'pattern', 'sourceProtocol', 'targetProtocol', 'frequency', 'epic', 'notes', 'links')
$SYSTEM_FIELDS = @('name', 'aliases', 'domain', 'type')
$DOMAIN_FIELDS = @('name', 'description')
$PATTERN_GROUPS = @('pubsub', 'file', 'platform', 'unknown')
$SPEEDS = @('slow', 'medium', 'fast')
$HTTPS_RULE = 'must be a full https:// URL, with any spaces or ( ) | [ ] ` written as %20, %28, %29, %7C, %5B, %5D, %60'
$IgnoreCase = [Text.RegularExpressions.RegexOptions]::IgnoreCase

function New-Issue([string] $Code, [string] $Message, [string] $File = $null) { [pscustomobject]@{ Code = $Code; Message = $Message; File = $File } }
function Test-Str($V) { $V -is [string] }
function Test-Obj($V) { $V -is [Collections.IDictionary] }
function Test-List($V) { $V -is [Collections.IList] -and $V -isnot [string] }
function Get-KindOf($V) {
  if ($null -eq $V) { 'null' } elseif (Test-List $V) { 'a list' } elseif (Test-Str $V) { 'text' } elseif ($V -is [double]) { 'a number' } elseif ($V -is [bool]) { 'true/false' } else { 'an object' }
}
function Get-Field($Obj, [string] $Key) { if ($Obj.Contains($Key)) { , $Obj[$Key] } else { $null } }
# A list field's items, one by one (nothing when it isn't a list), for @(...) and pipelines.
function Get-Items($Obj, [string] $Key) { if ($Obj.Contains($Key) -and (Test-List $Obj[$Key])) { $Obj[$Key] } }
function Get-NormKey($S) { ([string]$S).ToLowerInvariant() -creplace '[^a-z0-9]', '' }
function Get-Trimmed($V) { (Test-Str $V) ? $V.Trim() : '' }

function Test-Https($U) {
  if (-not (Test-Str $U) -or -not [regex]::IsMatch($U, '^https://', $IgnoreCase) -or [regex]::IsMatch($U, '[\s<>"`()|\[\]]')) { return $false }
  $uri = $null
  return [Uri]::TryCreate($U, [UriKind]::Absolute, [ref]$uri) -and $uri.Scheme -eq 'https' -and $uri.Host -ne ''
}

# A wiki-style cell as plain text (parseCell in lib/catalogue.mjs, text only).
function Get-CellText([string] $Raw) {
  $s = [regex]::Replace($Raw, '!\[[^\]]*\]\([^)]*\)', '')
  $s = [regex]::Replace($s, '\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)', '$1')
  $s = [regex]::Replace($s, '<br\s*/?>', "`n", $IgnoreCase)
  $s = [regex]::Replace($s, '</?[a-z][^>]*>', '', $IgnoreCase)
  $entities = @{ '&nbsp;' = ' '; '&amp;' = '&'; '&lt;' = '<'; '&gt;' = '>'; '&quot;' = '"'; '&apos;' = "'"; '&#39;' = "'" }
  $s = [regex]::Replace($s, '&(nbsp|amp|lt|gt|quot|apos|#39);', { param($m) $entities[$m.Value] })
  $s = [regex]::Replace($s, '\*\*|__|`', '').Replace([char]0x00A0, ' ')
  $lines = foreach ($line in $s.Split("`n")) { $t = [regex]::Replace($line, '[ \t]+', ' ').Trim(); if ($t) { $t } }
  return (@($lines) -join "`n")
}

function New-VocabIndex($Table) {
  $index = [Collections.Generic.Dictionary[string, object]]::new($Ordinal)
  foreach ($canonical in $Table.Keys) {
    $attrs = $Table[$canonical]
    $aliases = (Test-Obj $attrs) -and (Test-List (Get-Field $attrs 'aliases')) ? $attrs['aliases'] : @()
    foreach ($name in @($canonical) + @($aliases)) { $index[(Get-NormKey $name)] = $canonical }
  }
  return , $index
}

# Only what decides an error: is the value known, not applicable, unknown (TBC/blank), partly known or unrecognised?
function Get-ValueKind([string] $Raw, $Index, $Vocab) {
  $written = (Get-CellText $Raw).Replace("`n", ' ')
  if (-not $written) { return @{ Kind = 'unknown'; Value = $null } }
  $base = [regex]::Replace($written, '\?+\s*$', '').Trim()
  $key = Get-NormKey $base
  $unknown = @(Get-Items $Vocab 'unknownValues') | ForEach-Object { Get-NormKey $_ }
  $na = @(Get-Items $Vocab 'notApplicableValues') | ForEach-Object { Get-NormKey $_ }
  if (-not $key -or $unknown -ccontains $key) { return @{ Kind = 'unknown'; Value = $null } }
  if ($na -ccontains $key) { return @{ Kind = 'na'; Value = 'N/A' } }
  if ($Index.ContainsKey($key)) { return @{ Kind = 'known'; Value = $Index[$key] } }
  if ([regex]::IsMatch($base, '\bTBC\b', $IgnoreCase -bor [Text.RegularExpressions.RegexOptions]::ECMAScript)) { return @{ Kind = 'partial'; Value = $base } }
  return @{ Kind = 'unrecognised'; Value = $base }
}

function Test-Vocab($Vocab) {
  $issues = [Collections.Generic.List[object]]::new()
  $bad = { param($m) $issues.Add((New-Issue 'BAD_VOCAB' "config/vocab.json: $m" 'config/vocab.json')) }
  if (-not (Test-Obj $Vocab)) { & $bad "must be an object ({ … }), not $(Get-KindOf $Vocab)."; return , $issues }
  $isTextList = { param($v) (Test-List $v) -and -not (@($v) | Where-Object { -not (Test-Str $_) }) }
  foreach ($k in 'unknownValues', 'notApplicableValues') {
    $v = Get-Field $Vocab $k
    if ($null -ne $v -and -not (& $isTextList $v)) { & $bad "`"$k`" must be a list of values in quotes." }
  }
  $special = [Collections.Generic.HashSet[string]]::new($Ordinal)
  foreach ($k in 'unknownValues', 'notApplicableValues') { $v = Get-Field $Vocab $k; if (& $isTextList $v) { foreach ($x in $v) { [void]$special.Add((Get-NormKey $x)) } } }
  $pg = Get-Field $Vocab 'patternGroups'
  $groups = (Test-Obj $pg) ? @($pg.Keys) : @()
  if (-not (Test-Obj $pg)) { & $bad '"patternGroups" must be { "pubsub": { "label": "…" }, … }.' }
  foreach ($g in $groups) { if ($PATTERN_GROUPS -cnotcontains $g) { & $bad "pattern group `"$g`" isn't one the map has a line style for ($($PATTERN_GROUPS -join ', '))." } }
  $usable = @($groups | Where-Object { $PATTERN_GROUPS -ccontains $_ })
  foreach ($table in 'pattern', 'protocol', 'frequency') {
    $t = Get-Field $Vocab $table
    if (-not (Test-Obj $t)) { & $bad "`"$table`" must be a table of values ({ `"Value`": { `"aliases`": [] }, … })."; continue }
    $seen = [Collections.Generic.Dictionary[string, string]]::new($Ordinal)
    foreach ($value in $t.Keys) {
      $attrs = $t[$value]
      $where = "$table `"$value`""
      if (-not (Test-Obj $attrs)) { & $bad "$where must be { … }, not $(Get-KindOf $attrs)."; continue }
      $aliases = Get-Field $attrs 'aliases'
      if ($null -ne $aliases -and -not (& $isTextList $aliases)) { & $bad "${where}: aliases must be a list of values in quotes." }
      $group = Get-Field $attrs 'group'
      if ($table -eq 'pattern' -and -not ((Test-Str $group) -and $usable -ccontains $group)) { & $bad "${where}: group `"$($group ?? '')`" must be one of $($usable -join ', ')." }
      $twoWay = Get-Field $attrs 'twoWay'
      if ($table -eq 'pattern' -and $null -ne $twoWay -and $twoWay -isnot [bool]) { & $bad "${where}: twoWay must be true or false." }
      $speed = Get-Field $attrs 'speed'
      if ($table -eq 'frequency' -and -not ((Test-Str $speed) -and $SPEEDS -ccontains $speed)) { & $bad "${where}: speed `"$($speed ?? '')`" must be one of $($SPEEDS -join ', ')." }
      foreach ($name in @($value) + @((& $isTextList $aliases) ? $aliases : @())) {
        $key = Get-NormKey $name
        if (-not $key) { & $bad "${where}: `"$name`" has no letters or digits, so nothing can match it." }
        elseif ($special.Contains($key)) { & $bad "${where}: `"$name`" is also in unknownValues or notApplicableValues, which win, so it would never match." }
        elseif ($seen.ContainsKey($key) -and $seen[$key] -cne $value) { & $bad "${table}: `"$name`" maps to both `"$($seen[$key])`" and `"$value`"." }
        else { $seen[$key] = $value }
      }
    }
  }
  return , $issues
}

# The list inside domains.json or systems.json (listFromFile in lib/store.mjs).
function Get-ListFromFile($Json, [string] $Key, [string] $File) {
  $issues = [Collections.Generic.List[object]]::new()
  if (-not (Test-Obj $Json)) { $issues.Add((New-Issue 'BAD_VALUE' "$File must be { `"$Key`": [ … ] }, not $(Get-KindOf $Json)." $File)); return @{ List = $null; Issues = $issues } }
  $others = @($Json.Keys | Where-Object { $_ -cne '$comment' -and $_ -cne $Key })
  if (-not $Json.Contains($Key)) {
    $quoted = ($others | ForEach-Object { '"' + $_ + '"' }) -join ', '
    $hint = $others.Count ? " (it has ${quoted}: is `"$Key`" misspelt?)" : ''
    $issues.Add((New-Issue 'MISSING_FIELD' "$File has no `"$Key`" list$hint." $File)); return @{ List = $null; Issues = $issues }
  }
  if (-not (Test-List $Json[$Key])) { $issues.Add((New-Issue 'BAD_VALUE' "${File}: `"$Key`" must be a list ([ … ]), not $(Get-KindOf $Json[$Key])." $File)); return @{ List = $null; Issues = $issues } }
  foreach ($k in $others) { $issues.Add((New-Issue 'UNKNOWN_FIELD' "${File}: `"$k`" isn't a known field (only `"`$comment`" and `"$Key`")." $File)) }
  return @{ List = $Json[$Key]; Issues = $issues }
}

# The catalogue folder (readStore in lib/files.mjs). Labels name files with forward slashes.
function Read-Store([string] $Dir) {
  $rel = { param($p) $p.Replace('\', '/') }
  $issues = [Collections.Generic.List[object]]::new()
  $lists = @{}
  foreach ($pair in @(@('domains.json', 'domains'), @('systems.json', 'systems'))) {
    $label = & $rel (Join-Path $Dir $pair[0])
    $r = Read-JsonFile (Join-Path $Dir $pair[0]) $label
    if ($r.Contains('Issue')) { $issues.Add($r.Issue); $lists[$pair[1]] = $null; continue }
    $l = Get-ListFromFile $r.Value $pair[1] $label
    $issues.AddRange($l.Issues)
    $lists[$pair[1]] = $l.List
  }
  $store = @{ Domains = $lists.domains ?? @(); Systems = $lists.systems ?? @(); Integrations = [Collections.Generic.List[object]]::new(); Issues = $issues; Fatal = $false }
  if ($null -eq $lists.domains -or $null -eq $lists.systems) { $store.Fatal = $true; return $store }

  $intDir = Join-Path $Dir 'integrations'
  $names = [string[]]@(if ([IO.Directory]::Exists($intDir)) { [IO.Directory]::GetFileSystemEntries($intDir) | ForEach-Object { [IO.Path]::GetFileName($_) } })
  [Array]::Sort($names, $Ordinal)
  foreach ($f in $names) {
    $path = Join-Path $intDir $f
    $label = & $rel $path
    $isDir = [IO.Directory]::Exists($path)
    if ($isDir -or -not $f.EndsWith('.json', [StringComparison]::Ordinal)) {
      $issues.Add((New-Issue 'BAD_FILE' "${label}: only integration records belong in $(& $rel $intDir)/, one per file, named after the ID with `".json`" in lower case (e.g. I004.SVC01.json). Rename or move this $($isDir ? 'folder' : 'file')." $label))
      continue
    }
    $r = Read-JsonFile $path $label
    if ($r.Contains('Issue')) { $issues.Add($r.Issue) } else { $store.Integrations.Add(@{ File = $label; Label = $label; Record = $r.Value }) }
  }
  return $store
}

# The errors buildFromStore would report (warnings and data gaps aren't needed here). $Names says how domains.json and
# systems.json and their entries are named in messages: the files themselves, or the CSV sheets on import.
function Test-Store($Store, $Vocab, $Names = @{ Domains = 'domains.json'; Systems = 'systems.json'; DomainRow = { param($n) "#$n" }; SystemRow = { param($n) "#$n" } }) {
  $issues = [Collections.Generic.List[object]]::new()
  $issues.AddRange([object[]]@($Store.Issues))
  if ($Store.Fatal) { return , $issues }
  $vocabIssues = Test-Vocab $Vocab
  if ($vocabIssues.Count) { $issues.AddRange($vocabIssues); return , $issues }
  $err = { param($code, $message, $file = $null) $issues.Add((New-Issue $code $message $file)) }
  $unknownKeys = {
    param($obj, $allowed, $where, $commentHint)
    foreach ($k in @($obj.Keys)) {
      if ($k -ceq '$comment') { & $err 'UNKNOWN_FIELD' "${where}: `"`$comment`" isn't allowed here; $commentHint." }
      elseif ($allowed -cnotcontains $k) { & $err 'UNKNOWN_FIELD' "${where}: `"$k`" isn't a known field ($($allowed -join ', '))." }
    }
  }
  $DomFile = $Names.Domains; $SysFile = $Names.Systems

  # 1. Domains.
  $domainKeys = [Collections.Generic.HashSet[string]]::new($Ordinal)
  $n = 0
  foreach ($d in $Store.Domains) {
    $n++
    $where = "$DomFile $(& $Names.DomainRow $n)"
    if (-not (Test-Obj $d)) { & $err 'BAD_VALUE' "${where}: each domain must be { `"name`": `"…`", `"description`": `"…`" }, not $(Get-KindOf $d)."; continue }
    & $unknownKeys $d $DOMAIN_FIELDS $where 'use "description" instead'
    $name = Get-Field $d 'name'
    if ($null -ne $name -and -not (Test-Str $name)) { & $err 'BAD_VALUE' "${where}: name must be text in quotes, not $(Get-KindOf $name)."; continue }
    if (-not (Test-Str $name) -or -not $name.Trim()) { & $err 'MISSING_FIELD' "${where}: a domain needs a name."; continue }
    $key = Get-NormKey $name
    if (-not $key) { & $err 'BAD_VALUE' "${where}: domain name `"$name`" needs at least one letter or digit."; continue }
    if ($key -ceq 'unassigned') { & $err 'BAD_VALUE' "${where}: `"$name`" is reserved for systems without a domain; pick another name."; continue }
    if ($domainKeys.Contains($key)) { & $err 'DUPLICATE_DOMAIN' "Domain `"$name`" is listed twice in $DomFile."; continue }
    $desc = Get-Field $d 'description'
    if ($null -ne $desc -and -not (Test-Str $desc)) { & $err 'BAD_VALUE' "${where}: description must be text in quotes, not $(Get-KindOf $desc)." }
    [void]$domainKeys.Add($key)
  }

  # 2. Systems: names and aliases are matched ignoring case, spaces and punctuation, and must be unique.
  $systemByKey = [Collections.Generic.Dictionary[string, string]]::new($Ordinal) # key -> system name
  $n = 0
  foreach ($s in $Store.Systems) {
    $n++
    if (-not (Test-Obj $s)) { & $err 'BAD_VALUE' "$SysFile $(& $Names.SystemRow $n): each system must be { `"name`": `"…`", `"aliases`": [], `"domain`": `"…`", `"type`": `"…`" }, not $(Get-KindOf $s)."; continue }
    $name = Get-Field $s 'name'
    $where = (Test-Str $name) ? "$SysFile `"$name`"" : "$SysFile $(& $Names.SystemRow $n)"
    & $unknownKeys $s $SYSTEM_FIELDS $where 'put the comment in the "$comment" at the top of systems.json'
    if ($null -ne $name -and -not (Test-Str $name)) { & $err 'BAD_VALUE' "$SysFile $(& $Names.SystemRow $n): name must be text in quotes, not $(Get-KindOf $name)."; continue }
    if (-not (Test-Str $name) -or -not $name.Trim()) { & $err 'MISSING_FIELD' "$SysFile $(& $Names.SystemRow $n): a system needs a name."; continue }
    if (-not (Get-NormKey $name)) { & $err 'BAD_VALUE' "${where}: a system name needs at least one letter or digit."; continue }
    $aliases = [Collections.Generic.List[string]]::new()
    $rawAliases = Get-Field $s 'aliases'
    if ($null -ne $rawAliases -and -not (Test-List $rawAliases)) { & $err 'BAD_VALUE' "${where}: aliases must be a list ([ `"…`" ]), not $(Get-KindOf $rawAliases)." }
    foreach ($a in ((Test-List $rawAliases) ? $rawAliases : @())) {
      if (-not (Test-Str $a)) { & $err 'BAD_VALUE' "${where}: each alias must be text in quotes, not $(Get-KindOf $a)." }
      elseif ($a.Trim() -and -not (Get-NormKey $a)) { & $err 'BAD_VALUE' "${where}: alias `"$a`" needs at least one letter or digit." }
      elseif ($a.Trim()) { $aliases.Add($a.Trim()) }
    }
    $domain = Get-Field $s 'domain'
    if ($null -ne $domain -and -not (Test-Str $domain)) { & $err 'BAD_VALUE' "${where}: domain must be a domain's name in quotes, not $(Get-KindOf $domain)." }
    elseif (-not ((Test-Str $domain) -and $domainKeys.Contains((Get-NormKey $domain)))) { & $err 'UNKNOWN_DOMAIN' "${where}: domain `"$($domain ?? '')`" isn't in $DomFile." }
    $type = Get-Field $s 'type'
    $typeKey = (Test-Str $type) ? (Get-NormKey $type) : ''
    if ($typeKey -cne 'internal' -and $typeKey -cne 'external') { & $err 'BAD_VALUE' "${where}: type must be Internal or External." }
    $sysName = $name.Trim()
    foreach ($alias in @($sysName) + @($aliases)) {
      $key = Get-NormKey $alias
      if ($systemByKey.ContainsKey($key)) { & $err 'DUPLICATE_ALIAS' "`"$alias`" is used by both `"$($systemByKey[$key])`" and `"$sysName`" in $SysFile." }
      else { $systemByKey[$key] = $sysName }
    }
  }

  # 3. Integrations.
  $idx = @{ pattern = New-VocabIndex $Vocab['pattern']; protocol = New-VocabIndex $Vocab['protocol']; frequency = New-VocabIndex $Vocab['frequency'] }
  $seenIds = [Collections.Generic.Dictionary[string, string]]::new($Ordinal)
  foreach ($entry in $Store.Integrations) {
    $file = $entry.Label
    $r = $entry.Record
    if (-not (Test-Obj $r)) { & $err 'BAD_RECORD' "$file must hold one record ({ … }), not $(Get-KindOf $r)." $file; continue }
    $rid = Get-Field $r 'id'
    $id = Get-Trimmed $rid
    & $unknownKeys $r $INTEGRATION_FIELDS $file 'use "notes" instead'
    if ($null -ne $rid -and -not (Test-Str $rid)) { & $err 'BAD_ID' "${file}: id must be text in quotes (e.g. `"I004.SVC01`"), not $(Get-KindOf $rid)."; continue }
    if ($id -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { & $err 'BAD_ID' "${file}: id `"$($rid ?? '')`" must be letters, digits, `".`", `"_`" or `"-`"."; continue }
    $head = $id.Split('.')[0]
    if ($head -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])$') { & $err 'BAD_ID' "${file}: id `"$id`" starts with `"$head`", a name Windows keeps for devices (CON, PRN, AUX, NUL, COM1-9, LPT1-9), so its file can't be created there. Pick another id."; continue }
    if ($entry.File -and -not $entry.File.EndsWith("/$id.json", [StringComparison]::Ordinal)) { & $err 'FILE_NAME' "${file}: the file must be named after its id ($id.json)." }
    $idKey = Get-NormKey $id
    if ($seenIds.ContainsKey($idKey)) { & $err 'DUPLICATE_ID' "Integration ID `"$id`" is used by both $($seenIds[$idKey]) and $file."; continue }
    $seenIds[$idKey] = $file
    foreach ($f in 'release', 'workload', 'dataFlow', 'notes', 'pattern', 'sourceProtocol', 'targetProtocol', 'frequency') {
      $v = Get-Field $r $f
      if ($null -ne $v -and -not (Test-Str $v)) { & $err 'BAD_VALUE' "${file}: $f must be text in quotes, not $(Get-KindOf $v)." }
    }
    $link = Get-Field $r 'link'
    if ($null -ne $link -and $link -cne '' -and -not (Test-Https $link)) { & $err 'BAD_LINK' "${file}: link $HTTPS_RULE." }
    foreach ($field in 'source', 'target') {
      $v = Get-Field $r $field
      if ($null -ne $v -and -not (Test-List $v)) {
        $tail = (Test-Str $v) ? " (put `"$v`" inside [ ])" : ", not $(Get-KindOf $v)"
        & $err 'BAD_VALUE' "${file}: $field must be a list of system names, e.g. [`"ERP`"]$tail."
        continue
      }
      $endNames = @($v ?? @())
      $notText = @($endNames | Where-Object { -not (Test-Str $_) })
      if ($notText.Count) { & $err 'BAD_VALUE' "${file}: each $field name must be text in quotes, not $(Get-KindOf $notText[0])."; continue }
      foreach ($nm in $endNames) {
        $t = $nm.Trim()
        if ($t -and -not $systemByKey.ContainsKey((Get-NormKey $t))) { & $err 'UNKNOWN_SYSTEM' "${file}: $field `"$t`" isn't in $SysFile (add it, or add it as an alias)." }
      }
    }
    foreach ($pair in @(@('pattern', 'Integration Pattern', 'pattern'), @('sourceProtocol', 'Source Protocol', 'protocol'), @('targetProtocol', 'Target Protocol', 'protocol'), @('frequency', 'Schedule/Frequency', 'frequency'))) {
      $v = Get-ValueKind (Get-Trimmed (Get-Field $r $pair[0])) $idx[$pair[2]] $Vocab
      if ($v.Kind -ceq 'unrecognised') { & $err 'UNKNOWN_VALUE' "${file}: $($pair[1]) `"$($v.Value)`" isn't in config/vocab.json (use a listed value, or add it there)." }
    }
    $epic = Get-Field $r 'epic'
    if ($null -ne $epic) {
      if (-not (Test-Obj $epic) -or -not (Test-Str (Get-Field $epic 'id')) -or ($null -ne (Get-Field $epic 'url') -and -not (Test-Https $epic['url']))) {
        & $err 'BAD_VALUE' "${file}: epic must be { `"id`": `"12345`", `"url`": `"https://…`" } (url optional) or null; the url $HTTPS_RULE."
      } else { & $unknownKeys $epic @('id', 'url') "${file}: epic" 'use "notes" instead' }
    }
    $links = Get-Field $r 'links'
    if ($null -ne $links) {
      if (-not (Test-List $links)) { & $err 'BAD_VALUE' "${file}: links must be a list of { `"text`": `"…`", `"url`": `"https://…`" }, not $(Get-KindOf $links)." }
      else {
        $k = 0
        foreach ($l in $links) {
          $k++
          $where = "${file}: link $k"
          if (-not (Test-Obj $l)) { & $err 'BAD_LINK' "$where must be { `"text`": `"…`", `"url`": `"https://…`" }, not $(Get-KindOf $l)."; continue }
          & $unknownKeys $l @('text', 'url') $where 'use "notes" instead'
          $text = Get-Field $l 'text'
          if (-not (Test-Https (Get-Field $l 'url'))) { & $err 'BAD_LINK' "${where}: url $HTTPS_RULE." }
          elseif (-not (Test-Str $text) -or -not $text.Trim()) { & $err 'BAD_LINK' "$where needs `"text`": the words shown for the link." }
          elseif ($text -match '[\r\n]' -or $text.Contains($LINK_SEP)) { & $err 'BAD_LINK' "${where}: text must be on one line and not contain `"$LINK_SEP`" (the Excel export uses it between text and url)." }
        }
      }
    }
  }
  if ($Store.Integrations.Count -eq 0) { & $err 'NO_ROWS' 'catalogue/integrations has no integrations.' }
  return , $issues
}

# A record with its fields in the standard order, so files diff cleanly (canonicalRecord in lib/store.mjs).
function ConvertTo-CanonicalRecord($R) {
  $out = New-Obj
  foreach ($f in $INTEGRATION_FIELDS) {
    $v = Get-Field $R $f
    if ($f -ceq 'link' -or $f -ceq 'links') { if ($v -and (-not (Test-List $v) -or $v.Count)) { $out[$f] = $v } }
    elseif ($f -ceq 'epic') {
      if ((Test-Obj $v) -and ((Get-Field $v 'id') -or (Get-Field $v 'url'))) {
        $e = New-Obj; $e['id'] = (Get-Field $v 'id') ?? ''
        if (Get-Field $v 'url') { $e['url'] = $v['url'] }
        $out['epic'] = $e
      } else { $out['epic'] = $null }
    }
    elseif ($f -ceq 'source' -or $f -ceq 'target') { $out[$f] = $v ?? [Collections.Generic.List[object]]::new() }
    else { $out[$f] = $v ?? '' }
  }
  return , $out
}

# ---- The CSV files ------------------------------------------------------------------------------------------------
# Each file's columns: heading, and how a value goes to and from a cell. Free text comes back exactly as it is in the
# cell (spaces included), so an export and import with no edits changes nothing.

function Split-List([string] $V) { $l = [Collections.Generic.List[object]]::new(); foreach ($x in $V.Split(';')) { if ($x.Trim()) { $l.Add($x.Trim()) } }; return , $l }
function Set-Epic($R, [string] $Key, $Value) { if (-not $R.Contains('epic')) { $R['epic'] = New-Obj }; $R['epic'][$Key] = $Value }
function Get-Text($R, [string] $F) { [string]((Get-Field $R $F) ?? '') }

$SHEETS = [ordered]@{
  Integrations = @(
    @('Integration ID', { param($r) Get-Text $r 'id' }, { param($r, $v) $r['id'] = $v.Trim() }),
    @('Link', { param($r) Get-Text $r 'link' }, { param($r, $v) if ($v.Trim()) { $r['link'] = $v.Trim() } }),
    @('Release', { param($r) Get-Text $r 'release' }, { param($r, $v) $r['release'] = $v }),
    @('Workload', { param($r) Get-Text $r 'workload' }, { param($r, $v) $r['workload'] = $v }),
    @('Source', { param($r) @(Get-Items $r 'source') -join $LIST_SEP }, { param($r, $v) $r['source'] = Split-List $v }),
    @('Target', { param($r) @(Get-Items $r 'target') -join $LIST_SEP }, { param($r, $v) $r['target'] = Split-List $v }),
    @('Data Flow', { param($r) Get-Text $r 'dataFlow' }, { param($r, $v) $r['dataFlow'] = $v }),
    @('Integration Pattern', { param($r) Get-Text $r 'pattern' }, { param($r, $v) $r['pattern'] = $v }),
    @('Source Protocol', { param($r) Get-Text $r 'sourceProtocol' }, { param($r, $v) $r['sourceProtocol'] = $v }),
    @('Target Protocol', { param($r) Get-Text $r 'targetProtocol' }, { param($r, $v) $r['targetProtocol'] = $v }),
    @('Schedule/Frequency', { param($r) Get-Text $r 'frequency' }, { param($r, $v) $r['frequency'] = $v }),
    @('Epic', { param($r) $e = Get-Field $r 'epic'; $e ? (Get-Text $e 'id') : '' }, { param($r, $v) if ($v.Trim()) { Set-Epic $r 'id' $v } }),
    @('Epic link', { param($r) $e = Get-Field $r 'epic'; $e ? (Get-Text $e 'url') : '' }, { param($r, $v) if ($v.Trim()) { Set-Epic $r 'url' $v.Trim() } }),
    @('Notes', { param($r) Get-Text $r 'notes' }, { param($r, $v) $r['notes'] = $v }),
    # One link per line as "text | url". The build makes sure link text is on one line without " | " (and a URL has
    # no spaces), so each line splits back exactly; a line with only a URL uses it as the text too.
    @('Note links',
      { param($r) @(@(Get-Items $r 'links') | ForEach-Object { "$($_['text'])$LINK_SEP$($_['url'])" }) -join "`n" },
      { param($r, $v)
        $links = [Collections.Generic.List[object]]::new()
        foreach ($s in [regex]::Split($v, '\r?\n')) {
          if (-not $s.Trim()) { continue }
          $l = New-Obj
          $at = $s.LastIndexOf($LINK_SEP, [StringComparison]::Ordinal)
          if ($at -lt 0) { $l['text'] = $s.Trim(); $l['url'] = $s.Trim() } else { $l['text'] = $s.Substring(0, $at); $l['url'] = $s.Substring($at + $LINK_SEP.Length).Trim() }
          $links.Add($l)
        }
        if ($links.Count) { $r['links'] = $links }
      })
  )
  Systems = @(
    @('System', { param($r) Get-Text $r 'name' }, { param($r, $v) $r['name'] = $v }),
    @('Aliases', { param($r) @(Get-Items $r 'aliases') -join $LIST_SEP }, { param($r, $v) $r['aliases'] = Split-List $v }),
    @('Domain', { param($r) Get-Text $r 'domain' }, { param($r, $v) $r['domain'] = $v }),
    @('Type', { param($r) Get-Text $r 'type' }, { param($r, $v) $r['type'] = $v })
  )
  Domains = @(
    @('Domain', { param($r) Get-Text $r 'name' }, { param($r, $v) $r['name'] = $v }),
    @('Description', { param($r) Get-Text $r 'description' }, { param($r, $v) $r['description'] = $v })
  )
}

# Every cell quoted; UTF-8 with a byte-order mark, so Excel reads accents and symbols correctly.
function Write-CsvFile([string] $Path, $Columns, $Rows) {
  $quote = { param($s) '"' + ([string]$s).Replace('"', '""') + '"' }
  $lines = [Collections.Generic.List[string]]::new()
  $lines.Add((($Columns | ForEach-Object { & $quote $_[0] }) -join ','))
  foreach ($r in $Rows) { $lines.Add((($Columns | ForEach-Object { & $quote (& $_[1] $r) }) -join ',')) }
  [IO.File]::WriteAllText($Path, ($lines -join "`r`n") + "`r`n", [Text.UTF8Encoding]::new($true))
}

# The rows of a CSV file as lists of cells. Excel saves with "," or, in some regions, ";" between cells; the
# heading row says which. Quoted cells can hold line breaks and "" for a quote.
function Read-CsvFile([string] $Path, [string] $Name, $Problems) {
  try { $text = $StrictUtf8.GetString([IO.File]::ReadAllBytes($Path)).TrimStart([char]0xFEFF) }
  catch [Text.DecoderFallbackException] {
    $Problems.Add("${Name} isn't UTF-8 text. In Excel, use File > Save As > `"CSV UTF-8 (Comma delimited)`" and import again.")
    return , @()
  }
  $firstLine = ($text -split "`r?`n", 2)[0] -replace '"[^"]*"', ''
  $sep = (@(',', ';', "`t") | Sort-Object { -($firstLine.Split($_).Count) } | Select-Object -First 1)[0]
  $rows = [Collections.Generic.List[object]]::new()
  $row = [Collections.Generic.List[string]]::new()
  $cell = [Text.StringBuilder]::new()
  $quoted = $false
  for ($i = 0; $i -lt $text.Length; $i++) {
    $c = $text[$i]
    if ($quoted) {
      if ($c -eq '"') { if ($i + 1 -lt $text.Length -and $text[$i + 1] -eq '"') { [void]$cell.Append('"'); $i++ } else { $quoted = $false } }
      else { [void]$cell.Append($c) }
    }
    elseif ($c -eq '"') { $quoted = $true }
    elseif ($c -eq $sep) { $row.Add($cell.ToString()); [void]$cell.Clear() }
    elseif ($c -eq "`r" -or $c -eq "`n") {
      if ($c -eq "`r" -and $i + 1 -lt $text.Length -and $text[$i + 1] -eq "`n") { $i++ }
      $row.Add($cell.ToString()); [void]$cell.Clear(); $rows.Add($row.ToArray()); $row.Clear()
    }
    else { [void]$cell.Append($c) }
  }
  if ($cell.Length -or $row.Count) { $row.Add($cell.ToString()); $rows.Add($row.ToArray()) }
  return , $rows
}

# ---- Commands -----------------------------------------------------------------------------------------------------

if (-not $Config) { $Config = Join-Path $ROOT 'config' }
$source = Read-Json (Join-Path $Config 'source.json')
$vocab = Read-Json (Join-Path $Config 'vocab.json')
$storeDir = $source['store']['dir']
$DIR = [IO.Path]::GetFullPath($storeDir, $ROOT)
$csvDir = [IO.Path]::GetFullPath(($Folder ? $Folder : (Join-Path $REPO 'out/catalogue')), $PWD.ProviderPath)

# The catalogue as it is now. Anything the build would reject is refused here too, before Excel sees it: a field
# the CSV files have no column for (a "$comment", a misspelt field) would otherwise be dropped by the import.
function Read-CheckedStore {
  $store = Read-Store $DIR
  $errors = Test-Store $store $vocab
  if ($errors.Count) { Fail "$storeDir/ has errors; fix them first (npm run check), so nothing is lost on the way through Excel:`n  $(($errors | ForEach-Object Message) -join "`n  ")" }
  return $store
}

function Export-Catalogue {
  $store = Read-CheckedStore
  [void][IO.Directory]::CreateDirectory($csvDir)
  $rows = @{ Integrations = @($store.Integrations | ForEach-Object { $_.Record }); Systems = @($store.Systems); Domains = @($store.Domains) }
  foreach ($name in $SHEETS.Keys) { Write-CsvFile (Join-Path $csvDir "$name.csv") $SHEETS[$name] $rows[$name] }
  Write-Output "Wrote $csvDir`: Integrations.csv ($($rows.Integrations.Count)), Systems.csv ($($rows.Systems.Count)), Domains.csv ($($rows.Domains.Count))."
  Write-Output 'Edit them in Excel: change cells, add rows at the bottom, delete a row to remove it. Source, Target and Aliases hold several names separated by ";". Note links: one per line, as "text | https://...". Domains: the order sets the map colours, so add new ones at the bottom. Don''t rename the column headings.'
  Write-Output "Save each file as `"CSV UTF-8 (Comma delimited)`", then run: npm run excel -- import `"$csvDir`""
}

function Import-Catalogue {
  if (-not [IO.Directory]::Exists($csvDir)) { Fail "Folder not found: $csvDir" }
  $problems = [Collections.Generic.List[string]]::new()
  $read = {
    param($name)
    $path = Join-Path $csvDir "$name.csv"
    $out = [Collections.Generic.List[object]]::new()
    if (-not [IO.File]::Exists($path)) { $problems.Add("$name.csv is missing."); return , $out }
    $rows = Read-CsvFile $path "$name.csv" $problems
    if (-not $rows.Count) { if (-not $problems.Count) { $problems.Add("$name.csv is empty.") }; return , $out }
    $at = @{}
    for ($c = 0; $c -lt $rows[0].Count; $c++) { $at[$rows[0][$c].Trim().ToLowerInvariant()] = $c }
    $cols = foreach ($col in $SHEETS[$name]) { @{ Header = $col[0]; Set = $col[2]; C = $at[$col[0].ToLowerInvariant()] } }
    foreach ($col in $cols) { if ($null -eq $col.C) { $problems.Add("$name.csv: column `"$($col.Header)`" is missing.") } }
    for ($r = 1; $r -lt $rows.Count; $r++) {
      $values = foreach ($col in $cols) { ($null -ne $col.C -and $col.C -lt $rows[$r].Count) ? $rows[$r][$col.C] : '' }
      if (-not ($values | Where-Object { $_.Trim() })) { continue }
      $rec = New-Obj
      for ($i = 0; $i -lt $cols.Count; $i++) { & $cols[$i].Set $rec $values[$i] }
      $out.Add(@{ Row = $r + 1; Record = $rec })
    }
    return , $out
  }
  $domains = & $read 'Domains'
  $systems = & $read 'Systems'
  $integrations = & $read 'Integrations'
  if ($problems.Count) { Fail "Nothing was changed:`n  $($problems -join "`n  ")" }

  # The same checks as the build, on all three files, before anything is written. Messages name the CSV row.
  $records = @($integrations | ForEach-Object { @{ File = $null; Label = "Integrations.csv row $($_.Row)"; Record = (ConvertTo-CanonicalRecord $_.Record) } })
  $store = @{ Domains = @($domains | ForEach-Object Record); Systems = @($systems | ForEach-Object Record); Integrations = $records; Issues = @(); Fatal = $false }
  $rowOf = { param($list) { param($n) "row $($list[$n - 1].Row)" }.GetNewClosure() }
  $names = @{ Domains = 'Domains.csv'; Systems = 'Systems.csv'; DomainRow = (& $rowOf $domains); SystemRow = (& $rowOf $systems) }
  $errors = Test-Store $store $vocab $names
  if ($errors.Count) { Fail "Nothing was changed; fix these in the CSV files first:`n  $(($errors | ForEach-Object Message) -join "`n  ")" }

  $before = Read-CheckedStore
  $beforeIds = [Collections.Generic.HashSet[string]]::new([string[]]@($before.Integrations | ForEach-Object { $_.Record['id'] }), $Ordinal)
  $afterIds = [Collections.Generic.HashSet[string]]::new([string[]]@($records | ForEach-Object { $_.Record['id'] }), $Ordinal)
  $intDir = Join-Path $DIR 'integrations'
  foreach ($id in $beforeIds) { if (-not $afterIds.Contains($id)) { [IO.File]::Delete((Join-Path $intDir "$id.json")) } }
  $changed = 0
  foreach ($r in $records) { if (Write-JsonFile (Join-Path $intDir "$($r.Record['id']).json") $r.Record) { $changed++ } }
  foreach ($pair in @(@('domains.json', 'domains', $store.Domains), @('systems.json', 'systems', $store.Systems))) {
    $path = Join-Path $DIR $pair[0]
    $file = New-Obj
    $old = Read-Json $path
    if ((Test-Obj $old) -and $old.Contains('$comment')) { $file['$comment'] = $old['$comment'] }
    $file[$pair[1]] = [Collections.Generic.List[object]]::new([object[]]@($pair[2]))
    [void](Write-JsonFile $path $file)
  }
  $added = @($afterIds | Where-Object { -not $beforeIds.Contains($_) })
  $removed = @($beforeIds | Where-Object { -not $afterIds.Contains($_) })
  $addedNote = $added.Count ? " (added: $($added -join ', '))" : ''
  $removedNote = $removed.Count ? " (removed: $($removed -join ', '))" : ''
  Write-Output "Integrations: $($added.Count) added, $($changed - $added.Count) changed, $($removed.Count) removed$addedNote$removedNote."
  Write-Output "Systems: $($store.Systems.Count); domains: $($store.Domains.Count). Review with: git diff -- $storeDir"
}

switch ($Command) {
  'export' { Export-Catalogue }
  'import' { Import-Catalogue }
  default { Fail 'Usage: pwsh src/scripts/excel.ps1 export [folder] | import [folder]   (default folder: out/catalogue)' }
}
