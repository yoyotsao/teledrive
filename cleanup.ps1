$content = Get-Content 'D:\teledrive\frontend\src\components\ChonkyDrive.tsx' -Raw
$lines = $content -split "`n"
$newContent = ($lines[0..1139] -join "`n")
Set-Content 'D:\teledrive\frontend\src\components\ChonkyDrive.tsx' -Value $newContent -NoNewline