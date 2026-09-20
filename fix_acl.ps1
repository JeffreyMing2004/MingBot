$path = "H:\WorkSpace\MingBot\.git"
$acl = Get-Acl $path
$newRules = @()
foreach ($rule in $acl.Access) {
  if ($rule.IdentityReference -like "*mingm*" -and $rule.AccessControlType -eq "Deny") {
    Write-Host "Removing Deny rule:" $rule.IdentityReference
  } else {
    $newRules += $rule
  }
}
$newAcl = New-Object System.Security.AccessControl.DirectorySecurity
foreach ($r in $newRules) { $newAcl.AddAccessRule($r) }
Set-Acl -Path $path -AclObject $newAcl
Write-Host "Done"
