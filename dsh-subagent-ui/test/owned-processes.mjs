import { execFile } from 'node:child_process'
import { platform as currentPlatform } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function snapshotWindowsProcesses() {
  const command = 'Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine | ConvertTo-Json -Compress'
  const { stdout } = await execFileAsync('pwsh.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
  const parsed = JSON.parse(stdout.trim() || '[]')
  return (Array.isArray(parsed) ? parsed : [parsed]).map(row => ({ pid: row.ProcessId, parentPid: row.ParentProcessId, created: String(row.CreationDate), commandLine: row.CommandLine || '' }))
}

async function killWindowsTree(pid) {
  const executable = join(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe')
  await execFileAsync(executable, ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536, windowsHide: true })
}

export class OwnedTree {
  constructor(child, { home, platform = currentPlatform(), snapshot = snapshotWindowsProcesses, kill = killWindowsTree, delay = sleep } = {}) {
    this.rootPid = child.pid
    this.home = home.replace(/\\/g, '/').toLowerCase()
    this.homeAliases = new Set([this.home, this.home.replace(/^([a-z]):\//, '/$1/')])
    this.platform = platform
    this.snapshot = snapshot
    this.kill = kill
    this.delay = delay
    this.records = new Map()
    this.currentOwned = new Map()
  }

  async capture() {
    if (this.platform !== 'win32') return
    const processes = await this.snapshot()
    this.currentOwned = new Map()
    const byPid = new Map(processes.map(process => [process.pid, process]))
    const queue = []
    const queued = new Set()
    const enqueue = pid => {
      if (queued.has(pid)) return
      queued.add(pid)
      queue.push(pid)
    }
    const own = process => {
      this.currentOwned.set(process.pid, process)
      this.records.set(process.pid, process)
      enqueue(process.pid)
    }
    enqueue(this.rootPid)
    for (const pid of this.records.keys()) enqueue(pid)
    for (const process of processes) {
      const commandLine = process.commandLine.replace(/\\/g, '/').toLowerCase()
      if ([...this.homeAliases].some(alias => commandLine.includes(alias))) own(process)
    }
    while (queue.length) {
      const pid = queue.shift()
      const current = byPid.get(pid)
      const previous = this.records.get(pid)
      if (current && (!previous || previous.created === current.created)) own(current)
      for (const process of processes) if (process.parentPid === pid) {
        const known = this.records.get(process.pid)
        if (!known || known.created === process.created) enqueue(process.pid)
      }
    }
  }

  async stop() {
    if (this.platform !== 'win32') {
      try { process.kill(-this.rootPid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      await this.delay(200)
      try {
        process.kill(-this.rootPid, 0)
      } catch (error) {
        if (error.code === 'ESRCH') return
        throw error
      }
      throw new Error('OWNED_PROCESS_CLEANUP: process group still exists')
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.capture()
      for (const process of this.currentOwned.values()) {
        try { await this.kill(process.pid) } catch { /* verification below decides whether cleanup succeeded */ }
      }
      await this.delay(200)
      await this.capture()
      if (this.currentOwned.size === 0) {
        await this.delay(500)
        await this.capture()
        if (this.currentOwned.size === 0) return
      }
    }
    throw new Error('OWNED_PROCESS_CLEANUP: owned descendants remain after three cleanup passes and a settled empty rescan')
  }
}
