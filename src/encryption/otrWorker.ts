export class OtrWorkerController {
  private worker: Worker | undefined;
  private profileId: string | undefined;

  get isRunning(): boolean {
    return this.worker !== undefined;
  }

  start(profileId: string): void {
    if (this.worker && this.profileId === profileId) return;
    this.stop();
    this.profileId = profileId;
    this.worker = new Worker(new URL('./otr.worker.ts', import.meta.url), { type: 'module', name: `otr-${profileId}` });
    this.worker.postMessage({ type: 'initialize', profileId });
  }

  stop(): void {
    if (this.worker) {
      this.worker.postMessage({ type: 'shutdown' });
      this.worker.terminate();
    }
    this.worker = undefined;
    this.profileId = undefined;
  }
}
