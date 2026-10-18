# Script generate sertifikat & code-signing
$ErrorActionPreference = "Stop"

$subject = "CN=MabarBang, O=ChatGuessr, OU=Development"
Write-Host "Creating self-signed code-signing certificate: $subject..."

$cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $subject `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -NotAfter (Get-Date).AddYears(5)

Write-Host "Thumbprint: $($cert.Thumbprint)"

# Export ke file .cer (Public certificate)
$cerPath = Join-Path $PSScriptRoot "..\bin\MabarBang.cer"
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null
Write-Host "Exported certificate to: $cerPath"

# Sign file .exe
$targets = @("..\bin\MabarBang.exe", "..\bin\ChatGuessr.exe")
foreach ($t in $targets) {
    $fullPath = Join-Path $PSScriptRoot $t
    if (Test-Path $fullPath) {
        Write-Host "Signing $fullPath..."
        Set-AuthenticodeSignature -FilePath $fullPath -Certificate $cert -HashAlgorithm SHA256 | Out-Null
        $status = Get-AuthenticodeSignature -FilePath $fullPath
        Write-Host "$($status.Path) => Status: $($status.Status)"
    }
}

Write-Host "Done!"
