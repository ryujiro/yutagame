param([Parameter(Mandatory=$true)][string]$ResultFile)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
try {
    Write-Host 'Smile Zemi / Mimamoru-net login setup. Values are stored only as Cloudflare secrets.'
    $id=Read-Host 'Login ID (email)'
    $secure=Read-Host 'Password' -AsSecureString
    if ([string]::IsNullOrWhiteSpace($id) -or $secure.Length -eq 0) { throw 'Empty credentials' }
    $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    $id | & node node_modules/wrangler/bin/wrangler.js secret put SMILE_ZEMI_LOGIN_ID
    if ($LASTEXITCODE -ne 0) { throw 'ID setup failed' }
    $password | & node node_modules/wrangler/bin/wrangler.js secret put SMILE_ZEMI_PASSWORD
    if ($LASTEXITCODE -ne 0) { throw 'Password setup failed' }
    $id=$null; $password=$null
    '{"ok":true}' | Set-Content -LiteralPath $ResultFile
    Write-Host 'Saved. No login attempt was made by this setup window.'
} catch {
    '{"ok":false}' | Set-Content -LiteralPath $ResultFile
    Write-Host 'Setup was not completed. No secret values are logged.'
}
Read-Host 'Press Enter to close'
