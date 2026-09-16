import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

export async function privateWindowsDirectory(path: string): Promise<void> {
	const script = `
$ErrorActionPreference = 'Stop'
$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(path).toString("base64")}'))
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetSecurityDescriptorSddlForm("O:" + $sid + "D:P(A;OICI;FA;;;" + $sid + ")")
$directory = New-Object IO.DirectoryInfo($path)
if ($directory.Exists -and ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
	throw "Agent text requires a private, user-owned directory: $path"
}
$directory.Create($acl)
$sections = [Security.AccessControl.AccessControlSections]'Access,Owner'
$actual = $directory.GetAccessControl($sections)
if ($actual.GetSecurityDescriptorSddlForm($sections) -ne $acl.GetSecurityDescriptorSddlForm($sections)) {
	throw "Agent text requires a private, user-owned directory: $path"
}
`;
	await promisify(execFile)(join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
		"-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
	], { windowsHide: true, timeout: 10_000 });
}
