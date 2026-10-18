#ifndef AppVersion
#define AppVersion "3.1.6"
#endif

; Script Inno Setup untuk MabarBang (Per-User / Tanpa UAC Admin)
[Setup]
AppName=MabarBang
AppVersion={#AppVersion}
AppPublisher=kikobooo x arvana prod
SourceDir=..
DefaultDirName={userappdata}\Programs\MabarBang
DefaultGroupName=MabarBang
OutputDir=dist-installer
OutputBaseFilename=MabarBang-{#AppVersion}.Setup
Compression=lzma2/max
SolidCompression=yes
PrivilegesRequired=lowest
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableWelcomePage=no
UninstallDisplayIcon={app}\MabarBang.exe

[Files]
Source: "bin\MabarBang.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "run.bat"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userdesktop}\MabarBang"; Filename: "{app}\MabarBang.exe"
Name: "{userprograms}\MabarBang\MabarBang"; Filename: "{app}\MabarBang.exe"
Name: "{userprograms}\MabarBang\Uninstall MabarBang"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\MabarBang.exe"; Description: "Jalankan MabarBang Sekarang"; Flags: nowait postinstall skipifsilent
