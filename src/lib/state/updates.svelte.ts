import * as ipc from "../ipc";

export class Updates {
  status = $state<ipc.UpdateStatus | null>(null);
  dialogOpen = $state(false);
  error = $state<unknown>(null);
  checked = $state(false);

  accept(status: ipc.UpdateStatus) {
    if (this.status && status.revision < this.status.revision) return;
    this.status = status;
    if (!status.available) this.dialogOpen = false;
  }

  watch() {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void ipc.on("update:state", (status) => { if (alive) this.accept(status); })
      .then(async (off) => {
        if (!alive) { off(); return; }
        unlisten = off;
        const status = await ipc.updateStatus();
        if (alive) this.accept(status);
      }).catch((error) => console.warn("update state:", error));
    return () => { alive = false; unlisten?.(); };
  }

  async run(task: Promise<ipc.UpdateStatus>) {
    this.error = null;
    try { this.accept(await task); return true; }
    catch (error) { this.error = error; return false; }
  }

  async checkNow() {
    this.checked = false;
    if (await this.run(ipc.updateCheck())) {
      this.checked = true;
      this.dialogOpen = !!this.status?.available;
    }
  }

  setCheck(check: boolean) { return this.run(ipc.updateSetCheck(check)); }
  skip(version: string) { this.checked = false; return this.run(ipc.updateSkip(version)); }
  install(version: string) { return this.run(ipc.updateInstall(version)); }
  async cancel() {
    try { await ipc.updateCancel(); }
    catch (error) { this.error = error; }
  }
}

export const updates = new Updates();
