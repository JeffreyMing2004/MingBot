$path = "H:\WorkSpace\MingBot\.git"
$acl = Get-Acl $path
$sddl = $acl.Sddl
Write-Host "Original SDDL:"
Write-Host $sddl
# Remove Deny ACEs for this user
$newSddl = $sddl -replace "\(D;;[^)]*S-1-5-21-4244754608-966067002-114927028-4096666108\)", ""
$newSddl = $newSddl -replace "\(D;OICIIO;[^)]*S-1-5-21-4244754608-966067002-114927028-4096666108\)", ""
Write-Host "New SDDL:"
Write-Host $newSddl
$acl.SetSecurityDescriptorSddlForm($newSddl)
Set-Acl -Path $path -AclObject $acl
Write-Host "Done"
