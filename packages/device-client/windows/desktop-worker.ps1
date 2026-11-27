$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class YesImBotDesktop {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
  [StructLayout(LayoutKind.Explicit, Size=40)] public struct Input {
    [FieldOffset(0)] public uint type;
    [FieldOffset(8)] public ushort vk;
    [FieldOffset(10)] public ushort scan;
    [FieldOffset(12)] public uint flags;
  }
  [DllImport("user32.dll")] static extern uint SendInput(uint count, Input[] input, int size);
  public static void Text(string text) {
    foreach (char c in text) {
      var events = new Input[] { new Input {type=1,scan=c,flags=4}, new Input {type=1,scan=c,flags=6} };
      if(SendInput(2,events,40)!=2) throw new Exception("desktop_input_failed");
    }
  }
}
'@
[void][YesImBotDesktop]::SetProcessDPIAware()
$script:elements = @{}
$script:snapshot = ''
$script:window = 0
$script:scale = 1.0
$script:bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
function Assert-Desktop {
  if ([System.Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { throw 'interactive_desktop_required' }
  $handle = [YesImBotDesktop]::OpenInputDesktop(0, $false, 0x0100)
  if ($handle -eq [IntPtr]::Zero) { throw 'desktop_locked_or_unavailable' }
  [void][YesImBotDesktop]::CloseDesktop($handle)
}
function Get-Screen {
  $script:bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $b = $script:bounds
  $bitmap = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $output = $null
  $memory = New-Object System.IO.MemoryStream
  try {
    $graphics.CopyFromScreen($b.Left, $b.Top, 0, 0, $b.Size)
    $script:scale = [Math]::Min(1.0, 1600.0 / $b.Width)
    $w = [int]($b.Width * $script:scale); $h = [int]($b.Height * $script:scale)
    $output = New-Object System.Drawing.Bitmap($bitmap, $w, $h)
    $output.Save($memory, [System.Drawing.Imaging.ImageFormat]::Jpeg)
    return @{ data=[Convert]::ToBase64String($memory.ToArray()); mediaType='image/jpeg'; width=$w; height=$h; origin=@{x=$b.Left;y=$b.Top} }
  } finally { if ($output) { $output.Dispose() }; $graphics.Dispose(); $bitmap.Dispose(); $memory.Dispose() }
}
function Move-Pointer($a) {
  $x = [int]($a.x / $script:scale) + $script:bounds.Left
  $y = [int]($a.y / $script:scale) + $script:bounds.Top
  if ($x -lt $script:bounds.Left -or $x -ge $script:bounds.Right -or $y -lt $script:bounds.Top -or $y -ge $script:bounds.Bottom) { throw 'desktop_coordinates_out_of_range' }
  [void][YesImBotDesktop]::SetCursorPos($x, $y)
}
function Key-Code([string]$key) {
  $special = @{ CTRL=17; CONTROL=17; ALT=18; SHIFT=16; META=91; SUPER=91; WIN=91; ENTER=13; RETURN=13; TAB=9; ESC=27; ESCAPE=27; SPACE=32; BACKSPACE=8; DELETE=46; ARROWLEFT=37; LEFT=37; ARROWUP=38; UP=38; ARROWRIGHT=39; RIGHT=39; ARROWDOWN=40; DOWN=40; HOME=36; END=35; PAGEUP=33; PAGEDOWN=34 }
  $name = $key.ToUpperInvariant()
  if ($special.ContainsKey($name)) { return [byte]$special[$name] }
  if ($name -match '^F([1-9]|1[0-2])$') { return [byte](111+[int]$Matches[1]) }
  if ($name -match '^[A-Z0-9]$') { return [byte][char]$name }
  throw 'unsupported_desktop_key'
}
function Run-Actions($actions) {
  foreach ($a in $actions) {
    $held = @()
    try {
      if ($a.type -ne 'keypress') { foreach ($k in $a.keys) { $code=Key-Code $k; [YesImBotDesktop]::keybd_event($code,0,0,[UIntPtr]::Zero); $held += $code } }
      switch ($a.type) {
        'screenshot' { }
        'wait' { Start-Sleep -Milliseconds 250 }
        'move' { Move-Pointer $a }
        'type' { [YesImBotDesktop]::Text($a.text) }
        'keypress' { foreach ($k in $a.keys) { $code=Key-Code $k; [YesImBotDesktop]::keybd_event($code,0,0,[UIntPtr]::Zero); $held += $code } }
        { $_ -eq 'click' -or $_ -eq 'double_click' } {
          Move-Pointer $a
          $down=2; $up=4; $data=0
          if ($a.button -eq 'right') {$down=8;$up=16}
          elseif ($a.button -eq 'wheel') {$down=32;$up=64}
          elseif ($a.button -in @('back','forward')) {$down=128;$up=256;$data=1;if($a.button -eq 'forward'){$data=2}}
          $times=1;if($a.type -eq 'double_click'){$times=2}
          for($i=0;$i -lt $times;$i++){ [YesImBotDesktop]::mouse_event($down,0,0,$data,[UIntPtr]::Zero); [YesImBotDesktop]::mouse_event($up,0,0,$data,[UIntPtr]::Zero) }
        }
        'drag' {
          Move-Pointer $a.path[0]
          [YesImBotDesktop]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
          try { foreach($point in $a.path){Move-Pointer $point} } finally { [YesImBotDesktop]::mouse_event(4,0,0,0,[UIntPtr]::Zero) }
        }
        'scroll' {
          Move-Pointer $a
          if($a.scrollY){[YesImBotDesktop]::mouse_event(2048,0,0,[BitConverter]::ToUInt32([BitConverter]::GetBytes([int](-$a.scrollY)),0),[UIntPtr]::Zero)}
          if($a.scrollX){[YesImBotDesktop]::mouse_event(4096,0,0,[BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$a.scrollX),0),[UIntPtr]::Zero)}
        }
        default { throw 'unsupported_desktop_action' }
      }
    } finally { [array]::Reverse($held); foreach($code in $held){[YesImBotDesktop]::keybd_event($code,0,2,[UIntPtr]::Zero)} }
  }
  return Get-Screen
}
function Inspect-Desktop($inputData) {
  $windows = New-Object System.Collections.Generic.List[object]
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
  foreach($w in $all) {
    if($windows.Count -ge 80){break}
    try { if(-not $w.Current.IsOffscreen){ $windows.Add(@{handle=$w.Current.NativeWindowHandle;title=$w.Current.Name;processId=$w.Current.ProcessId}) } } catch { }
  }
  $handle = [YesImBotDesktop]::GetForegroundWindow()
  if($inputData.window){$handle=[IntPtr][long]$inputData.window}
  $target = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  $script:elements = @{}; $script:snapshot = [guid]::NewGuid().ToString(); $script:window=$handle.ToInt64()
  $rows = New-Object System.Collections.Generic.List[object]
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($target)
  $walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
  $limit=150;if($inputData.limit){$limit=[int]$inputData.limit}
  while($queue.Count -gt 0 -and $rows.Count -lt $limit) {
    $node=$queue.Dequeue()
    try {
      $current=$node.Current
      if(-not $current.IsOffscreen) {
        $ref='e'+$rows.Count; $script:elements[$ref]=$node
        $row=@{ref=$ref;name=$current.Name;type=$current.ControlType.ProgrammaticName;enabled=$current.IsEnabled;password=$current.IsPassword}
        if($current.IsPassword){$row.name='[password]'}
        $rows.Add($row)
      }
      $child=$walker.GetFirstChild($node)
      while($child -and $queue.Count -lt 600){$queue.Enqueue($child);$child=$walker.GetNextSibling($child)}
    } catch { }
  }
  return @{snapshot=$script:snapshot;window=$script:window;windows=@($windows.ToArray());controls=@($rows.ToArray());truncated=($queue.Count -gt 0)}
}
function Control-Element($inputData) {
  if($inputData.snapshot -ne $script:snapshot -or -not $script:elements.ContainsKey($inputData.ref)){throw 'stale_desktop_snapshot'}
  $node=$script:elements[$inputData.ref]
  if($node.Current.IsPassword){throw 'password_control_requires_user'}
  [void][YesImBotDesktop]::SetForegroundWindow([IntPtr]$script:window)
  switch($inputData.action){
    'focus' {$node.SetFocus()}
    'invoke' {$node.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()}
    'setValue' {$node.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue([string]$inputData.text)}
    'select' {$node.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()}
    'expand' {$node.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()}
    'collapse' {$node.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Collapse()}
    default {throw 'unsupported_desktop_action'}
  }
  $script:elements=@{};$script:snapshot=''
  return @{action=$inputData.action;completed=$true}
}
while($null -ne ($line=[Console]::ReadLine())) {
  $message=$null
  try {
    if($line.Length -gt 262144){throw 'desktop_input_too_large'}
    $message=ConvertFrom-Json $line
    Assert-Desktop
    $output=switch($message.method){
      'inspect' {Inspect-Desktop $message.input}
      'control' {Control-Element $message.input}
      'execute' {Run-Actions $message.input.actions}
      default {throw 'unsupported_desktop_method'}
    }
    $reply=@{id=$message.id;ok=$true;output=$output}
  } catch {
    $code=$_.Exception.Message
    if($code -notmatch '^[a-z_]+$'){$code='desktop_action_failed'}
    $reply=@{id=$message.id;ok=$false;error=$code}
  }
  [Console]::WriteLine((ConvertTo-Json $reply -Depth 20 -Compress))
}
