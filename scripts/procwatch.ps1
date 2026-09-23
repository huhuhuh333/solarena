# Death watch for the silent server kills (3 so far, no trace anywhere).
# Runs as a Scheduled Task, OUTSIDE any job object a tool session may hold,
# and appends one line for every node.exe / cmd.exe that terminates:
# who died, whose child it was, and when — to the second.
#
# Interpretation:
#   - the whole chain (outer cmd + npm node + inner cmd + server node) stamps
#     out in the same second  -> external TREE/JOB kill (nothing inside the
#     server can do that)
#   - only the server node dies -> look at exitcode.log next to it: the cmd
#     wrapper above it survives long enough to record node's exit code.
$log = 'C:\Users\WIN11\Desktop\hoodarena\server\data\procwatch.log'
Add-Content -Path $log -Value ("{0} WATCHER-START pid={1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $PID)

Register-CimIndicationEvent -Query "SELECT * FROM __InstanceDeletionEvent WITHIN 1 WHERE TargetInstance ISA 'Win32_Process' AND (TargetInstance.Name='node.exe' OR TargetInstance.Name='cmd.exe')" -SourceIdentifier hooddel | Out-Null

while ($true) {
  $e = Wait-Event -SourceIdentifier hooddel
  $t = $e.SourceEventArgs.NewEvent.TargetInstance
  $cl = $t.CommandLine
  if (-not $cl) { $cl = '' }
  $cl = ($cl -replace '\s+', ' ')
  if ($cl.Length -gt 130) { $cl = $cl.Substring(0, 130) }
  Add-Content -Path $log -Value ("{0} STOP {1} pid={2} ppid={3} :: {4}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $t.Name, $t.ProcessId, $t.ParentProcessId, $cl)
  Remove-Event -EventIdentifier $e.EventIdentifier
}
