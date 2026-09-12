import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const command = (name, args) => { try { return execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

export function nativeSnapshotCapabilities(root) {
  const base = resolve(root);
  if (process.platform === 'win32') { const ps = Boolean(command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'])), drive = base.slice(0, 2), fsType = ps ? command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Volume -DriveLetter '${drive[0]}').FileSystem`]) : null; return { platform: 'win32', backend: 'vss', available: ps, filesystem: fsType?.trim() ?? 'unknown', requiresElevation: true, permission: 'Administrator or SE_BACKUP_NAME', note: 'NTFS and ReFS use the same VSS backend' , root: base }; }
  if (process.platform === 'darwin') return { platform: 'darwin', backend: 'apfs', available: Boolean(command('diskutil', ['info', base])), requiresElevation: true, permission: 'root or Full Disk Access for protected volumes', root: base };
  if (process.platform === 'linux') { const fsType = command('findmnt', ['-no', 'FSTYPE', '--target', base]); return { platform: 'linux', backend: fsType === 'btrfs' ? 'btrfs' : 'portable-cas', available: fsType === 'btrfs', requiresElevation: fsType === 'btrfs', permission: fsType === 'btrfs' ? 'root or CAP_SYS_ADMIN' : 'none', fsType, root: base }; }
  return { platform: process.platform, backend: 'portable-cas', available: false, requiresElevation: false, permission: 'none', root: base };
}

export function createNativeSnapshot(root, { backend = 'auto' } = {}) {
  const caps = nativeSnapshotCapabilities(root), selected = backend === 'auto' ? caps.backend : backend;
  if (!caps.available && selected !== 'vss') throw new Error(`native snapshot backend unavailable: ${selected}`);
  if (selected === 'vss') {
    const volume = `${resolve(root).slice(0, 2)}\\`;
    const script = `$v='${volume.replaceAll("'", "''")}';$r=([WMIClass]'\\\\.\\root\\cimv2:Win32_ShadowCopy').Create($v,'ClientAccessible');if($r.ReturnValue -ne 0){throw "VSS error $($r.ReturnValue)"};$s=Get-CimInstance Win32_ShadowCopy -Filter "ID='$($r.ShadowID)'";[pscustomobject]@{id=$s.ID;device=$s.DeviceObject}|ConvertTo-Json -Compress`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const out = command('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
    if (!out) throw new Error('VSS snapshot creation failed');
    const value = JSON.parse(out); return { backend: 'vss', reference: value.id, device: value.device, root: resolve(root) };
  }
  if (selected === 'apfs') {
    const out = command('tmutil', ['localsnapshot']);
    if (!out) throw new Error('APFS snapshot creation failed');
    return { backend: 'apfs', reference: out.split(/\r?\n/).at(-1), root: resolve(root) };
  }
  if (selected === 'btrfs') throw new Error('btrfs native snapshot requires a subvolume target and is not implicit');
  throw new Error(`unsupported native snapshot backend: ${selected}`);
}

export function nativeSnapshotPath(snapshot, relativePath) {
  if (!snapshot?.device) return null;
  const rel = String(relativePath).replaceAll('/', '\\').replace(/^\\+/, '');
  return `${snapshot.device.replace(/[\\/]$/, '')}\\${rel}`;
}
